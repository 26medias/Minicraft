// Toys spec §3.5 / §3.7: GameLoop.placeBlocks, the batched mirror of removeBlocks (dome glass, lake water).
import { describe, it, expect } from 'vitest';
import { makeLoop } from './test-loop';
import { AIR, BLOCK_BY_NAME, isSolid } from '../data/blocks.data';
import { chunkIndex } from '../engine/world/coords';
import type { GameLoop } from './loop';
import type { World } from '../engine/world/world';
import type { Chunk } from '../engine/world/chunk';

const stone = BLOCK_BY_NAME['stone'].id, water = BLOCK_BY_NAME['water'].id, bedrock = BLOCK_BY_NAME['bedrock'].id;
const glass = BLOCK_BY_NAME['glass'].id;
type Cell = { x: number; y: number; z: number };
type Lanes = { editLane: Set<number>; bulkLane: Set<number>; shadowOnly: Set<number>; streamSet: Set<number> };
const lanes = (loop: GameLoop) => loop as unknown as Lanes;

function fnv(a: ArrayBufferView): number {
	const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	let h = 2166136261 >>> 0;
	for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
	return h;
}
const chunkState = (c: Chunk) => ({ blocks: fnv(c.blocks), lights: fnv(c.lights), modified: c.modified, frontier: [...c.liquidFrontier].sort((a, b) => a - b).join(',') });
const top = (world: World, x: number, z: number) => { for (let y = world.height - 1; y > 0; y--) if (isSolid(world.getBlock(x, y, z))) return y; return 0; };

/** Today's single-block path, per cell: world write, the edge re-mesh, the per-block light update. */
function perBlock(loop: GameLoop, world: World, cells: Cell[], id: number): void {
	for (const { x, y, z } of cells) {
		if (world.getBlock(x, y, z) !== AIR) continue;
		world.setBlock(x, y, z, id);
		loop.markChunkDirtyAround(x, z);
		loop.applyLightUpdate(x, y, z);
	}
}

/** Seed-3 v3 world. A 6 × 6 roof 3 above the ground straddling the chunk 21/22 border, and water poured into a dug pit. */
function fixture(path: 'old' | 'new', what: 'roof' | 'pit') {
	const h = makeLoop({ seed: 3 });
	h.player.position = [0.5, 250, 0.5]; // far away: the player's box never overlaps the fixture
	const x0 = 22 * 16 - 3, z0 = 12 * 16 + 5, t = top(h.world, x0, z0);
	const cells: Cell[] = [];
	if (what === 'roof') {
		for (let x = x0; x < x0 + 6; x++) for (let z = z0; z < z0 + 6; z++) cells.push({ x, y: t + 3, z });
	} else {
		for (let x = x0; x < x0 + 4; x++) for (let z = z0; z < z0 + 4; z++) for (let y = t - 3; y <= t; y++) {
			h.world.setBlock(x, y, z, AIR);
			h.loop.applyLightUpdate(x, y, z);
			if (y < t) cells.push({ x, y, z });
		}
	}
	const L = lanes(h.loop);
	L.editLane.clear(); L.bulkLane.clear(); L.shadowOnly.clear();
	const id = what === 'roof' ? stone : water;
	if (path === 'old') perBlock(h.loop, h.world, cells, id);
	else h.loop.placeBlocks(cells, id, cells[0]);
	const chunks = new Map<string, ReturnType<typeof chunkState>>();
	for (const c of h.world.allChunks()) chunks.set(`${c.cx},${c.cz}`, chunkState(c));
	return { h, cells, chunks };
}

describe('placeBlocks is equivalent to the per-block place path (toys spec §3.5)', () => {
	for (const what of ['roof', 'pit'] as const) {
		it(`${what}: every loaded chunk's blocks, light, modified and liquid frontier match (catches a batch that skips the light update or writes through chunk.set)`, () => {
			const a = fixture('old', what), b = fixture('new', what);
			expect(b.cells.length).toBeGreaterThan(20);
			expect([...b.chunks.keys()].sort()).toEqual([...a.chunks.keys()].sort());
			const diff: string[] = [];
			for (const [k, s] of a.chunks) {
				const t = b.chunks.get(k)!;
				for (const field of ['blocks', 'lights', 'modified', 'frontier'] as const) if (s[field] !== t[field]) diff.push(`${k}:${field}`);
			}
			expect(diff).toEqual([]);
		}, 60_000);
	}
});

describe('placeBlocks rules (toys spec §3.5)', () => {
	it('skips out-of-bounds, solid, liquid and bedrock cells and the player\'s box; returns what it placed in input order (catches glass written over blocks or water, or sealed into the player)', () => {
		const { loop, world, player } = makeLoop();
		player.position = [262.5, 40, 260.5]; // box x 262.2..262.8, y 40..41.8: cells (262,40,260) and (262,41,260)
		world.setBlock(260, 40, 260, stone);
		world.setBlock(261, 40, 260, water);
		world.setBlock(261, 41, 260, bedrock);
		const cells: Cell[] = [
			{ x: -1, y: 40, z: 260 }, { x: 260, y: 64, z: 260 }, { x: 260, y: 40, z: 260 }, { x: 261, y: 40, z: 260 }, { x: 261, y: 41, z: 260 },
			{ x: 262, y: 40, z: 260 }, { x: 262, y: 41, z: 260 }, { x: 262, y: 42, z: 260 }, { x: 263, y: 40, z: 260 },
		];
		const { placed } = loop.placeBlocks(cells, glass, { x: 263, y: 40, z: 260 });
		expect(placed).toEqual([{ x: 262, y: 42, z: 260 }, { x: 263, y: 40, z: 260 }]);
		expect(world.getBlock(260, 40, 260)).toBe(stone);
		expect(world.getBlock(261, 40, 260)).toBe(water);
		expect(world.getBlock(261, 41, 260)).toBe(bedrock);
		expect(world.getBlock(262, 40, 260)).toBe(AIR);
		expect(world.getBlock(262, 41, 260)).toBe(AIR);
		expect(world.getBlock(262, 42, 260)).toBe(glass);
		expect(world.getBlock(263, 40, 260)).toBe(glass);
	});

	it('the anchor chunk goes to the edit lane, every other chunk it touched to the bulk lane (catches the whole batch in the synchronous edit lane)', () => {
		const { loop } = makeLoop();
		const L = lanes(loop);
		L.editLane.clear(); L.bulkLane.clear(); L.streamSet.clear(); L.shadowOnly.clear();
		// Chunk (16,16) and, across x = 272, chunk (17,16).
		const { placed } = loop.placeBlocks([{ x: 265, y: 40, z: 264 }, { x: 275, y: 40, z: 264 }], glass, { x: 265, y: 40, z: 264 });
		expect(placed).toHaveLength(2);
		expect([...L.editLane]).toEqual([chunkIndex(16, 16)]);
		expect(L.bulkLane.has(chunkIndex(17, 16))).toBe(true);
		expect(L.bulkLane.has(chunkIndex(16, 16))).toBe(false);
	});

	it('placed water is a live source: it flows onto the floor beside it (catches placeBlocks writing through chunk.set, which never wakes the liquids)', () => {
		const h = makeLoop();
		for (let x = 258; x <= 268; x++) for (let z = 258; z <= 268; z++) h.world.setBlock(x, 39, z, stone);
		for (let i = 0; i < 20; i++) h.loop.simulate(0.05);
		h.loop.placeBlocks([{ x: 263, y: 40, z: 263 }], water, { x: 263, y: 40, z: 263 });
		for (let i = 0; i < 60; i++) h.loop.simulate(0.05);
		expect(h.world.getBlock(264, 40, 263)).toBe(water);
	});
});
