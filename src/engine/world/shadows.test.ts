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

// ---------------------------------------------------------------------------
// Task 2 (spec §3.C / §6.1): early-out + in-chunk walk, ray counter, load-order independence.
// ---------------------------------------------------------------------------
import { computeChunkShadowsBrute } from './shadows.brute';
import { hashSunlit, SHADOW_STATS, ensureShadowNeighbourhood } from './shadows';
import { spawnV3 } from './v3/spawn';
import type { Chunk } from './chunk';

function fnv8(a: Uint8Array): number { let h = 2166136261 >>> 0; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }

/** Fully-loaded reference: every chunk of the (radius+1) square exists before any shadow is cast. */
function fullyLoaded(seed: number, radius: number) {
	const w = World.create(seed);
	const s = spawnV3(seed);
	const pcx = Math.floor(s.x / 16), pcz = Math.floor(s.z / 16);
	const order: [number, number][] = [];
	for (let dx = -radius - 1; dx <= radius + 1; dx++) for (let dz = -radius - 1; dz <= radius + 1; dz++) {
		const cx = pcx + dx, cz = pcz + dz;
		if (w.chunkInWorld(cx, cz)) { w.ensureChunk(cx, cz); if (Math.max(Math.abs(dx), Math.abs(dz)) <= radius) order.push([cx, cz]); }
	}
	return { w, pcx, pcz, order };
}

describe('computeChunkShadows — §3.C early-out and in-chunk walk', () => {
	it('is byte-identical to the brute-force caster on a fully-loaded 3×3 (v2 fixtures + v3 seeds 1–3)', { timeout: 30_000 }, () => {
		for (const seed of [1, 2, 3]) {
			const { w, order } = fullyLoaded(seed, 2);
			for (const [cx, cz] of order) {
				const c = w.getChunk(cx, cz)!;
				computeChunkShadowsBrute(w, c); const ref = fnv8(c.sunlit);
				c.shadowsDirty = true; computeChunkShadows(w, c);
				expect(fnv8(c.sunlit), `seed ${seed} chunk ${cx},${cz}`).toBe(ref);
			}
		}
	});

	it('casts at most 2 % of the candidate rays (measured 0.72 %; mutant: drop the per-start-column early-out → 11.7 %)', { timeout: 30_000 }, () => {
		const { w, order } = fullyLoaded(3, 1);
		let candidates = 0;
		for (const [cx, cz] of order) {
			const c = w.getChunk(cx, cz)!;
			for (let i = 0; i < c.blocks.length; i++) { const d = BLOCKS[c.blocks[i]]; const opaque = !!d && d.lightFilter >= 15 && d.liquid === 'none'; if (!opaque && ((c.lights[i] >> 12) & 0xf) !== 0) candidates++; }
		}
		SHADOW_STATS.rays = 0;
		for (const [cx, cz] of order) { const c = w.getChunk(cx, cz)!; c.shadowsDirty = true; computeChunkShadows(w, c); }
		expect(SHADOW_STATS.rays).toBeLessThan(candidates * 0.02);
	});

	it('hashSunlit is FNV-1a over the bytes and changes when one voxel flips', () => {
		const a = new Uint8Array(16).fill(1); const h = hashSunlit(a); a[7] = 0;
		expect(hashSunlit(a)).not.toBe(h);
		expect(hashSunlit(new Uint8Array(0))).toBe(2166136261);
	});
});

describe('shadows are independent of load order (spec §3.C.1; red at HEAD: 5 of 49 chunks differ on this fixture)', () => {
	it('a simulated nearest-first stream of seed 3 ends with the same sunlit as the fully-loaded reference (mutant: shadow without ensuring the 3×3)', { timeout: 30_000 }, () => {
		const ref = fullyLoaded(3, 3);
		const refHash = new Map<string, number>();
		for (const [cx, cz] of ref.order) { const c = ref.w.getChunk(cx, cz)!; computeChunkShadowsBrute(ref.w, c); refHash.set(`${cx},${cz}`, fnv8(c.sunlit)); }

		const w = World.create(3);
		const { pcx, pcz } = ref;
		// nearest-first stream, exactly what the scheduler will do: ensure the chunk, ensure its 3×3, shadow, and re-dirty the 3×3 neighbours already shadowed.
		const stream = [...ref.order].sort((a, b) => Math.max(Math.abs(a[0] - pcx), Math.abs(a[1] - pcz)) - Math.max(Math.abs(b[0] - pcx), Math.abs(b[1] - pcz)));
		const shadowed: Chunk[] = [];
		for (const [cx, cz] of stream) {
			const c = w.ensureChunk(cx, cz);
			ensureShadowNeighbourhood(w, c);
			computeChunkShadows(w, c);
			shadowed.push(c);
			// any already-shadowed chunk whose 3×3 just gained a member is stale: the loop re-dirties it
			for (const s of shadowed) if (s !== c && Math.abs(s.cx - cx) <= 1 && Math.abs(s.cz - cz) <= 1) s.shadowsDirty = true;
			for (const s of shadowed) if (s.shadowsDirty) computeChunkShadows(w, s);
		}
		let diff = 0;
		for (const [cx, cz] of ref.order) if (fnv8(w.getChunk(cx, cz)!.sunlit) !== refHash.get(`${cx},${cz}`)) diff++;
		expect(diff).toBe(0);
	});
});
