// Crafting spec §7 / §11: GameLoop.removeBlocks against today's per-block path, and TNT on top of it.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeLoop } from './test-loop';
import { AIR, BLOCKS, BLOCK_BY_NAME, isSolid, type BlockId } from '../data/blocks.data';
import { LightRegistry } from '../engine/render/light-registry';
import { TNT_CHAIN_FUSE, TNT_PRIME_FUSE } from './tnt';
import type { GameLoop } from './loop';
import type { World } from '../engine/world/world';
import type { Chunk } from '../engine/world/chunk';

const tnt = BLOCK_BY_NAME['tnt'].id, stone = BLOCK_BY_NAME['stone'].id, lamp = BLOCK_BY_NAME['lamp'].id;
const water = BLOCK_BY_NAME['water'].id, bedrock = BLOCK_BY_NAME['bedrock'].id;
type Cell = { x: number; y: number; z: number };
type Lanes = { editLane: Set<number>; bulkLane?: Set<number>; shadowOnly: Set<number> };
const lanes = (loop: GameLoop) => loop as unknown as Lanes;

/**
 * FROZEN COPY of today's TNT path (3114ce7), kept here because production no longer contains it (spec §11):
 * detonate()'s cell selection at TNT_RADIUS 3, and GameLoop.detonateAt's per-block removal loop.
 */
const FROZEN_RADIUS = 3;
function frozenDetonateCells(world: World, ox: number, oy: number, oz: number): Cell[] {
	const destroyed: Cell[] = [];
	if (world.inBounds(ox, oy, oz) && isSolid(world.getBlock(ox, oy, oz))) destroyed.push({ x: ox, y: oy, z: oz });
	for (let dy = -FROZEN_RADIUS; dy <= FROZEN_RADIUS; dy++) {
		for (let dz = -FROZEN_RADIUS; dz <= FROZEN_RADIUS; dz++) {
			for (let dx = -FROZEN_RADIUS; dx <= FROZEN_RADIUS; dx++) {
				if (dx === 0 && dy === 0 && dz === 0) continue;
				if (dx * dx + dy * dy + dz * dz > FROZEN_RADIUS * FROZEN_RADIUS) continue;
				const x = ox + dx, y = oy + dy, z = oz + dz;
				if (!world.inBounds(x, y, z)) continue;
				const id = world.getBlock(x, y, z);
				if (id === tnt) continue; // primed, never destroyed (the fixtures hold no other TNT)
				if (isSolid(id) && (BLOCKS[id]?.hardness ?? 0) > 0) destroyed.push({ x, y, z });
			}
		}
	}
	return destroyed;
}
function frozenDetonateAtLoop(loop: GameLoop, world: World, lights: LightRegistry, destroyed: Cell[]): void {
	for (const { x, y, z } of destroyed) {
		if (world.getBlock(x, y, z) === lamp) lights.remove(x, y, z);
		world.setBlock(x, y, z, AIR);
		loop.markChunkDirtyAround(x, z);
		loop.applyLightUpdate(x, y, z);
	}
}

function fnv(a: ArrayBufferView): number {
	const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	let h = 2166136261 >>> 0;
	for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
	return h;
}
function chunkState(c: Chunk) {
	return { blocks: fnv(c.blocks), lights: fnv(c.lights), modified: c.modified, frontier: [...c.liquidFrontier].sort((a, b) => a - b).join(',') };
}
const top = (world: World, x: number, z: number) => { for (let y = world.height - 1; y > 0; y--) if (isSolid(world.getBlock(x, y, z))) return y; return 0; };
/** Lamp placed as the game places one: block, registry colour, light update (lanes are cleared before the blast). */
function placeLamp(loop: GameLoop, world: World, lights: LightRegistry, p: Cell): void {
	world.setBlock(p.x, p.y, p.z, lamp);
	lights.add(p.x, p.y, p.z, '#ff8800');
	loop.applyLightUpdate(p.x, p.y, p.z);
}

/** Seed-3 world; spawn chunk (21, 12). Each fixture returns the TNT origin; it runs identically on both loops. */
type Fixture = { name: string; build: (loop: GameLoop, world: World, lights: LightRegistry) => Cell; probe?: (world: World, o: Cell) => void };
const FIXTURES: Fixture[] = [
	{ name: 'interior', build: (_l, w) => { const x = 21 * 16 + 8, z = 12 * 16 + 8; return { x, y: top(w, x, z) - 2, z }; } },
	{ name: 'chunk corner (lx = lz = 0: four chunks)', build: (_l, w) => { const x = 22 * 16, z = 13 * 16; return { x, y: top(w, x, z) - 2, z }; } },
	{
		// Catches a whole-chunk relight: the hole is in chunk 22, the lamp lights it from chunk 21.
		name: 'a lamp in a neighbour chunk shining into the hole',
		build: (l, w, lights) => {
			const x = 22 * 16 + 2, z = 12 * 16 + 8, y = top(w, x, z) - 15;
			placeLamp(l, w, lights, { x: x - 4, y, z }); // lx 14 of chunk 21; the blast opens lx 15 beside it
			return { x, y, z };
		},
		probe: (w, o) => {
			const c = w.getChunk(22, 12)!;
			expect(c.getBlockR(0, o.y, o.z & 15)).toBeGreaterThan(0); // lamp light crossed the border into the hole
		},
	},
	{
		// Catches a bounding-box relight: sky light must fall 35 blocks below the blast's box.
		name: 'a blast opening the roof of a sealed shaft 36 deep',
		build: (_l, w) => {
			const x = 21 * 16 + 8, z = 13 * 16 + 8, t = top(w, x, z);
			for (let y = t - 40; y <= t - 5; y++) w.setBlock(x, y, z, AIR);
			return { x, y: t - 2, z };
		},
		probe: (w, o) => {
			const c = w.getChunk(21, 13)!;
			expect(c.getSky(8, o.y - 38, 8)).toBeGreaterThan(0);
		},
	},
	{
		name: 'a lamp inside the blast',
		build: (l, w, lights) => {
			const x = 20 * 16 + 8, z = 12 * 16 + 8, y = top(w, x, z) - 12;
			placeLamp(l, w, lights, { x: x + 1, y, z });
			return { x, y, z };
		},
		probe: (w, o) => {
			expect(w.getBlock(o.x + 1, o.y, o.z)).toBe(AIR);
		},
	},
];

function run(path: 'old' | 'new', f: Fixture) {
	const lights = new LightRegistry(new THREE.Scene());
	const h = makeLoop({ seed: 3, lights });
	const o = f.build(h.loop, h.world, lights);
	h.world.setBlock(o.x, o.y, o.z, tnt);
	const L = lanes(h.loop);
	L.editLane.clear(); L.bulkLane?.clear(); L.shadowOnly.clear();
	const cells = frozenDetonateCells(h.world, o.x, o.y, o.z);
	if (path === 'old') frozenDetonateAtLoop(h.loop, h.world, lights, cells);
	else h.loop.removeBlocks(cells, o);
	const chunks = new Map<string, ReturnType<typeof chunkState>>();
	for (const c of h.world.allChunks()) chunks.set(`${c.cx},${c.cz}`, chunkState(c));
	const queued = [...new Set([...L.editLane, ...(L.bulkLane ?? []), ...L.shadowOnly])].sort((a, b) => a - b);
	return { h, o, cells, chunks, queued, lampColor: lights.getColor(o.x + 1, o.y, o.z) };
}

describe('removeBlocks is equivalent to today\'s per-block TNT path (crafting spec §11)', () => {
	for (const f of FIXTURES) {
		it(`${f.name}: every loaded chunk's blocks, light, modified and liquid frontier match; lanes union = old edit + shadow-only`, () => {
			const a = run('old', f), b = run('new', f);
			expect(b.cells.length).toBeGreaterThan(10); // non-vacuous: the blast removed something
			f.probe?.(b.h.world, b.o);
			expect([...b.chunks.keys()].sort()).toEqual([...a.chunks.keys()].sort());
			const diff: string[] = [];
			for (const [k, s] of a.chunks) {
				const t = b.chunks.get(k)!;
				for (const field of ['blocks', 'lights', 'modified', 'frontier'] as const) if (s[field] !== t[field]) diff.push(`${k}:${field}`);
			}
			expect(diff).toEqual([]);
			expect(b.queued).toEqual(a.queued);
			expect(b.lampColor).toBe(a.lampColor);
		}, 60_000);
	}
});

describe('TNT through removeBlocks (crafting spec §2, §7)', () => {
	// makeLoop() clears chunk (16,16) = x,z 256..271 of a 64-high v1 world: open air.
	it('a lone TNT fires onBlocksRemoved once with the stone it broke and without its own cell (catches reporting removeBlocks\' whole result: the TNT would count itself)', () => {
		const { loop, world } = makeLoop();
		const calls: Array<Array<{ blockId: BlockId }>> = [];
		loop.onBlocksRemoved = (removed) => calls.push(removed);
		world.setBlock(260, 40, 260, tnt);
		world.setBlock(261, 40, 260, stone);
		expect(loop.ignite({ x: 260, y: 40, z: 260, face: 'py', distance: 1 })).toBe(true);
		loop.simulate(TNT_PRIME_FUSE + 0.1);
		expect(world.getBlock(260, 40, 260)).toBe(AIR);
		expect(calls).toHaveLength(1);
		expect(calls[0].map((r) => r.blockId)).toEqual([stone]);
	});

	it('a chained TNT is primed, not removed or reported, then goes off itself (catches a blast that removes TNT in its radius)', () => {
		const { loop, world } = makeLoop();
		const ids: BlockId[] = [];
		loop.onBlocksRemoved = (removed) => ids.push(...removed.map((r) => r.blockId));
		world.setBlock(260, 40, 260, tnt);
		world.setBlock(262, 40, 260, tnt);
		world.setBlock(265, 40, 260, stone); // 5 from the first, 3 from the second
		loop.ignite({ x: 260, y: 40, z: 260, face: 'py', distance: 1 });
		loop.simulate(TNT_PRIME_FUSE + 0.1);
		expect(world.getBlock(262, 40, 260)).toBe(tnt);
		expect(ids).toEqual([]);
		loop.simulate(TNT_CHAIN_FUSE + 0.05);
		expect(world.getBlock(262, 40, 260)).toBe(AIR);
		expect(world.getBlock(265, 40, 260)).toBe(AIR);
		expect(ids).toEqual([stone]);
	});

	it('removeBlocks skips out-of-bounds, air, liquid and bedrock cells, and a primed TNT in the batch loses its fuse (catches a batch that writes bedrock or water to air, or leaves the fuse to blow up the ring)', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, stone);
		world.setBlock(261, 40, 260, water);
		world.setBlock(262, 40, 260, bedrock);
		world.setBlock(263, 40, 260, tnt);
		world.setBlock(266, 40, 260, stone); // 3 from the TNT: a leaked fuse would remove it
		expect(loop.ignite({ x: 263, y: 40, z: 260, face: 'py', distance: 1 })).toBe(true);
		const cells = [{ x: -1, y: 40, z: 260 }, { x: 260, y: 64, z: 260 }, { x: 259, y: 40, z: 260 }, { x: 260, y: 40, z: 260 }, { x: 261, y: 40, z: 260 }, { x: 262, y: 40, z: 260 }, { x: 263, y: 40, z: 260 }];
		const { removed } = loop.removeBlocks(cells, { x: 260, y: 40, z: 260 });
		expect(removed).toEqual([{ x: 260, y: 40, z: 260, blockId: stone }, { x: 263, y: 40, z: 260, blockId: tnt }]);
		expect(world.getBlock(261, 40, 260)).toBe(water);
		expect(world.getBlock(262, 40, 260)).toBe(bedrock);
		loop.simulate(TNT_PRIME_FUSE + 0.5);
		expect(world.getBlock(266, 40, 260)).toBe(stone);
	});
});
it('water next to a removed wall flows into the hole (catches removeBlocks writing through chunk.set, which skips the liquid wake-up)', () => {
	const h = makeLoop();
	const stone = BLOCK_BY_NAME['stone'].id, water = BLOCK_BY_NAME['water'].id;
	// Floor at y 39, a water source at (262,40,264), and a one-block stone wall at x 263.
	for (let x = 260; x <= 268; x++) for (let z = 262; z <= 266; z++) h.world.setBlock(x, 39, z, stone);
	h.world.setBlock(262, 40, 264, water);
	h.world.setBlock(263, 40, 264, stone);
	// Settle first, so the water placed above is no longer on the liquid frontier: only removeBlocks' own wake-up can move it.
	for (let i = 0; i < 60; i++) h.loop.simulate(0.05);
	expect(h.world.getBlock(263, 40, 264)).toBe(stone);
	h.loop.removeBlocks([{ x: 263, y: 40, z: 264 }], { x: 263, y: 40, z: 264 });
	for (let i = 0; i < 60; i++) h.loop.simulate(0.05);
	expect(h.world.getBlock(263, 40, 264)).toBe(water);
});
