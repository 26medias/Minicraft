/**
 * The brains launcher (spec §4; Task 6): `npm run brains -- [start] laya|clm` starts the configured local
 * decision-model server from `bots.config.ts`'s `brains` entry — e.g. `laya-serve` per
 * `~/Projects/AI/BRAINS.md` — with its exact start argv, on 127.0.0.1. It spawns that argv directly
 * (no shell): a start entry like `['env', 'LAYA_HOST=127.0.0.1', ..., '.venv/bin/laya-serve']` sets
 * its env vars via the real `env` binary and execs the server, so `BrainDef` needs no separate `env`
 * field.
 *
 * It never runs the game server or a bot — only a brain server — and never on port 8080 (refused,
 * mirroring `config.ts`'s `assertNotPort8080`).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import defaultBotsConfig from '../bots.config.js';
import type { BotsConfigData, BrainDef } from './config.js';

const DEFAULT_BOTS_CONFIG = defaultBotsConfig as BotsConfigData;

export type BrainKey = 'laya' | 'clm';
const BRAIN_KEYS: readonly BrainKey[] = ['laya', 'clm'];

/** `~` and `~/...` expansion via an injected `homedir` (mirrors `config.ts`'s private `expandHome`). */
export function expandHome(path: string, homedirFn: () => string): string {
	if (path === '~') return homedirFn();
	if (path.startsWith('~/')) return `${homedirFn()}${path.slice(1)}`;
	return path;
}

/** Refuses a brain whose configured url is on port 8080 — the live mcserver's port on this desktop
 *  (spec §4). This launcher starts brain servers only, but the refusal is unconditional: a
 *  misconfigured `bots.config.ts` entry must not be able to point this at the live port. */
export function refusePort8080(def: BrainDef): void {
	let parsed: URL;
	try {
		parsed = new URL(def.url);
	} catch {
		throw new Error(`invalid brain url: ${def.url}`);
	}
	if (parsed.port === '8080') {
		throw new Error(`brain url "${def.url}" uses port 8080, which is reserved for the live multiplayer server on this desktop — refused`);
	}
}

/** Resolves `argv[0]` (`laya` or `clm`) against the configured brains. Throws a usage error
 *  otherwise. */
export function resolveBrain(arg: string | undefined, brains: BotsConfigData['brains']): { key: BrainKey; def: BrainDef } {
	if (!arg || !BRAIN_KEYS.includes(arg as BrainKey)) {
		throw new Error(`usage: npm run brains -- [start] <${BRAIN_KEYS.join('|')}>`);
	}
	const key = arg as BrainKey;
	const def = brains[key];
	if (!def) throw new Error(`no brain config for "${key}"`);
	if (def.start.length === 0) throw new Error(`brain "${key}" has an empty start argv`);
	if (key === 'laya') requireLayaEnglish(def);
	return { key, def };
}

/**
 * Laya must run English-only (spec §3.2): with all three checkpoints loaded, the LLM gets only 1.4 of its 3.6 GB on
 * the GPU and `appraise.size` takes p50 4.4 s; with `LAYA_MODELS=english`, Laya uses about 1.9 GB and the LLM fits.
 */
export function requireLayaEnglish(def: BrainDef): void {
	if (!def.start.includes('LAYA_MODELS=english')) {
		throw new Error(`laya must start with LAYA_MODELS=english (spec §3.2: all checkpoints push the LLM off the GPU); add it to its start argv in bots.config.ts`);
	}
}

export interface BrainsCliDeps {
	config: BotsConfigData;
	homedir(): string;
	/** Injectable for tests (a fake child process); defaults to `node:child_process`'s `spawn`,
	 *  stdio inherited. */
	spawnProcess(command: string, args: string[], options: { cwd: string }): ChildProcess;
	print(line: string): void;
	/** Injectable for tests: registers a process-signal forwarder; defaults to `process.on`. Returns
	 *  the matching unsubscribe. */
	onSignal(signal: NodeJS.Signals, handler: () => void): () => void;
}

const DEFAULT_DEPS: BrainsCliDeps = {
	config: DEFAULT_BOTS_CONFIG,
	homedir,
	spawnProcess: (command, args, options) => spawn(command, args, { cwd: options.cwd, stdio: 'inherit' }),
	print: (line) => console.log(line),
	onSignal: (signal, handler) => {
		process.on(signal, handler);
		return () => process.off(signal, handler);
	},
};

/**
 * Spawns the brain's configured start argv (Task 6): `cwd` = its expanded `home`, stdio inherited,
 * SIGINT/SIGTERM forwarded to the child, port 8080 refused. Resolves with the child's exit code (or
 * 1, if it died to a signal) once it exits.
 */
export async function runBrainsCli(argv: readonly string[], deps: BrainsCliDeps = DEFAULT_DEPS): Promise<number> {
	const args0 = argv[0] === 'start' ? argv.slice(1) : argv;   // `brains start laya` and `brains laya` are the same
	const { key, def } = resolveBrain(args0[0], deps.config.brains);
	refusePort8080(def);
	const [command, ...args] = def.start;
	const cwd = expandHome(def.home, deps.homedir);
	deps.print(`starting ${key}: ${def.start.join(' ')} (cwd ${cwd})`);
	const child = deps.spawnProcess(command, args, { cwd });

	return new Promise<number>((resolve) => {
		const forward = (signal: NodeJS.Signals): (() => void) => {
			return deps.onSignal(signal, () => child.kill(signal));
		};
		const offSigint = forward('SIGINT');
		const offSigterm = forward('SIGTERM');
		child.on('exit', (code, signal) => {
			offSigint();
			offSigterm();
			resolve(code ?? (signal ? 1 : 0));
		});
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	runBrainsCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		});
}

