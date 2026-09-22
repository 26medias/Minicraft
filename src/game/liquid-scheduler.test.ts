import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { BLOCK_BY_NAME, AIR, LAVA, OBSIDIAN, WATER } from '../data/blocks.data';
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

const sponge = BLOCK_BY_NAME['sponge'].id;
const wetSponge = BLOCK_BY_NAME['wet_sponge'].id;

/** Like freshWorld() but also clears chunks (15,16) and (17,16), for tests near x=256 / x=271. */
function freshWorldWide(): World {
	const w = new World(1);
	for (const cx of [15, 16, 17]) {
		const c = w.ensureChunk(cx, 16);
		c.blocks.fill(AIR);
		c.lights.fill(0);
		c.liquidFrontier.clear();
	}
	return w;
}

/** Stone slab at y (default 29) covering x0..x1 × z0..z1 inclusive. */
function floor(w: World, x0: number, x1: number, z0: number, z1: number, y = 29): void {
	for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) w.setBlock(x, y, z, stone);
}

/** Whether the voxel is a liquid source (liquid present, no flow meta). */
function isSourceAt(w: World, x: number, y: number, z: number): boolean {
	const c = w.getChunk(Math.floor(x / 16), Math.floor(z / 16))!;
	return !c.isFlow(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16);
}

// Task 2 (sponge tests) is the first consumer of these; keep noUnusedLocals quiet until then.
void [WATER, sponge, wetSponge, isSourceAt];

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

describe('block id exports', () => {
	it('SPONGE and WET_SPONGE resolve to the catalog rows', async () => {
		const mod = await import('../data/blocks.data');
		expect(mod.SPONGE).toBe(315);
		expect(mod.WET_SPONGE).toBe(363);
	});
});

describe('LiquidScheduler — chunk-edge dirty reporting', () => {
	it('an obsidian reaction at local x=0 also dirties the -x neighbour chunk', () => {
		const w = freshWorldWide();
		floor(w, 255, 258, 259, 261);
		// Walls so nothing spreads sideways: only the reaction writes.
		for (const z of [259, 261]) for (let x = 255; x <= 258; x++) w.setBlock(x, 30, z, stone);
		w.setBlock(255, 30, 260, stone);
		w.setBlock(258, 30, 260, stone);
		w.setBlock(256, 30, 260, LAVA);   // chunk 16, lx = 0
		w.setBlock(257, 30, 260, water);
		const dirty: [number, number][] = [];
		const s = new LiquidScheduler(w, (cx, cz) => dirty.push([cx, cz]));
		s.tick(0.6);
		expect(w.getBlock(256, 30, 260)).toBe(OBSIDIAN);
		expect(dirty).toContainEqual([15, 16]);
	});

	it('markDirty at world x=0 emits the out-of-world neighbour key without throwing', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 16);
		c.blocks.fill(AIR); c.lights.fill(0); c.liquidFrontier.clear();
		floor(w, 0, 3, 259, 261);
		w.setBlock(0, 30, 260, LAVA);
		w.setBlock(1, 30, 260, water);
		const dirty: [number, number][] = [];
		expect(() => new LiquidScheduler(w, (cx, cz) => dirty.push([cx, cz])).tick(0.6)).not.toThrow();
		expect(dirty).toContainEqual([-1, 16]);
	});
});

describe('LiquidScheduler — sponge', () => {
	it('1. dry sponge absorbs an adjacent source and turns wet', () => {
		const w = freshWorld();
		floor(w, 259, 262, 259, 261);
		w.setBlock(260, 30, 260, water);
		w.setBlock(261, 30, 260, sponge);
		// Note: tick()'s return value is not asserted — on the pristine scheduler it is
		// already true every tick (pre-existing, out of scope), so it cannot go red.
		new LiquidScheduler(w, () => {}).tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(AIR);
		expect(w.getBlock(261, 30, 260)).toBe(wetSponge);
	});

	it('2. absorbs exactly 7 hops along a line', () => {
		const w = freshWorld();
		floor(w, 258, 271, 259, 261);
		for (let x = 260; x <= 270; x++) w.setBlock(x, 30, 260, water);
		w.setBlock(259, 30, 260, sponge);
		new LiquidScheduler(w, () => {}).tick(0.6);
		expect(w.getBlock(259, 30, 260)).toBe(wetSponge);
		for (let x = 260; x <= 265; x++) expect(w.getBlock(x, 30, 260), `x=${x}`).toBe(AIR);
		// 266 (hop 7) may already be refilled as flow from 267 this same tick.
		expect(w.getBlock(267, 30, 260)).toBe(water);
		expect(isSourceAt(w, 267, 30, 260)).toBe(true);
	});

	it('3. distance is BFS hops through liquid, not taxicab', () => {
		const w = freshWorld();
		floor(w, 259, 268, 258, 265);
		// Fill the slab with stone at y=30, then carve a serpentine so every carved
		// cell stays inside the taxicab-7 ball of the sponge while hop count exceeds 7.
		for (let x = 259; x <= 268; x++) for (let z = 258; z <= 265; z++) w.setBlock(x, 30, z, stone);
		const carve = (x: number, z: number) => w.setBlock(x, 30, z, water);
		for (let x = 262; x <= 265; x++) carve(x, 260);   // hops 1..4
		carve(265, 261);                                   // hop 5
		carve(265, 262);                                   // hop 6
		carve(264, 262);                                   // hop 7
		carve(263, 262);                                   // hop 8, taxicab 4
		carve(262, 262);                                   // hop 9, taxicab 3
		w.setBlock(261, 30, 260, sponge);
		new LiquidScheduler(w, () => {}).tick(0.6);
		expect(w.getBlock(261, 30, 260)).toBe(wetSponge);
		for (let x = 262; x <= 265; x++) expect(w.getBlock(x, 30, 260), `x=${x}`).toBe(AIR);
		// (264,262) is hop 7: absorbed, then refilled as flow from (263,262) this tick — not asserted.
		expect(w.getBlock(263, 30, 262)).toBe(water);
		expect(isSourceAt(w, 263, 30, 262)).toBe(true);
		expect(w.getBlock(262, 30, 262)).toBe(water);
		expect(isSourceAt(w, 262, 30, 262)).toBe(true);
	});

	it('3b. walls stop the search (U-channel)', () => {
		const w = freshWorld();
		floor(w, 260, 270, 258, 265);
		for (let x = 260; x <= 270; x++) for (let z = 258; z <= 265; z++) w.setBlock(x, 30, z, stone);
		const carve = (x: number, z: number) => w.setBlock(x, 30, z, water);
		for (let x = 262; x <= 268; x++) carve(x, 260);          // hops 1..7
		for (let z = 261; z <= 263; z++) carve(268, z);          // hops 8..10
		for (let x = 267; x >= 262; x--) carve(x, 263);          // hops 11..16
		w.setBlock(261, 30, 260, sponge);
		new LiquidScheduler(w, () => {}).tick(0.6);
		for (let x = 262; x <= 267; x++) expect(w.getBlock(x, 30, 260), `x=${x}`).toBe(AIR);
		expect(w.getBlock(262, 30, 263)).toBe(water);
		expect(isSourceAt(w, 262, 30, 263)).toBe(true);
	});

	it('4. search does not jump a non-liquid gap', () => {
		const w = freshWorld();
		floor(w, 258, 263, 259, 261);
		w.setBlock(260, 30, 260, water);
		w.setBlock(261, 30, 260, stone);
		w.setBlock(262, 30, 260, water);
		w.setBlock(259, 30, 260, sponge);
		new LiquidScheduler(w, () => {}).tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(AIR);
		expect(w.getBlock(262, 30, 260)).toBe(water);
	});

	it('5. lava and water are one component; no obsidian forms', () => {
		const w = freshWorld();
		floor(w, 259, 263, 259, 261);
		w.setBlock(260, 30, 260, LAVA);
		w.setBlock(261, 30, 260, water);
		w.setBlock(262, 30, 260, sponge);
		new LiquidScheduler(w, () => {}).tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(AIR);
		expect(w.getBlock(261, 30, 260)).toBe(AIR);
		expect(w.getBlock(262, 30, 260)).toBe(wetSponge);
		for (let x = 260; x <= 262; x++) for (let z = 259; z <= 261; z++) {
			expect(w.getBlock(x, 30, z), `${x},${z}`).not.toBe(OBSIDIAN);
		}
	});

	it('6. wet sponge does nothing', () => {
		const w = freshWorld();
		floor(w, 259, 262, 259, 261);
		w.setBlock(260, 30, 260, water);
		w.setBlock(261, 30, 260, wetSponge);
		new LiquidScheduler(w, () => {}).tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(water);
		expect(w.getBlock(261, 30, 260)).toBe(wetSponge);
	});

	it('7. fires when liquid arrives later (open floor)', () => {
		const w = freshWorld();
		floor(w, 258, 266, 259, 261);
		w.setBlock(263, 30, 260, sponge);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		let ticks = 0;
		while (w.getBlock(263, 30, 260) !== wetSponge && ticks < 5) { s.tick(0.6); ticks++; }
		expect(w.getBlock(263, 30, 260)).toBe(wetSponge);
		for (let x = 260; x <= 262; x++) expect(w.getBlock(x, 30, 260), `x=${x}`).toBe(AIR);
	});

	it('9. sponge placed against draining flow still absorbs', () => {
		const w = freshWorld();
		floor(w, 258, 267, 259, 261);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		for (let i = 0; i < 4; i++) s.tick(0.6);
		expect(w.getBlock(264, 30, 260)).toBe(water);
		w.setBlock(260, 30, 260, AIR);           // remove the source: puddle is orphan
		w.setBlock(265, 30, 260, sponge);
		s.tick(0.6);
		expect(w.getBlock(265, 30, 260)).toBe(wetSponge);
		expect(w.getBlock(264, 30, 260)).toBe(AIR);
	});

	it('10. zero absorb keeps the sponge dry', () => {
		const w = freshWorld();
		floor(w, 259, 262, 259, 261);
		w.setBlock(261, 30, 260, sponge);
		w.getChunk(16, 16)!.liquidFrontier.add(indexOf(4, 30, 4));   // stale entry at (260,30,260)
		new LiquidScheduler(w, () => {}).tick(0.6);
		expect(w.getBlock(261, 30, 260)).toBe(sponge);
	});

	it('11. onBlockChanged fires for the absorbed lava cell and the sponge cell', () => {
		const w = freshWorld();
		floor(w, 259, 262, 259, 261);
		w.setBlock(260, 30, 260, LAVA);
		w.setBlock(261, 30, 260, sponge);
		const changed: [number, number, number][] = [];
		new LiquidScheduler(w, () => {}, (x, y, z) => changed.push([x, y, z])).tick(0.6);
		expect(changed).toContainEqual([260, 30, 260]);
		expect(changed).toContainEqual([261, 30, 260]);
	});

	it('12. a sponge on a chunk edge dirties the neighbour chunk', () => {
		const w = freshWorldWide();
		floor(w, 255, 258, 259, 261);
		w.setBlock(256, 30, 260, sponge);       // chunk 16, local x 0
		w.setBlock(257, 30, 260, water);
		const dirty: [number, number][] = [];
		new LiquidScheduler(w, (cx, cz) => dirty.push([cx, cz])).tick(0.6);
		expect(w.getBlock(256, 30, 260)).toBe(wetSponge);
		expect(dirty).toContainEqual([15, 16]);
	});

	it('13. a sponge placed INTO a liquid cell absorbs its neighbours', () => {
		const w = freshWorld();
		floor(w, 258, 262, 258, 262);
		for (let x = 259; x <= 261; x++) for (let z = 259; z <= 261; z++) w.setBlock(x, 30, z, water);
		w.setBlock(260, 30, 260, sponge);      // overwrites the centre source, as placeBlock does
		new LiquidScheduler(w, () => {}).tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(wetSponge);
		for (let x = 259; x <= 261; x++) for (let z = 259; z <= 261; z++) {
			if (x === 260 && z === 260) continue;
			expect(w.getBlock(x, 30, z), `${x},${z}`).toBe(AIR);
		}
	});

	it('14. a sponge hole next to an orphan puddle settles to dry', () => {
		const w = freshWorld();
		floor(w, 255, 268, 255, 265);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		for (let i = 0; i < 4; i++) s.tick(0.6);      // 4-hop puddle, 41 cells
		w.setBlock(265, 30, 260, sponge);             // touches the distance-4 rim
		w.setBlock(260, 30, 260, AIR);                // puddle is now orphan
		const liquidCount = () => {
			let n = 0;
			for (let x = 255; x <= 268; x++) for (let z = 255; z <= 265; z++) if (w.getBlock(x, 30, z) === water) n++;
			return n;
		};
		for (let i = 0; i < 12; i++) s.tick(0.6);
		expect(w.getBlock(265, 30, 260)).toBe(wetSponge);
		expect(liquidCount()).toBe(0);
	});

	it('8. fires at the end of a 1-wide trench (decay exception)', () => {
		const w = freshWorld();
		floor(w, 258, 266, 259, 261);
		for (let x = 259; x <= 263; x++) { w.setBlock(x, 30, 259, stone); w.setBlock(x, 30, 261, stone); }
		w.setBlock(263, 30, 260, sponge);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		let ticks = 0;
		while (w.getBlock(263, 30, 260) !== wetSponge && ticks < 6) { s.tick(0.6); ticks++; }
		expect(w.getBlock(263, 30, 260)).toBe(wetSponge);
		expect(w.getBlock(262, 30, 260)).toBe(AIR);
	});

	it('8b. a sponge sitting on top of the trench end still fires', () => {
		const w = freshWorld();
		floor(w, 258, 263, 259, 261);
		for (let x = 259; x <= 262; x++) { w.setBlock(x, 30, 259, stone); w.setBlock(x, 30, 261, stone); }
		w.setBlock(263, 30, 260, stone);        // trench dead-ends here
		w.setBlock(262, 31, 260, sponge);       // sponge on top of the last trench cell
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		let ticks = 0;
		while (w.getBlock(262, 31, 260) !== wetSponge && ticks < 6) { s.tick(0.6); ticks++; }
		expect(w.getBlock(262, 31, 260)).toBe(wetSponge);
		expect(w.getBlock(262, 30, 260)).toBe(AIR);
	});
});

describe('liquids at height 256', () => {
	it('a source at y=240 falls to a floor at y=121', () => {
		const w = new World(1, { height: 256 });
		const c = w.ensureChunk(16, 16); c.blocks.fill(AIR); c.lights.fill(0); c.liquidFrontier.clear();
		floor(w, 258, 262, 258, 262, 121);
		w.setBlock(260, 240, 260, water);
		const s = new LiquidScheduler(w, () => {});
		// The scheduler advances one block per 0.5 s flow step; tick until the water
		// lands or we give up. 2000 ticks is ~10x the 118-block fall.
		let ticks = 0;
		while (w.getBlock(260, 122, 260) !== water && ticks < 2000) { s.tick(0.5); ticks++; }
		expect(ticks).toBeLessThan(2000);
		expect(w.getBlock(260, 122, 260)).toBe(water);
		expect(w.getBlock(260, 121, 260)).toBe(stone);
	});
});

describe('world edge and arrival seeding (perf gate-1 follow-up)', () => {
	it('water against the world edge treats outside the map as a wall: no writes, frontier decays', () => {
		const w = new World(1);
		const c = w.ensureChunk(31, 16); // east edge: world x 496..511
		c.blocks.fill(AIR);
		c.liquidFrontier.clear();
		for (let x = 500; x <= 511; x++) for (let z = 260; z <= 265; z++) {
			w.setBlock(x, 29, z, stone);
			w.setBlock(x, 30, z, water);
		}
		// wall the other three sides so only the map edge is open
		for (let z = 259; z <= 266; z++) { w.setBlock(499, 30, z, stone); }
		for (let x = 499; x <= 511; x++) { w.setBlock(x, 30, 259, stone); w.setBlock(x, 30, 266, stone); }
		for (let x = 500; x <= 511; x++) for (let z = 260; z <= 265; z++) c.liquidFrontier.add((30 * 256) + ((z & 15) * 16) + (x & 15));
		let writes = 0;
		const s = new LiquidScheduler(w, () => {}, () => { writes++; });
		for (let k = 0; k < 4; k++) s.tick(0.5);
		expect(writes).toBe(0);
		expect(c.liquidFrontier.size).toBe(0);
	});

	it('seedArrival adds only liquid cells that can act this tick, and one tick then matches full seeding', () => {
		const build = () => {
			const w = freshWorldWide();
			floor(w, 256, 271, 256, 271);
			// enclosed pool (stone walls, no air contact): rests
			for (let x = 258; x <= 262; x++) for (let z = 258; z <= 262; z++) w.setBlock(x, 30, z, water);
			for (let x = 257; x <= 263; x++) { w.setBlock(x, 30, 257, stone); w.setBlock(x, 30, 263, stone); w.setBlock(x, 31, 257, stone); w.setBlock(x, 31, 263, stone); }
			for (let z = 257; z <= 263; z++) { w.setBlock(257, 30, z, stone); w.setBlock(263, 30, z, stone); }
			for (let x = 258; x <= 262; x++) for (let z = 258; z <= 262; z++) w.setBlock(x, 31, z, stone); // lid
			// open puddle next to air: can spread
			w.setBlock(266, 30, 266, water);
			// water touching lava under a lid: reacts
			w.setBlock(268, 30, 260, water); w.setBlock(269, 30, 260, LAVA);
			for (const [x, z] of [[267, 260], [270, 260], [268, 259], [268, 261], [269, 259], [269, 261]] as const) w.setBlock(x, 30, z, stone);
			w.setBlock(268, 31, 260, stone); w.setBlock(269, 31, 260, stone);
			// water next to a sponge
			w.setBlock(260, 30, 268, water); w.setBlock(261, 30, 268, sponge);
			for (const [x, z] of [[259, 268], [260, 267], [260, 269]] as const) w.setBlock(x, 30, z, stone);
			w.setBlock(260, 31, 268, stone);
			const c = w.getChunk(16, 16)!;
			c.liquidFrontier.clear();
			return { w, c };
		};
		const snap = (w: World) => Array.from(w.getChunk(16, 16)!.blocks);
		// reference: today's full seeding (every liquid voxel)
		const A = build();
		for (let i = 0; i < A.c.blocks.length; i++) if (A.c.blocks[i] === water || A.c.blocks[i] === LAVA) A.c.liquidFrontier.add(i);
		const sa = new LiquidScheduler(A.w, () => {});
		// candidate: seedArrival
		const B = build();
		const sb = new LiquidScheduler(B.w, () => {});
		sb.seedArrival(B.c);
		// the 25-cell enclosed pool is not seeded; the puddle, the water/lava pair and the sponge-side water are
		expect(B.c.liquidFrontier.size).toBe(4);
		sa.tick(0.5); sb.tick(0.5);
		expect(snap(B.w)).toEqual(snap(A.w));
		expect([...B.c.liquidFrontier].sort()).toEqual([...A.c.liquidFrontier].sort());
	});

	it('a chunk holding flow cells is seeded in full (drain needs its sources)', () => {
		const w = freshWorld();
		const c = w.getChunk(16, 16)!;
		floor(w, 256, 271, 256, 271);
		w.setBlock(260, 30, 260, water);
		w.setBlockFlow(261, 30, 260, water, 1);
		for (const [x, z] of [[259, 260], [262, 260], [260, 259], [260, 261], [261, 259], [261, 261]] as const) w.setBlock(x, 30, z, stone);
		w.setBlock(260, 31, 260, stone); w.setBlock(261, 31, 260, stone);
		c.liquidFrontier.clear();
		new LiquidScheduler(w, () => {}).seedArrival(c);
		expect(c.liquidFrontier.size).toBe(2);
	});
});
