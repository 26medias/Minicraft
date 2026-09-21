import { describe, it, expect } from 'vitest';
import { Chunk } from './chunk';
import { generateChunk, worldProfile, NEWEST_GEN_VERSION } from './generation';
import { BLOCK_BY_NAME } from '../../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from './coords';

describe('generateChunk', () => {
	it('is deterministic for a given seed + chunk coord', () => {
		const a = new Chunk(3, 5);
		const b = new Chunk(3, 5);
		generateChunk(a, 12345);
		generateChunk(b, 12345);
		expect(a.blocks).toEqual(b.blocks);
	});

	it('differs across seeds', () => {
		const a = new Chunk(0, 0);
		const b = new Chunk(0, 0);
		generateChunk(a, 1);
		generateChunk(b, 2);
		expect(a.blocks).not.toEqual(b.blocks);
	});

	it('differs across chunk coords within a seed', () => {
		const a = new Chunk(0, 0);
		const b = new Chunk(1, 0);
		generateChunk(a, 42);
		generateChunk(b, 42);
		expect(a.blocks).not.toEqual(b.blocks);
	});

	it("clears the modified flag so un-touched chunks don't persist", () => {
		const c = new Chunk(0, 0);
		generateChunk(c, 1);
		expect(c.modified).toBe(false);
	});

	it('produces a grass top, dirt band, stone below', () => {
		const c = new Chunk(0, 0);
		generateChunk(c, 42);
		const grass = BLOCK_BY_NAME['grass_block'].id;
		const dirt = BLOCK_BY_NAME['dirt'].id;
		const stone = BLOCK_BY_NAME['stone'].id;

		for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
			for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
				let topY = -1;
				for (let y = 63; y >= 0; y--) {
					if (c.get(lx, y, lz) !== 0) {
						topY = y;
						break;
					}
				}
				expect(topY).toBeGreaterThan(0);
				expect(c.get(lx, topY, lz)).toBe(grass);
				if (topY >= 3) {
					expect(c.get(lx, topY - 1, lz)).toBe(dirt);
					expect(c.get(lx, topY - 2, lz)).toBe(dirt);
					expect(c.get(lx, topY - 3, lz)).toBe(dirt);
					expect(c.get(lx, topY - 4, lz)).toBe(stone);
				}
			}
		}
	});
});

describe('generateChunk — flatter terrain', () => {
	it('heightmap values fall within the new range [24, 34]', () => {
		const c = new Chunk(5, 5);
		generateChunk(c, 42);
		const tops = new Set<number>();
		for (let lx = 0; lx < 16; lx++) {
			for (let lz = 0; lz < 16; lz++) {
				for (let y = 63; y >= 0; y--) {
					if (c.blocks[y * 16 * 16 + lz * 16 + lx] !== 0) {
						tops.add(y);
						break;
					}
				}
			}
		}
		for (const t of tops) {
			expect(t).toBeGreaterThanOrEqual(24);
			expect(t).toBeLessThanOrEqual(34);
		}
	});
});

const EXPECTED_HASH = 4166549171; // filled in below by running the test once

function hashBytes(bytes: ArrayLike<number>): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h;
}

describe('generateChunk — sea-level water fill', () => {
	it('columns with h < SEA_LEVEL get water at y from h+1 to SEA_LEVEL', () => {
		const c = new Chunk(0, 1);
		generateChunk(c, 42);
		const WATER = BLOCK_BY_NAME['water'].id;
		let foundLowColumn = false;
		for (let lx = 0; lx < 16 && !foundLowColumn; lx++) {
			for (let lz = 0; lz < 16 && !foundLowColumn; lz++) {
				let h = -1;
				for (let y = 63; y >= 0; y--) {
					const id = c.blocks[y * 16 * 16 + lz * 16 + lx];
					if (id !== 0 && id !== WATER) {
						h = y;
						break;
					}
				}
				if (h >= 0 && h < 28) {
					foundLowColumn = true;
					for (let y = h + 1; y <= 28; y++) {
						expect(c.blocks[y * 16 * 16 + lz * 16 + lx]).toBe(WATER);
					}
					for (let y = 29; y < 64; y++) {
						expect(c.blocks[y * 16 * 16 + lz * 16 + lx]).toBe(0);
					}
				}
			}
		}
		expect(foundLowColumn).toBe(true);
	});

	it('columns with h >= SEA_LEVEL have no water', () => {
		const c = new Chunk(9, 9);
		generateChunk(c, 42);
		const WATER = BLOCK_BY_NAME['water'].id;
		for (let lx = 0; lx < 16; lx++) {
			for (let lz = 0; lz < 16; lz++) {
				let h = -1;
				for (let y = 63; y >= 0; y--) {
					const id = c.blocks[y * 16 * 16 + lz * 16 + lx];
					if (id !== 0 && id !== WATER) {
						h = y;
						break;
					}
				}
				if (h >= 28) {
					for (let y = 0; y < 64; y++) {
						expect(c.blocks[y * 16 * 16 + lz * 16 + lx]).not.toBe(WATER);
					}
				}
			}
		}
	});

	it('top block is sand for underwater/shoreline columns, grass otherwise', () => {
		const c = new Chunk(3, 3);
		generateChunk(c, 42);
		const GRASS = BLOCK_BY_NAME['grass_block'].id;
		const SAND = BLOCK_BY_NAME['sand'].id;
		const WATER = BLOCK_BY_NAME['water'].id;
		for (let lx = 0; lx < 16; lx++) {
			for (let lz = 0; lz < 16; lz++) {
				let h = -1;
				for (let y = 63; y >= 0; y--) {
					const id = c.blocks[y * 16 * 16 + lz * 16 + lx];
					if (id !== 0 && id !== WATER) {
						h = y;
						break;
					}
				}
				if (h < 0) continue;
				const top = c.blocks[h * 16 * 16 + lz * 16 + lx];
				if (h < 28) expect(top).toBe(SAND);
				else expect(top).toBe(GRASS);
			}
		}
	});
});

describe('determinism', () => {
	it('hashes a fixed seed+coord to a stable value', () => {
		const c = new Chunk(0, 0);
		generateChunk(c, 2026);
		const hash = hashBytes(c.blocks);
		expect(hash).toBe(EXPECTED_HASH);
	});
});

describe('world profile', () => {
	it('maps generator versions to heights and rejects unknown ones', () => {
		expect(worldProfile(1)).toEqual({ height: 64 });
		expect(worldProfile(2)).toEqual({ height: 256 });
		expect(worldProfile(3)).toEqual({ height: 256 });
		expect(NEWEST_GEN_VERSION).toBe(3);
		expect(() => worldProfile(4)).toThrow(RangeError);
	});
	it('refuses to run a generator on a chunk of the wrong height', () => {
		expect(() => generateChunk(new Chunk(0, 0, 256), 1, 1)).toThrow();
		expect(() => generateChunk(new Chunk(0, 0, 64), 1, 2)).toThrow();
		expect(() => generateChunk(new Chunk(0, 0, 64), 1, 3)).toThrow();
	});
});

const EXPECTED_HASH_V2 = 3402466961; // recorded ONCE in Task 4 step 5 by running this test; never re-recorded

describe('generateChunk v2 (tall)', () => {
	const BEDROCK = BLOCK_BY_NAME['bedrock'].id;
	const WATER = BLOCK_BY_NAME['water'].id;

	it('puts bedrock at y=0 in every column and nothing but air above y=131', () => {
		const c = new Chunk(4, 7, 256);
		generateChunk(c, 42, 2);
		for (let lz = 0; lz < 16; lz++)
			for (let lx = 0; lx < 16; lx++) {
				expect(c.get(lx, 0, lz)).toBe(BEDROCK);
				for (let y = 132; y < 256; y++) expect(c.get(lx, y, lz)).toBe(0);
			}
		expect(c.modified).toBe(false);
	});

	it('keeps the surface (top non-water block) within 114..130', () => {
		for (const [cx, cz] of [[0, 0], [5, 5], [31, 31]] as const) {
			const c = new Chunk(cx, cz, 256);
			generateChunk(c, 42, 2);
			for (let lz = 0; lz < 16; lz++)
				for (let lx = 0; lx < 16; lx++) {
					let top = -1;
					for (let y = 255; y >= 0; y--) {
						const id = c.get(lx, y, lz);
						if (id !== 0 && id !== WATER) { top = y; break; }
					}
					expect(top).toBeGreaterThanOrEqual(114);
					expect(top).toBeLessThanOrEqual(130);
				}
		}
	});

	it('fills water from the surface up to sea level 120 where the land is low', () => {
		let found = false;
		for (let cx = 0; cx < 8 && !found; cx++) {
			const c = new Chunk(cx, 1, 256);
			generateChunk(c, 42, 2);
			for (let lx = 0; lx < 16 && !found; lx++)
				for (let lz = 0; lz < 16 && !found; lz++) {
					let h = -1;
					for (let y = 255; y >= 0; y--) { const id = c.get(lx, y, lz); if (id !== 0 && id !== WATER) { h = y; break; } }
					if (h < 120) {
						found = true;
						for (let y = h + 1; y <= 120; y++) expect(c.get(lx, y, lz)).toBe(WATER);
						expect(c.get(lx, 121, lz)).toBe(0);
					}
				}
		}
		expect(found).toBe(true);
	});

	it('hashes a fixed seed+coord to a stable value', () => {
		const c = new Chunk(3, 5, 256);
		generateChunk(c, 12345, 2);
		expect(hashBytes(c.blocks)).toBe(EXPECTED_HASH_V2);
	});
});

/** v3 reference hashes (spec §10): chunks (0,0), (16,16), (31,31), (5,27) of seed 12345, FNV-1a-32 over the Uint16 elements of `blocks`. Recorded ONCE at bootstrap (two processes agreed; prototype cross-check in the spec §10); never re-recorded — any constant change is genVersion 4. */
const EXPECTED_HASH_V3: readonly [number, number, number, number] = [2020764513, 800740276, 2743801548, 161955245]; // bootstrapped 2026-09-21 (spec §10): engine = prototype, two processes agreed; re-run 2026-09-21 after the §4 snow-line rule (17917e1): unchanged, AGREE
const V3_CHUNKS: readonly [number, number][] = [[0, 0], [16, 16], [31, 31], [5, 27]];

describe('generateChunk v3 (rich world) — reference hashes', () => {
	const bootstrapped = EXPECTED_HASH_V3.length === 4;
	(bootstrapped ? it : it.skip)('hashes the four fixed chunks of seed 12345 to the recorded values', () => {
		V3_CHUNKS.forEach(([cx, cz], i) => { const c = new Chunk(cx, cz, 256); generateChunk(c, 12345, 3); expect(hashBytes(c.blocks), `chunk ${cx},${cz}`).toBe(EXPECTED_HASH_V3[i]); });
	});
	it('is deterministic across two fresh generations of the same chunk', () => {
		const a = new Chunk(16, 16, 256), b = new Chunk(16, 16, 256); generateChunk(a, 12345, 3); generateChunk(b, 12345, 3); expect(hashBytes(a.blocks)).toBe(hashBytes(b.blocks));
	});
});
