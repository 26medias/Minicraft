import { describe, it, expect } from 'vitest';
import { World } from './world';
import { Chunk } from './chunk';
import { chunkIndex, chunkIndexOrNeg, WORLD_CHUNKS_Z } from './coords';

/** Test-local string-keyed reference: the semantics `getChunk` had before this task. */
class StringKeyedRef {
	private m = new Map<string, Chunk>();
	put(c: Chunk) {
		this.m.set(`${c.cx},${c.cz}`, c);
	}
	get(cx: number, cz: number) {
		return this.m.get(`${cx},${cz}`);
	}
}

describe('World chunk index (spec §3.A)', () => {
	it('chunkIndex is exactly cx * WORLD_CHUNKS_Z + cz', () => {
		expect(chunkIndex(0, 0)).toBe(0);
		expect(chunkIndex(1, 0)).toBe(WORLD_CHUNKS_Z);
		expect(chunkIndex(31, 31)).toBe(31 * WORLD_CHUNKS_Z + 31);
		expect(chunkIndexOrNeg(-1, 0)).toBe(-1);
		expect(chunkIndexOrNeg(0, WORLD_CHUNKS_Z)).toBe(-1);
	});

	it('edge chunks and out-of-range inputs agree with a string-keyed reference (mutant: drop the bounds check → (1,-1) aliases (0,31))', () => {
		const w = new World(7, { height: 64 });
		const ref = new StringKeyedRef();
		for (const [cx, cz] of [[0, 0], [0, 31], [31, 0], [31, 31], [1, 0], [0, 1], [5, 0], [4, 31]] as [number, number][]) {
			ref.put(w.ensureChunk(cx, cz));
		}
		const probes: [number, number][] = [];
		for (const cx of [-1, 0, 1, 4, 5, 31, 32]) for (const cz of [-1, 0, 1, 31, 32, 33]) probes.push([cx, cz]);
		for (const [cx, cz] of probes) {
			expect(w.getChunk(cx, cz), `getChunk(${cx},${cz})`).toBe(ref.get(cx, cz));
		}
		// The two aliasing cases the spec names, stated explicitly.
		expect(w.getChunk(1, -1)).toBeUndefined();
		expect(w.getChunk(0, 33)).toBeUndefined();
	});

	it('iteration and modifiedChunks see exactly the ensured chunks', () => {
		const w = new World(7, { height: 64 });
		w.ensureChunk(3, 4);
		w.ensureChunk(0, 31);
		w.getChunk(0, 31)!.modified = true;
		expect([...w.allChunks()].map((c) => `${c.cx},${c.cz}`).sort()).toEqual(['0,31', '3,4']);
		expect(w.modifiedChunks().map((c) => `${c.cx},${c.cz}`)).toEqual(['0,31']);
		expect(w.dropChunk(3, 4)).toBe(true);
		expect(w.dropChunk(3, 4)).toBe(false);
		expect(w.getChunk(3, 4)).toBeUndefined();
	});
});
