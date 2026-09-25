// Plan Task 5 step 5: BotClient over a fake WebSocket and vitest fake timers (spec §6, §12a).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BlockedError,
	BotClient,
	NotConnectedError,
	OutdatedClientError,
	ReplacedError,
	ServerRefusedError,
	type BotClientOptions,
	type ConnectResult,
} from '../src/index';
import { BLOCKS, BLOCK_BY_NAME, isSolid } from '../../../src/data/blocks.data';
import { CLIENT_VERSION, POS_EVERY_MS, PROTO, type Op, type PlayerInfo } from '../../../src/net/protocol';
import { NEWEST_GEN_VERSION } from '../../../src/engine/world/generation';
import { miningDuration } from '../../../src/game/tools';
import { EYE_HEIGHT, WALK_SPEED } from '../../../src/game/player-constants';
import { World } from '../../../src/engine/world/world';
import { spawnV3 } from '../../../src/engine/world/v3/spawn';
import { FakeWS, SEED, snapshot, welcome } from './fixtures';

const STONE = BLOCK_BY_NAME['stone'].id;
const DIRT = BLOCK_BY_NAME['dirt'].id;
const AIR = 0;
const BEDROCK = BLOCK_BY_NAME['bedrock'].id;
const LAMP = BLOCK_BY_NAME['lamp'].id;
const STEP = (WALK_SPEED * POS_EVERY_MS) / 1000;

const tmpDirs: string[] = [];
afterAll(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
	FakeWS.all = [];
	vi.useFakeTimers();
	// MpApi.listWorlds (the reconnect probe): a minimal answer, no real Response streams under fake timers.
	vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function client(over: Partial<BotClientOptions> = {}): BotClient {
	// editGapMs 0 unless a test sets it (pass `editGapMs: undefined` for the default 150).
	return new BotClient({ url: 'http://127.0.0.1:18080', token: 'e2e', WebSocket: FakeWS as never, editGapMs: 0, ...over });
}

/** The oracle world (the game's own, seed 12345) for finding spots. */
const oracle = World.create(SEED);

function groundOf(x: number, z: number, nearY = 250): number | null {
	const top = Math.min(oracle.height - 3, Math.floor(nearY) + 2);
	for (let y = top; y >= Math.max(1, top - 64); y--) {
		if (isSolid(oracle.getBlock(Math.floor(x), y - 1, Math.floor(z))) && !isSolid(oracle.getBlock(Math.floor(x), y, Math.floor(z))) && !isSolid(oracle.getBlock(Math.floor(x), y + 1, Math.floor(z)))) return y;
	}
	return null;
}

/** Top non-air, non-liquid y of a column (oracle). */
function surfaceOf(x: number, z: number): number {
	for (let y = oracle.height - 1; y >= 0; y--) {
		const id = oracle.getBlock(x, y, z);
		if (id !== AIR && BLOCKS[id].liquid === 'none') return y;
	}
	return -1;
}

/**
 * A synthetic stone platform high in the air (y 199), 18 × 7, built with the bot's own world writes: feet y 200.
 * `under` adds a second floor 6 below for the given x offsets (a "cave" under the platform).
 */
const PLAT = { x: 100, y: 200, z: 100 };
function platform(bot: BotClient, under: number[] = []): { x: number; y: number; z: number } {
	for (let dx = -3; dx <= 14; dx++) for (let dz = -3; dz <= 3; dz++) {
		for (let y = PLAT.y - 8; y <= PLAT.y + 8; y++) if (oracle.getBlock(PLAT.x + dx, y, PLAT.z + dz) !== AIR) throw new Error('platform: terrain in the way');
		bot.world.localSet(PLAT.x + dx, PLAT.y - 1, PLAT.z + dz, STONE);
	}
	for (const dx of under) for (let dz = -3; dz <= 3; dz++) bot.world.localSet(PLAT.x + dx, PLAT.y - 7, PLAT.z + dz, STONE);
	return { ...PLAT };
}

type Conn = { bot: BotClient; ws: FakeWS; res: ConnectResult };

/** Lets queued promise callbacks run (the edit chain, the reconnect probe). */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Connects a bot through the fake socket: open, welcome, snapshot. */
async function connected(opts: { over?: Partial<BotClientOptions>; spawn?: { x: number; y: number; z: number }; players?: PlayerInfo[]; cells?: Op[]; you?: number; catalogMax?: number } = {}): Promise<Conn> {
	const bot = client(opts.over);
	const p = bot.connect({ world: 'world-1', name: 'Robo', skin: 'enderman' });
	const ws = FakeWS.last;
	ws.open();
	ws.recv(welcome({ you: opts.you ?? 1, spawn: { mode: 'return', x: 100.5, y: 80, z: 100.5, yaw: 0.7, pitch: 0.1 }, players: opts.players ?? [], catalogMax: opts.catalogMax ?? 5000 }));
	ws.recvBin(snapshot(opts.cells ?? []));
	const res = await p;
	// A test's start pose: set it and let one pose go out.
	if (opts.spawn) {
		bot.move({ ...opts.spawn, yaw: 0, pitch: 0 });
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS);
	}
	return { bot, ws, res };
}

function kid(id: number, x: number, y: number, z: number, over: Partial<PlayerInfo> = {}): PlayerInfo {
	return { id, name: `Kid${id}`, skin: 'steve', x, y, z, yaw: 0, pitch: 0, hasPos: true, ...over };
}

/** FNV-1a 32 of the UTF-8 name, hex (the default bid rule). */
function fnvHex(s: string): string {
	let h = 0x811c9dc5;
	for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
	return h.toString(16).padStart(8, '0');
}

describe('connect', () => {
	it('sends the hello as the game builds it, plus bot: true and the default bid', async () => {
		const { ws } = await connected();
		expect(ws.sent[0]).toEqual({
			t: 'hello', world: 'world-1', name: 'Robo', skin: 'enderman', bid: 'bot-' + fnvHex('Robo'),
			proto: PROTO, gen: NEWEST_GEN_VERSION, resume: false, ver: CLIENT_VERSION, bot: true,
		});
		expect(ws.url).toBe('ws://127.0.0.1:18080/ws?token=e2e');
	});

	it('sends the resolved spawn pose before it resolves, and resolves {you, spawn, players, world}', async () => {
		const bot = client();
		let resolved = false;
		const p = bot.connect({ world: 'world-1', name: 'Robo', skin: 'enderman' }).then((r) => {
			resolved = true;
			return r;
		});
		const ws = FakeWS.last;
		ws.open();
		ws.recv(welcome({ you: 4, players: [kid(4, 0, 0, 0, { name: 'Robo' }), kid(2, 5, 70, 5)] }));
		await Promise.resolve();
		expect(resolved).toBe(false);
		expect(ws.of('pos')).toEqual([]);
		ws.recvBin(snapshot());
		const res = await p;
		// Mode 'first' (the fixture's): the world's v3 spawn column, on its topmost block (the game's resolveMpSpawn).
		const sp = spawnV3(SEED);
		const first = { x: sp.x + 0.5, y: surfaceOf(sp.x, sp.z) + 1, z: sp.z + 0.5, yaw: 0, pitch: 0 };
		expect(first.y).toBeGreaterThan(64);
		expect(ws.of('pos')).toEqual([{ t: 'pos', ...first }]);
		expect(res.you).toBe(4);
		expect(res.spawn).toEqual({ mode: 'first', ...first });
		expect(res.players.map((p) => p.id)).toEqual([2]);
		expect(res.world).toBe(bot.world);
		expect(bot.pose()).toEqual(first);
	});

	it("spawn mode 'return': the saved spot, grounded, with the saved yaw and pitch", async () => {
		const bot = client();
		const p = bot.connect({ world: 'world-1', name: 'Robo', skin: 'enderman' });
		const ws = FakeWS.last;
		ws.open();
		const x = 300.5, z = 310.5, g = groundOf(x, z, surfaceOf(300, 310) + 1)!;
		ws.recv(welcome({ spawn: { mode: 'return', x, y: g + 0.4, z, yaw: 1.25, pitch: -0.5 } }));
		ws.recvBin(snapshot());
		await p;
		expect(bot.pose()).toEqual({ x, y: g, z, yaw: 1.25, pitch: -0.5 });
	});

	it("spawn mode 'near': 3–6 blocks from the target on dry ground, facing it", async () => {
		const bot = client();
		const p = bot.connect({ world: 'world-1', name: 'Robo', skin: 'enderman' });
		const ws = FakeWS.last;
		ws.open();
		const sp = spawnV3(SEED);
		const t = { x: sp.x + 0.5, y: surfaceOf(sp.x, sp.z) + 1, z: sp.z + 0.5 };
		ws.recv(welcome({ spawn: { mode: 'near', ...t, yaw: 0, pitch: 0, target: 2 } }));
		ws.recvBin(snapshot());
		await p;
		const me = bot.pose();
		const d = Math.hypot(me.x - t.x, me.z - t.z);
		expect(d).toBeGreaterThanOrEqual(3);
		expect(d).toBeLessThanOrEqual(6);
		expect(Math.abs(me.y - t.y)).toBeLessThanOrEqual(4);
		expect(groundOf(me.x, me.z, me.y)).toBe(me.y);
		expect(me.yaw).toBeCloseTo(Math.atan2(-(t.x - me.x), -(t.z - me.z)), 9);
	});

	it('bid: explicit, else the one saved in statePath, else bot-<fnv1a32(name)>', async () => {
		const a = await connected({ over: { bid: 'explicit-bid' } });
		expect(a.ws.sent[0].bid).toBe('explicit-bid');
		const dir = mkdtempSync(join(tmpdir(), 'minicraft-bot-state-'));
		tmpDirs.push(dir);
		const statePath = join(dir, 'state.json');
		writeFileSync(statePath, JSON.stringify({ bid: 'saved-bid', journal: [] }));
		const b = await connected({ over: { statePath } });
		expect(b.ws.sent[0].bid).toBe('saved-bid');
		const c = await connected();
		expect(c.ws.sent[0].bid).toBe('bot-' + fnvHex('Robo'));
	});

	it('actions throw NotConnectedError before connect resolves', () => {
		const bot = client();
		expect(() => bot.move({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 })).toThrow(NotConnectedError);
		expect(() => bot.place(0, 0, 0, 'stone')).toThrow(NotConnectedError);
		expect(() => bot.break(0, 0, 0)).toThrow(NotConnectedError);
		expect(() => bot.mine(0, 0, 0)).toThrow(NotConnectedError);
		expect(() => bot.walkTo({ x: 0, z: 0 })).toThrow(NotConnectedError);
		expect(() => bot.lookAt(0, 0, 0)).toThrow(NotConnectedError);
		expect(() => bot.revert()).toThrow(NotConnectedError);
		expect(() => bot.world).toThrow(NotConnectedError);
	});
});

describe('refusal mapping (connect rejects)', () => {
	async function refused(code: number, err?: object): Promise<unknown> {
		const bot = client();
		const p = bot.connect({ world: 'world-1', name: 'Robo', skin: 'enderman' });
		const ws = FakeWS.last;
		ws.open();
		if (err) ws.recv({ t: 'error', ...err });
		ws.serverClose(code);
		return p.then(() => null, (e: unknown) => e);
	}

	it('4004 + outdated → OutdatedClientError{ver, min}', async () => {
		const e = await refused(4004, { code: 4004, message: 'outdated', min: 2 });
		expect(e).toBeInstanceOf(OutdatedClientError);
		expect(e).toMatchObject({ ver: CLIENT_VERSION, min: 2 });
		expect((e as Error).message).toMatch(/npm run build:bot/);
	});

	it('4004 without an error message → ServerRefusedError{4004}', async () => {
		const e = await refused(4004);
		expect(e).toBeInstanceOf(ServerRefusedError);
		expect(e).toMatchObject({ code: 4004 });
	});

	it('4004 proto → ServerRefusedError{4004, proto}', async () => {
		const e = await refused(4004, { code: 4004, message: 'proto' });
		expect(e).toBeInstanceOf(ServerRefusedError);
		expect(e).toMatchObject({ code: 4004, message: 'proto' });
	});

	it('4001 → ReplacedError', async () => {
		expect(await refused(4001)).toBeInstanceOf(ReplacedError);
	});

	it.each([4005, 4006, 4007, 4008, 4009])('%i → ServerRefusedError{code}', async (code) => {
		const e = await refused(code, { code, message: `m${code}` });
		expect(e).toBeInstanceOf(ServerRefusedError);
		expect(e).toMatchObject({ code, message: `m${code}` });
	});
});

describe('pose, players, move', () => {
	it('players() excludes the bot itself and carries hasPos; ticks update poses', async () => {
		const { bot, ws } = await connected({ you: 3, players: [kid(3, 1, 1, 1, { name: 'Robo', bot: true }), kid(5, 10, 70, 10, { hasPos: false })] });
		expect(bot.players()).toEqual([{ id: 5, name: 'Kid5', skin: 'steve', bot: false, x: 10, y: 70, z: 10, yaw: 0, pitch: 0, hasPos: false }]);
		const poses: number[] = [];
		bot.on('pose', (p) => poses.push(p.id));
		ws.recv({ t: 'join', id: 6, name: 'Other', skin: 'alex', bot: true });
		ws.recv({ t: 'tick', poses: [[5, 11, 71, 12, 0.5, 0.25], [6, 1, 2, 3, 0, 0]] });
		expect(bot.players()).toEqual([
			{ id: 5, name: 'Kid5', skin: 'steve', bot: false, x: 11, y: 71, z: 12, yaw: 0.5, pitch: 0.25, hasPos: true },
			{ id: 6, name: 'Other', skin: 'alex', bot: true, x: 1, y: 2, z: 3, yaw: 0, pitch: 0, hasPos: true },
		]);
		expect(poses).toEqual([5, 6]);
		ws.recv({ t: 'left', id: 6 });
		expect(bot.players().map((p) => p.id)).toEqual([5]);
	});

	it('move is coalesced to one pos per POS_EVERY_MS (latest wins); an unchanged pose is not re-sent', async () => {
		const { bot, ws } = await connected();
		const at0 = ws.of('pos').length;
		bot.move({ x: 101, y: 80, z: 100, yaw: 0, pitch: 0 });
		bot.move({ x: 102, y: 80, z: 100, yaw: 0, pitch: 0 });
		expect(ws.of('pos').length).toBe(at0);
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS);
		expect(ws.of('pos').slice(at0)).toEqual([{ t: 'pos', x: 102, y: 80, z: 100, yaw: 0, pitch: 0 }]);
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 5);
		expect(ws.of('pos').length).toBe(at0 + 1);
		bot.move({ x: 102.001, y: 80, z: 100, yaw: 0.0001, pitch: 0 }); // same key at toFixed(2)/(3)
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 2);
		expect(ws.of('pos').length).toBe(at0 + 1);
		expect(bot.pose()).toEqual({ x: 102.001, y: 80, z: 100, yaw: 0.0001, pitch: 0 });
	});

	it('a NaN or infinite pose throws (a programming error) and changes nothing', async () => {
		const { bot } = await connected();
		const before = bot.pose();
		expect(() => bot.move({ x: NaN, y: 70, z: 0 })).toThrow(RangeError);
		expect(() => bot.move({ x: 0, y: 70, z: 0, yaw: Infinity })).toThrow(RangeError);
		expect(() => bot.lookAt(0, NaN, 0)).toThrow(RangeError);
		expect(() => bot.walkTo({ x: 1, z: NaN })).toThrow(RangeError);
		expect(bot.pose()).toEqual(before);
	});

	it('lookAt turns from the eye and only rotates', async () => {
		const { bot } = await connected({ spawn: { x: 10, y: 70, z: 10 } });
		bot.lookAt(13, 70 + EYE_HEIGHT + 3, 6);
		const p = bot.pose();
		expect(p.x).toBe(10);
		expect(p.y).toBe(70);
		expect(p.yaw).toBeCloseTo(Math.atan2(-3, 4), 9);
		expect(p.pitch).toBeCloseTo(Math.atan2(3, 5), 9);
		bot.lookAt(10, 200, 10);
		expect(bot.pose().pitch).toBeCloseTo(Math.PI / 2, 9);
	});
});

describe('walkTo', () => {
	/** Deterministic scan for a straight 10-block walk over real terrain the walk rule accepts. */
	function findWalkablePath(): { sx: number; sy: number; sz: number; tx: number; tz: number } {
		for (let i = 0; i < 400; i++) {
			const sx = 120 + (i % 20) * 13 + 0.37, sz = 140 + Math.floor(i / 20) * 11 + 0.61;
			const dir = (i % 4) * (Math.PI / 2) + 0.3;
			const tx = sx - Math.sin(dir) * 10, tz = sz - Math.cos(dir) * 10;
			const g0 = groundOf(sx, sz);
			if (g0 === null) continue;
			let y = g0, x = sx, z = sz, ok = true;
			for (let k = 0; k < 40 && ok; k++) {
				const dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz);
				if (d <= 0.3) break;
				const s = Math.min(d, STEP);
				const nx = x + (dx / d) * s, nz = z + (dz / d) * s;
				const ny = groundOf(nx, nz, y);
				if (ny === null || ny > y + 1 || ny < y - 1) ok = false;
				else if (ny < y && (isSolid(oracle.getBlock(Math.floor(nx), y, Math.floor(nz))) || isSolid(oracle.getBlock(Math.floor(nx), y + 1, Math.floor(nz))))) ok = false;
				else if (isLiquidAt(nx, ny, nz)) ok = false;
				else { x = nx; z = nz; y = ny; }
			}
			if (ok) return { sx, sy: g0, sz, tx, tz };
		}
		throw new Error('no walkable path found in the scan');
	}
	function isLiquidAt(x: number, y: number, z: number): boolean {
		return BLOCKS[oracle.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))].liquid !== 'none';
	}

	it('arrives over real generated terrain from a fractional start, pacing at WALK_SPEED', async () => {
		const path = findWalkablePath();
		const { bot, ws } = await connected({ spawn: { x: path.sx, y: path.sy, z: path.sz } });
		const sends: Array<{ t: number; x: number; y: number; z: number; yaw: number }> = [];
		const origSend = ws.send.bind(ws);
		ws.send = (data: string) => {
			const m = JSON.parse(data) as { t: string; x: number; y: number; z: number; yaw: number };
			if (m.t === 'pos') sends.push({ t: Date.now(), x: m.x, y: m.y, z: m.z, yaw: m.yaw });
			origSend(data);
		};
		const p = bot.walkTo({ x: path.tx, z: path.tz });
		let result: string | null = null;
		void p.then((r) => (result = r));
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 40);
		expect(result).toBe('arrived');
		const end = bot.pose();
		expect(Math.hypot(end.x - path.tx, end.z - path.tz)).toBeLessThanOrEqual(0.3);
		expect(sends.length).toBeGreaterThanOrEqual(19);
		let prev = { t: -Infinity, x: path.sx, z: path.sz };
		for (const s of sends) {
			expect(s.t - prev.t).toBeGreaterThanOrEqual(POS_EVERY_MS);
			expect(Math.hypot(s.x - prev.x, s.z - prev.z)).toBeLessThanOrEqual(STEP + 1e-9);
			prev = s;
		}
		// Yaw faces the direction of travel.
		const first = sends[0];
		expect(first.yaw).toBeCloseTo(Math.atan2(-(path.tx - path.sx), -(path.tz - path.sz)), 6);
	});

	it('a wall more than one block high → BlockedError{wall, at}', async () => {
		const s = PLAT;
		const { bot } = await connected({ spawn: { x: s.x + 0.5, y: s.y, z: s.z + 0.5 } });
		platform(bot);
		for (let dz = -2; dz <= 2; dz++) for (const h of [0, 1]) bot.world.localSet(s.x + 4, s.y + h, s.z + dz, STONE);
		const p = bot.walkTo({ x: s.x + 9.5, z: s.z + 0.5 });
		const caught = p.then(() => null, (e: unknown) => e);
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 30);
		const e = await caught;
		expect(e).toBeInstanceOf(BlockedError);
		expect(e).toMatchObject({ reason: 'wall' });
		const at = (e as BlockedError).at;
		expect(at.x).toBeGreaterThan(s.x + 3);
		expect(at.x).toBeLessThan(s.x + 4);
		expect(at.y).toBe(s.y);
		expect(bot.pose()).toEqual(at);
	});

	it('a three-high wall over a cave is still a wall (the body cannot enter the column)', async () => {
		const s = PLAT;
		const { bot } = await connected({ spawn: { x: s.x + 0.5, y: s.y, z: s.z + 0.5 } });
		// A floor 6 below the platform under the wall column: groundY there finds the "cave" floor.
		platform(bot, [4]);
		for (let dz = -2; dz <= 2; dz++) for (const h of [0, 1, 2]) bot.world.localSet(s.x + 4, s.y + h, s.z + dz, STONE);
		expect(bot.world.groundY(s.x + 4, s.z, s.y)).toBe(s.y - 6);
		const caught = bot.walkTo({ x: s.x + 9.5, z: s.z + 0.5 }).then(() => null, (e: unknown) => e);
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 30);
		expect(await caught).toMatchObject({ reason: 'wall' });
	});

	it('a one-block step up is climbed', async () => {
		const s = PLAT;
		const { bot } = await connected({ spawn: { x: s.x + 0.5, y: s.y, z: s.z + 0.5 } });
		platform(bot);
		for (let dx = 3; dx <= 8; dx++) bot.world.localSet(s.x + dx, s.y, s.z, STONE);
		let r: string | null = null;
		void bot.walkTo({ x: s.x + 6.5, z: s.z + 0.5 }).then((v) => (r = v));
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 30);
		expect(r).toBe('arrived');
		expect(bot.pose().y).toBe(s.y + 1);
	});

	it('no ground (off the world edge) → BlockedError{noGround}', async () => {
		const { bot } = await connected({ spawn: { x: 1.5, y: 200, z: 300.5 } });
		for (let x = 0; x <= 3; x++) bot.world.localSet(x, 199, 300, STONE);
		// Off the world at x < 0: every cell reads AIR.
		const caught = bot.walkTo({ x: -8, z: 300.5 }).then(() => null, (e: unknown) => e);
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 40);
		const e = await caught;
		expect(e).toBeInstanceOf(BlockedError);
		expect(e).toMatchObject({ reason: 'noGround' });
	});

	it('a cliff: descends at most 2 per pose, and keeps descending before moving on', async () => {
		const s = PLAT;
		const { bot, ws } = await connected({ spawn: { x: s.x + 0.5, y: s.y, z: s.z + 0.5 } });
		// A 6-deep drop: the platform is cut away from dx 2 on, over a floor 6 below.
		const low = s.y - 6;
		platform(bot, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		for (let dx = 2; dx <= 12; dx++) for (let dz = -3; dz <= 3; dz++) bot.world.localSet(s.x + dx, s.y - 1, s.z + dz, AIR);
		const n0 = ws.of('pos').length;
		let r: string | null = null;
		void bot.walkTo({ x: s.x + 8.5, z: s.z + 0.5 }).then((v) => (r = v));
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 40);
		expect(r).toBe('arrived');
		expect(bot.pose().y).toBe(low);
		const poses = ws.of('pos').slice(n0 - 1) as Array<{ x: number; y: number }>;
		let sawHover = false;
		for (let i = 1; i < poses.length; i++) {
			expect(poses[i].y - poses[i - 1].y).toBeGreaterThanOrEqual(-2);
			if (poses[i].y < poses[i - 1].y && poses[i].y > low) sawHover = true;
			// While still above the floor (mid-drop), it doesn't move horizontally.
			if (poses[i - 1].y > low && poses[i - 1].y < s.y) expect(poses[i].x).toBe(poses[i - 1].x);
		}
		expect(sawHover).toBe(true);
	});

	it('a new walkTo or a move resolves the old one with cancelled, never a rejection', async () => {
		const s = PLAT;
		const { bot } = await connected({ spawn: { x: s.x + 0.5, y: s.y, z: s.z + 0.5 } });
		platform(bot);
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const first = bot.walkTo({ x: s.x + 9.5, z: s.z + 0.5 });
			await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 2);
			const second = bot.walkTo({ x: s.x + 0.5, z: s.z + 2.5 });
			expect(await first).toBe('cancelled');
			await vi.advanceTimersByTimeAsync(POS_EVERY_MS);
			bot.move({ ...bot.pose() });
			expect(await second).toBe('cancelled');
			await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 2);
			vi.useRealTimers();
			await new Promise((r) => setTimeout(r, 20));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});

	it('lookAt and mine do not cancel a walk', async () => {
		const s = PLAT;
		const { bot } = await connected({ spawn: { x: s.x + 0.5, y: s.y, z: s.z + 0.5 } });
		platform(bot);
		let r: string | null = null;
		void bot.walkTo({ x: s.x + 5.5, z: s.z + 0.5 }).then((v) => (r = v));
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS);
		bot.lookAt(s.x, s.y, s.z + 5);
		void bot.mine(s.x - 1, s.y - 1, s.z);
		await vi.advanceTimersByTimeAsync(POS_EVERY_MS * 20);
		expect(r).toBe('arrived');
	});
});

describe('place and break', () => {
	it('places: one edit, journaled, and resolves true', async () => {
		const { bot, ws } = await connected();
		const old = bot.world.getBlock(10, 200, 10);
		await expect(bot.place(10, 200, 10, 'stone')).resolves.toBe(true);
		expect(ws.of('edit')).toEqual([{ t: 'edit', cid: 1, ops: [[10, 200, 10, STONE, 0, 0]] }]);
		expect(bot.journal()).toEqual([{ x: 10, y: 200, z: 10, oldId: old, newId: STONE, t: Date.now() }]);
	});

	it('places a coloured lamp; a malformed colour throws (a programming error)', async () => {
		const { bot, ws } = await connected();
		await expect(bot.place(10, 200, 10, 'lamp', '#00FF00')).resolves.toBe(true);
		expect(ws.of('edit')[0].ops).toEqual([[10, 200, 10, LAMP, 0, 0x1000000 | 0x00ff00]]);
		expect(() => bot.place(11, 200, 10, 'lamp', 'green')).toThrow(/colour/);
	});

	it('refuses (resolves false, sends nothing): unknown, retired, bedrock, air, above catalogMax, out of the world', async () => {
		const { bot, ws } = await connected({ catalogMax: 999 });
		const retired = BLOCKS.find((b) => b.retired)!;
		const high = BLOCKS.filter((b) => !b.retired && b.id > 999)[0];
		expect(high).toBeDefined();
		for (const [name, y] of [['no_such', 200], [retired.name, 200], ['bedrock', 200], ['air', 200], [high.name, 200], ['stone', 256], ['stone', -1]] as const) {
			await expect(bot.place(10, y, 10, name), name).resolves.toBe(false);
		}
		expect(ws.of('edit')).toEqual([]);
		expect(bot.journal()).toEqual([]);
	});

	it("refuses a cell inside a kid's body box (x±0.3, z±0.3, feet to head), not a bot's, not a kid without a pose", async () => {
		const { bot, ws } = await connected({
			players: [kid(2, 10.8, 100.5, 20.1), kid(3, 30.5, 100, 30.5, { bot: true }), kid(4, 40.5, 100, 40.5, { hasPos: false })],
		});
		// Kid 2 covers x 10..11 (10.5–11.1), y 100..102 (100.5–102.3), z 19..20 (19.8–20.4).
		for (const [x, y, z] of [[10, 100, 20], [11, 100, 19], [11, 102, 20], [10, 101, 19]]) {
			await expect(bot.place(x, y, z, 'stone'), `${x},${y},${z}`).resolves.toBe(false);
		}
		for (const [x, y, z] of [[12, 100, 20], [10, 99, 20], [10, 103, 20], [10, 100, 21], [9, 100, 20]]) {
			await expect(bot.place(x, y, z, 'stone'), `${x},${y},${z}`).resolves.toBe(true);
		}
		await expect(bot.place(30, 100, 30, 'stone')).resolves.toBe(true);
		await expect(bot.place(40, 100, 40, 'stone')).resolves.toBe(true);
		expect(ws.of('edit').length).toBe(7);
	});

	it('waits editGapMs between edits (promise chain)', async () => {
		const { bot, ws } = await connected({ over: { editGapMs: undefined } }); // the default, 150
		const times: number[] = [];
		const orig = ws.send.bind(ws);
		ws.send = (d: string) => {
			if (JSON.parse(d).t === 'edit') times.push(Date.now());
			orig(d);
		};
		const all = Promise.all([bot.place(10, 200, 10, 'stone'), bot.place(11, 200, 10, 'stone'), bot.break(10, 200, 10)]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await all).toEqual([true, true, true]);
		expect(times).toHaveLength(3);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(150);
		expect(times[2] - times[1]).toBeGreaterThanOrEqual(150);
	});

	it('editGapMs 0 is allowed', async () => {
		const { bot, ws } = await connected({ over: { editGapMs: 0 } });
		await Promise.all([bot.place(10, 200, 10, 'stone'), bot.place(11, 200, 10, 'stone')]);
		expect(ws.of('edit')).toHaveLength(2);
	});

	it('break resolves true when sent, false for bedrock or air already', async () => {
		const { bot, ws } = await connected({ cells: [[10, 200, 10, STONE, 0, 0], [11, 200, 10, BEDROCK, 0, 0]] });
		await expect(bot.break(10, 200, 10)).resolves.toBe(true);
		await vi.advanceTimersByTimeAsync(200);
		await expect(bot.break(11, 200, 10)).resolves.toBe(false);
		await expect(bot.break(12, 200, 10)).resolves.toBe(false);
		expect(ws.of('edit').map((m) => m.ops)).toEqual([[[10, 200, 10, AIR, 0, 0]]]);
	});

	it('persists the journal to statePath', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'minicraft-bot-state-'));
		tmpDirs.push(dir);
		const statePath = join(dir, 'state.json');
		const { bot } = await connected({ over: { statePath } });
		await bot.place(10, 200, 10, 'stone');
		const saved = JSON.parse(readFileSync(statePath, 'utf8'));
		expect(saved.bid).toBe('bot-' + fnvHex('Robo'));
		expect(saved.journal).toEqual(bot.journal());
		expect(saved.journal).toHaveLength(1);
		expect(saved.world).toBe('world-1');
		// A restarted bot loads the journal.
		const again = await connected({ over: { statePath } });
		expect(again.bot.journal()).toEqual(saved.journal);
		// …but never uses it in another world (reverting there would change a kid's world).
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const other = client({ statePath });
		const p = other.connect({ world: 'world-2', name: 'Robo', skin: 'enderman' });
		FakeWS.last.open();
		FakeWS.last.recv(welcome());
		FakeWS.last.recvBin(snapshot());
		await p;
		expect(other.journal()).toEqual([]);
		expect(warn).toHaveBeenCalledOnce();
		expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ world: 'world-2', journal: [] });
	});
});

describe('mine', () => {
	it('faces the block, sends fx mine {tier, dur}, waits dur, then breaks', async () => {
		const { bot, ws } = await connected({ spawn: { x: 10.5, y: 200, z: 10.5 }, cells: [[12, 201, 10, STONE, 0, 0]] });
		const dur = Math.round(miningDuration(BLOCKS[STONE].hardness, 0, 'none') * 1000);
		expect(dur).toBeGreaterThan(0);
		let r: boolean | null = null;
		void bot.mine(12, 201, 10).then((v) => (r = v));
		expect(ws.of('fx')).toEqual([{ t: 'fx', kind: 'mine', x: 12, y: 201, z: 10, tier: STONE, dur }]);
		const p = bot.pose();
		expect(p.yaw).toBeCloseTo(Math.atan2(-(12.5 - 10.5), -(10.5 - 10.5)), 9);
		expect(p.pitch).toBeCloseTo(Math.atan2(201.5 - (200 + EYE_HEIGHT), 2), 9);
		await vi.advanceTimersByTimeAsync(dur - 1);
		await flush();
		expect(ws.of('edit')).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await flush();
		expect(ws.of('edit').map((m) => m.ops)).toEqual([[[12, 201, 10, AIR, 0, 0]]]);
		expect(r).toBe(true);
	});

	it('ms overrides the duration, and dur is what it waits', async () => {
		const { bot, ws } = await connected({ cells: [[12, 201, 10, STONE, 0, 0]] });
		void bot.mine(12, 201, 10, 40);
		expect(ws.of('fx')[0]).toMatchObject({ dur: 40 });
		await vi.advanceTimersByTimeAsync(39);
		await flush();
		expect(ws.of('edit')).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await flush();
		expect(ws.of('edit')).toHaveLength(1);
	});

	it('refuses bedrock and air (false, no fx)', async () => {
		const { bot, ws } = await connected({ cells: [[12, 201, 10, BEDROCK, 0, 0]] });
		await expect(bot.mine(12, 201, 10)).resolves.toBe(false);
		await expect(bot.mine(13, 201, 10)).resolves.toBe(false);
		expect(ws.of('fx')).toEqual([]);
	});

	it('a new mine cancels the old one: mine-stop, and the old resolves false', async () => {
		const { bot, ws } = await connected({ cells: [[12, 201, 10, STONE, 0, 0], [13, 201, 10, DIRT, 0, 0]] });
		const first = bot.mine(12, 201, 10);
		await vi.advanceTimersByTimeAsync(50);
		const second = bot.mine(13, 201, 10);
		expect(await first).toBe(false);
		expect(ws.of('fx').map((m) => [m.kind, m.x])).toEqual([['mine', 12], ['mine-stop', 12], ['mine', 13]]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await second).toBe(true);
		expect(bot.world.getBlock(12, 201, 10)).toBe(STONE);
	});

	it('close cancels a mine: mine-stop, false', async () => {
		const { bot, ws } = await connected({ cells: [[12, 201, 10, STONE, 0, 0]] });
		const m = bot.mine(12, 201, 10);
		const closes: number[] = [];
		bot.on('close', (c) => closes.push(c));
		bot.close();
		expect(await m).toBe(false);
		expect(ws.of('fx').map((f) => f.kind)).toEqual(['mine', 'mine-stop']);
		expect(ws.closedWith).toBe(1000);
		expect(closes).toEqual([1000]);
		expect(() => bot.place(1, 200, 1, 'stone')).toThrow(NotConnectedError);
	});
});

describe('revert', () => {
	it("skips a cell a kid overwrote, and doesn't journal its own writes", async () => {
		const { bot, ws } = await connected({ over: { editGapMs: 0 } });
		const a0 = bot.world.getBlock(10, 200, 10), b0 = bot.world.getBlock(11, 200, 10);
		await bot.place(10, 200, 10, 'stone');
		await bot.place(11, 200, 10, 'stone');
		ws.recv({ t: 'edit', seq: 5, by: 9, ops: [[11, 200, 10, DIRT, 0, 0]] });
		expect(await bot.revert()).toBe(1);
		expect(bot.world.getBlock(10, 200, 10)).toBe(a0);
		expect(bot.world.getBlock(11, 200, 10)).toBe(DIRT);
		expect(b0).not.toBe(DIRT);
		expect(bot.journal()).toEqual([]);
		expect(ws.of('edit').at(-1)!.ops).toEqual([[10, 200, 10, a0, 0, 0]]);
	});

	it('one cell edited A→B→C by the bot ends at A (newest-first)', async () => {
		const { bot } = await connected({ over: { editGapMs: 0 } });
		const a = bot.world.getBlock(10, 200, 10);
		await bot.place(10, 200, 10, 'stone');
		await bot.place(10, 200, 10, 'dirt');
		expect(await bot.revert()).toBe(2);
		expect(bot.world.getBlock(10, 200, 10)).toBe(a);
	});

	it("doesn't restore a solid block into a kid's body; the entry is kept for a later revert", async () => {
		const { bot, ws } = await connected({ players: [kid(2, 50.5, 150, 50.5)], cells: [[10, 200, 10, STONE, 0, 0]] });
		await bot.break(10, 200, 10);
		ws.recv({ t: 'tick', poses: [[2, 10.5, 199.5, 10.5, 0, 0]] }); // the kid steps into the hole
		expect(await bot.revert()).toBe(0);
		expect(bot.world.getBlock(10, 200, 10)).toBe(AIR);
		expect(bot.journal()).toHaveLength(1);
		ws.recv({ t: 'tick', poses: [[2, 20.5, 199.5, 20.5, 0, 0]] }); // and out again
		expect(await bot.revert()).toBe(1);
		expect(bot.world.getBlock(10, 200, 10)).toBe(STONE);
		expect(bot.journal()).toEqual([]);
	});

	it('sinceMs (a Date.now() timestamp) reverts only the edits made at or after it', async () => {
		const { bot } = await connected({ over: { editGapMs: 0 } });
		const a = bot.world.getBlock(10, 200, 10);
		await bot.place(10, 200, 10, 'stone');
		await vi.advanceTimersByTimeAsync(1000);
		const since = Date.now();
		await bot.place(11, 200, 10, 'stone');
		expect(await bot.revert(since)).toBe(1);
		expect(bot.world.getBlock(11, 200, 10)).toBe(a);
		expect(bot.world.getBlock(10, 200, 10)).toBe(STONE);
		expect(bot.journal()).toHaveLength(1);
	});
});

describe('events', () => {
	it('emits join, left, edit, fx, leaving', async () => {
		const { bot, ws } = await connected();
		const got: string[] = [];
		bot.on('join', (p) => got.push(`join ${p.name}`));
		bot.on('left', (id) => got.push(`left ${id}`));
		bot.on('edit', (m) => got.push(`edit ${m.by}`));
		bot.on('fx', (m) => got.push(`fx ${m.kind}`));
		const off = bot.on('leaving', (m) => got.push(`leaving ${m.secondsLeft}`));
		ws.recv({ t: 'join', id: 8, name: 'Noah', skin: 'steve' });
		ws.recv({ t: 'edit', seq: 1, by: 8, ops: [[1, 200, 1, STONE, 0, 0]] });
		ws.recv({ t: 'fx', kind: 'boom', x: 1, y: 2, z: 3, by: 8 });
		ws.recv({ t: 'leaving', secondsLeft: 10, by: 8 });
		off();
		ws.recv({ t: 'leaving', secondsLeft: 0, by: 8 });
		ws.recv({ t: 'left', id: 8 });
		expect(got).toEqual(['join Noah', 'edit 8', 'fx boom', 'leaving 10', 'left 8']);
	});
});

describe('reconnect', () => {
	it('on a transient close: probes, opens a new socket with resume, the same bid and storage, and resets the same BotWorld', async () => {
		const { bot, ws, res } = await connected({ over: { editGapMs: 0 } });
		const world = bot.world;
		const events: string[] = [];
		bot.on('reconnect', () => events.push('reconnect'));
		bot.on('close', (c) => events.push(`close ${c}`));
		// A resync (4003) is transient; MpClient counts it in the storage it was given.
		ws.serverClose(4003);
		await vi.advanceTimersByTimeAsync(1000);
		await flush();
		expect(FakeWS.all).toHaveLength(2);
		const ws2 = FakeWS.last;
		ws2.open();
		expect(ws2.sent[0]).toMatchObject({ t: 'hello', resume: true, bid: ws.sent[0].bid, bot: true, ver: CLIENT_VERSION });
		// Between the welcome and the snapshot, a read goes to the old world; the snapshot's cell wins after.
		ws2.recv(welcome({ you: 2 }));
		expect(bot.world.getBlock(50, 200, 50)).toBe(AIR);
		ws2.recvBin(snapshot([[50, 200, 50, STONE, 0, 0]]));
		expect(bot.world).toBe(world);
		expect(res.world).toBe(world);
		expect(world.getBlock(50, 200, 50)).toBe(STONE);
		expect(events).toEqual(['reconnect']);
		expect(ws2.of('pos')).toEqual([{ t: 'pos', ...bot.pose() }]);
		await expect(bot.place(51, 200, 50, 'stone')).resolves.toBe(true);
		expect(ws2.of('edit')[0]).toMatchObject({ cid: 1 });
		// The same storage: a second 4003 in a row is the synthetic fatal 4004 → close, no more reconnects.
		ws2.serverClose(4003);
		await vi.advanceTimersByTimeAsync(40_000);
		expect(FakeWS.all).toHaveLength(2);
		expect(events).toEqual(['reconnect', 'close 4004']);
	});

	it('gives up after 30 s without the server: close', async () => {
		const { bot, ws } = await connected();
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
		const closes: number[] = [];
		bot.on('close', (c) => closes.push(c));
		let walk: string | null = null;
		void bot.walkTo({ x: 110, z: 100 }).then((r) => (walk = r));
		ws.serverClose(1006);
		await vi.advanceTimersByTimeAsync(0);
		expect(walk).toBe('cancelled');
		await vi.advanceTimersByTimeAsync(29_999);
		expect(closes).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(closes).toEqual([1006]);
		expect(FakeWS.all).toHaveLength(1);
		expect(() => bot.move(bot.pose())).toThrow(NotConnectedError);
	});

	it('a fatal close after connect: close, no reconnect', async () => {
		const { bot, ws } = await connected();
		const closes: number[] = [];
		bot.on('close', (c) => closes.push(c));
		ws.serverClose(4006);
		await vi.advanceTimersByTimeAsync(40_000);
		expect(closes).toEqual([4006]);
		expect(FakeWS.all).toHaveLength(1);
	});

	it('while reconnecting, place/break/mine resolve false instead of throwing', async () => {
		const { bot, ws } = await connected();
		ws.serverClose(1006);
		await expect(bot.place(1, 200, 1, 'stone')).resolves.toBe(false);
		await expect(bot.break(1, 200, 1)).resolves.toBe(false);
		await expect(bot.mine(1, 200, 1)).resolves.toBe(false);
	});
});

describe('raw fx', () => {
	it('sends a raw fx message', async () => {
		const { bot, ws } = await connected();
		bot.fx({ kind: 'firework', x: 1, y: 2, z: 3 });
		expect(ws.of('fx')).toEqual([{ t: 'fx', kind: 'firework', x: 1, y: 2, z: 3 }]);
	});
});
