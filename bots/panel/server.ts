/**
 * Local bot control panel: `npm --prefix bots run panel [-- --port 7777] [--dry-run]`.
 * Binds loopback only. Starts/stops `mcbot-<slug>` systemd user units via systemd-run, stops legacy
 * `minicraft-*` bot units, and shows each bot's state from its newest JSONL log. Never touches
 * minicraft-server or minicraft-tunnel (lib.ts whitelists units). Every child runs via execFile
 * with an argv array — no shell.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BOT_TYPES, SKIN_IDS, isLegacyUnit, isLogOf, isPanelUnit, isProtectedUnit, isStoppableUnit, isValidName, isValidWorld,
	parseAvailableCommands, parseShow, parseUnitCommand, parseWorlds, summarizeLog, systemdRunArgv, unitFor, validateStart,
	type RunEnv,
} from './lib.js';

const PANEL_DIR = dirname(fileURLToPath(import.meta.url));
const BOTS_DIR = resolve(PANEL_DIR, '..');
const WORKTREE = resolve(BOTS_DIR, '..');
const STATE_ROOT = join(BOTS_DIR, '.state');
const NODE_DIR = dirname(process.execPath);
const RUN_ENV: RunEnv = { worktree: WORKTREE, nodeDir: NODE_DIR, npm: join(NODE_DIR, 'npm') };
const LAYA_HEALTH = 'http://127.0.0.1:8000/health';
const TAIL_BYTES = 2 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function parseFlags(argv: string[]): { host: string; port: number; dryRun: boolean } {
	let host = '127.0.0.1';
	let port = 7777;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--port') port = Number(argv[++i]);
		else if (a === '--host') host = argv[++i] ?? '';
		else if (a === '--dry-run') dryRun = true;
		else throw new Error(`unknown flag ${a} (flags: --port N, --host 127.0.0.1|::1, --dry-run)`);
	}
	if (!LOOPBACK.has(host)) throw new Error(`refusing to bind ${host}: loopback only`);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad --port');
	return { host: host === 'localhost' ? '127.0.0.1' : host, port, dryRun };
}

interface RunResult { code: number; stdout: string; stderr: string }
function run(argv: string[], timeoutMs = 20_000): Promise<RunResult> {
	return new Promise((res) => {
		execFile(argv[0], argv.slice(1), { cwd: WORKTREE, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: `${NODE_DIR}:${process.env.PATH ?? ''}` } }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
			res({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

// ---- CLI capabilities (cached) -----------------------------------------------------------------

let typesCache: { at: number; types: string[] } | null = null;
async function availableTypes(): Promise<string[]> {
	if (typesCache && Date.now() - typesCache.at < 60_000) return typesCache.types;
	const r = await run([RUN_ENV.npm, '--prefix', 'bots', 'run', '--silent', 'bot', '--', '__panel_probe__']);
	const offered = parseAvailableCommands(r.stderr + r.stdout);
	const types = BOT_TYPES.map((t) => t.id).filter((id) => offered.includes(id));
	typesCache = { at: Date.now(), types };
	return types;
}

function whenSupported(): boolean {
	try {
		return readFileSync(join(BOTS_DIR, 'src', 'cli-args.ts'), 'utf8').includes("'--when'");
	} catch {
		return false;
	}
}

const worldsCache = new Map<string, { at: number; value: unknown }>();
async function listWorlds(target: 'live' | 'local'): Promise<unknown> {
	const hit = worldsCache.get(target);
	if (hit && Date.now() - hit.at < 30_000) return hit.value;
	const r = await run([RUN_ENV.npm, '--prefix', 'bots', 'run', '--silent', 'bot', '--', 'companion', '--target', target, '--brain', 'v2']);
	const worlds = parseWorlds(r.stdout);
	const value = { worlds, error: worlds.length === 0 ? (r.stderr.trim() || r.stdout.trim() || 'no worlds').slice(0, 400) : null };
	worldsCache.set(target, { at: Date.now(), value });
	return value;
}

async function layaUp(): Promise<boolean> {
	try {
		const res = await fetch(LAYA_HEALTH, { signal: AbortSignal.timeout(1500) });
		return res.ok;
	} catch {
		return false;
	}
}

// ---- units -------------------------------------------------------------------------------------

const SHOW_PROPS = 'Id,Description,ActiveState,SubState,Result,NRestarts,ExecMainStartTimestamp';

async function listInstances(): Promise<unknown[]> {
	const r = await run(['systemctl', '--user', 'list-units', '--all', '--plain', '--no-legend', '--type=service', 'mcbot-*', 'minicraft-*']);
	const units = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]?.replace(/\.service$/, '') ?? '').filter((u) => u && (isPanelUnit(u) || isLegacyUnit(u)));
	if (units.length === 0) return [];
	const show = await run(['systemctl', '--user', 'show', '-p', SHOW_PROPS, ...units.map((u) => `${u}.service`)]);
	return parseShow(show.stdout).map((p) => {
		const unit = (p.Id ?? '').replace(/\.service$/, '');
		return {
			unit, kind: isPanelUnit(unit) ? 'panel' : 'legacy', active: p.ActiveState, sub: p.SubState, result: p.Result,
			restarts: Number(p.NRestarts ?? 0), since: p.ExecMainStartTimestamp, cmd: parseUnitCommand(p.Description ?? ''),
		};
	}).filter((x) => isPanelUnit(x.unit) || isLegacyUnit(x.unit));
}

function tailFile(path: string, bytes: number): { tail: string; first: string } {
	const fd = openSync(path, 'r');
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		let tail = buf.toString('utf8');
		if (start > 0) tail = tail.slice(tail.indexOf('\n') + 1);
		const hb = Buffer.alloc(Math.min(size, 16 * 1024));
		readSync(fd, hb, 0, hb.length, 0);
		const first = hb.toString('utf8').split('\n')[0] ?? '';
		return { tail, first };
	} finally {
		closeSync(fd);
	}
}

function newestLog(target: string, world: string, name: string): string | null {
	if (!/^(live|local)$/.test(target) || !isValidWorld(world) || !isValidName(name)) return null;
	const dir = join(STATE_ROOT, 'logs', target, world);
	if (!existsSync(dir)) return null;
	const files = readdirSync(dir).filter((f) => isLogOf(f, name)).map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
	return files.length ? join(dir, files[0].f) : null;
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

async function instanceDetail(unit: string): Promise<unknown> {
	const show = await run(['systemctl', '--user', 'show', '-p', SHOW_PROPS, `${unit}.service`]);
	const p = parseShow(show.stdout)[0] ?? {};
	const cmd = parseUnitCommand(p.Description ?? '');
	const journal = await run(['journalctl', '--user', '-u', `${unit}.service`, '-n', '8', '--no-pager', '-o', 'short-iso']);
	let summary: unknown = null;
	let logPath: string | null = null;
	if (cmd.name && cmd.world) {
		logPath = newestLog(cmd.target, cmd.world, cmd.name);
		if (logPath) {
			const { tail, first } = tailFile(logPath, TAIL_BYTES);
			const persisted = readJson(join(STATE_ROOT, 'brain', cmd.target, cmd.world, `${cmd.name}.json`));
			summary = summarizeLog(tail, first, persisted);
		}
	}
	return {
		unit, active: p.ActiveState, sub: p.SubState, result: p.Result, restarts: Number(p.NRestarts ?? 0), since: p.ExecMainStartTimestamp,
		description: p.Description, cmd, journal: journal.stdout.trim().split('\n').slice(-8), logPath, summary,
	};
}

// ---- HTTP --------------------------------------------------------------------------------------

function send(res: ServerResponse, code: number, body: unknown, type = 'application/json'): void {
	const data = type === 'application/json' ? JSON.stringify(body) : String(body);
	res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
	res.end(data);
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((res, rej) => {
		let s = '';
		req.on('data', (c) => {
			s += c;
			if (s.length > 16_384) rej(new Error('body too large'));
		});
		req.on('end', () => {
			try {
				res(JSON.parse(s || '{}'));
			} catch {
				rej(new Error('bad JSON'));
			}
		});
	});
}

export function startServer(opts: { host: string; port: number; dryRun: boolean }): void {
	const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);
	const server = createServer(async (req, res) => {
		try {
			// DNS-rebinding / cross-site guard: only our own origin, JSON bodies only (forces a CORS preflight we never answer).
			if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'bad host' });
			const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
			if (req.method === 'GET' && url.pathname === '/') {
				return send(res, 200, readFileSync(join(PANEL_DIR, 'index.html'), 'utf8'), 'text/html');
			}
			if (req.method === 'GET' && url.pathname === '/api/meta') {
				const [types, laya] = await Promise.all([availableTypes(), layaUp()]);
				return send(res, 200, {
					types: BOT_TYPES.filter((t) => types.includes(t.id)), skins: SKIN_IDS, whenSupported: whenSupported(), laya, dryRun: opts.dryRun,
				});
			}
			if (req.method === 'GET' && url.pathname === '/api/worlds') {
				const target = url.searchParams.get('target') === 'local' ? 'local' : 'live';
				return send(res, 200, await listWorlds(target));
			}
			if (req.method === 'GET' && url.pathname === '/api/instances') return send(res, 200, await listInstances());
			if (req.method === 'GET' && url.pathname === '/api/instance') {
				const unit = url.searchParams.get('unit');
				if (!isStoppableUnit(unit)) return send(res, 400, { error: 'not a bot unit' });
				return send(res, 200, await instanceDetail(unit));
			}
			if (req.method === 'POST') {
				if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
				const body = await readBody(req);
				if (url.pathname === '/api/start') {
					const spec = validateStart(body, { types: await availableTypes(), whenSupported: whenSupported() });
					if ('error' in spec) return send(res, 400, spec);
					const unit = unitFor(spec.name);
					if (!isPanelUnit(unit)) return send(res, 400, { error: `bad unit ${unit}` });
					const argv = systemdRunArgv(spec, RUN_ENV);
					if (opts.dryRun) {
						console.log('[dry-run] start', JSON.stringify(argv));
						return send(res, 200, { dryRun: true, argv });
					}
					const st = await run(['systemctl', '--user', 'show', '-p', 'ActiveState', `${unit}.service`]);
					if (/ActiveState=(active|activating|reloading|deactivating)/.test(st.stdout)) return send(res, 409, { error: `${unit} is already running` });
					await run(['systemctl', '--user', 'reset-failed', `${unit}.service`]);
					const r = await run(argv);
					return send(res, r.code === 0 ? 200 : 500, { argv, code: r.code, out: (r.stdout + r.stderr).trim() });
				}
				if (url.pathname === '/api/stop') {
					const unit = (body as { unit?: unknown }).unit;
					if (typeof unit !== 'string' || isProtectedUnit(unit) || !isStoppableUnit(unit)) return send(res, 403, { error: 'only mcbot-* and legacy minicraft-* bot units can be stopped' });
					const argvs = [['systemctl', '--user', 'stop', `${unit}.service`], ['systemctl', '--user', 'reset-failed', `${unit}.service`]];
					if (opts.dryRun) {
						console.log('[dry-run] stop', JSON.stringify(argvs));
						return send(res, 200, { dryRun: true, argv: argvs });
					}
					const r = await run(argvs[0], 60_000);
					await run(argvs[1]);
					return send(res, r.code === 0 ? 200 : 500, { code: r.code, out: (r.stdout + r.stderr).trim() });
				}
			}
			return send(res, 404, { error: 'not found' });
		} catch (e) {
			return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
		}
	});
	server.listen(opts.port, opts.host, () => {
		console.log(`bot panel on http://${opts.host === '::1' ? '[::1]' : opts.host}:${opts.port}/${opts.dryRun ? '  (dry run: start/stop only print their argv)' : ''}`);
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		startServer(parseFlags(process.argv.slice(2)));
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}
