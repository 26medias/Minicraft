// Plan Task 5 step 4: BotWorld, the SDK's World + ChunkOverlay pair (spec §6, §12a).
import { describe, expect, it } from 'vitest';
import { BotWorld, blockNames } from '../src/bot-world';
import { World } from '../../../src/engine/world/world';
import { ChunkOverlay } from '../../../src/engine/world/overlay';
import { applyRemoteOps } from '../../../src/engine/world/apply-remote';
import { indexOf } from '../../../src/engine/world/coords';
import { AIR, BLOCKS, BLOCK_BY_NAME, isLiquid, isSolid } from '../../../src/data/blocks.data';
import { colorToInt, type EditMsg, type EditOut, type Op } from '../../../src/net/protocol';
import { SEED, snapshot, welcome } from './fixtures';

const STONE = BLOCK_BY_NAME['stone'].id;
const DIRT = BLOCK_BY_NAME['dirt'].id;
const LAMP = BLOCK_BY_NAME['lamp'].id;
const WATER = BLOCK_BY_NAME['water'].id;
const LEAVES = BLOCKS.filter((b) => !b.retired && b.name.includes('leaves')).map((b) => b.id);

type Change = { x: number; y: number; z: number; oldId: number | null; newId: number; by: number };

function setup(cells: Op[] = [], you = 1) {
	const sent: EditMsg[] = [];
	const world = BotWorld.create(welcome({ you }), snapshot(cells), (m) => sent.push(m as EditMsg), you);
	const changes: Change[] = [];
	const off = world.onBlockChange((x, y, z, oldId, newId, by) => changes.push({ x, y, z, oldId, newId, by }));
	return { world, sent, changes, off };
}

/** The game's own world for seed 12345 (the oracle). */
const oracle = World.create(SEED);

/** Top non-air, non-liquid y of a column in the oracle, or −1. */
function oracleSurface(x: number, z: number): number {
	for (let y = oracle.height - 1; y >= 0; y--) {
		const id = oracle.getBlock(x, y, z);
		if (id !== AIR && !isLiquid(id)) return y;
	}
	return -1;
}

/** A flat, dry, open 5×5 patch near (x0, z0): its ground y (feet level), plus x and z. Deterministic scan. */
function flatSpot(x0 = 200, z0 = 200): { x: number; y: number; z: number } {
	for (let r = 0; r < 120; r++) for (let dx = -r; dx <= r; dx++) for (const dz of [-r, r]) {
		const x = x0 + dx, z = z0 + dz;
		const s = oracleSurface(x, z);
		if (s < 0) continue;
		let ok = true;
		for (let ax = -2; ax <= 2 && ok; ax++) for (let az = -2; az <= 2 && ok; az++) {
			if (oracleSurface(x + ax, z + az) !== s) ok = false;
			const top = oracle.getBlock(x + ax, s, z + az);
			if (!isSolid(top) || LEAVES.includes(top)) ok = false;
			for (let y = s + 1; y <= s + 8; y++) if (oracle.getBlock(x + ax, y, z + az) !== AIR) ok = false;
		}
		if (ok) return { x, y: s + 1, z };
	}
	throw new Error('no flat spot found');
}

describe('BotWorld.create / reset', () => {
	it('loads the snapshot before the world is used, and reset swaps in a fresh world with the new snapshot', () => {
		const { x, y, z } = flatSpot();
		const { world } = setup();
		const generated = world.getBlock(x, y - 1, z);
		const edited = generated === STONE ? DIRT : STONE;
		// A chunk read before the reset stays generated in the OLD world; the reset's new world reads the snapshot.
		world.reset(welcome(), snapshot([[x, y - 1, z, edited, 0, 0]]), 1);
		expect(world.getBlock(x, y - 1, z)).toBe(edited);
	});

	it('create reads snapshot cells', () => {
		const { world } = setup([[10, 100, 10, STONE, 0, 0]]);
		expect(world.getBlock(10, 100, 10)).toBe(STONE);
		expect(world.seed).toBe(SEED);
		expect(world.height).toBe(256);
	});

	it('reset restarts the edit cids (a new MpSync per connection)', () => {
		const { world, sent } = setup();
		world.localSet(5, 120, 5, STONE);
		world.localSet(6, 120, 5, STONE);
		world.reset(welcome(), snapshot(), 1);
		world.localSet(7, 120, 5, STONE);
		expect(sent.map((m) => m.cid)).toEqual([1, 2, 1]);
	});
});

describe('every coordinate API floors x, y, z', () => {
	it('getBlock', () => {
		const { world } = setup([[10, 100, 10, STONE, 0, 0]]);
		expect(world.getBlock(10.9, 100.2, 10.5)).toBe(STONE);
		expect(world.getBlock(-0.5, 100, 10)).toBe(AIR); // floor(−0.5) = −1: out of bounds
	});

	it('groundY, surfaceY, region and findNearest', () => {
		const { x, y, z } = flatSpot();
		const { world } = setup();
		expect(world.groundY(x + 0.7, z + 0.2, y + 0.9)).toBe(world.groundY(x, z, y));
		expect(world.surfaceY(x + 0.99, z + 0.01)).toBe(world.surfaceY(x, z));
		expect([...world.region({ x: x + 0.5, y: y - 1.5, z: z + 0.5 }, { x: x + 1.9, y: y + 0.5, z: z + 1.1 })]).toEqual([
			...world.region({ x, y: y - 2, z }, { x: x + 1, y, z: z + 1 }),
		]);
		expect(world.findNearest('stone', { x: x + 0.6, y: y + 0.6, z: z + 0.6 }, 6)).toEqual(world.findNearest('stone', { x, y, z }, 6));
	});
});

describe('groundY', () => {
	it('under a roof: the floor', () => {
		const { x, y, z } = flatSpot();
		const { world } = setup();
		for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) world.localSet(x + dx, y + 2, z + dz, STONE);
		expect(world.groundY(x, z, y)).toBe(y);
		expect(world.groundY(x, z, y + 0.5)).toBe(y);
	});

	it('under a leaf canopy (synthetic): the ground, not the canopy', () => {
		const { x, y, z } = flatSpot();
		const { world } = setup();
		for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const h of [3, 4]) world.localSet(x + dx, y + h, z + dz, LEAVES[0]);
		expect(world.groundY(x, z, y)).toBe(y);
	});

	it('under a real tree canopy on seed 12345: the ground', () => {
		const { world } = setup();
		let checked = 0;
		for (let x = 150; x < 400 && checked < 3; x += 3) for (let z = 150; z < 400 && checked < 3; z += 3) {
			const s = oracleSurface(x, z);
			if (s < 0 || !LEAVES.includes(oracle.getBlock(x, s, z))) continue;
			// Below the canopy: skip leaves, then an air gap of ≥ 2, then the ground.
			let y = s;
			while (y > 0 && LEAVES.includes(oracle.getBlock(x, y, z))) y--;
			let gap = 0;
			while (y > 0 && oracle.getBlock(x, y, z) === AIR) { y--; gap++; }
			if (gap < 2 || !isSolid(oracle.getBlock(x, y, z)) || LEAVES.includes(oracle.getBlock(x, y, z))) continue;
			const ground = y + 1;
			expect(world.groundY(x, z, ground)).toBe(ground);
			expect(world.groundY(x, z, ground + 0.3)).toBe(ground);
			checked++;
		}
		expect(checked).toBe(3);
	});

	it('near a lake: the lake bed (documented)', () => {
		const { world } = setup();
		let found = false;
		for (let x = 0; x < 512 && !found; x += 7) for (let z = 0; z < 512 && !found; z += 7) {
			let top = -1;
			for (let y = oracle.height - 1; y >= 0; y--) if (oracle.getBlock(x, y, z) !== AIR) { top = y; break; }
			if (top < 0 || oracle.getBlock(x, top, z) !== WATER) continue;
			let y = top;
			while (y > 0 && oracle.getBlock(x, y, z) === WATER) y--;
			if (top - y > 50 || !isSolid(oracle.getBlock(x, y, z))) continue;
			expect(world.groundY(x, z, top + 1)).toBe(y + 1);
			found = true;
		}
		expect(found).toBe(true);
	});

	it('a one-high gap is not standable (the head cell must be free)', () => {
		const { x, y, z } = flatSpot();
		const { world } = setup();
		for (let h = 1; h <= 3; h++) world.localSet(x, y + h, z, STONE);
		expect(world.groundY(x, z, y)).not.toBe(y);
	});

	it('none within 64 below: null (and out of the world: null)', () => {
		const { x, y, z } = flatSpot();
		const { world } = setup();
		expect(world.groundY(x, z, y + 100)).toBeNull();
		expect(world.groundY(-10, z, y)).toBeNull();
	});
});

describe('surfaceY', () => {
	it('is the topmost non-air, non-liquid block, or −1', () => {
		const { x, y, z } = flatSpot();
		const { world } = setup();
		expect(world.surfaceY(x, z)).toBe(y - 1);
		world.localSet(x, y + 5, z, STONE);
		expect(world.surfaceY(x, z)).toBe(y + 5);
		expect(world.surfaceY(-3, 5)).toBe(-1);
	});
});

describe('region', () => {
	it('indexes (y−y0)·dx·dz + (z−z0)·dx + (x−x0), bounds inclusive', () => {
		const { x, y, z } = flatSpot();
		const { world } = setup();
		world.localSet(x + 2, y + 1, z + 1, LAMP, '#FF0000');
		const min = { x, y: y - 3, z }, max = { x: x + 3, y: y + 2, z: z + 2 };
		const r = world.region(min, max);
		const dx = 4, dz = 3;
		expect(r).toBeInstanceOf(Uint16Array);
		expect(r.length).toBe(4 * 6 * 3);
		for (let yy = min.y; yy <= max.y; yy++) for (let zz = min.z; zz <= max.z; zz++) for (let xx = min.x; xx <= max.x; xx++) {
			expect(r[(yy - min.y) * dx * dz + (zz - min.z) * dx + (xx - min.x)]).toBe(world.getBlock(xx, yy, zz));
		}
		expect(r[(y + 1 - min.y) * dx * dz + 1 * dx + 2]).toBe(LAMP);
	});

	it('allows 32 per side and throws beyond', () => {
		const { world } = setup();
		expect(world.region({ x: 0, y: 100, z: 0 }, { x: 31, y: 131, z: 31 }).length).toBe(32 ** 3);
		expect(() => world.region({ x: 0, y: 100, z: 0 }, { x: 32, y: 100, z: 0 })).toThrow(/32/);
		expect(() => world.region({ x: 0, y: 100, z: 0 }, { x: 0, y: 132, z: 0 })).toThrow(/32/);
		expect(() => world.region({ x: 0, y: 100, z: 0 }, { x: 0, y: 100, z: 32 })).toThrow(/32/);
	});
});

describe('findNearest', () => {
	it('is deterministic regardless of which chunks were read before', () => {
		const { x, y, z } = flatSpot();
		const a = setup().world;
		const b = setup().world;
		// b reads only its own chunk first; a reads nothing. An implementation scanning loaded chunks only would differ.
		b.getBlock(x, y, z);
		for (const name of ['coal_ore', 'water', 'oak_log', 'stone']) {
			expect(b.findNearest(name, { x, y, z }, 32), name).toEqual(a.findNearest(name, { x, y, z }, 32));
		}
	});

	it('returns the nearest cell, ties by (y, z, x) order, or null; the radius is clamped to 32', () => {
		const { x, y, z } = flatSpot();
		const { world } = setup();
		const GOLD = BLOCK_BY_NAME['gold_block'].id;
		// Two cells at the same distance 3: (x, y+3, z) and (x+3, y, z)… order (y, z, x) picks the lower y first.
		world.localSet(x + 3, y, z, GOLD);
		world.localSet(x, y + 3, z, GOLD);
		expect(world.findNearest('gold_block', { x, y, z }, 5)).toEqual({ x: x + 3, y, z });
		world.localSet(x - 2, y, z, GOLD);
		expect(world.findNearest('gold_block', { x, y, z }, 5)).toEqual({ x: x - 2, y, z });
		expect(world.findNearest('gold_block', { x, y, z }, 1)).toBeNull();
		expect(world.findNearest('no_such_block', { x, y, z }, 5)).toBeNull();
		world.localSet(x + 40, y, z, BLOCK_BY_NAME['diamond_block'].id);
		expect(world.findNearest('diamond_block', { x, y, z }, 100)).toBeNull();
	});
});

describe('blockNames', () => {
	it('lists every catalog name except retired ids', () => {
		const names = blockNames();
		expect(names).toContain('stone');
		expect(names).toContain('lamp');
		expect(names.some((n) => n.startsWith('retired_'))).toBe(false);
		expect(names.length).toBe(BLOCKS.filter((b) => !b.retired).length);
	});
});

describe('localSet', () => {
	it('writes, flushes one edit, and fires onBlockChange with by = you', () => {
		const { world, sent, changes } = setup([], 7);
		const before = world.getBlock(3, 200, 3);
		world.localSet(3, 200, 3, STONE);
		expect(sent).toEqual([{ t: 'edit', cid: 1, ops: [[3, 200, 3, STONE, 0, 0]] }]);
		expect(changes).toEqual([{ x: 3, y: 200, z: 3, oldId: before, newId: STONE, by: 7 }]);
		expect(world.getBlock(3, 200, 3)).toBe(STONE);
	});

	it('sends a lamp colour and validates it; a colour on another block is ignored', () => {
		const { world, sent } = setup();
		world.localSet(3, 200, 3, LAMP, '#FF8A99');
		expect(sent[0].ops[0][5]).toBe(colorToInt('#FF8A99'));
		expect(() => world.localSet(4, 200, 3, LAMP, 'red')).toThrow(/colour/);
		world.localSet(5, 200, 3, STONE, 'not a colour');
		expect(sent[sent.length - 1].ops[0][5]).toBe(0);
		// Replacing the lamp drops its colour.
		world.localSet(3, 200, 3, STONE);
		expect(sent[sent.length - 1].ops[0]).toEqual([3, 200, 3, STONE, 0, 0]);
	});
});

describe('onBlockChange', () => {
	it('fires for an applied remote op with the author as by', () => {
		const { world, changes } = setup();
		world.getBlock(3, 200, 3);
		world.onServerEdit({ t: 'edit', seq: 1, by: 9, ops: [[3, 200, 3, STONE, 0, 0]] });
		expect(changes).toEqual([{ x: 3, y: 200, z: 3, oldId: AIR, newId: STONE, by: 9 }]);
		expect(world.getBlock(3, 200, 3)).toBe(STONE);
	});

	it('an op on a chunk not generated yet fires with oldId null, and later reads see it', () => {
		const { world, changes } = setup();
		world.onServerEdit({ t: 'edit', seq: 1, by: 9, ops: [[300, 200, 300, STONE, 0, 0]] });
		expect(changes).toEqual([{ x: 300, y: 200, z: 300, oldId: null, newId: STONE, by: 9 }]);
		expect(world.getBlock(300, 200, 300)).toBe(STONE);
	});

	it('an op that changes nothing does not fire', () => {
		const { world, changes } = setup();
		world.getBlock(3, 200, 3);
		world.onServerEdit({ t: 'edit', seq: 1, by: 9, ops: [[3, 200, 3, AIR, 0, 0]] });
		expect(changes).toEqual([]);
	});

	it("the echo of the bot's own write does not fire a second time", () => {
		const { world, changes } = setup([], 1);
		world.localSet(3, 200, 3, STONE);
		world.onServerEdit({ t: 'edit', seq: 1, by: 1, cid: 1, ops: [[3, 200, 3, STONE, 0, 0]] });
		expect(changes.map((c) => c.by)).toEqual([1]);
	});

	it("…unless a kid's write landed in between: the echo re-applies and fires once more (correct: the cell changed back)", () => {
		const { world, changes } = setup([], 1);
		world.localSet(3, 200, 3, STONE);
		world.onServerEdit({ t: 'edit', seq: 1, by: 9, ops: [[3, 200, 3, DIRT, 0, 0]] });
		world.onServerEdit({ t: 'edit', seq: 2, by: 1, cid: 1, ops: [[3, 200, 3, STONE, 0, 0]] });
		expect(changes.map((c) => [c.by, c.oldId, c.newId])).toEqual([[1, AIR, STONE], [9, STONE, DIRT], [1, DIRT, STONE]]);
		expect(world.getBlock(3, 200, 3)).toBe(STONE);
	});

	it('returns an unsubscribe function', () => {
		const { world, changes, off } = setup();
		off();
		world.localSet(3, 200, 3, STONE);
		expect(changes).toEqual([]);
	});
});

// ── Parity with the game's World (spec §9.6) ──

/** The game's receiving path: World + ChunkOverlay + applyRemoteOps (GameLoop's drain). */
function gameReceiver(seed = SEED) {
	const w = new World(seed, { height: 256, genVersion: 3, saveVersion: 3 });
	const overlay = new ChunkOverlay();
	w.overlay = overlay;
	return { w, apply: (ops: Op[]) => applyRemoteOps(w, overlay, ops) };
}

describe('parity with the game World', () => {
	it('the mp-sync.test.ts T7 echo sequence ends where the game ends', () => {
		const { world, changes } = setup([], 7);
		const game = gameReceiver();
		const Y = 70;
		// The game side of T7: the author's own writes, then echo1, a foreign op, echo2 through the echo rule.
		world.localSet(5, Y, 5, STONE);
		world.localSet(5, Y, 5, AIR);
		game.w.setBlock(5, Y, 5, STONE);
		game.w.setBlock(5, Y, 5, AIR);
		const msgs: EditOut[] = [
			{ t: 'edit', seq: 1, by: 7, cid: 1, ops: [[5, Y, 5, STONE, 0, 0]] },
			{ t: 'edit', seq: 2, by: 9, ops: [[5, Y, 5, DIRT, 0, 0]] },
			{ t: 'edit', seq: 3, by: 7, cid: 2, ops: [[5, Y, 5, AIR, 0, 0]] },
		];
		world.onServerEdit(msgs[0]);
		// mp-sync.test.ts's "never applies the stale stone echo (no flicker)": echo 1 is skipped (cid 2 is pending).
		expect(world.getBlock(5, Y, 5)).toBe(AIR);
		world.onServerEdit(msgs[1]);
		world.onServerEdit(msgs[2]);
		expect(changes.filter((c) => c.newId === STONE).map((c) => c.by)).toEqual([7]);
		// mp-sync.test.ts's assertion: the final value is the author's mine (AIR), never the stale stone.
		game.apply([[5, Y, 5, DIRT, 0, 0]]);
		game.apply([[5, Y, 5, AIR, 0, 0]]);
		expect(world.getBlock(5, Y, 5)).toBe(AIR);
		expect(world.getBlock(5, Y, 5)).toBe(game.w.getBlock(5, Y, 5));
	});

	it('a liquid op stream (mp-liquid.test.ts style: a pour spreading under the real scheduler) lands identically', async () => {
		const { LiquidScheduler } = await import('../../../src/game/liquid-scheduler');
		const { x, y, z } = flatSpot(260, 260);
		// The author: the game's World and LiquidScheduler, flushing touched cells once per tick like MpSync.
		const src = new World(SEED, { height: 256, genVersion: 3, saveVersion: 3 });
		const touched = new Set<string>();
		src.onLocalWrite = (a, b, c) => touched.add(`${a},${b},${c}`);
		const sched = new LiquidScheduler(src, () => {});
		src.setBlock(x, y, z, WATER);
		const batches: Op[][] = [];
		const flush = () => {
			if (touched.size === 0) return;
			batches.push([...touched].map((k) => {
				const [a, b, c] = k.split(',').map(Number);
				const ch = src.getChunk(Math.floor(a / 16), Math.floor(c / 16))!;
				const i = indexOf(a & 15, b, c & 15);
				return [a, b, c, ch.blocks[i], ch.fluidMeta.get(i) ?? 0, 0] as Op;
			}));
			touched.clear();
		};
		for (let t = 0; t < 600; t++) { sched.tick(1 / 60); flush(); }
		flush();
		expect(batches.length).toBeGreaterThan(3);

		// Receivers: the bot (chunk loaded half-way through, so both the chunk and the overlay path run) and the game.
		const { world } = setup([], 1);
		const game = gameReceiver();
		game.w.getBlock(x, y, z);
		batches.forEach((ops, i) => {
			if (i === 2) world.getBlock(x, y, z);
			world.onServerEdit({ t: 'edit', seq: i + 1, by: 9, ops });
			game.apply(ops);
		});
		const cells = new Set(batches.flat().map((op) => `${op[0]},${op[1]},${op[2]}`));
		expect(cells.size).toBeGreaterThan(5);
		for (const k of cells) {
			const [a, b, c] = k.split(',').map(Number);
			expect(world.getBlock(a, b, c), k).toBe(game.w.getBlock(a, b, c));
			expect(world.getBlock(a, b, c), k).toBe(src.getBlock(a, b, c));
		}
	});
});
