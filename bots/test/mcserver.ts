/**
 * The e2e's own `mcserver` (logic from `scripts/mp-e2e.ts`): built with Go into a temp dir under
 * `BOTS_E2E_SCRATCH`, run on 127.0.0.1 against a temp DB with the token `e2e`, and stopped by OUR
 * PID with SIGTERM. It never touches port 8080 (the live server) or `~/minicraft-mp`.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN = 'e2e';
const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const GO_DIR = join(process.env.HOME ?? '', '.local/go/bin');
const GO = join(GO_DIR, 'go');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The required scratch root: every temp dir (Go build, DB, logs) goes under it. */
export function scratchRoot(): string {
	const s = process.env.BOTS_E2E_SCRATCH ?? '';
	if (s === '') {
		console.error('bots e2e: set BOTS_E2E_SCRATCH to your own scratch directory (mcserver build, temp DB, logs); there is no default');
		process.exit(1);
	}
	return s;
}

/** A free port: bind 0, read it, close. Asserted numeric, not 0 and not 8080. */
export async function freePort(): Promise<number> {
	const port = await new Promise<number>((res, rej) => {
		const srv = createServer();
		srv.once('error', rej);
		srv.listen(0, '127.0.0.1', () => {
			const a = srv.address();
			const p = typeof a === 'object' && a !== null ? a.port : NaN;
			srv.close(() => res(p));
		});
	});
	if (!Number.isInteger(port) || port === 0 || port === 8080) throw new Error(`freePort: bad port ${port}`);
	return port;
}

/** True when something listens on 127.0.0.1:port. */
export async function portInUse(port: number): Promise<boolean> {
	return new Promise<boolean>((res) => {
		const srv = createServer();
		srv.once('error', () => res(true));
		srv.listen(port, '127.0.0.1', () => srv.close(() => res(false)));
	});
}

let builtBin: { dir: string; bin: string } | null = null;

/** Builds `mcserver` once per process into a fresh temp dir under the scratch root. */
export function buildServer(): string {
	if (builtBin) return builtBin.bin;
	const dir = mkdtempSync(join(scratchRoot(), 'mcserver-build-'));
	const bin = join(dir, 'mcserver');
	const env = { ...process.env, PATH: `${GO_DIR}:${process.env.PATH}` };
	const r = spawnSync(GO, ['build', '-o', bin, './cmd/mcserver'], { cwd: join(REPO, 'server'), env, stdio: 'inherit' });
	if (r.status !== 0) throw new Error('go build mcserver failed');
	builtBin = { dir, bin };
	return bin;
}

/** Removes the build dir (ours). */
export function removeBuild(): void {
	if (builtBin) rmSync(builtBin.dir, { recursive: true, force: true });
	builtBin = null;
}

export interface McServer {
	port: number;
	url: string;
	pid: number;
	createWorld(name: string, seed?: number, gen?: number): Promise<string>;
	stop(): Promise<void>;
}

async function startOn(bin: string, port: number): Promise<McServer> {
	if (port === 8080) throw new Error('refusing port 8080');
	const dbDir = mkdtempSync(join(scratchRoot(), 'mcserver-db-'));
	const env = { ...process.env };
	delete env.MC_GCS_BUCKET;
	delete env.MC_TOKEN;
	delete env.MC_MIN_CLIENT;
	const child: ChildProcess = spawn(bin, ['-addr', `127.0.0.1:${port}`, '-db', join(dbDir, 'mc.sqlite'), '-token', TOKEN, '-gcs-bucket', ''], {
		env,
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr?.on('data', (d: Buffer) => {
		stderr += d.toString();
		if (process.env.BOTS_E2E_VERBOSE) process.stderr.write(`[mcserver] ${d}`);
	});
	const url = `http://127.0.0.1:${port}`;
	const cleanupDb = () => rmSync(dbDir, { recursive: true, force: true });
	// Readiness: the child must still run, and GET /worlds must answer 200 with the token.
	let ready = false;
	for (let i = 0; i < 80 && !ready; i++) {
		if (child.exitCode !== null || child.signalCode !== null) break;
		try {
			const r = await fetch(`${url}/worlds`, { headers: { Authorization: `Bearer ${TOKEN}` } });
			if (r.status === 200) ready = true;
		} catch {
			// not up yet
		}
		if (!ready) await sleep(125);
	}
	if (!ready) {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
		cleanupDb();
		throw new Error(`mcserver on ${port} never became ready: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
	}
	const pid = child.pid!;
	return {
		port,
		url,
		pid,
		async createWorld(name, seed = 12345, gen = 3) {
			const r = await fetch(`${url}/worlds`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, seed, mustMine: false, gen }),
			});
			if (r.status !== 200 && r.status !== 201) throw new Error(`createWorld ${name}: HTTP ${r.status}`);
			return ((await r.json()) as { uuid: string }).uuid;
		},
		async stop() {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = new Promise<void>((r) => child.once('exit', () => r()));
				process.kill(pid, 'SIGTERM');
				await Promise.race([exited, sleep(15_000)]);
			}
			cleanupDb();
		},
	};
}

/**
 * Starts a server: on `fixedPort` when given (checked free first), else on a free port, retried once
 * on a new port.
 */
export async function startServer(fixedPort?: number): Promise<McServer> {
	const bin = buildServer();
	if (fixedPort !== undefined) {
		if (await portInUse(fixedPort)) throw new Error(`port ${fixedPort} is busy; not starting (never reusing a server we did not start)`);
		return startOn(bin, fixedPort);
	}
	try {
		return await startOn(bin, await freePort());
	} catch (err) {
		console.log(`   mcserver: first start failed (${(err as Error).message}); retrying on a new port`);
		return startOn(bin, await freePort());
	}
}
