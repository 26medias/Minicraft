import { describe, it, expect } from 'vitest';
import { Chunk } from '../chunk';
import { generateChunkV3 } from './generate';
import { treesOf, treeTemplate, SPECIES } from './trees';
import { V3, LOG_IDS, LEAF_IDS } from './blocks';
import { column, BIOME } from './columns';

function region(seed: number, cx0: number, cx1: number, cz0: number, cz1: number) {
	const m = new Map<number, Uint16Array>();
	for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) { const c = new Chunk(cx, cz, 256); generateChunkV3(c, seed); m.set(cz * 32 + cx, c.blocks); }
	return (x: number, y: number, z: number) => { const b = m.get((z >> 4) * 32 + (x >> 4)); if (!b || y < 0 || y > 255) return -1; return b[y * 256 + (z & 15) * 16 + (x & 15)]; };
}

describe('v3 trees', () => {
	it('treesOf is pure per origin chunk, memoised, and never places in desert/badlands or off flat cells', () => {
		expect(treesOf(1, 5, 5)).toBe(treesOf(1, 5, 5));
		let n = 0;
		for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) { const cc = column(1, cx * 16 + 8, cz * 16 + 8); const list = treesOf(1, cx, cz); n += list.length;
			if (cc.biome === BIOME.desert || cc.biome === BIOME.badlands || cc.biome === BIOME.ocean) expect(list.length).toBe(0);
			for (const t of list) { expect(t.x >> 4).toBe(cx); expect(t.z >> 4).toBe(cz); expect(column(1, t.x, t.z).biome).toBe(cc.biome); expect(t.hh).toBeGreaterThanOrEqual(t.sp.h0); expect(t.hh).toBeLessThanOrEqual(t.sp.h1); } }
		expect(n).toBeGreaterThanOrEqual(422); expect(n).toBeLessThanOrEqual(1391); // §12 trees per map range
	});
	it('§11.9 canopy shapes: hand numbers per species incl. the acacia bend (2 logs off the base column)', () => {
		const seen = new Set<string>();
		for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) for (const t of treesOf(2, cx, cz)) {
			const tpl = treeTemplate(t); const logs = tpl.filter(([, , , id]) => LOG_IDS.has(id)); const leaves = tpl.filter(([, , , id]) => LEAF_IDS.has(id)); const top = t.h + t.hh;
			const bx = Math.max(...leaves.map(([x]) => Math.abs(x - t.x))), bz = Math.max(...leaves.map(([, , z]) => Math.abs(z - t.z))), ymin = Math.min(...leaves.map(([, y]) => y)), ymax = Math.max(...leaves.map(([, y]) => y));
			let exp: [number, number, number, number, number]; // [leafMin, leafMax, maxXZ, yMin, yMax]
			if (t.sp.name === 'oak' || t.sp.name === 'birch') exp = [53, 61, 2, top - 3, top + 1];
			else if (t.sp.name === 'spruce') { const L = t.hh - 2; const n = 8 * Math.ceil(L / 2) + 20 * Math.floor(L / 2) + 1; exp = [n, n, 2, t.h + 3, top + 1]; }
			else if (t.sp.name === 'acacia') exp = [25, 25, 3, top, top + 1];
			else exp = [93, 93, 3, top - 1, top + 2];
			expect(logs.length, t.sp.name).toBe(t.hh);
			if (t.sp.name === 'acacia') expect(logs.filter(([x, , z]) => x !== t.x || z !== t.z).length).toBe(2); else expect(logs.every(([x, , z]) => x === t.x && z === t.z)).toBe(true);
			expect(leaves.length, `${t.sp.name} hh ${t.hh}`).toBeGreaterThanOrEqual(exp[0]); expect(leaves.length).toBeLessThanOrEqual(exp[1]);
			expect(Math.max(bx, bz)).toBeLessThanOrEqual(exp[2]); expect(ymin).toBe(exp[3]); expect(ymax).toBe(exp[4]);
			seen.add(t.sp.name);
		}
		expect([...seen].sort()).toEqual(['acacia', 'birch', 'cherry', 'oak', 'spruce']);
	});
	it('§11.9 template completeness across chunk planes and base voxels (16 × 16 chunks of seed 1)', () => {
		const get = region(1, 8, 23, 8, 23); let trees = 0, missingLogs = 0, missingLeaves = 0, baseBad = 0; const forest: number[] = [];
		for (let cz = 9; cz <= 22; cz++) for (let cx = 9; cx <= 22; cx++) { const list = treesOf(1, cx, cz); const cc = column(1, cx * 16 + 8, cz * 16 + 8); if (cc.biome === BIOME.forest) forest.push(list.length);
			for (const t of list) { trees++; if (![V3.dirt, V3.grass_block, V3.podzol, V3.coarse_dirt, V3.snow_block].includes(get(t.x, t.h, t.z))) baseBad++;
				for (const [x, y, z, id] of treeTemplate(t)) { const v = get(x, y, z); if (LOG_IDS.has(id)) { if (v !== id) missingLogs++; } else if (v === 0) missingLeaves++; } } }
		expect(trees).toBeGreaterThan(50); expect(missingLogs).toBe(0); expect(missingLeaves).toBe(0); expect(baseBad).toBe(0);
		if (forest.length) expect(forest.reduce((a, b) => a + b, 0) / forest.length).toBeGreaterThanOrEqual(0.4);
	}, 60_000);
	it('SPECIES trunk ranges match §8', () => {
		expect([SPECIES.oak.h0, SPECIES.oak.h1]).toEqual([4, 6]); expect([SPECIES.birch.h0, SPECIES.birch.h1]).toEqual([5, 7]); expect([SPECIES.spruce.h0, SPECIES.spruce.h1]).toEqual([6, 10]);
		expect([SPECIES.acacia.h0, SPECIES.acacia.h1]).toEqual([5, 6]); expect([SPECIES.cherry.h0, SPECIES.cherry.h1]).toEqual([4, 5]);
	});
});
