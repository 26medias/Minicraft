import { describe, it, expect } from 'vitest';
import { WORLDGEN_BLOCKS, CRAFTED_ONLY, PICKAXES, AREA_FLOOR_ARMED, AREA_FLOOR_HELD } from './crafting.data';
import { NAMES } from '../engine/world/v3/blocks';
import { Chunk } from '../engine/world/chunk';
import { generateChunkV3 } from '../engine/world/v3/generate';
import { BLOCKS, BLOCK_BY_NAME } from './blocks.data';

describe('WORLDGEN_BLOCKS (spec §3)', () => {
	it('every entry is a v3 NAMES entry and a real block (catches a typo, which would leave the real block free to farm)', () => {
		const names = new Set<string>(NAMES);
		for (const n of WORLDGEN_BLOCKS) {
			expect(names.has(n), n).toBe(true);
			expect(BLOCK_BY_NAME[n], n).toBeDefined();
		}
		expect(new Set(WORLDGEN_BLOCKS).size).toBe(WORLDGEN_BLOCKS.length);
	});

	it('leaves out the exclusions and the never-generated names (catches a list copied from NAMES, which counts cobblestone)', () => {
		for (const n of ['air', 'water', 'lava', 'bedrock', 'cobblestone', 'mossy_cobblestone', 'red_sandstone'])
			expect(WORLDGEN_BLOCKS, n).not.toContain(n);
	});

	// Slow: 512 v3 chunks, ≈ 2.2 s measured alone on the dev box (spec estimate ≈ 6 s under load); explicit timeout.
	it('[slow] holds every block seed 1 writes on every second chunk column (cx even), apart from air, water, lava, bedrock (catches a hand list missing a generated block such as tuff)', () => {
		const excluded = new Set(['air', 'water', 'lava', 'bedrock']);
		const listed = new Set(WORLDGEN_BLOCKS);
		const seen = new Uint8Array(BLOCKS.length);
		for (let cx = 0; cx < 32; cx += 2) for (let cz = 0; cz < 32; cz++) {
			const c = new Chunk(cx, cz, 256);
			generateChunkV3(c, 1);
			for (let i = 0; i < c.blocks.length; i++) seen[c.blocks[i]] = 1;
		}
		const missing: string[] = [];
		for (let id = 0; id < seen.length; id++) {
			if (!seen[id]) continue;
			const name = BLOCKS[id].name;
			if (!excluded.has(name) && !listed.has(name)) missing.push(name);
		}
		expect(missing).toEqual([]);
	}, 60_000);
});

describe('CRAFTED_ONLY', () => {
	it('is Big and Mega TNT plus the five blast toys; plain tnt is not crafted-only (catches plain TNT becoming unplaceable in unlimited worlds, and a toy placeable for free)', () => {
		expect([...CRAFTED_ONLY]).toEqual(['big_tnt', 'mega_tnt', 'fireworks', 'tunnel_tnt', 'block_bomb', 'flatten_tnt', 'lake_tnt']);
	});
});

describe('PICKAXES (spec §4 table)', () => {
	it('has tiers 0–7 with the spec bonuses and areas (catches a transposed bonus or an area written d × w × h)', () => {
		expect(PICKAXES.map((p) => [p.tier, p.bonus, p.area.w, p.area.h, p.area.d])).toEqual([
			[0, 0, 1, 1, 1],
			[1, 0.15, 1, 1, 1],
			[2, 0.5, 1, 1, 1],
			[3, 0.75, 1, 1, 2],
			[4, 1, 3, 3, 1],
			[5, 2, 3, 3, 2],
			[6, 5, 3, 3, 3],
			[7, 10, 5, 5, 5],
		]);
		PICKAXES.forEach((p, i) => expect(p.tier).toBe(i));
	});

	it('floors are 0.4 s armed and 0.25 s held', () => {
		expect(AREA_FLOOR_ARMED).toBe(0.4);
		expect(AREA_FLOOR_HELD).toBe(0.25);
	});
});
