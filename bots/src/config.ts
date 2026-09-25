/**
 * Pure, fully injected config and CLI parsing (spec §4, §12a). Nothing here reads the real
 * filesystem or environment: `loadConfig` and `checkLiveAck` take `readFile`/`writeFile`/`homedir`/
 * `now` as plain functions, injected by the caller (cli.ts in real use, fakes in tests). The only
 * non-injected input is `bots/bots.config.ts`'s default export, a static, committed data literal
 * with no secrets — callers (tests) may still override it via `config`.
 */
import defaultBotsConfig from '../bots.config.js';
import { parseArgs } from './cli-args.js';
import type { WorldListing } from 'minicraft-bot';

/** Thrown by `loadConfig`, and returned (not thrown) by the other functions here. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

export interface TargetDef {
	url: string;
	/** A static token (local/dev/test targets). Mutually exclusive with `tokenEnv`/`tokenFile`. */
	token?: string;
	/** The env var carrying the live token (checked first). */
	tokenEnv?: string;
	/** A token file path (`~` expanded via the injected `homedir`), read only if `tokenEnv` misses. */
	tokenFile?: string;
}

export interface BrainDef {
	url: string;
	health: string;
	home: string;
	start: string[];
	timeoutMs: number;
	experimental?: boolean;
}

export interface CompanionTuning {
	tickMs: number;
	editEveryMs: number;
	editBudget: number;
	followDist: number;
	minConfidence: number;
	stopMs: number;
	wanderTether: number;
	statusEveryMs: number;
	idleSwitchMs: number;
	minTargetMs: number;
}

/** The shape of `bots/bots.config.ts`'s default export. */
export interface BotsConfigData {
	targets: Record<string, TargetDef>;
	brains: Record<string, BrainDef>;
	companion: CompanionTuning;
}

const DEFAULT_BOTS_CONFIG = defaultBotsConfig as BotsConfigData;

export type BrainName = 'laya' | 'clm' | 'scripted';

export interface Config {
	target: { name: string; url: string; token: string };
	worldArg?: string;
	name: string;
	skin?: string;
	brain: BrainName;
	noEdits: boolean;
	revertOnExit: boolean;
	ackLive: boolean;
	companion: CompanionTuning;
	brains: Record<string, BrainDef>;
	/** Where `.state` lives for this run (injected, defaulted in cli.ts only). */
	stateRoot: string;
	statePath(worldUuid: string): string;
}

export interface LoadConfigInput {
	argv: readonly string[];
	env: Record<string, string | undefined>;
	readFile(path: string): string | null;
	homedir(): string;
	stateRoot: string;
	/** Overrides `bots.config.ts`'s default export. Tests use this to inject synthetic targets
	 *  (e.g. `targets.test = { url, token }`) without touching the real ports or live URL. */
	config?: BotsConfigData;
}

const ENV_LIVE_TOKEN_FILE = '.env.live';
const DEFAULT_ENV_KEY = 'MC_LIVE_TOKEN';

function expandHome(path: string, homedir: () => string): string {
	if (path === '~') return homedir();
	if (path.startsWith('~/')) return `${homedir()}${path.slice(1)}`;
	return path;
}

/** Refuses any target on port 8080 — the live mcserver's port on this desktop (see spec §4). */
export function assertNotPort8080(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ConfigError(`invalid target url: ${url}`);
	}
	if (parsed.port === '8080') {
		throw new ConfigError(`target url "${url}" uses port 8080, which is reserved for the live multiplayer server on this desktop — refused`);
	}
}

function parseEnvFileValue(content: string, key: string): string | undefined {
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		if (line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
	}
	return undefined;
}

/** Resolves a target's token. The live token file/env is read only for targets that need it
 *  (no static `token`) — never for local/test targets with a static one. */
function resolveToken(targetDef: TargetDef, env: Record<string, string | undefined>, readFile: (path: string) => string | null, homedir: () => string): string | ConfigError {
	if (targetDef.token) return targetDef.token;

	const envKey = targetDef.tokenEnv ?? DEFAULT_ENV_KEY;
	const fromEnv = env[envKey];
	if (fromEnv) return fromEnv;

	const envFile = readFile(ENV_LIVE_TOKEN_FILE);
	if (envFile) {
		const fromEnvFile = parseEnvFileValue(envFile, envKey);
		if (fromEnvFile) return fromEnvFile;
	}

	if (targetDef.tokenFile) {
		const expanded = expandHome(targetDef.tokenFile, homedir);
		const fromFile = readFile(expanded);
		if (fromFile && fromFile.trim()) return fromFile.trim();
	}

	return new ConfigError(`no live token found for this target: set ${envKey}, put it in bots/${ENV_LIVE_TOKEN_FILE}, or deploy one to ${targetDef.tokenFile ?? '(no token file configured)'}`);
}

const BRAIN_NAMES: readonly BrainName[] = ['laya', 'clm', 'scripted'];

/** Builds a `Config` from fully injected inputs. Throws `ConfigError` with a human message. */
export function loadConfig(input: LoadConfigInput): Config {
	const { argv, env, readFile, homedir, stateRoot } = input;
	const botsConfig = input.config ?? DEFAULT_BOTS_CONFIG;
	const args = parseArgs(argv);

	if (!args.target) {
		throw new ConfigError(`missing --target; available: ${Object.keys(botsConfig.targets).join(', ')}`);
	}
	const targetDef = botsConfig.targets[args.target];
	if (!targetDef) {
		throw new ConfigError(`unknown --target "${args.target}"; available: ${Object.keys(botsConfig.targets).join(', ')}`);
	}

	assertNotPort8080(targetDef.url);

	const token = resolveToken(targetDef, env, readFile, homedir);
	if (token instanceof ConfigError) throw token;

	const brain = (args.brain ?? 'laya') as BrainName;
	if (!BRAIN_NAMES.includes(brain)) {
		throw new ConfigError(`unknown --brain "${args.brain}"; expected one of ${BRAIN_NAMES.join(', ')}`);
	}

	const targetName = args.target;
	const name = args.name ?? 'Bot';

	return {
		target: { name: targetName, url: targetDef.url, token },
		worldArg: args.world,
		name,
		skin: args.skin,
		brain,
		noEdits: args.noEdits,
		revertOnExit: args.revertOnExit,
		ackLive: args.iDeployedTheServer,
		companion: botsConfig.companion,
		brains: botsConfig.brains,
		stateRoot,
		statePath(worldUuid: string): string {
			return `${stateRoot}/${targetName}/${worldUuid}/${name}.json`;
		},
	};
}

export interface CheckLiveAckInput {
	cfg: Config;
	worldUuid: string;
	readFile(path: string): string | null;
	writeFile(path: string, content: string): void;
	now(): number;
}

/** Called after the world is resolved, for the live target only. The first run per world needs
 *  `--i-deployed-the-server` (`cfg.ackLive`); once acknowledged, it's remembered per world uuid in
 *  `<stateRoot>/live-ack.json` and later runs don't need the flag again. */
export function checkLiveAck(input: CheckLiveAckInput): void | ConfigError {
	const { cfg, worldUuid, readFile, writeFile, now } = input;
	if (cfg.target.name !== 'live') return undefined;

	const path = `${cfg.stateRoot}/live-ack.json`;
	const raw = readFile(path);
	let acked: Record<string, string> = {};
	if (raw) {
		try {
			acked = JSON.parse(raw) as Record<string, string>;
		} catch {
			acked = {};
		}
	}

	if (acked[worldUuid]) return undefined;

	if (!cfg.ackLive) {
		return new ConfigError(
			'this is the first run against the live target for this world. An older live server ignores the "bot" flag, which makes the bot a spawn target and can block world deletion. If you have deployed a server version that supports bots, re-run with --i-deployed-the-server.',
		);
	}

	acked[worldUuid] = new Date(now()).toISOString();
	writeFile(path, JSON.stringify(acked));
	return undefined;
}

/** Resolves `--world` (a uuid, or an exact case-insensitive name) against `listWorlds()`'s rows.
 *  With no `arg` at all, the caller should list the target's worlds and exit. */
export function resolveWorld(worlds: readonly WorldListing[], arg: string | undefined): WorldListing | ConfigError | 'listOnly' {
	if (!arg) return 'listOnly';

	const byUuid = worlds.find((w) => w.uuid === arg);
	if (byUuid) return byUuid;

	const lower = arg.toLowerCase();
	const byName = worlds.filter((w) => w.name.toLowerCase() === lower);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		const list = byName.map((w) => `${w.name} (${w.uuid})`).join(', ');
		return new ConfigError(`"${arg}" matches more than one world: ${list}`);
	}

	return new ConfigError(`no world found for "${arg}"`);
}

/** Refuses a bot name that equals (case-insensitively) any occupied name — online or in-world —
 *  so a bot never takes over a kid's record. */
export function checkName(name: string, occupiedNames: readonly string[]): 'ok' | ConfigError {
	const lower = name.toLowerCase();
	if (occupiedNames.some((n) => n.toLowerCase() === lower)) {
		return new ConfigError(`the name "${name}" is already in use (online or in this world) — pick another --name`);
	}
	return 'ok';
}

/** Picks a skin: `requested` if valid, else the first catalog id that no kid is currently wearing. */
export function pickSkin(skins: readonly string[], kidsSkins: readonly string[], requested?: string): string | ConfigError {
	if (requested !== undefined) {
		if (!skins.includes(requested)) {
			return new ConfigError(`unknown --skin "${requested}"; available: ${skins.join(', ')}`);
		}
		return requested;
	}
	return skins.find((s) => !kidsSkins.includes(s)) ?? skins[0];
}
