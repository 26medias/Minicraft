import { describe, expect, it } from 'vitest';
import { worldSpawn } from 'minicraft-bot';
import { SiteSearch, evaluateSite, type Site, type SiteQuery } from '../../src/brain2/behaviours/site-search.js';
import { Ownership } from '../../src/brain2/ownership.js';
import type { WorldView } from '../../src/port.js';
import type { Vec3 } from '../../src/brain2/types.js';
import { FAKE_GEN, FAKE_SEED, FakeWorld } from '../fake-port.js';

const SMALL_HOUSE = { w: 5, d: 5, h: 4 };

function spawnOf(world: WorldView): Vec3 {
	const s = worldSpawn(FAKE_SEED, FAKE_GEN);
	return { x: s.x, y: world.groundY(s.x, s.z, 250) ?? 120, z: s.z };
}
function run(world: WorldView, q: SiteQuery, spawn: Vec3, own = new Ownership(world, () => ({}))): Site | 'none' {
	const s = new SiteSearch(q, { world, own, spawn });
	for (let i = 0; i < 1000; i++) {
		const r = s.step();
		if (r !== null) return r;
	}
	throw new Error('search never finished');
}
const centre = (s: Site, q: { w: number; d: number }) => ({ x: s.origin.x + q.w / 2, z: s.origin.z + q.d / 2 });

describe('site search (spec §6.1)', () => {
	// Red if the spawn-distance rule is missing (a perfectly flat patch is made at spawn itself, so it would win), or the ±1 rule is.
	it('finds a ±1 site near spawn for a small house', () => {
		const world = new FakeWorld();
		const spawn = spawnOf(world);
		const flatY = spawn.y - 1;
		for (let x = spawn.x - 5; x <= spawn.x + 5; x++) {
			for (let z = spawn.z - 5; z <= spawn.z + 5; z++) {
				world.setNatural(x, flatY, z, 'grass_block');
				for (let y = flatY + 1; y <= flatY + 12; y++) world.setNatural(x, y, z, 'air');
			}
		}
		const q: SiteQuery = { ...SMALL_HOUSE, anchor: spawn, avoid: [] };
		const site = run(world, q, spawn);
		if (site === 'none') throw new Error('no site');
		const c = centre(site, q);
		expect(Math.hypot(c.x - spawn.x, c.z - spawn.z)).toBeGreaterThanOrEqual(16);
		expect(Math.hypot(c.x - spawn.x, c.z - spawn.z)).toBeLessThanOrEqual(32);
		expect(site.origin.y).toBe(site.groundY + 1);
		for (let x = site.origin.x - 1; x <= site.origin.x + q.w; x++) {
			for (let z = site.origin.z - 1; z <= site.origin.z + q.d; z++) expect(Math.abs(world.surfaceY(x, z) - site.groundY)).toBeLessThanOrEqual(1);
		}
	});

	// Red if the kid-cell rule is missing: the same flat site would win again.
	it('rejects a site within 14.5 of a kid cell', () => {
		const world = new FakeWorld();
		const spawn = spawnOf(world);
		const q: SiteQuery = { ...SMALL_HOUSE, anchor: spawn, avoid: [] };
		const first = run(world, q, spawn);
		if (first === 'none') throw new Error('no site');
		const c = centre(first, q);
		const kx = Math.floor(c.x) + 5, kz = Math.floor(c.z);
		const kidCell = { x: kx, y: world.surfaceY(kx, kz) + 1, z: kz };
		world.set(kidCell.x, kidCell.y, kidCell.z, 'dirt');   // an edited cell nobody owns: a kid cell
		const again = run(world, q, spawn);
		if (again === 'none') throw new Error('no site');
		const c2 = centre(again, q);
		expect(Math.hypot(c2.x - kidCell.x, c2.z - kidCell.z)).toBeGreaterThanOrEqual(14.5);
	});

	// Red if avoid boxes are ignored: the first run's site would be picked again.
	it('never picks a site overlapping an avoid box', () => {
		const world = new FakeWorld();
		const spawn = spawnOf(world);
		const q: SiteQuery = { ...SMALL_HOUSE, anchor: spawn, avoid: [] };
		const first = run(world, q, spawn);
		if (first === 'none') throw new Error('no site');
		const box = { min: { x: first.origin.x, y: first.origin.y, z: first.origin.z }, max: { x: first.origin.x + 4, y: first.origin.y + 3, z: first.origin.z + 4 } };
		const second = run(world, { ...q, avoid: [box] }, spawn);
		if (second === 'none') throw new Error('no site');
		const g = { x0: second.origin.x - 1, x1: second.origin.x + q.w, z0: second.origin.z - 1, z1: second.origin.z + q.d };
		const overlaps = g.x0 <= box.max.x && g.x1 >= box.min.x && g.z0 <= box.max.z && g.z1 >= box.min.z;
		expect(overlaps).toBe(false);
	});

	// Red if digs/fills are swapped, taken at the wrong y, or include the level cells.
	it('levelling: digs are the median+1 bumps, fills are the median−1 holes', () => {
		const world = new FakeWorld();
		const Y = 199;                                        // the median surface, in open air
		const o = { x: 100, z: 300 };                          // the template origin; the patch is the 7×7 grown area
		for (let x = o.x - 1; x <= o.x + 5; x++) for (let z = o.z - 1; z <= o.z + 5; z++) world.setNatural(x, Y, z, 'stone');
		const bumps = [[o.x, o.z], [o.x + 2, o.z + 3], [o.x + 4, o.z + 4]];
		const holes = [[o.x + 1, o.z], [o.x + 3, o.z + 1]];
		for (const [x, z] of bumps) world.setNatural(x, Y + 1, z, 'dirt');
		for (const [x, z] of holes) {
			world.setNatural(x, Y, z, 'air');
			world.setNatural(x, Y - 1, z, 'stone');
		}
		const spawn = spawnOf(world);
		const q: SiteQuery = { ...SMALL_HOUSE, anchor: { x: o.x, y: Y, z: o.z }, avoid: [] };
		const site = evaluateSite(o.x, o.z, q, { world, own: new Ownership(world, () => ({})), spawn });
		expect(site).not.toBeNull();
		expect(site!.groundY).toBe(Y);
		expect(site!.origin).toEqual({ x: o.x, y: Y + 1, z: o.z });
		const k = (v: Vec3) => `${v.x},${v.y},${v.z}`;
		expect(site!.digs.map(k).sort()).toEqual(bumps.map(([x, z]) => k({ x, y: Y + 1, z })).sort());
		expect(site!.fills.map(k).sort()).toEqual(holes.map(([x, z]) => k({ x, y: Y, z })).sort());
		// A 2-high bump is not ±1: the same patch no longer qualifies.
		world.setNatural(o.x + 2, Y + 2, o.z + 2, 'dirt');
		world.setNatural(o.x + 2, Y + 1, o.z + 2, 'dirt');
		expect(evaluateSite(o.x, o.z, q, { world, own: new Ownership(world, () => ({})), spawn })).toBeNull();
	});

	// Fix round (R10). Red if the search avoids only kid-placed cells: the kid stands on the flat patch's best site.
	it('rejects a site whose grown footprint meets a kid\'s body buffer (where he stands now)', () => {
		const world = new FakeWorld();
		const spawn = spawnOf(world);
		const q: SiteQuery = { ...SMALL_HOUSE, anchor: spawn, avoid: [] };
		const first = run(world, q, spawn);
		if (first === 'none') throw new Error('no site');
		const kid = { x: first.origin.x + 2.5, y: first.origin.y, z: first.origin.z + 2.5 };   // in the middle of it
		const s = new SiteSearch({ ...q, anchor: kid }, { world, own: new Ownership(world, () => ({})), spawn, kids: [kid] });
		let r: ReturnType<SiteSearch['step']> = null;
		for (let i = 0; i < 1000 && r === null; i++) r = s.step();
		if (r === null || r === 'none') throw new Error('no site');
		// The grown footprint (margin 1) stays clear of the kid's buffer columns (his box's column ± 1).
		const kx = Math.floor(kid.x), kz = Math.floor(kid.z);
		const g = { x0: r.origin.x - 1, x1: r.origin.x + q.w, z0: r.origin.z - 1, z1: r.origin.z + q.d };
		const meets = g.x0 <= kx + 1 && g.x1 >= kx - 1 && g.z0 <= kz + 1 && g.z1 >= kz - 1;
		expect(meets).toBe(false);
		// evaluateSite alone refuses the site he stands on.
		expect(evaluateSite(first.origin.x, first.origin.z, q, { world, own: new Ownership(world, () => ({})), spawn, kids: [kid] })).toBeNull();
		expect(evaluateSite(first.origin.x, first.origin.z, q, { world, own: new Ownership(world, () => ({})), spawn })).not.toBeNull();
	});

	// Fix round (I3). Red if leaves and logs count as the ground: the site would sit on the canopy.
	it('a tree canopy is not the ground: the site sits on the soil under it, and a trunk in it refuses the site', () => {
		const world = new FakeWorld();
		const Y = 199;
		const o = { x: 100, z: 300 };
		for (let x = o.x - 1; x <= o.x + 5; x++) {
			for (let z = o.z - 1; z <= o.z + 5; z++) {
				world.setNatural(x, Y, z, 'grass_block');
				world.setNatural(x, Y + 8, z, 'oak_leaves');          // a flat canopy, above the house's height
			}
		}
		const spawn = spawnOf(world);
		const q: SiteQuery = { ...SMALL_HOUSE, anchor: { x: o.x, y: Y, z: o.z }, avoid: [] };
		const ctx = { world, own: new Ownership(world, () => ({})), spawn };
		const site = evaluateSite(o.x, o.z, q, ctx);
		expect(site?.groundY).toBe(Y);
		// A trunk inside the footprint: no longer a site (its log is solid where the house goes).
		for (let y = Y + 1; y <= Y + 7; y++) world.setNatural(o.x + 2, y, o.z + 2, 'oak_log');
		expect(evaluateSite(o.x, o.z, q, ctx)).toBeNull();
		// A 1-high stump in the margin, below the headroom rows: still refused.
		for (let y = Y + 1; y <= Y + 7; y++) world.setNatural(o.x + 2, y, o.z + 2, 'air');
		world.setNatural(o.x - 1, Y + 1, o.z, 'oak_log');
		expect(evaluateSite(o.x, o.z, q, ctx)).toBeNull();
	});

	// Red on a search that scans the whole leash in one call.
	it('step() touches at most one new chunk per call', () => {
		const inner = new FakeWorld();
		const touched = new Set<string>();
		const rec = (x: number, z: number) => touched.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
		const world: WorldView = {
			getBlock: (x, y, z) => (rec(x, z), inner.getBlock(x, y, z)),
			groundY: (x, z, n) => (rec(x, z), inner.groundY(x, z, n)),
			blockName: (v) => inner.blockName(v), isSolid: (v) => inner.isSolid(v), isLiquid: (v) => inner.isLiquid(v),
			raycast: (o, d, m) => inner.raycast(o, d, m), generatedBlock: (x, y, z) => inner.generatedBlock(x, y, z),
			isEdited: (x, y, z) => inner.isEdited(x, y, z), editedCellsInChunk: (cx, cz) => inner.editedCellsInChunk(cx, cz), mustMine: false,
		};
		const spawn = spawnOf(inner);
		const s = new SiteSearch({ ...SMALL_HOUSE, anchor: spawn, avoid: [] }, { world, own: new Ownership(world, () => ({})), spawn });
		let calls = 0, r: ReturnType<SiteSearch['step']> = null;
		while (r === null) {
			const before = touched.size;
			r = s.step();
			calls++;
			expect(touched.size - before).toBeLessThanOrEqual(1);
		}
		expect(calls).toBeGreaterThan(1);
		expect(r).not.toBe('none');
	});
});
