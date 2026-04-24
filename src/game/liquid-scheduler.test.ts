import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { BLOCK_BY_NAME, AIR, LAVA, OBSIDIAN } from '../data/blocks.data';
import { LiquidScheduler } from './liquid-scheduler';

const water = BLOCK_BY_NAME['water'].id;
const stone = BLOCK_BY_NAME['stone'].id;

function freshWorld(): World {
	const w = new World(1);
	// Force-create chunk (16, 16) covering coords ~(256..271). Clear it.
	const c = w.ensureChunk(16, 16);
	c.blocks.fill(AIR);
	c.lights.fill(0);
	c.liquidFrontier.clear();
	return w;
}

describe('LiquidScheduler — tick accumulator', () => {
	it('tick(0.4) does not fire', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.4);
		expect(w.getBlock(260, 30, 260)).toBe(water);
		expect(w.getBlock(260, 29, 260)).toBe(AIR);
	});

	it('tick(0.6) fires once', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(water);  // source stays in place
		expect(w.getBlock(260, 29, 260)).toBe(water);  // flow created below
	});

	it('tick(1.2) fires once, not twice (no catch-up)', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(1.2);
		expect(w.getBlock(260, 30, 260)).toBe(water);  // source stays
		expect(w.getBlock(260, 29, 260)).toBe(water);  // one flow voxel below
		expect(w.getBlock(260, 28, 260)).toBe(AIR);    // not two
	});
});

describe('LiquidScheduler — fall rule', () => {
	it('unsupported liquid block falls by 1 voxel per tick', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 29, 260)).toBe(water);  // flow created
		expect(w.getBlock(260, 30, 260)).toBe(water);  // source stays
	});

	it('liquid with solid below does not fall', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, stone);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(water);
	});

	it('liquid with same-type liquid below does not fall', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, water);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(water);
		expect(w.getBlock(260, 29, 260)).toBe(water);
	});
});

import { indexOf } from '../engine/world/coords';

describe('LiquidScheduler — sideways spread', () => {
	it('liquid with solid below spreads horizontally to adjacent air', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, stone);
		w.setBlock(261, 29, 260, stone); // neighbor support
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(261, 30, 260)).toBe(water);
	});

	it('liquid does not spread upward', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, stone);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 31, 260)).toBe(AIR);
	});

	it('fall takes priority over sideways-spread', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 29, 260)).toBe(water);
		expect(w.getBlock(261, 30, 260)).toBe(AIR);
	});

	it('fully-enclosed liquid drops out of the active frontier', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		w.setBlock(260, 29, 260, stone);
		w.setBlock(260, 31, 260, stone);
		w.setBlock(259, 30, 260, stone);
		w.setBlock(261, 30, 260, stone);
		w.setBlock(260, 30, 259, stone);
		w.setBlock(260, 30, 261, stone);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		const c = w.getChunk(Math.floor(260 / 16), Math.floor(260 / 16))!;
		const lx = 260 % 16,
			lz = 260 % 16;
		expect(c.liquidFrontier.has(indexOf(lx, 30, lz))).toBe(false);
	});
});

describe('LiquidScheduler — bounded spread (water budget = 4)', () => {
	function flatGroundWorld(): World {
		const w = new World(1);
		const c = w.ensureChunk(16, 16);
		c.blocks.fill(AIR);
		c.lights.fill(0);
		c.fluidMeta.clear();
		c.liquidFrontier.clear();
		// Stone floor across the chunk at y=29
		for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
			c.set(lx, 29, lz, BLOCK_BY_NAME['stone'].id);
		}
		return w;
	}

	it('water source on flat ground spreads to distance 4 and stops', () => {
		const w = flatGroundWorld();
		w.setBlock(264, 30, 264, water); // source
		const s = new LiquidScheduler(w, () => {});
		for (let i = 0; i < 5; i++) s.tick(0.6);

		expect(w.getBlock(268, 30, 264)).toBe(water);
		expect(w.getBlock(269, 30, 264)).toBe(AIR);
		expect(w.getBlock(264, 30, 264)).toBe(water);
		expect(w.getBlock(266, 30, 266)).toBe(water);
		expect(w.getBlock(267, 30, 267)).toBe(AIR);
	});
});

describe('LiquidScheduler — bounded spread (lava budget = 2)', () => {
	function flatGroundWorld(): World {
		const w = new World(1);
		const c = w.ensureChunk(16, 16);
		c.blocks.fill(AIR);
		c.lights.fill(0);
		c.fluidMeta.clear();
		c.liquidFrontier.clear();
		for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
			c.set(lx, 29, lz, BLOCK_BY_NAME['stone'].id);
		}
		return w;
	}

	it('lava source on flat ground spreads to distance 2 and stops', () => {
		const w = flatGroundWorld();
		w.setBlock(264, 30, 264, LAVA);
		const s = new LiquidScheduler(w, () => {});
		for (let i = 0; i < 5; i++) s.tick(0.6);

		expect(w.getBlock(266, 30, 264)).toBe(LAVA);
		expect(w.getBlock(267, 30, 264)).toBe(AIR);
	});
});

describe('LiquidScheduler — vertical falls do not consume budget', () => {
	it('water falling from a tall cliff still spreads 4 hops at the bottom', () => {
		const w = new World(1);
		const c = w.ensureChunk(16, 16);
		c.blocks.fill(AIR);
		c.lights.fill(0);
		c.fluidMeta.clear();
		c.liquidFrontier.clear();
		for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
			c.set(lx, 29, lz, BLOCK_BY_NAME['stone'].id);
		}
		w.setBlock(264, 38, 264, water);
		const s = new LiquidScheduler(w, () => {});
		for (let i = 0; i < 13; i++) s.tick(0.6);

		for (let y = 30; y <= 38; y++) {
			expect(w.getBlock(264, y, 264)).toBe(water);
		}
		expect(w.getBlock(268, 30, 264)).toBe(water);
		expect(w.getBlock(269, 30, 264)).toBe(AIR);
	});
});

describe('LiquidScheduler — water + lava reaction', () => {
	it('water adjacent to lava → lava becomes obsidian, water becomes air', () => {
		const w = new World(1);
		const c = w.ensureChunk(16, 16);
		c.blocks.fill(AIR);
		c.fluidMeta.clear();
		c.liquidFrontier.clear();
		c.set(8, 29, 8, BLOCK_BY_NAME['stone'].id);
		c.set(9, 29, 8, BLOCK_BY_NAME['stone'].id);
		w.setBlock(264, 30, 264, water);
		w.setBlock(265, 30, 264, LAVA);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);

		expect(w.getBlock(265, 30, 264)).toBe(OBSIDIAN);
		expect(w.getBlock(264, 30, 264)).toBe(AIR);
	});
});

describe('LiquidScheduler — drain when source removed', () => {
	function flatGroundWorld(): World {
		const w = new World(1);
		const c = w.ensureChunk(16, 16);
		c.blocks.fill(AIR);
		c.fluidMeta.clear();
		c.liquidFrontier.clear();
		for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
			c.set(lx, 29, lz, BLOCK_BY_NAME['stone'].id);
		}
		return w;
	}

	it('mining the source drains the puddle one ring per tick', () => {
		const w = flatGroundWorld();
		w.setBlock(264, 30, 264, water);
		const s = new LiquidScheduler(w, () => {});
		for (let i = 0; i < 5; i++) s.tick(0.6);
		expect(w.getBlock(268, 30, 264)).toBe(water);

		w.setBlock(264, 30, 264, AIR);

		s.tick(0.6);
		expect(w.getBlock(268, 30, 264)).toBe(AIR);
		expect(w.getBlock(267, 30, 264)).toBe(water);

		s.tick(0.6);
		s.tick(0.6);
		s.tick(0.6);
		for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
			if (Math.abs(dx) + Math.abs(dz) === 0) continue;
			expect(w.getBlock(264 + dx, 30, 264 + dz)).toBe(AIR);
		}
	});

	it('two sources feeding the same puddle: removing one leaves the puddle', () => {
		const w = flatGroundWorld();
		w.setBlock(260, 30, 264, water);
		w.setBlock(268, 30, 264, water);
		const s = new LiquidScheduler(w, () => {});
		for (let i = 0; i < 6; i++) s.tick(0.6);
		expect(w.getBlock(264, 30, 264)).toBe(water);

		w.setBlock(260, 30, 264, AIR);

		for (let i = 0; i < 6; i++) s.tick(0.6);
		expect(w.getBlock(268, 30, 264)).toBe(water);
		expect(w.getBlock(267, 30, 264)).toBe(water);
	});
});

describe('LiquidScheduler — generation ocean is free', () => {
	it('mining a cell from a sea of sources creates no fluidMeta entries', () => {
		const w = new World(1);
		const c = w.ensureChunk(16, 16);
		c.blocks.fill(AIR);
		c.fluidMeta.clear();
		c.liquidFrontier.clear();
		for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
			c.set(dx, 29, dz, BLOCK_BY_NAME['stone'].id);
			c.set(dx, 30, dz, water);
			c.liquidFrontier.add(indexOf(dx, 30, dz));
		}
		const s = new LiquidScheduler(w, () => {});
		w.setBlock(258, 30, 258, AIR);
		s.tick(0.6);

		expect(w.getBlock(258, 30, 258)).toBe(water);
		expect(c.isFlow(0, 30, 0)).toBe(false);
		expect(c.isFlow(4, 30, 4)).toBe(false);
	});
});
