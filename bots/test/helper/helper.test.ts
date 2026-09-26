import { describe, expect, it } from 'vitest';
import { Ownership } from '../../src/brain2/ownership.js';
import { planCells } from '../../src/builder/moves.js';
import { HELP_CHOICES, facing, helpTemplate, helperSite, kidBuilding, kidPalette, rotate, type KidPlacement } from '../../src/helper/plan.js';
import { FakeWorld } from '../fake-port.js';

function kidRow() {
	const world = new FakeWorld();
	const cells = [];
	for (let i = 0; i < 10; i++) {
		const x = 100 + i, z = 100;
		const c = { x, y: world.surfaceY(x, z) + 1, z };
		world.set(c.x, c.y, c.z, i < 8 ? 'oak_planks' : 'cobblestone');
		cells.push(c);
	}
	const own = new Ownership(world, () => ({}));
	return { world, cells, own, blocks: cells.map((_, i) => (i < 8 ? 'oak_planks' : 'cobblestone')) };
}

describe('helper placement rule', () => {
	// Red if the site rule lets a helper cell near a kid cell (mutation run: the ≥ 4 gap checks removed and the nearest
	// site preferred → 3 of 4 choices land 1–2 blocks away), or the palette is not his.
	for (const choice of Object.keys(HELP_CHOICES)) {
		it(`${choice}: every cell ≥ 4 (never within 3) of his cells, nearest ≤ 8, only his blocks, facing him`, () => {
			const { world, cells, own, blocks } = kidRow();
			const kid = { x: 104.5, y: cells[4].y, z: 102.5 };
			let n = 0;
			const rng = () => (n++ % 3) / 3;
			const t = helpTemplate(choice, rng);
			const site = helperSite({ world, template: t, kidCells: cells, kidCellWithin: (x, z, r) => own.kidCellWithin(x, z, r), kids: [kid] });
			expect(site, choice).not.toBeNull();
			const palette = kidPalette(blocks)!;
			const plan = planCells(site!.template, site!.origin, palette);
			expect(plan.length).toBe(t.cells.length);
			const gaps = plan.map((p) => Math.min(...cells.map((c) => Math.hypot(c.x - p.cell.x, c.z - p.cell.z))));
			expect(Math.min(...gaps)).toBeGreaterThan(3);
			expect(Math.min(...gaps)).toBeLessThanOrEqual(8);
			for (const p of plan) expect(['oak_planks', 'cobblestone']).toContain(p.block);
			// Never inside his body buffer (his box's columns ± 1).
			expect(plan.some((p) => Math.abs(p.cell.x + 0.5 - kid.x) <= 1.8 && Math.abs(p.cell.z + 0.5 - kid.z) <= 1.8)).toBe(false);
			const fc = { x: site!.origin.x + site!.template.w / 2, z: site!.origin.z + site!.template.d / 2 };
			expect(site!.rot).toBe(facing(fc, { x: 104.5, z: 100 }));
		});
	}

	it('his palette: most-used block is the wall; TNT, sand and liquids are never copied', () => {
		expect(kidPalette(['oak_planks', 'oak_planks', 'glass'])!.blocks).toEqual({ wall: 'oak_planks', roof: 'glass', floor: 'oak_planks', accent: 'glass' });
		expect(kidPalette(['tnt', 'sand', 'water'])).toBeNull();
	});

	it('a rotated template keeps its cells and swaps its footprint', () => {
		const t = helpTemplate('wall', () => 0);
		const r = rotate(t, 1);
		expect([r.w, r.d]).toEqual([t.d, t.w]);
		expect(r.cells.every((c) => c.x >= 0 && c.x < r.w && c.z >= 0 && c.z < r.d)).toBe(true);
	});

	it('kidBuilding: ≥ 3 placements near him in the last 60 s; not before, not after', () => {
		const p = (i: number, t: number): KidPlacement => ({ cell: { x: 100 + i, y: 70, z: 100 }, block: 'oak_planks', kid: 'Noah', t });
		const kids = [{ name: 'Noah', x: 102, y: 71, z: 102 }];
		expect(kidBuilding([p(0, 1000), p(1, 2000)], kids, 3000)).toBeNull();
		expect(kidBuilding([p(0, 1000), p(1, 2000), p(2, 3000)], kids, 3000)?.cells).toHaveLength(3);
		expect(kidBuilding([p(0, 1000), p(1, 2000), p(2, 3000)], kids, 70_000)).toBeNull();
		expect(kidBuilding([p(0, 1000), p(1, 2000), p(2, 3000)], [{ ...kids[0], x: 200 }], 3000)).toBeNull();
	});
});
