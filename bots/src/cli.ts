/**
 * The bot CLI (spec §4, §12a): `npm run bot -- <companion|revert> [flags]`.
 *
 * - `companion` (the default): loads the config, resolves the world (`--world` by uuid or name; none →
 *   lists the target's worlds), checks the live acknowledgement, the name and the skin, connects a
 *   `BotClient` and runs the companion. SIGINT/SIGTERM stop it cleanly; with `--revert-on-exit` the
 *   bot's edits are reverted first. Decisions go to `bots/.state/logs/…jsonl`.
 * - `revert`: connects with the same `statePath`, runs `revert()`, prints the count and exits.
 *
 * Only `--brain scripted` is available until Task 6 adds the Laya and CLM brains.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BotClient } from 'minicraft-bot';
import type { WorldListing } from 'minicraft-bot';
import { jsonlLogger } from './body/log.js';
import { runCompanion, seededRng } from './bots/companion.js';
import { ConfigError, checkLiveAck, checkName, loadConfig, pickSkin, resolveWorld } from './config.js';
import type { Config } from './config.js';
import { realPort } from './port.js';
import { SKIN_IDS } from './skins.js';

const BOTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_ROOT = resolve(BOTS_DIR, '.state');

export type Command = 'companion' | 'revert';

/** Splits `<companion|revert> [flags]`; flags alone mean `companion`. */
export function parseCommand(argv: readonly string[]): { command: Command; flags: string[] } {
	const [first, ...rest] = argv;
	if (first === 'companion' || first === 'revert') return { command: first, flags: rest };
	if (first === undefined || first.startsWith('--')) return { command: 'companion', flags: [...argv] };
	throw new ConfigError(`unknown bot "${first}"; expected companion or revert`);
}

/** The brains this build can run. Task 6 adds laya and clm. */
export function brainRefusal(brain: string): string | null {
	return brain === 'scripted' ? null : 'only --brain scripted is available in this build';
}

function readFileOrNull(path: string): string | null {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

function writeFileMkdir(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function listWorldsText(worlds: readonly WorldListing[]): string {
	if (worlds.length === 0) return 'no worlds on this target';
	return worlds.map((w) => `${w.uuid}  ${w.name}${w.mustMine ? '  (mustMine)' : ''}  online: ${w.online.map((p) => p.name).join(', ') || '-'}`).join('\n');
}

/** Resolves the world and runs the checks shared by both commands. `null` = listed worlds, exit. */
async function prepare(cfg: Config): Promise<{ listing: WorldListing; skin: string } | null> {
	const lister = new BotClient({ url: cfg.target.url, token: cfg.target.token });
	const worlds = await lister.listWorlds();
	const world = resolveWorld(worlds, cfg.worldArg);
	if (world === 'listOnly') {
		console.log(listWorldsText(worlds));
		return null;
	}
	if (world instanceof ConfigError) throw world;
	const ack = checkLiveAck({ cfg, worldUuid: world.uuid, readFile: readFileOrNull, writeFile: writeFileMkdir, now: () => Date.now() });
	if (ack instanceof ConfigError) throw ack;
	const name = checkName(cfg.name, world.online.map((p) => p.name));
	if (name instanceof ConfigError) throw name;
	const skin = pickSkin(SKIN_IDS, world.online.map((p) => p.skin), cfg.skin);
	if (skin instanceof ConfigError) throw skin;
	return { listing: world, skin };
}

async function connect(cfg: Config, listing: WorldListing, skin: string): Promise<BotClient> {
	const statePath = cfg.statePath(listing.uuid);
	mkdirSync(dirname(statePath), { recursive: true });
	const client = new BotClient({ url: cfg.target.url, token: cfg.target.token, statePath });
	await client.connect({ world: listing.uuid, name: cfg.name, skin });
	return client;
}

async function revertCommand(cfg: Config): Promise<void> {
	const prepared = await prepare(cfg);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin);
	try {
		const n = await client.revert();
		console.log(`reverted ${n} cell${n === 1 ? '' : 's'}`);
	} finally {
		client.close();
	}
}

async function companionCommand(cfg: Config): Promise<void> {
	const refusal = brainRefusal(cfg.brain);
	if (refusal) throw new ConfigError(refusal);
	const prepared = await prepare(cfg);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin);
	const port = realPort(client, prepared.listing);

	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(STATE_ROOT, 'logs', cfg.target.name, prepared.listing.uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const log = jsonlLogger((line) => appendFileSync(logPath, line), seed, () => Date.now());
	console.log(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; brain ${cfg.brain}; log ${logPath}`);

	const handle = runCompanion({
		body: port.body,
		world: port.world,
		brain: null,
		config: { companion: cfg.companion, noEdits: cfg.noEdits, brainTimeoutMs: cfg.brains[cfg.brain]?.timeoutMs ?? 400, name: cfg.name },
		log,
		clock: () => Date.now(),
		rng: seededRng(seed),
		seed,
		status: (line) => console.log(line),
	});

	let exiting = false;
	const exit = async (signal: string): Promise<void> => {
		if (exiting) return;
		exiting = true;
		console.log(`${signal}: stopping`);
		await handle.stop();
		if (cfg.revertOnExit) {
			const n = await client.revert();
			console.log(`reverted ${n} cell${n === 1 ? '' : 's'}`);
		}
		client.close();
	};
	process.on('SIGINT', () => void exit('SIGINT'));
	process.on('SIGTERM', () => void exit('SIGTERM'));
	client.on('close', (code) => {
		if (exiting) return;
		console.log(`connection closed (${code})`);
		void handle.stop().then(() => process.exit(code === 1000 ? 0 : 1));
	});
}

export async function main(argv: readonly string[]): Promise<void> {
	const { command, flags } = parseCommand(argv);
	const cfg = loadConfig({ argv: flags, env: process.env, readFile: readFileOrNull, homedir, stateRoot: STATE_ROOT });
	if (command === 'revert') await revertCommand(cfg);
	else await companionCommand(cfg);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
}
