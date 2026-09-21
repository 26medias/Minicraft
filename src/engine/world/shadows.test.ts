import { describe, it, expect } from 'vitest';
import { World } from './world';
import { BLOCK_BY_NAME, BLOCKS, AIR } from '../../data/blocks.data';
import { fillChunkLights } from './lighting';
import { computeChunkShadows, maxOpaqueY } from './shadows';
import { indexOf } from './coords';

const stone = BLOCK_BY_NAME['stone'].id;

function emptyWorld(): World {
	const w = new World(1);
	const c = w.ensureChunk(0, 0);
	c.blocks.fill(AIR);
	c.lights.fill(0);
	c.liquidFrontier.clear();
	return w;
}

describe('computeChunkShadows', () => {
	it('opaque block is always in shadow (sunlit=0) regardless of position', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 40, 5)] = stone;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		expect(c.sunlit[indexOf(5, 40, 5)]).toBe(0);
	});

	it('air voxel under open sky is sunlit (sunlit=1)', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		// Any air voxel at mid-height, nothing blocking toward NW-up sun.
		expect(c.sunlit[indexOf(5, 30, 5)]).toBe(1);
	});

	it('air voxel under a roof is in shadow', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Roof over entire chunk at y=40.
		for (let dx = 0; dx < 16; dx++)
			for (let dz = 0; dz < 16; dz++) c.blocks[indexOf(dx, 40, dz)] = stone;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		// Under the roof, enclosed by skylight=0 OR blocked by ray cast: sunlit=0.
		expect(c.sunlit[indexOf(5, 20, 5)]).toBe(0);
	});

	it("voxel directly SE of a tall pillar is in the pillar's shadow", () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Tall pillar at (5, 30..40, 5). Test a voxel 1 step SE of the pillar at y=30.
		for (let y = 30; y <= 40; y++) c.blocks[indexOf(5, y, 5)] = stone;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		// SE direction for sun=[-0.5, 1, -0.3] means +x, +z is NOT the shadow direction.
		// Shadow direction is opposite the sun dir, so +x direction is where shadows fall
		// (sun dx is -0.5, so shadow dx is +0.5). +z too (sun dz is -0.3).
		// So a voxel at (6, 30, 5) should be in shadow from the pillar.
		expect(c.sunlit[indexOf(6, 30, 5)]).toBe(0);
	});

	it('voxel NW of the pillar (upwind of shadow) is still sunlit', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		for (let y = 30; y <= 40; y++) c.blocks[indexOf(5, y, 5)] = stone;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		// NW of pillar: (4, 30, 4) — ray toward NW-up doesn't hit the pillar.
		expect(c.sunlit[indexOf(4, 30, 4)]).toBe(1);
	});
});

/** The pre-early-out algorithm, kept verbatim so the optimised one is checked against it. */
function bruteShadows(w: World, chunk: ReturnType<World['ensureChunk']>): Uint8Array {
	const out = new Uint8Array(chunk.sunlit.length);
	const raw: [number, number, number] = [-0.5, 1.0, -0.3];
	const len = Math.hypot(...raw);
	const dx = raw[0] / len, dy = raw[1] / len, dz = raw[2] / len;
	const baseX = chunk.cx * 16, baseZ = chunk.cz * 16;
	const opaque = (id: number) => { const d = BLOCKS[id]; return !!d && d.lightFilter >= 15 && d.liquid === 'none'; };
	const hits = (ox: number, oy: number, oz: number): boolean => {
		let ix = Math.floor(ox), iy = Math.floor(oy), iz = Math.floor(oz);
		const sx = dx > 0 ? 1 : -1, sy = 1, sz = dz > 0 ? 1 : -1;
		const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
		let tmx = (sx > 0 ? ix + 1 - ox : ox - ix) * tdx;
		let tmy = (iy + 1 - oy) * tdy;
		let tmz = (sz > 0 ? iz + 1 - oz : oz - iz) * tdz;
		let t = 0;
		while (t < 32) {
			if (tmx < tmy && tmx < tmz) { ix += sx; t = tmx; tmx += tdx; }
			else if (tmy < tmz) { iy += sy; t = tmy; tmy += tdy; }
			else { iz += sz; t = tmz; tmz += tdz; }
			if (iy >= w.height || iy < 0) return false;
			const c = w.getChunk(Math.floor(ix / 16), Math.floor(iz / 16));
			if (!c) return false;
			const lx = ((ix % 16) + 16) % 16, lz = ((iz % 16) + 16) % 16;
			if (opaque(c.blocks[indexOf(lx, iy, lz)])) return true;
		}
		return false;
	};
	for (let y = 0; y < chunk.height; y++)
		for (let z = 0; z < 16; z++)
			for (let x = 0; x < 16; x++) {
				const i = indexOf(x, y, z);
				if (opaque(chunk.blocks[i])) { out[i] = 0; continue; }
				if (chunk.getSky(x, y, z) === 0) { out[i] = 0; continue; }
				out[i] = hits(baseX + x + 0.5, y + 0.5, baseZ + z + 0.5) ? 0 : 1;
			}
	return out;
}

/** 3x3 loaded chunks around (1,1): flat stone floor at `floorY`, a 6x1x6 stone plate at `plateY` in the NW neighbour (0,0). */
function terrainFixture(height: 64 | 256, floorY: number, plateY: number): World {
	const w = new World(7, { height });
	for (let cx = 0; cx <= 2; cx++)
		for (let cz = 0; cz <= 2; cz++) {
			const c = w.ensureChunk(cx, cz);
			c.blocks.fill(AIR);
			c.lights.fill(0);
			c.liquidFrontier.clear();
			for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) c.blocks[indexOf(x, floorY, z)] = stone;
		}
	const nw = w.getChunk(0, 0)!;
	for (let x = 10; x < 16; x++) for (let z = 10; z < 16; z++) nw.blocks[indexOf(x, plateY, z)] = stone;
	for (let cx = 0; cx <= 2; cx++) for (let cz = 0; cz <= 2; cz++) fillChunkLights(w, w.getChunk(cx, cz)!);
	return w;
}

describe('computeChunkShadows — heightmap early-out equivalence', () => {
	for (const [height, floorY, plateY] of [[64, 30, 50], [256, 120, 200]] as const) {
		it(`matches the brute-force result byte for byte at height ${height}`, () => {
			const w = terrainFixture(height, floorY, plateY);
			const c = w.getChunk(1, 1)!;
			const expected = bruteShadows(w, c);
			computeChunkShadows(w, c);
			expect(c.sunlit).toEqual(expected);
			// The fixture must exercise the cross-chunk case: some voxel of (1,1)
			// between the floor and the plate is shaded by the plate in (0,0).
			let shaded = 0;
			for (let y = floorY + 1; y < plateY; y++)
				for (let z = 0; z < 16; z++)
					for (let x = 0; x < 16; x++) if (c.sunlit[indexOf(x, y, z)] === 0 && c.getSky(x, y, z) > 0) shaded++;
			expect(shaded).toBeGreaterThan(0);
		});
	}

	it('maxOpaqueY reports the highest opaque voxel or -1', () => {
		const w = new World(1, { height: 256 });
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(AIR);
		expect(maxOpaqueY(c)).toBe(-1);
		c.blocks[indexOf(4, 130, 4)] = stone;
		expect(maxOpaqueY(c)).toBe(130);
	});

	it('is fast on a 256 column with only a floor (sky voxels skip the raycast)', () => {
		// Floor-only fixture: plateY = floorY puts the "plate" inside the floor, so the
		// neighbourhood max is 120 and every voxel above skips the ray. Measured ~19 ms
		// with the early-out vs ~465 ms brute force. With a plate at 200 the 80 air
		// layers between floor and plate still raycast (~100 ms) — that fixture is for
		// the equivalence test, not this one. Brute force measures 145-150 ms on a fast
		// box, so the bound is 80 ms: still 4x the early-out time, and red without it.
		const w = terrainFixture(256, 120, 120);
		const c = w.getChunk(1, 1)!;
		computeChunkShadows(w, c);
		const t0 = performance.now();
		computeChunkShadows(w, c);
		expect(performance.now() - t0).toBeLessThan(80);
	});
});
