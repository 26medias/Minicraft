/**
 * The bot CLI (spec §4, §12a): `npm run bot -- <companion|revert> [flags]`.
 *
 * - `companion` (the default): loads the config, resolves the world (`--world` by uuid or name; none →
 *   lists the target's worlds), checks the live acknowledgement, the name and the skin, connects a
 *   `BotClient` and runs the companion. SIGINT/SIGTERM stop it cleanly; with `--revert-on-exit` the
 *   bot's edits are reverted first. Decisions go to `bots/.state/logs/…jsonl`.
 * - `revert`: connects with the same `statePath`, runs `revert()`, prints the count and exits.
 *
 * `--brain laya|clm` (Task 6) builds a `SystemOneBrain` from `bots.config.ts`'s `brains` entry and
 * health-checks it before connecting: a down brain refuses to start (spec §4) with a message naming
 * how to start it, unless `--brain scripted` (which has no external process, and always passes).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BotClient } from 'minicraft-bot';
import type { BotClientOptions, JournalEntry, WorldListing } from 'minicraft-bot';
import type { Brain } from './brain/brain.js';
import { SystemOneBrain } from './brain/systemone.js';
import { jsonlLogger } from './body/log.js';
import { runCompanion, seededRng } from './bots/companion.js';
import { ConfigError, checkLiveAck, checkName, loadConfig, pickSkin, resolveWorld } from './config.js';
import type { BrainDef, BrainName, Config } from './config.js';
import { realPort } from './port.js';
import { runBrain2, type Brain2Handle } from './brain2/brain.js';
import { PERSONALITIES } from './brain2/data/personalities.data.js';
import { LIMITS } from './brain2/data/limits.data.js';
import { BrainSaver, brainFilePath, loadBrainFile, reconcileRevert, type BrainFile } from './brain2/persist.js';
import { Store, initialState, type Patch } from './brain2/store.js';
import type { State } from './brain2/types.js';
import { logFileWriter, type LogLine } from './brain2/log.js';
import { armHardExit, installCrashGuards } from './brain2/guards.js';
import { applyPoke, startTui, type Poke } from './brain2/tui.js';
import { SKIN_IDS } from './skins.js';
import { forbiddenByKids } from './body/guard.js';
import { blockNames, worldSpawn } from 'minicraft-bot';
import { builderStatePath, runBuilder, saveBuilderFile, type BuilderHandle } from './builder/builder.js';
import { jevEngine, layaEngine, parseJevKey, type ChoiceEngine } from './builder/engines.js';
import { Jev } from './brain2/engines/jev.js';
import { runVillage, saveVillageFile, villageStatePath, type VillageHandle } from './village/village.js';
import { SharedCells, sharedCellsPath } from './shared/bot-cells.js';
import { helperStatePath, runHelper, type HelperHandle } from './helper/helper.js';
import { runArchitect, type ArchitectHandle } from './architect/architect.js';
import { ollamaProposer } from './architect/llm-params.js';
import { builderDir, decoratorStatePath, runDecorator, saveDecoratorFile, type DecoratorHandle } from './decorator/decorator.js';
import { foremanStatePath, runForeman, saveForemanFile, type ForemanHandle } from './foreman/foreman.js';
import { planFilePath } from './foreman/plan-file.js';
import { LANDSCAPER_REST_SEC, landscaperStatePath, runLandscaper, saveLandscaperFile, type LandscaperHandle } from './landscaper/landscaper.js';
import { boardPath } from './board/board.js';

const BOTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_ROOT = resolve(BOTS_DIR, '.state');

export type Command = 'companion' | 'revert' | 'builder' | 'decorator' | 'village' | 'helper' | 'architect' | 'foreman' | 'landscaper';

/** Splits `<companion|revert> [flags]`; flags alone mean `companion`. */
export function parseCommand(argv: readonly string[]): { command: Command; flags: string[] } {
	const [first, ...rest] = argv;
	if (first === 'companion' || first === 'revert' || first === 'builder' || first === 'decorator' || first === 'village' || first === 'helper' || first === 'architect' || first === 'foreman' || first === 'landscaper') return { command: first, flags: rest };
	if (first === undefined || first.startsWith('--')) return { command: 'companion', flags: [...argv] };
	throw new ConfigError(`unknown bot "${first}"; expected companion, revert, builder, decorator, village, helper, architect, foreman or landscaper`);
}

/** Builds the real brain for `--brain laya|clm` (Task 6), or `null` for `--brain scripted` (the loop
 *  then decides every tick by script). Pure given `brains` and `fetchImpl`: no health check here. */
export function buildBrain(brain: BrainName, brains: Record<string, BrainDef>, fetchImpl: typeof fetch): Brain | null {
	if (brain === 'scripted') return null;
	const def = brains[brain];
	if (!def) throw new ConfigError(`no brain config for "${brain}"`);
	return new SystemOneBrain({ name: brain, url: def.url, healthPath: def.health, fetchImpl });
}

/** The refusal message when a real brain's `health()` fails: names how to start it. */
export function brainHealthMessage(brain: 'laya' | 'clm'): string {
	if (brain === 'clm') return 'clm is not running — its encoder does not fit this GPU; see ~/Projects/AI/BRAINS.md';
	return `${brain} is not running or not healthy; start it with \`npm run brains -- ${brain}\` (see ~/Projects/AI/BRAINS.md)`;
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

/** What the commands need from outside: injected so tests run them against a fake client. */
export interface CliDeps {
	makeClient(opts: BotClientOptions): BotClient;
	stateRoot: string;
	env: Record<string, string | undefined>;
	readFile(path: string): string | null;
	print(line: string): void;
	/** Injectable for tests (a `node:http` fake); defaults to the global `fetch`. Used only by
	 *  `--brain laya|clm` (health check and `ask`). */
	fetchImpl?: typeof fetch;
	/** The pause between `revert --builds` writes (default: a real timer). */
	sleep?: (ms: number) => Promise<void>;
	/** Test hook: the running builder and its client (the e2e stops it itself). */
	onBuilder?: (h: BuilderHandle, client: BotClient) => void;
	/** Test hook: the builder's rest between builds (default: --rest-sec, 30 s). */
	builderRestMs?: number;
	/** Test hook: the running decorator and its client (the e2e stops it itself). */
	onDecorator?: (h: DecoratorHandle, client: BotClient) => void;
	/** Test hook: the running village bot and its client (the e2e stops it itself). */
	onVillage?: (h: VillageHandle, client: BotClient) => void;
	/** Test hook: the running helper bot and its client (the e2e stops it itself). */
	onHelper?: (h: HelperHandle, client: BotClient) => void;
	/** Test hook: the running architect bot and its client (the e2e stops it itself). */
	onArchitect?: (h: ArchitectHandle, client: BotClient) => void;
	/** Test hook: the running foreman and its client (the e2e stops it itself). */
	onForeman?: (h: ForemanHandle, client: BotClient) => void;
	/** Test hook: the foreman's pause between placements (default 800 ms). */
	foremanPaceMs?: number;
	/** Test hook: the running landscaper and its client (the e2e stops it itself). */
	onLandscaper?: (h: LandscaperHandle, client: BotClient) => void;
	/** Test hook: the landscaper's rest between blasts (default: --rest-sec). */
	landscaperRestMs?: number;
	/** Test hook: the landscaper's mining time per block (default: the hand's time for the block). */
	landscaperMineMs?: number;
	/** Test hook: the side of the squares it levels (default 16). */
	landscaperAreaSize?: number;
}

const DEFAULT_DEPS: CliDeps = {
	makeClient: (opts) => new BotClient(opts),
	stateRoot: STATE_ROOT,
	env: process.env,
	readFile: readFileOrNull,
	print: (line) => console.log(line),
};

/** Resolves the world and runs the checks shared by both commands. `null` = listed worlds, exit. */
async function prepare(cfg: Config, deps: CliDeps): Promise<{ listing: WorldListing; skin: string } | null> {
	const lister = deps.makeClient({ url: cfg.target.url, token: cfg.target.token });
	const worlds = await lister.listWorlds();
	const world = resolveWorld(worlds, cfg.worldArg);
	if (world === 'listOnly') {
		deps.print(listWorldsText(worlds));
		return null;
	}
	if (world instanceof ConfigError) throw world;
	const ack = checkLiveAck({ cfg, worldUuid: world.uuid, readFile: deps.readFile, writeFile: writeFileMkdir, now: () => Date.now() });
	if (ack instanceof ConfigError) throw ack;
	const name = checkName(cfg.name, world.online.map((p) => p.name));
	if (name instanceof ConfigError) throw name;
	const skin = pickSkin(SKIN_IDS, world.online.map((p) => p.skin), cfg.skin);
	if (skin instanceof ConfigError) throw skin;
	return { listing: world, skin };
}

async function connect(cfg: Config, listing: WorldListing, skin: string, deps: CliDeps): Promise<BotClient> {
	const statePath = cfg.statePath(listing.uuid);
	mkdirSync(dirname(statePath), { recursive: true });
	const client = deps.makeClient({ url: cfg.target.url, token: cfg.target.token, statePath });
	await client.connect({ world: listing.uuid, name: cfg.name, skin });
	return client;
}

function cells(n: number): string {
	return `reverted ${n} cell${n === 1 ? '' : 's'}`;
}

/**
 * The clean exit: stop the loop, then (with `--revert-on-exit`) revert, then close — `close()` always
 * runs, even when stopping or reverting fails. A failed revert is reported, not thrown.
 */
export async function shutdown(o: {
	handle: { stop(): Promise<void> };
	client: { revert(): Promise<number>; close(): void };
	revertOnExit: boolean;
	print: (line: string) => void;
}): Promise<void> {
	try {
		await o.handle.stop();
		if (o.revertOnExit) {
			try {
				o.print(cells(await o.client.revert()));
			} catch (err) {
				o.print(`revert failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	} finally {
		o.client.close();
	}
}

/** The v2 brain file of this bot on this world (spec §4.6). */
function brainPathOf(cfg: Config, worldUuid: string): string {
	return brainFilePath(cfg.stateRoot, cfg.target.name, worldUuid, cfg.name);
}

/** A State carrying a brain file's persisted fields, as is (no halving: a revert is not a new session). */
function stateOfFile(f: BrainFile): State {
	const s = structuredClone(initialState(PERSONALITIES.pip, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 })) as State;
	return { ...s, relations: f.relations, inventory: f.inventory, builds: f.builds, digs: f.digs, owned: f.owned, explored: Object.fromEntries(f.explored.map((k) => [k, true])) };
}

/**
 * Applies `patch(state)` to the brain file at `path` and writes it back, keeping its `lastAlive` (a revert is not
 * the bot being alive). Returns the load note when there is no usable file.
 */
function rewriteBrainFile(path: string, meta: { worldUuid: string; bot: string }, patch: (s: Readonly<State>) => Patch): string {
	const { file, note } = loadBrainFile(path, meta, Date.now());
	if (!file) return note;
	const store = new Store(stateOfFile(file), () => 0);
	store.apply(patch(store.state), { kind: 'persist', by: 'revert' });
	new BrainSaver(path, meta, () => file.lastAlive).flush(store.state);
	return 'reconciled';
}

/**
 * The journal entries a `revert(sinceMs)` restores, as the SDK decides (newest first): an entry at or after the
 * cut whose cell still holds its `newId` — read from `blockBefore`, the world before the revert, as each restore
 * changes it. A cell the SDK deferred (a solid block into a kid's body) keeps its deferred entry and every older one
 * in `after`, the journal after the revert: those are not restored.
 */
export function revertedEntries(before: readonly JournalEntry[], after: readonly JournalEntry[], sinceMs: number, blockBefore: (x: number, y: number, z: number) => number): JournalEntry[] {
	const k = (e: JournalEntry) => `${e.x},${e.y},${e.z}`;
	const keptPerCell = new Map<string, number>();
	for (const e of after) if (e.t >= sinceMs) keptPerCell.set(k(e), (keptPerCell.get(k(e)) ?? 0) + 1);
	const totalPerCell = new Map<string, number>();
	for (const e of before) if (e.t >= sinceMs) totalPerCell.set(k(e), (totalPerCell.get(k(e)) ?? 0) + 1);
	const seen = new Map<string, number>();
	const cur = new Map<string, number>();
	const out: JournalEntry[] = [];
	for (let i = before.length - 1; i >= 0; i--) {
		const e = before[i];
		if (e.t < sinceMs) continue;
		const key = k(e);
		const nth = (seen.get(key) ?? 0) + 1;
		seen.set(key, nth);
		if (nth > (totalPerCell.get(key) ?? 0) - (keptPerCell.get(key) ?? 0)) continue;   // deferred, or older than it
		const v = cur.has(key) ? cur.get(key)! : blockBefore(e.x, e.y, e.z);
		if (v !== e.newId) continue;
		cur.set(key, e.oldId);
		out.push(e);
	}
	return out;
}

/**
 * `revert` with a v2 brain file (spec §4.6): the journal is read BEFORE reverting (after, it no longer holds what
 * was undone), then `client.revert`, then the brain file's inventory, `owned`, builds and digs are reconciled.
 */
export async function revertAndReconcile(client: BotClient, path: string, meta: { worldUuid: string; bot: string }, sinceMs = -Infinity): Promise<{ n: number; note: string }> {
	const before = client.journal();
	const snap = new Map<string, number>();
	for (const e of before) if (e.t >= sinceMs) snap.set(`${e.x},${e.y},${e.z}`, client.world.getBlock(e.x, e.y, e.z));
	const n = await client.revert(sinceMs);
	const entries = revertedEntries(before, client.journal(), sinceMs, (x, y, z) => snap.get(`${x},${y},${z}`) ?? 0);
	const note = existsSync(path) ? rewriteBrainFile(path, meta, (s) => reconcileRevert(s, entries, (v) => client.world.blockName(v))) : 'no brain file';
	return { n, note };
}

/** How long `revert --builds` waits for an online kid's first position (he may have just joined). */
const KID_POSE_WAIT_MS = 3000;

/**
 * `revert --builds` (spec §4.6): every cell of the brain file's builds that is still the bot's (it holds the block
 * the bot wrote) gets its journal `oldId` back, one write per edit gap; then the file is reconciled and those builds
 * are `reverted`. Cells with no journal entry are left alone (their old block is unknown). A cell within an online
 * kid's body buffer (read again before each cell) is skipped: a kid who re-placed the same block there while the bot
 * was offline can't be told apart from the bot's. An online kid with no position yet (waited for up to 3 s) stops
 * it before any write.
 */
async function revertBuilds(client: BotClient, path: string, meta: { worldUuid: string; bot: string }, sleep: (ms: number) => Promise<void>): Promise<{ n: number; note: string }> {
	const { file, note } = loadBrainFile(path, meta, Date.now());
	if (!file) return { n: 0, note };
	const unposed = () => client.players().filter((p) => !p.bot && !p.hasPos);
	for (let waited = 0; unposed().length > 0 && waited < KID_POSE_WAIT_MS; waited += 100) await sleep(100);
	const still = unposed();
	if (still.length > 0) return { n: 0, note: `untouched: ${still.map((p) => p.name).join(', ')} online with no position yet; try again` };
	const kids = () => client.players().filter((p) => !p.bot).map((p) => ({ x: p.x, y: p.y, z: p.z }));
	const journal = client.journal();
	const latest = (x: number, y: number, z: number) => {
		for (let i = journal.length - 1; i >= 0; i--) if (journal[i].x === x && journal[i].y === y && journal[i].z === z) return journal[i];
		return undefined;
	};
	const w = client.world;
	const done: JournalEntry[] = [];
	const visited = new Set<string>();
	let skipped = 0;
	for (const b of file.builds) {
		for (const { cell: c } of b.cells) {
			const key = `${c.x},${c.y},${c.z}`;
			if (visited.has(key)) continue;
			visited.add(key);
			const mine = file.owned[key];
			const e = latest(c.x, c.y, c.z);
			if (mine === undefined || w.getBlock(c.x, c.y, c.z) !== mine || !e || e.newId !== mine) continue;
			if (forbiddenByKids(c, kids())) {
				skipped++;
				continue;
			}
			if (done.length > 0) await sleep(LIMITS.EDIT_GAP_MIN_MS);
			let ok = await client.break(c.x, c.y, c.z);
			const old = e.oldId !== 0 ? w.blockName(e.oldId) : null;
			if (ok && old) {
				await sleep(LIMITS.EDIT_GAP_MIN_MS);
				ok = await client.place(c.x, c.y, c.z, old);
			}
			if (ok) done.push({ x: c.x, y: c.y, z: c.z, oldId: e.oldId, newId: mine, t: Date.now() });
		}
	}
	const reconciled = rewriteBrainFile(path, meta, (s) => reconcileRevert(s, done, (v) => w.blockName(v)));
	return { n: done.length, note: skipped > 0 ? `${reconciled}; ${skipped} cell(s) beside an online kid left alone` : reconciled };
}

async function revertCommand(cfg: Config, deps: CliDeps): Promise<void> {
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	try {
		const path = brainPathOf(cfg, prepared.listing.uuid);
		const meta = { worldUuid: prepared.listing.uuid, bot: cfg.name };
		if (cfg.revertBuilds) {
			const r = await revertBuilds(client, path, meta, deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))));
			deps.print(`${cells(r.n)} of its builds; brain file ${r.note}`);
		} else if (existsSync(path)) {
			const r = await revertAndReconcile(client, path, meta);
			deps.print(`${cells(r.n)}; brain file ${r.note}`);
		} else {
			deps.print(cells(await client.revert()));
		}
	} finally {
		client.close();
	}
}

/** The TUI's poke (spec §8): none against a live target, so the `p` key is refused there. */
export function pokeFor(live: boolean, store: Store, clock: () => number): ((p: Poke) => void) | undefined {
	if (live) return undefined;
	return (p) => applyPoke(store, p, clock());
}

/**
 * `--brain v2` (spec §10 step 2): runBrain2 with code engines only (part 2 adds Laya and the LLM). Runs until
 * SIGINT/SIGTERM or the connection closes; the brain file is flushed on the way out, and `--revert-on-exit`
 * reconciles it with what the revert undid.
 */
async function companionV2(cfg: Config, deps: CliDeps): Promise<void> {
	// Experiment E2: --jev needs the key up front (read at runtime, never printed).
	let jev: Jev | null = null;
	if (cfg.jev) {
		const key = JEV_ENV_FILES.map((f) => parseJevKey(deps.readFile(f))).find((k) => k) ?? null;
		if (!key) throw new ConfigError(`--jev: no JEV_API_KEY in ${JEV_ENV_FILES.join(' or ')}`);
		jev = new Jev({ key, fetchImpl: deps.fetchImpl ?? fetch });
	}
	const engineName = jev ? 'jev' : 'code';
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);
	const uuid = prepared.listing.uuid;
	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logDir = resolve(deps.stateRoot, 'logs', cfg.target.name, uuid);
	// Past 50 MB the session continues in <bot>-<stamp>-<n>.jsonl (rotation keeps the newest 20 files).
	const logFile = logFileWriter({ dir: logDir, base: `${cfg.name}-${stamp}` });
	const logPath = logFile.path;
	const brainFile = brainPathOf(cfg, uuid);
	const meta = { worldUuid: uuid, bot: cfg.name };
	deps.print(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; brain v2 (${cfg.personality}, ${engineName} engines); log ${logPath}; brain file ${brainFile}`);
	// A monotonic ms clock on the wall's scale: brain2 times never jump with the system clock.
	const t0 = Date.now() - performance.now();
	const clock = () => t0 + performance.now();
	// The TUI's last select and expert feed, from the log as it is written.
	let lastSelect: Extract<LogLine, { k: 'select' }> | null = null;
	let calls: Array<Extract<LogLine, { k: 'call' }>> = [];
	const handle: Brain2Handle = runBrain2({
		when: cfg.when,
		port, clock, wall: () => Date.now(), rng: seededRng(seed), seed,
		personality: PERSONALITIES[cfg.personality], statePaths: { brainFile, logDir },
		meta: { ...meta, target: cfg.target.name, live: cfg.target.live }, world: { seed: client.world.seed, gen: client.world.gen },
		engines: () => ({ laya: null, llm: null, jev }), jev: !!jev, noEdits: cfg.noEdits,
		logWrite: (line) => {
			logFile.write(line);
			if (cfg.tui && (line.startsWith('{"k":"select"') || line.startsWith('{"k":"call"'))) {
				const l = JSON.parse(line) as LogLine;
				if (l.k === 'select') lastSelect = l;
				else if (l.k === 'call') calls = [...calls, l].slice(-8);
			}
		},
		// With the TUI up, status lines would scroll it away: the view shows the same.
		status: cfg.tui ? undefined : (line) => deps.print(`[${new Date().toISOString()}] ${line}`),
	});
	// An unattended night: a stray rejection is logged and the bot goes on; an uncaught exception is logged, the brain
	// file flushed, and the process exits 1. Both are removed on a normal stop.
	const removeGuards = installCrashGuards({ event: (kind, data) => handle.event(kind, data), flush: () => handle.flush(), print: deps.print });
	let stopTui: (() => void) | null = null;
	if (cfg.tui) {
		stopTui = startTui({
			model: () => ({ state: handle.store.state, lanes: handle.scheduler.lanes(), health: null, lastSelect, calls, now: clock(), world: prepared.listing.name, engines: engineName }),
			poke: pokeFor(cfg.target.live, handle.store, clock),
			quit: () => onSignal('quit'),
			kid: () => port.body.players().find((p) => !p.bot)?.name,
		});
	}
	const stopAll = async (): Promise<void> => {
		try {
			await handle.stop();
			if (cfg.revertOnExit) {
				try {
					const r = await revertAndReconcile(client, brainFile, meta);
					deps.print(`${cells(r.n)}; brain file ${r.note}`);
				} catch (err) {
					deps.print(`revert failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		} finally {
			client.close();
		}
	};
	let exiting = false;
	const onSigint = (): void => onSignal('SIGINT');
	const onSigterm = (): void => onSignal('SIGTERM');
	const unhook = (): void => {
		removeGuards();
		process.off('SIGINT', onSigint);
		process.off('SIGTERM', onSigterm);
	};
	function onSignal(signal: string): void {
		if (exiting) {
			deps.print(`${signal} again: exiting now`);
			process.exit(130);
		}
		exiting = true;
		stopTui?.();
		stopTui = null;
		deps.print(`${signal}: stopping`);
		// Once the clean stop is done (armed then, not at the signal: --revert-on-exit can take longer than 5 s),
		// something (a socket, a timer) may still keep the event loop alive: exit anyway after 5 s.
		stopAll().then(
			() => {
				deps.print('stopped; brain file flushed');
				unhook();
				armHardExit();
			},
			(err: unknown) => {
				deps.print(`stop failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
				unhook();
				armHardExit(undefined, () => process.exit(1));
			},
		);
	}
	process.on('SIGINT', onSigint);
	process.on('SIGTERM', onSigterm);
	client.on('close', (code) => {
		if (exiting) return;
		exiting = true;
		stopTui?.();
		deps.print(`connection closed (${code})`);
		void handle.stop().finally(() => {
			unhook();
			process.exit(code === 1000 ? 0 : 1);
		});
	});
}

async function companionCommand(cfg: Config, deps: CliDeps): Promise<void> {
	if (cfg.brain === 'v2') return companionV2(cfg, deps);
	const brain = buildBrain(cfg.brain, cfg.brains, deps.fetchImpl ?? fetch);
	if (brain && !(await brain.health())) {
		throw new ConfigError(brainHealthMessage(cfg.brain as 'laya' | 'clm'));
	}
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);

	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(deps.stateRoot, 'logs', cfg.target.name, prepared.listing.uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const log = jsonlLogger((line) => appendFileSync(logPath, line), seed, () => Date.now());
	deps.print(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; brain ${cfg.brain}; log ${logPath}`);

	const handle = runCompanion({
		body: port.body,
		world: port.world,
		brain,
		config: { companion: cfg.companion, noEdits: cfg.noEdits, brainTimeoutMs: cfg.brains[cfg.brain]?.timeoutMs ?? 400, name: cfg.name },
		log,
		clock: () => Date.now(),
		rng: seededRng(seed),
		seed,
		status: deps.print,
	});

	let exiting = false;
	const onSignal = (signal: string): void => {
		if (exiting) {
			// A second Ctrl-C: don't wait for the clean exit.
			deps.print(`${signal} again: exiting now`);
			process.exit(130);
		}
		exiting = true;
		deps.print(`${signal}: stopping`);
		void shutdown({ handle, client, revertOnExit: cfg.revertOnExit, print: deps.print });
	};
	process.on('SIGINT', () => onSignal('SIGINT'));
	process.on('SIGTERM', () => onSignal('SIGTERM'));
	client.on('close', (code) => {
		if (exiting) return;
		deps.print(`connection closed (${code})`);
		void handle.stop().then(() => process.exit(code === 1000 ? 0 : 1));
	});
}

/** Where JEV_API_KEY lives: this checkout's .env, else the main Minicraft checkout's (worktrees have none). Read at
 *  runtime only, never printed. */
const JEV_ENV_FILES = [resolve(BOTS_DIR, '..', '.env'), resolve(homedir(), 'Projects', 'Minicraft', '.env')];

/**
 * `builder` (the builder bot): only builds, unlimited blocks. `--brain laya|jev` picks the primary engine (default
 * laya); `--compare` also asks the other one. A down engine is not a refusal: every question falls back to the
 * heuristic. Runs until SIGINT/SIGTERM or the connection closes.
 */
async function builderCommand(cfg: Config, deps: CliDeps): Promise<void> {
	if (cfg.brain !== 'laya' && cfg.brain !== 'jev') throw new ConfigError(`builder: --brain must be laya or jev, not "${cfg.brain}"`);
	const fetchImpl = deps.fetchImpl ?? fetch;
	const laya = (): ChoiceEngine => layaEngine(cfg.brains.laya.url, fetchImpl, cfg.brains.laya.timeoutMs);
	const jev = (): ChoiceEngine | null => {
		const key = JEV_ENV_FILES.map((f) => parseJevKey(deps.readFile(f))).find((k) => k) ?? null;
		if (!key) deps.print(`jev: no JEV_API_KEY in ${JEV_ENV_FILES.join(' or ')}; jev questions fall back`);
		return key ? jevEngine(key, fetchImpl) : null;
	};
	const primary = cfg.brain === 'jev' ? jev() : laya();
	const secondary = cfg.compare ? (cfg.brain === 'jev' ? laya() : jev()) : null;
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);
	const uuid = prepared.listing.uuid;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(deps.stateRoot, 'logs', cfg.target.name, uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const statePath = builderStatePath(deps.stateRoot, cfg.target.name, uuid, cfg.name);
	const sp = worldSpawn(client.world.seed, client.world.gen);
	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	deps.print(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; builder (${primary?.name ?? 'no engine'}${secondary ? ` + ${secondary.name} compare` : ''})${cfg.noEdits ? ' --no-edits' : ''}; log ${logPath}; state ${statePath}`);
	const handle = runBuilder({
		when: cfg.when,
		name: cfg.name, body: port.body, world: port.world, spawn: { x: sp.x, y: 0, z: sp.z }, primary, secondary,
		noEdits: cfg.noEdits, statePath, rng: seededRng(seed), known: new Set(blockNames()), restMs: deps.builderRestMs ?? cfg.restSec * 1000, maxBuilds: cfg.maxBuilds,
		planPath: planFilePath(deps.stateRoot, cfg.target.name, uuid), joinPlan: cfg.joinPlan,
		shared: new SharedCells(sharedCellsPath(deps.stateRoot, cfg.target.name, uuid), cfg.name),
		log: (o) => {
			try {
				appendFileSync(logPath, `${JSON.stringify(o)}\n`);
			} catch {
				// a full disk must not stop the bot
			}
		},
		status: (line) => deps.print(`[${new Date().toISOString()}] ${line}`),
	});
	deps.onBuilder?.(handle, client);
	const removeGuards = deps.onBuilder ? () => undefined : installCrashGuards({
		event: (kind, data) => {
			try {
				appendFileSync(logPath, `${JSON.stringify({ k: kind, t: Date.now(), data })}\n`);
			} catch {
				// ignore
			}
		},
		flush: () => saveBuilderFile(statePath, handle.file),
		print: deps.print,
	});
	let exiting = false;
	const onSignal = (signal: string): void => {
		if (exiting) {
			deps.print(`${signal} again: exiting now`);
			process.exit(130);
		}
		exiting = true;
		deps.print(`${signal}: stopping`);
		void Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => {
			client.close();
			removeGuards();
			deps.print('stopped');
			armHardExit();
		});
	};
	if (!deps.onBuilder) {
		process.on('SIGINT', () => onSignal('SIGINT'));
		process.on('SIGTERM', () => onSignal('SIGTERM'));
		client.on('close', (code) => {
			if (exiting) return;
			exiting = true;
			deps.print(`connection closed (${code})`);
			void handle.stop().finally(() => process.exit(code === 1000 ? 0 : 1));
		});
	}
}

/**
 * `decorator` (the decorator bot): decorates around the builder bots' builds (all bots' records of this world), with
 * unlimited blocks. Same engines (`--brain laya|jev`, `--compare`), safety and signals as `builder`.
 */
async function decoratorCommand(cfg: Config, deps: CliDeps): Promise<void> {
	if (cfg.brain !== 'laya' && cfg.brain !== 'jev') throw new ConfigError(`decorator: --brain must be laya or jev, not "${cfg.brain}"`);
	const fetchImpl = deps.fetchImpl ?? fetch;
	const laya = (): ChoiceEngine => layaEngine(cfg.brains.laya.url, fetchImpl, cfg.brains.laya.timeoutMs);
	const jev = (): ChoiceEngine | null => {
		const key = JEV_ENV_FILES.map((f) => parseJevKey(deps.readFile(f))).find((k) => k) ?? null;
		if (!key) deps.print(`jev: no JEV_API_KEY in ${JEV_ENV_FILES.join(' or ')}; jev questions fall back`);
		return key ? jevEngine(key, fetchImpl) : null;
	};
	const primary = cfg.brain === 'jev' ? jev() : laya();
	const secondary = cfg.compare ? (cfg.brain === 'jev' ? laya() : jev()) : null;
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);
	const uuid = prepared.listing.uuid;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(deps.stateRoot, 'logs', cfg.target.name, uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const statePath = decoratorStatePath(deps.stateRoot, cfg.target.name, uuid, cfg.name);
	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	deps.print(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; decorator (${primary?.name ?? 'no engine'}${secondary ? ` + ${secondary.name} compare` : ''})${cfg.noEdits ? ' --no-edits' : ''}; log ${logPath}; state ${statePath}`);
	const handle = runDecorator({
		when: cfg.when,
		name: cfg.name, body: port.body, world: port.world, primary, secondary, noEdits: cfg.noEdits, statePath,
		builderDir: builderDir(deps.stateRoot, cfg.target.name, uuid), rng: seededRng(seed), known: new Set(blockNames()),
		restMs: deps.builderRestMs ?? cfg.restSec * 1000, shared: new SharedCells(sharedCellsPath(deps.stateRoot, cfg.target.name, uuid), cfg.name), maxDecorations: cfg.maxDecorations,
		log: (o) => {
			try {
				appendFileSync(logPath, `${JSON.stringify(o)}\n`);
			} catch {
				// a full disk must not stop the bot
			}
		},
		status: (line) => deps.print(`[${new Date().toISOString()}] ${line}`),
	});
	deps.onDecorator?.(handle, client);
	if (deps.onDecorator) return;
	const removeGuards = installCrashGuards({
		event: (kind, data) => {
			try {
				appendFileSync(logPath, `${JSON.stringify({ k: kind, t: Date.now(), data })}\n`);
			} catch {
				// ignore
			}
		},
		flush: () => saveDecoratorFile(statePath, handle.file),
		print: deps.print,
	});
	let exiting = false;
	const onSignal = (signal: string): void => {
		if (exiting) {
			deps.print(`${signal} again: exiting now`);
			process.exit(130);
		}
		exiting = true;
		deps.print(`${signal}: stopping`);
		void Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => {
			client.close();
			removeGuards();
			deps.print('stopped');
			armHardExit();
		});
	};
	process.on('SIGINT', () => onSignal('SIGINT'));
	process.on('SIGTERM', () => onSignal('SIGTERM'));
	client.on('close', (code) => {
		if (exiting) return;
		exiting = true;
		deps.print(`connection closed (${code})`);
		void handle.stop().finally(() => process.exit(code === 1000 ? 0 : 1));
	});
}

/**
 * `village` (the village planner bot): plans a village near the nearest kid or spawn (the model picks the theme and
 * the layout), builds it lot by lot with the builder's move loop, then paths and lamps. Same engines (`--brain
 * laya|jev`, `--compare`), safety and signals as `builder`; the plan persists, so a restart resumes it.
 */
async function villageCommand(cfg: Config, deps: CliDeps): Promise<void> {
	if (cfg.brain !== 'laya' && cfg.brain !== 'jev') throw new ConfigError(`village: --brain must be laya or jev, not "${cfg.brain}"`);
	const fetchImpl = deps.fetchImpl ?? fetch;
	const laya = (): ChoiceEngine => layaEngine(cfg.brains.laya.url, fetchImpl, cfg.brains.laya.timeoutMs);
	const jev = (): ChoiceEngine | null => {
		const key = JEV_ENV_FILES.map((f) => parseJevKey(deps.readFile(f))).find((k) => k) ?? null;
		if (!key) deps.print(`jev: no JEV_API_KEY in ${JEV_ENV_FILES.join(' or ')}; jev questions fall back`);
		return key ? jevEngine(key, fetchImpl) : null;
	};
	const primary = cfg.brain === 'jev' ? jev() : laya();
	const secondary = cfg.compare ? (cfg.brain === 'jev' ? laya() : jev()) : null;
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);
	const uuid = prepared.listing.uuid;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(deps.stateRoot, 'logs', cfg.target.name, uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const statePath = villageStatePath(deps.stateRoot, cfg.target.name, uuid, cfg.name);
	const sp = worldSpawn(client.world.seed, client.world.gen);
	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	deps.print(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; village (${primary?.name ?? 'no engine'}${secondary ? ` + ${secondary.name} compare` : ''})${cfg.noEdits ? ' --no-edits' : ''}; log ${logPath}; state ${statePath}`);
	const handle = runVillage({
		when: cfg.when,
		name: cfg.name, body: port.body, world: port.world, spawn: { x: sp.x, y: 0, z: sp.z }, primary, secondary,
		noEdits: cfg.noEdits, statePath, builderDir: builderDir(deps.stateRoot, cfg.target.name, uuid), rng: seededRng(seed),
		known: new Set(blockNames()), restMs: deps.builderRestMs ?? cfg.restSec * 1000,
		planPath: planFilePath(deps.stateRoot, cfg.target.name, uuid),
		shared: new SharedCells(sharedCellsPath(deps.stateRoot, cfg.target.name, uuid), cfg.name),
		log: (o) => {
			try {
				appendFileSync(logPath, `${JSON.stringify(o)}\n`);
			} catch {
				// a full disk must not stop the bot
			}
		},
		status: (line) => deps.print(`[${new Date().toISOString()}] ${line}`),
	});
	deps.onVillage?.(handle, client);
	if (deps.onVillage) return;
	const removeGuards = installCrashGuards({
		event: (kind, data) => {
			try {
				appendFileSync(logPath, `${JSON.stringify({ k: kind, t: Date.now(), data })}\n`);
			} catch {
				// ignore
			}
		},
		flush: () => saveVillageFile(statePath, handle.file),
		print: deps.print,
	});
	let exiting = false;
	const onSignal = (signal: string): void => {
		if (exiting) {
			deps.print(`${signal} again: exiting now`);
			process.exit(130);
		}
		exiting = true;
		deps.print(`${signal}: stopping`);
		void Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => {
			client.close();
			removeGuards();
			deps.print('stopped');
			armHardExit();
		});
	};
	process.on('SIGINT', () => onSignal('SIGINT'));
	process.on('SIGTERM', () => onSignal('SIGTERM'));
	client.on('close', (code) => {
		if (exiting) return;
		exiting = true;
		deps.print(`connection closed (${code})`);
		void handle.stop().finally(() => process.exit(code === 1000 ? 0 : 1));
	});
}

/**
 * `helper` (experiment E5): when a kid is building, builds a small matching structure 4–8 blocks from his build with
 * his blocks, facing him; otherwise idles near spawn. Same engines (`--brain laya|jev`, `--compare`), safety, shared
 * bot-cell registry and signals as `builder`.
 */
async function helperCommand(cfg: Config, deps: CliDeps): Promise<void> {
	if (cfg.brain !== 'laya' && cfg.brain !== 'jev') throw new ConfigError(`helper: --brain must be laya or jev, not "${cfg.brain}"`);
	const fetchImpl = deps.fetchImpl ?? fetch;
	const laya = (): ChoiceEngine => layaEngine(cfg.brains.laya.url, fetchImpl, cfg.brains.laya.timeoutMs);
	const jev = (): ChoiceEngine | null => {
		const key = JEV_ENV_FILES.map((f) => parseJevKey(deps.readFile(f))).find((k) => k) ?? null;
		if (!key) deps.print(`jev: no JEV_API_KEY in ${JEV_ENV_FILES.join(' or ')}; jev questions fall back`);
		return key ? jevEngine(key, fetchImpl) : null;
	};
	const primary = cfg.brain === 'jev' ? jev() : laya();
	const secondary = cfg.compare ? (cfg.brain === 'jev' ? laya() : jev()) : null;
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);
	const uuid = prepared.listing.uuid;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(deps.stateRoot, 'logs', cfg.target.name, uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const statePath = helperStatePath(deps.stateRoot, cfg.target.name, uuid, cfg.name);
	const sp = worldSpawn(client.world.seed, client.world.gen);
	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	deps.print(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; helper (${primary?.name ?? 'no engine'}${secondary ? ` + ${secondary.name} compare` : ''})${cfg.noEdits ? ' --no-edits' : ''}; log ${logPath}; state ${statePath}`);
	const handle = runHelper({
		when: cfg.when,
		name: cfg.name, body: port.body, world: port.world, spawn: { x: sp.x, y: 0, z: sp.z }, primary, secondary,
		noEdits: cfg.noEdits, statePath, rng: seededRng(seed),
		known: new Set(blockNames()), restMs: deps.builderRestMs ?? cfg.restSec * 1000, maxBuilds: cfg.maxBuilds,
		shared: new SharedCells(sharedCellsPath(deps.stateRoot, cfg.target.name, uuid), cfg.name),
		log: (o) => {
			try {
				appendFileSync(logPath, `${JSON.stringify(o)}\n`);
			} catch {
				// a full disk must not stop the bot
			}
		},
		status: (line) => deps.print(`[${new Date().toISOString()}] ${line}`),
	});
	deps.onHelper?.(handle, client);
	if (deps.onHelper) return;
	const removeGuards = installCrashGuards({
		event: (kind, data) => {
			try {
				appendFileSync(logPath, `${JSON.stringify({ k: kind, t: Date.now(), data })}\n`);
			} catch {
				// ignore
			}
		},
		flush: () => saveBuilderFile(statePath, handle.file),
		print: deps.print,
	});
	let exiting = false;
	const onSignal = (signal: string): void => {
		if (exiting) {
			deps.print(`${signal} again: exiting now`);
			process.exit(130);
		}
		exiting = true;
		deps.print(`${signal}: stopping`);
		void Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => {
			client.close();
			removeGuards();
			deps.print('stopped');
			armHardExit();
		});
	};
	process.on('SIGINT', () => onSignal('SIGINT'));
	process.on('SIGTERM', () => onSignal('SIGTERM'));
	client.on('close', (code) => {
		if (exiting) return;
		exiting = true;
		deps.print(`connection closed (${code})`);
		void handle.stop().finally(() => process.exit(code === 1000 ? 0 : 1));
	});
}

/**
 * `architect` (experiment E6): designs its own structures (parametric generators; the model picks the idea, theme,
 * size and style; `--llm-params`: Ollama proposes the numbers) and builds them with the builder's move loop. Same
 * engines (`--brain laya|jev`, `--compare`), safety, shared bot-cell registry and signals as `builder`; its builds
 * live in the builder's state directory.
 */
async function architectCommand(cfg: Config, deps: CliDeps): Promise<void> {
	if (cfg.brain !== 'laya' && cfg.brain !== 'jev') throw new ConfigError(`architect: --brain must be laya or jev, not "${cfg.brain}"`);
	const fetchImpl = deps.fetchImpl ?? fetch;
	const laya = (): ChoiceEngine => layaEngine(cfg.brains.laya.url, fetchImpl, cfg.brains.laya.timeoutMs);
	const jev = (): ChoiceEngine | null => {
		const key = JEV_ENV_FILES.map((f) => parseJevKey(deps.readFile(f))).find((k) => k) ?? null;
		if (!key) deps.print(`jev: no JEV_API_KEY in ${JEV_ENV_FILES.join(' or ')}; jev questions fall back`);
		return key ? jevEngine(key, fetchImpl) : null;
	};
	const primary = cfg.brain === 'jev' ? jev() : laya();
	const secondary = cfg.compare ? (cfg.brain === 'jev' ? laya() : jev()) : null;
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);
	const uuid = prepared.listing.uuid;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(deps.stateRoot, 'logs', cfg.target.name, uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const statePath = builderStatePath(deps.stateRoot, cfg.target.name, uuid, cfg.name);
	const proposer = cfg.llmParams && cfg.llm ? ollamaProposer(cfg.llm.url, cfg.llm.model, fetchImpl, Math.max(cfg.llm.timeoutMs, 8000)) : null;
	const sp = worldSpawn(client.world.seed, client.world.gen);
	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	deps.print(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; architect (${primary?.name ?? 'no engine'}${secondary ? ` + ${secondary.name} compare` : ''}${proposer ? ` + ${proposer.name} params` : ''})${cfg.noEdits ? ' --no-edits' : ''}; log ${logPath}; state ${statePath}`);
	const handle = runArchitect({
		when: cfg.when,
		name: cfg.name, body: port.body, world: port.world, spawn: { x: sp.x, y: 0, z: sp.z }, primary, secondary, proposer,
		noEdits: cfg.noEdits, statePath, builderDir: builderDir(deps.stateRoot, cfg.target.name, uuid), rng: seededRng(seed),
		known: new Set(blockNames()), restMs: deps.builderRestMs ?? cfg.restSec * 1000, maxBuilds: cfg.maxBuilds,
		planPath: planFilePath(deps.stateRoot, cfg.target.name, uuid), joinPlan: cfg.joinPlan,
		shared: new SharedCells(sharedCellsPath(deps.stateRoot, cfg.target.name, uuid), cfg.name),
		log: (o) => {
			try {
				appendFileSync(logPath, `${JSON.stringify(o)}\n`);
			} catch {
				// a full disk must not stop the bot
			}
		},
		status: (line) => deps.print(`[${new Date().toISOString()}] ${line}`),
	});
	deps.onArchitect?.(handle, client);
	if (deps.onArchitect) return;
	const removeGuards = installCrashGuards({
		event: (kind, data) => {
			try {
				appendFileSync(logPath, `${JSON.stringify({ k: kind, t: Date.now(), data })}\n`);
			} catch {
				// ignore
			}
		},
		flush: () => saveBuilderFile(statePath, handle.file),
		print: deps.print,
	});
	let exiting = false;
	const onSignal = (signal: string): void => {
		if (exiting) {
			deps.print(`${signal} again: exiting now`);
			process.exit(130);
		}
		exiting = true;
		deps.print(`${signal}: stopping`);
		void Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => {
			client.close();
			removeGuards();
			deps.print('stopped');
			armHardExit();
		});
	};
	process.on('SIGINT', () => onSignal('SIGINT'));
	process.on('SIGTERM', () => onSignal('SIGTERM'));
	client.on('close', (code) => {
		if (exiting) return;
		exiting = true;
		deps.print(`connection closed (${code})`);
		void handle.stop().finally(() => process.exit(code === 1000 ? 0 : 1));
	});
}

/**
 * `landscaper` (the landscaper bot): mines the ingredients, crafts Flattening TNT by the game's recipes and levels hilly
 * ground near the neighbourhood (or where the board / a kid's red marker asks), posting 'flattened' on the shared board.
 * Same engines (`--brain laya|jev`, `--compare`), signals and `--when` as `builder`; `--max-blasts N` (default 6); `--pickaxe <name>` (hand … emerald: its mining time, and a multi-block tier's area
 * break around each mined cell, each area cell checked by the safety rules); `--grant-ores N` (once per state file).
 */
async function landscaperCommand(cfg: Config, deps: CliDeps): Promise<void> {
	if (cfg.brain !== 'laya' && cfg.brain !== 'jev') throw new ConfigError(`landscaper: --brain must be laya or jev, not "${cfg.brain}"`);
	const fetchImpl = deps.fetchImpl ?? fetch;
	const laya = (): ChoiceEngine => layaEngine(cfg.brains.laya.url, fetchImpl, cfg.brains.laya.timeoutMs);
	const jev = (): ChoiceEngine | null => {
		const key = JEV_ENV_FILES.map((f) => parseJevKey(deps.readFile(f))).find((k) => k) ?? null;
		if (!key) deps.print(`jev: no JEV_API_KEY in ${JEV_ENV_FILES.join(' or ')}; jev questions fall back`);
		return key ? jevEngine(key, fetchImpl) : null;
	};
	const primary = cfg.brain === 'jev' ? jev() : laya();
	const secondary = cfg.compare ? (cfg.brain === 'jev' ? laya() : jev()) : null;
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);
	const uuid = prepared.listing.uuid;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(deps.stateRoot, 'logs', cfg.target.name, uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const statePath = landscaperStatePath(deps.stateRoot, cfg.target.name, uuid, cfg.name);
	const board = boardPath(deps.stateRoot, cfg.target.name, uuid);
	const sp = worldSpawn(client.world.seed, client.world.gen);
	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	const mineMs = deps.landscaperMineMs;
	deps.print(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; landscaper (${primary?.name ?? 'no engine'}${secondary ? ` + ${secondary.name} compare` : ''})${cfg.noEdits ? ' --no-edits' : ''}; board ${board}; log ${logPath}; state ${statePath}`);
	const handle = runLandscaper({
		when: cfg.when,
		name: cfg.name, body: port.body, world: port.world, spawn: { x: sp.x, y: 0, z: sp.z }, primary, secondary,
		noEdits: cfg.noEdits, statePath, boardPath: board, planPath: planFilePath(deps.stateRoot, cfg.target.name, uuid), rng: seededRng(seed),
		restMs: deps.landscaperRestMs ?? (cfg.restSecGiven ? cfg.restSec : LANDSCAPER_REST_SEC) * 1000, maxBlasts: cfg.maxBlasts, areaSize: deps.landscaperAreaSize,
		pickaxe: cfg.pickaxe, grantOres: cfg.grantOres,
		mine: (x, y, z, face) => client.mine(x, y, z, mineMs, { tier: cfg.pickaxe, face }),
		breakMany: (cells) => client.breakMany(cells),
		shared: new SharedCells(sharedCellsPath(deps.stateRoot, cfg.target.name, uuid), cfg.name),
		log: (o) => {
			try {
				appendFileSync(logPath, `${JSON.stringify(o)}\n`);
			} catch {
				// a full disk must not stop the bot
			}
		},
		status: (line) => deps.print(`[${new Date().toISOString()}] ${line}`),
	});
	deps.onLandscaper?.(handle, client);
	if (deps.onLandscaper) return;
	const removeGuards = installCrashGuards({
		event: (kind, data) => {
			try {
				appendFileSync(logPath, `${JSON.stringify({ k: kind, t: Date.now(), data })}\n`);
			} catch {
				// ignore
			}
		},
		flush: () => saveLandscaperFile(statePath, handle.file),
		print: deps.print,
	});
	let exiting = false;
	const onSignal = (signal: string): void => {
		if (exiting) {
			deps.print(`${signal} again: exiting now`);
			process.exit(130);
		}
		exiting = true;
		deps.print(`${signal}: stopping`);
		void Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 8000))]).finally(() => {
			client.close();
			removeGuards();
			deps.print('stopped');
			armHardExit();
		});
	};
	process.on('SIGINT', () => onSignal('SIGINT'));
	process.on('SIGTERM', () => onSignal('SIGTERM'));
	client.on('close', (code) => {
		if (exiting) return;
		exiting = true;
		deps.print(`connection closed (${code})`);
		void handle.stop().finally(() => process.exit(code === 1000 ? 0 : 1));
	});
}

/**
 * `foreman` (experiment E7): lays out one neighbourhood per world (4–10 lots on a road grid) in the shared plan
 * `bots/.state/shared/<target>/<world>/plan.json`, then builds the roads and lamps itself. Builder and architect bots
 * started with `--join-plan` build on its lots. No engine; same safety and signals as `builder`.
 */
async function foremanCommand(cfg: Config, deps: CliDeps): Promise<void> {
	const prepared = await prepare(cfg, deps);
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);
	const uuid = prepared.listing.uuid;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(deps.stateRoot, 'logs', cfg.target.name, uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const statePath = foremanStatePath(deps.stateRoot, cfg.target.name, uuid, cfg.name);
	const planPath = planFilePath(deps.stateRoot, cfg.target.name, uuid);
	const sp = worldSpawn(client.world.seed, client.world.gen);
	const seed = (Date.now() ^ (process.pid << 16)) >>> 0;
	deps.print(`${cfg.name} joined "${prepared.listing.name}" as ${prepared.skin}; foreman${cfg.noEdits ? ' --no-edits' : ''}; plan ${planPath}; log ${logPath}; state ${statePath}`);
	const handle = runForeman({
		when: cfg.when,
		name: cfg.name, body: port.body, world: port.world, spawn: { x: sp.x, y: 0, z: sp.z },
		noEdits: cfg.noEdits, statePath, planPath, builderDir: builderDir(deps.stateRoot, cfg.target.name, uuid), rng: seededRng(seed),
		boardPath: boardPath(deps.stateRoot, cfg.target.name, uuid),
		paceMs: deps.foremanPaceMs, shared: new SharedCells(sharedCellsPath(deps.stateRoot, cfg.target.name, uuid), cfg.name),
		log: (o) => {
			try {
				appendFileSync(logPath, `${JSON.stringify(o)}\n`);
			} catch {
				// a full disk must not stop the bot
			}
		},
		status: (line) => deps.print(`[${new Date().toISOString()}] ${line}`),
	});
	deps.onForeman?.(handle, client);
	if (deps.onForeman) return;
	const removeGuards = installCrashGuards({
		event: (kind, data) => {
			try {
				appendFileSync(logPath, `${JSON.stringify({ k: kind, t: Date.now(), data })}\n`);
			} catch {
				// ignore
			}
		},
		flush: () => saveForemanFile(statePath, handle.file),
		print: deps.print,
	});
	let exiting = false;
	const onSignal = (signal: string): void => {
		if (exiting) {
			deps.print(`${signal} again: exiting now`);
			process.exit(130);
		}
		exiting = true;
		deps.print(`${signal}: stopping`);
		void Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => {
			client.close();
			removeGuards();
			deps.print('stopped');
			armHardExit();
		});
	};
	process.on('SIGINT', () => onSignal('SIGINT'));
	process.on('SIGTERM', () => onSignal('SIGTERM'));
	client.on('close', (code) => {
		if (exiting) return;
		exiting = true;
		deps.print(`connection closed (${code})`);
		void handle.stop().finally(() => process.exit(code === 1000 ? 0 : 1));
	});
}

export async function main(argv: readonly string[], deps: CliDeps = DEFAULT_DEPS): Promise<void> {
	const { command, flags } = parseCommand(argv);
	const cfg = loadConfig({ argv: flags, env: deps.env, readFile: deps.readFile, homedir, stateRoot: deps.stateRoot });
	if (command === 'revert') await revertCommand(cfg, deps);
	else if (command === 'builder') await builderCommand(cfg, deps);
	else if (command === 'decorator') await decoratorCommand(cfg, deps);
	else if (command === 'village') await villageCommand(cfg, deps);
	else if (command === 'helper') await helperCommand(cfg, deps);
	else if (command === 'architect') await architectCommand(cfg, deps);
	else if (command === 'foreman') await foremanCommand(cfg, deps);
	else if (command === 'landscaper') await landscaperCommand(cfg, deps);
	else await companionCommand(cfg, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
}
