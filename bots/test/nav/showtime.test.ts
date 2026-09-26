import { describe, expect, it } from 'vitest';
import { SiteSearch, type Site, type SiteQuery } from '../../src/brain2/behaviours/site-search.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { inShowtime, type Showtime } from '../../src/nav/showtime.js';
import { FakeWorld } from '../fake-port.js';

const SMALL_HOUSE = { w: 5, d: 5, h: 4 };
const FAR_SPAWN = { x: 500, y: 200, z: 500 };

function run(world: FakeWorld, q: SiteQuery, kid: { x: number; y: number; z: number }): Site {
	const s = new SiteSearch(q, { world, own: new Ownership(world, () => ({})), spawn: FAR_SPAWN, kids: [kid] });
	for (let i = 0; i < 1000; i++) {
		const r = s.step();
		if (r === 'none') throw new Error('no site');
		if (r) return r;
	}
	throw new Error('search never finished');
}
const centre = (s: Site) => ({ x: s.origin.x + SMALL_HOUSE.w / 2, z: s.origin.z + SMALL_HOUSE.d / 2 });

describe('showtime sites', () => {
	it('the band: 15–30 away, within ±70° of the facing (yaw 0 faces −z)', () => {
		const k: Showtime = { x: 0, z: 0, yaw: 0 };
		expect(inShowtime(k, 0, -20)).toBe(true);
		expect(inShowtime(k, 0, -10)).toBe(false); // too near
		expect(inShowtime(k, 0, -35)).toBe(false); // too far
		expect(inShowtime(k, 0, 20)).toBe(false); // behind him
		const a = (69 * Math.PI) / 180, b = (72 * Math.PI) / 180;
		expect(inShowtime(k, 20 * Math.sin(a), -20 * Math.cos(a))).toBe(true);
		expect(inShowtime(k, 20 * Math.sin(b), -20 * Math.cos(b))).toBe(false);
		expect(inShowtime({ x: 0, z: 0, yaw: -Math.PI / 2 }, 20, 0)).toBe(true); // yaw −90° faces +x
	});

	// Red if the search ignores showtime: the plain best lies behind the kid, and a flat patch waits in front of him.
	it('with a kid online the search prefers a site in front of him, 15–30 away; else the plain best', () => {
		const world = new FakeWorld();
		const kid = { x: 300.5, y: 0, z: 300.5 };
		kid.y = world.surfaceY(300, 300) + 1;
		const q: SiteQuery = { ...SMALL_HOUSE, anchor: kid, avoid: [] };
		const plainSite = run(world, q, kid);
		const plain = centre(plainSite);
		expect(plainSite.digs.length + plainSite.fills.length).toBeLessThan(12);
		// The kid faces straight away from the plain best (yaw faces (−sin yaw, −cos yaw)).
		const yaw = Math.atan2(plain.x - kid.x, plain.z - kid.z);
		const show: Showtime = { x: kid.x, z: kid.z, yaw };
		expect(inShowtime(show, plain.x, plain.z)).toBe(false);
		// A ±1 patch 22 in front of him (natural grass, open above), a checkerboard of bumps: any site on it levels
		// at least 12 cells, so it never beats the plain best on cost alone.
		const fx = Math.round(kid.x - Math.sin(yaw) * 22), fz = Math.round(kid.z - Math.cos(yaw) * 22);
		const Y = world.surfaceY(fx, fz);
		for (let x = fx - 5; x <= fx + 5; x++) {
			for (let z = fz - 5; z <= fz + 5; z++) {
				world.setNatural(x, Y, z, 'grass_block');
				for (let y = Y + 1; y <= Y + 20; y++) world.setNatural(x, y, z, 'air');
				if ((x + z) % 2 === 0) world.setNatural(x, Y + 1, z, 'grass_block');
			}
		}
		const site = run(world, { ...q, showtime: show }, kid);
		const c = centre(site);
		expect(inShowtime(show, c.x, c.z)).toBe(true);
		// Without showtime the plain best still stands: only the preference moved the site.
		const again = centre(run(world, q, kid));
		expect(inShowtime(show, again.x, again.z)).toBe(false);
	});
});
