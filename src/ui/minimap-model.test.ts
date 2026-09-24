import { describe, expect, it } from 'vitest';
import { Chunk } from '../engine/world/chunk';
import { AIR, BLOCK_BY_NAME, WATER } from '../data/blocks.data';
import {
	ColumnCache,
	DARK_GREY,
	MAP_CELLS,
	MAP_RADIUS_BLOCKS,
	columnColor,
	fillMap,
	heightArrow,
	mapRotation,
	toMap,
	type MapWorld,
} from './minimap-model';

const R_PX = 80;
const STONE = BLOCK_BY_NAME['stone'].id;
const SAND = BLOCK_BY_NAME['sand'].id;

/** A colour table where block id n has the colour (n, 2n, 3n) mod 256. */
function fakeTable(): Uint8Array {
	const t = new Uint8Array(4096 * 3);
	for (let id = 0; id < 4096; id++) {
		t[id * 3] = id & 0xff;
		t[id * 3 + 1] = (id * 2) & 0xff;
		t[id * 3 + 2] = (id * 3) & 0xff;
	}
	return t;
}

/** Rotates an image-space offset (x right = +x world, y down = +z world) by the canvas rotation. */
function rotate(x: number, y: number, a: number): [number, number] {
	return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
}

describe('toMap (T11)', () => {
	// Camera convention (camera.ts): forward = (-sin yaw, 0, -cos yaw). Facing +z is yaw = π.
	const FACING_PLUS_Z = Math.PI;

	it('maps a friend 10 blocks straight ahead to straight up the screen', () => {
		const p = toMap(0, 0, FACING_PLUS_Z, 0, 10, MAP_RADIUS_BLOCKS, R_PX);
		expect(p.x).toBeCloseTo(0, 6);
		expect(p.y).toBeCloseTo((-R_PX * 10) / 48, 6);
		expect(p.clamped).toBe(false);
	});

	it('puts the same friend to the side when the player turns 90°', () => {
		// Turning left (yaw + π/2) from facing +z means facing +x; the friend who was ahead is now on the right.
		const turnedLeft = toMap(0, 0, FACING_PLUS_Z + Math.PI / 2, 0, 10, MAP_RADIUS_BLOCKS, R_PX);
		expect(turnedLeft.x).toBeCloseTo((R_PX * 10) / 48, 6);
		expect(turnedLeft.y).toBeCloseTo(0, 6);
		// Turning right (yaw − π/2) means facing −x; the friend is then on the left.
		const turnedRight = toMap(0, 0, FACING_PLUS_Z - Math.PI / 2, 0, 10, MAP_RADIUS_BLOCKS, R_PX);
		expect(turnedRight.x).toBeCloseTo((-R_PX * 10) / 48, 6);
		expect(turnedRight.y).toBeCloseTo(0, 6);
	});

	it('maps a friend behind to straight down the screen, and uses the player position', () => {
		const p = toMap(100, 200, 0, 100, 210, MAP_RADIUS_BLOCKS, R_PX); // facing −z, friend at +z
		expect(p.x).toBeCloseTo(0, 6);
		expect(p.y).toBeCloseTo((R_PX * 10) / 48, 6);
	});

	it('clamps a friend 200 blocks away to the rim, in the right direction', () => {
		// Facing −z (yaw 0), the friend is 200 blocks east (+x): on the right, at the rim.
		const p = toMap(50, 50, 0, 250, 50, MAP_RADIUS_BLOCKS, R_PX);
		expect(p.clamped).toBe(true);
		expect(p.x).toBeCloseTo(R_PX, 6);
		expect(p.y).toBeCloseTo(0, 6);
		// Diagonal, after rotation: facing +z, the friend 200 ahead and 200 to the right.
		// Facing +z, right is −x (right = (cos yaw, −sin yaw) = (−1, 0)).
		const d = toMap(0, 0, Math.PI, -200, 200, MAP_RADIUS_BLOCKS, R_PX);
		expect(d.clamped).toBe(true);
		expect(Math.hypot(d.x, d.y)).toBeCloseTo(R_PX, 6);
		expect(d.x).toBeCloseTo(R_PX / Math.SQRT2, 6);
		expect(d.y).toBeCloseTo(-R_PX / Math.SQRT2, 6);
	});

	it('does not clamp a friend exactly on the radius, and clamps one just past it', () => {
		expect(toMap(0, 0, 0, 48, 0, MAP_RADIUS_BLOCKS, R_PX).clamped).toBe(false);
		expect(toMap(0, 0, 0, 48.01, 0, MAP_RADIUS_BLOCKS, R_PX).clamped).toBe(true);
	});

	it('agrees with the terrain image rotation for any yaw', () => {
		// The terrain image is drawn north-up (x right = +x, y down = +z) then rotated by mapRotation.
		// A dot must land where the image shows the friend's column.
		const scale = R_PX / MAP_RADIUS_BLOCKS;
		for (const yaw of [0, 0.4, 1.3, Math.PI, -2.2, 5.9]) {
			for (const [dx, dz] of [[10, 0], [0, 10], [-7, 3], [20, -30]]) {
				const p = toMap(3, 4, yaw, 3 + dx, 4 + dz, MAP_RADIUS_BLOCKS, R_PX);
				const [rx, ry] = rotate(dx * scale, dz * scale, mapRotation(yaw));
				expect(p.x).toBeCloseTo(rx, 6);
				expect(p.y).toBeCloseTo(ry, 6);
			}
		}
	});
});

describe('heightArrow (T11)', () => {
	it('shows ▲/▼ only beyond 8 blocks', () => {
		expect(heightArrow(9)).toBe('▲');
		expect(heightArrow(-9)).toBe('▼');
		expect(heightArrow(8)).toBe('');
		expect(heightArrow(-8)).toBe('');
		expect(heightArrow(8.5)).toBe('▲');
		expect(heightArrow(0)).toBe('');
	});
});

describe('columnColor (T11)', () => {
	it('returns the table entry for a known block id', () => {
		const t = fakeTable();
		expect(columnColor(STONE, t)).toEqual([STONE & 0xff, (STONE * 2) & 0xff, (STONE * 3) & 0xff]);
		expect(columnColor(WATER, t)).toEqual([17, 34, 51]);
	});
});

/** A world made of the given chunks; getChunk never creates one. */
function fakeWorld(chunks: Chunk[], height: 64 | 256 = 64): MapWorld & { calls: number } {
	const byKey = new Map(chunks.map((c) => [`${c.cx},${c.cz}`, c]));
	const w = {
		height,
		calls: 0,
		getChunk(cx: number, cz: number) {
			w.calls++;
			return byKey.get(`${cx},${cz}`);
		},
	};
	return w;
}

function flatChunk(cx: number, cz: number, top: number, topY = 10): Chunk {
	const c = new Chunk(cx, cz, 64);
	for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
		for (let y = 0; y < topY; y++) c.set(x, y, z, STONE);
		c.set(x, topY, z, top);
	}
	return c;
}

describe('ColumnCache', () => {
	it('records the highest non-air block per column, and the floor under a liquid', () => {
		const c = flatChunk(0, 0, WATER);
		c.set(3, 9, 4, SAND);
		c.set(5, 20, 6, STONE); // a floating block is still the highest
		const cache = new ColumnCache();
		cache.prepare([c], 4);
		const e = cache.lookup(c)!;
		expect(e.top[4 * 16 + 3]).toBe(WATER);
		expect(e.floor[4 * 16 + 3]).toBe(SAND);
		expect(e.top[6 * 16 + 5]).toBe(STONE);
		expect(e.top[0]).toBe(WATER);
		expect(e.floor[0]).toBe(STONE);
	});

	it('rebuilds at most the budget per call, and only chunks whose rev changed', () => {
		const chunks = [0, 1, 2, 3, 4, 5].map((i) => flatChunk(i, 0, STONE));
		const cache = new ColumnCache();
		expect(cache.prepare(chunks, 4)).toBe(4);
		expect(cache.prepare(chunks, 4)).toBe(2);
		expect(cache.prepare(chunks, 4)).toBe(0);
		chunks[2].set(1, 30, 1, SAND);
		expect(cache.prepare(chunks, 4)).toBe(1);
		expect(cache.lookup(chunks[2])!.top[1 * 16 + 1]).toBe(SAND);
	});

	it('keeps serving a stale entry until its rebuild, and treats a replaced chunk object as new', () => {
		const a = flatChunk(0, 0, STONE);
		const cache = new ColumnCache();
		cache.prepare([a], 4);
		a.set(0, 30, 0, SAND);
		expect(cache.lookup(a)!.top[0]).toBe(STONE); // stale, not missing
		// Same coordinates and same rev, but a different object (dropped and regenerated).
		const b = flatChunk(0, 0, SAND);
		b.rev = cache.lookup(a)!.rev;
		expect(cache.lookup(b)).toBeUndefined();
		expect(cache.prepare([b], 4)).toBe(1);
		expect(cache.lookup(b)!.top[0]).toBe(SAND);
	});

	it('finds the same tops on a block buffer that is not 4-byte aligned', () => {
		const aligned = flatChunk(0, 0, SAND, 30);
		aligned.set(15, 40, 15, STONE); // a lone high block in the last cell of its layer
		const buf = new Uint16Array(aligned.blocks.length + 1);
		const unaligned = new Uint16Array(buf.buffer, 2, aligned.blocks.length);
		unaligned.set(aligned.blocks);
		const odd = Chunk.over(0, 0, 64, unaligned);
		const cache = new ColumnCache();
		cache.prepare([aligned, odd], 4);
		expect(Array.from(cache.lookup(odd)!.top)).toEqual(Array.from(cache.lookup(aligned)!.top));
		expect(cache.lookup(aligned)!.top[255]).toBe(STONE);
		expect(cache.lookup(aligned)!.top[0]).toBe(SAND);
	});

	it('records AIR for an empty column', () => {
		const c = new Chunk(0, 0, 64);
		const cache = new ColumnCache();
		cache.prepare([c], 4);
		expect(cache.lookup(c)!.top[0]).toBe(AIR);
	});
});

describe('fillMap', () => {
	const px = 8.5, pz = 8.5; // centre cell = column (8, 8) of chunk (0, 0)
	const centre = (MAP_RADIUS_BLOCKS * MAP_CELLS + MAP_RADIUS_BLOCKS) * 4;

	it('paints unloaded columns dark grey, and never asks the world to create a chunk', () => {
		const w = fakeWorld([]);
		const img = new Uint8ClampedArray(MAP_CELLS * MAP_CELLS * 4);
		fillMap(img, w, px, pz, new ColumnCache(), fakeTable(), 4);
		expect([img[centre], img[centre + 1], img[centre + 2], img[centre + 3]]).toEqual([...DARK_GREY, 255]);
	});

	it('paints a column its top block colour, and a liquid at 70% over its floor', () => {
		const c = flatChunk(0, 0, STONE);
		c.set(8, 11, 8, WATER);
		c.set(9, 10, 8, SAND);
		const t = fakeTable();
		const img = new Uint8ClampedArray(MAP_CELLS * MAP_CELLS * 4);
		fillMap(img, fakeWorld([c]), px, pz, new ColumnCache(), t, 4);
		const [wr, wg, wb] = columnColor(WATER, t);
		const [sr, sg, sb] = columnColor(STONE, t);
		expect(img[centre]).toBe(Math.round(0.7 * wr + 0.3 * sr));
		expect(img[centre + 1]).toBe(Math.round(0.7 * wg + 0.3 * sg));
		expect(img[centre + 2]).toBe(Math.round(0.7 * wb + 0.3 * sb));
		// One cell to the right (+x) is the sand column.
		expect([img[centre + 4], img[centre + 5], img[centre + 6]]).toEqual(columnColor(SAND, t));
		// One cell up (−z) is plain stone.
		const up = centre - MAP_CELLS * 4;
		expect([img[up], img[up + 1], img[up + 2]]).toEqual(columnColor(STONE, t));
	});

	it('paints a loaded chunk not yet in the cache dark grey until its rebuild', () => {
		const c = flatChunk(0, 0, STONE);
		const img = new Uint8ClampedArray(MAP_CELLS * MAP_CELLS * 4);
		fillMap(img, fakeWorld([c]), px, pz, new ColumnCache(), fakeTable(), 0);
		expect([img[centre], img[centre + 1], img[centre + 2]]).toEqual([...DARK_GREY]);
	});

	it('rebuilds the nearest chunks first', () => {
		// The player stands in chunk (5, 5); the window spans chunks 2..8 on each axis.
		const chunks: Chunk[] = [];
		for (let cx = 2; cx <= 8; cx++) for (let cz = 2; cz <= 8; cz++) chunks.push(flatChunk(cx, cz, STONE));
		const cache = new ColumnCache();
		const img = new Uint8ClampedArray(MAP_CELLS * MAP_CELLS * 4);
		fillMap(img, fakeWorld(chunks), 5 * 16 + 8, 5 * 16 + 8, cache, fakeTable(), 1);
		const home = chunks.find((c) => c.cx === 5 && c.cz === 5)!;
		expect(cache.lookup(home)).toBeDefined();
		expect(chunks.filter((c) => cache.lookup(c)).length).toBe(1);
	});
});
