// Toys spec §2 (origin and chain rules), §3.4–3.7 and §6 "Blast shapes": the pure shape dispatch.
import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { AIR, BLOCK_BY_NAME, BLOCKS, isSolid, type BlockId } from '../data/blocks.data';
import { tntSpec, type DetonationResult } from './tnt';
import { chainDir, detonate, yawDir, type Cell } from './blast-shapes';

const tnt = BLOCK_BY_NAME['tnt'].id, big = BLOCK_BY_NAME['big_tnt'].id, mega = BLOCK_BY_NAME['mega_tnt'].id;
const stone = BLOCK_BY_NAME['stone'].id, bedrock = BLOCK_BY_NAME['bedrock'].id, water = BLOCK_BY_NAME['water'].id;
const tunnel = BLOCK_BY_NAME['tunnel_tnt'].id, flatten = BLOCK_BY_NAME['flatten_tnt'].id;
const never = () => false;
const key = (c: Cell) => `${c.x},${c.y},${c.z}`;
const keys = (cells: Cell[]) => new Set(cells.map(key));

/** A v1 world (64 high) with chunks 14..18 cleared: x and z 224..303 are open air, as makeLoop clears chunk 16. */
function emptyWorld(): World {
	const w = new World(1);
	for (let cx = 14; cx <= 18; cx++) for (let cz = 14; cz <= 18; cz++) {
		const c = w.ensureChunk(cx, cz);
		c.blocks.fill(AIR);
		c.lights.fill(0);
		c.liquidFrontier.clear();
	}
	return w;
}
function fill(w: World, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, id: BlockId): void {
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) w.setBlock(x, y, z, id);
}
const O = { x: 264, y: 30, z: 264 };

describe('tunnel (toys spec §3.4)', () => {
	const expected = (dir: 'px' | 'nx' | 'pz' | 'nz'): Set<string> => {
		const out = new Set<string>();
		for (let l = 0; l < 24; l++) for (let dy = 0; dy <= 2; dy++) for (let w = -1; w <= 1; w++) {
			const x = dir === 'px' ? O.x + l : dir === 'nx' ? O.x - l : O.x + w;
			const z = dir === 'pz' ? O.z + l : dir === 'nz' ? O.z - l : O.z + w;
			out.add(`${x},${O.y + dy},${z}`);
		}
		return out;
	};

	for (const dir of ['px', 'nx', 'pz', 'nz'] as const) {
		it(`${dir}: exactly the 3 wide × 3 tall × 24 long box from the TNT's cell, floor at the TNT's y (catches a tunnel centred on the TNT's y, one starting a cell ahead, a 25-long tunnel, or a flipped direction)`, () => {
			const w = emptyWorld();
			fill(w, O.x - 30, O.x + 30, O.y - 3, O.y + 5, O.z - 30, O.z + 30, stone);
			w.setBlock(O.x, O.y, O.z, tunnel);
			const r = detonate(w, O.x, O.y, O.z, never, 0, { shape: 'tunnel', dir });
			expect(r.destroyed).toHaveLength(216);
			expect(keys(r.destroyed)).toEqual(expected(dir));
			expect(r.destroyed[0]).toEqual(O);
			expect(Math.min(...r.destroyed.map((c) => c.y))).toBe(O.y);
			expect(r.primed).toEqual([]);
		});
	}
});

describe('flatten (toys spec §3.6)', () => {
	it('the cylinder dx² + dz² ≤ 36 from the TNT\'s y to y + 12, 1,469 cells, nothing below the TNT (catches a sphere, a cylinder that digs the floor at y − 1, or one 12 tall instead of 13)', () => {
		const w = emptyWorld();
		fill(w, O.x - 8, O.x + 8, O.y - 3, O.y + 14, O.z - 8, O.z + 8, stone);
		w.setBlock(O.x, O.y, O.z, flatten);
		const r = detonate(w, O.x, O.y, O.z, never, 6, { shape: 'flatten' });
		expect(r.destroyed).toHaveLength(1469);
		expect(new Set(r.destroyed.map(key)).size).toBe(1469);
		for (const c of r.destroyed) {
			expect(c.y).toBeGreaterThanOrEqual(O.y);
			expect(c.y).toBeLessThanOrEqual(O.y + 12);
			expect((c.x - O.x) ** 2 + (c.z - O.z) ** 2).toBeLessThanOrEqual(36);
		}
		const k = keys(r.destroyed);
		expect(k.has(`${O.x + 6},${O.y},${O.z}`)).toBe(true);
		expect(k.has(`${O.x},${O.y + 12},${O.z}`)).toBe(true);
		expect(k.has(`${O.x + 6},${O.y},${O.z + 1}`)).toBe(false);
		expect(k.has(`${O.x},${O.y + 13},${O.z}`)).toBe(false);
		expect(k.has(`${O.x},${O.y - 1},${O.z}`)).toBe(false);
	});
});

describe('origin rule (toys spec §2)', () => {
	for (const [name, id, shape, radius] of [['Tunnel', tunnel, 'tunnel', 0], ['Flatten', flatten, 'flatten', 6]] as const) {
		it(`a lone ${name} removes its own cell and primes nothing (catches the origin going through the chain rule: it would re-prime itself every 0.1 s forever)`, () => {
			const w = emptyWorld();
			w.setBlock(O.x, O.y, O.z, id);
			const r = detonate(w, O.x, O.y, O.z, never, radius, { shape, dir: 'px' });
			expect(r.destroyed).toEqual([O]);
			expect(r.primed).toEqual([]);
		});
	}
});

describe('chain rule (toys spec §2)', () => {
	it('a TNT inside a Tunnel is primed with its own radius, not removed (catches a shape that removes TNT in its path)', () => {
		const w = emptyWorld();
		fill(w, O.x - 1, O.x + 30, O.y, O.y + 2, O.z - 1, O.z + 1, stone);
		w.setBlock(O.x, O.y, O.z, tunnel);
		w.setBlock(O.x + 10, O.y + 1, O.z, tnt);
		const r = detonate(w, O.x, O.y, O.z, never, 0, { shape: 'tunnel', dir: 'px' });
		expect(r.primed).toEqual([{ x: O.x + 10, y: O.y + 1, z: O.z, radius: 3, blockId: tnt }]);
		expect(keys(r.destroyed).has(`${O.x + 10},${O.y + 1},${O.z}`)).toBe(false);
		expect(r.destroyed).toHaveLength(215);
	});

	it('a TNT inside a Flatten is primed, not removed; one already primed is skipped (catches a flatten that removes TNT, or re-primes a lit one)', () => {
		const w = emptyWorld();
		w.setBlock(O.x, O.y, O.z, flatten);
		w.setBlock(O.x + 3, O.y + 5, O.z, big);
		w.setBlock(O.x - 3, O.y + 5, O.z, tnt);
		w.setBlock(O.x, O.y + 1, O.z, stone);
		const lit = (x: number, y: number, z: number) => x === O.x - 3 && y === O.y + 5 && z === O.z;
		const r = detonate(w, O.x, O.y, O.z, lit, 6, { shape: 'flatten' });
		expect(r.primed).toEqual([{ x: O.x + 3, y: O.y + 5, z: O.z, radius: 5, blockId: big }]);
		expect(r.destroyed).toEqual([O, { x: O.x, y: O.y + 1, z: O.z }]);
	});
});

describe('tunnel direction (toys spec §3.4)', () => {
	it('chained: the dominant horizontal axis of (TNT − blast origin); a tie goes to x; straight above or below is px (catches z winning the tie, and a directly-above Tunnel with no direction)', () => {
		expect(chainDir(3, 1)).toBe('px');
		expect(chainDir(-3, 1)).toBe('nx');
		expect(chainDir(1, 3)).toBe('pz');
		expect(chainDir(-1, -3)).toBe('nz');
		expect(chainDir(2, 2)).toBe('px');
		expect(chainDir(-2, 2)).toBe('nx');
		expect(chainDir(-2, -2)).toBe('nx');
		expect(chainDir(0, 0)).toBe('px');
	});

	it('a Tunnel primed by a blast carries its chained direction; a plain TNT primed by the same blast has no dir key (catches the dir left off the primed entry, or added to every tier)', () => {
		const w = emptyWorld();
		w.setBlock(O.x, O.y, O.z, big);
		const cases: Array<[number, number, number, string]> = [
			[3, 0, 1, 'px'], [-3, 0, 1, 'nx'], [1, 0, 3, 'pz'], [-1, 0, -3, 'nz'],
			[2, 0, 2, 'px'], [-2, 0, -2, 'nx'], [0, 2, 0, 'px'], [0, -2, 0, 'px'],
		];
		for (const [dx, dy, dz] of cases) w.setBlock(O.x + dx, O.y + dy, O.z + dz, tunnel);
		w.setBlock(O.x + 4, O.y, O.z, tnt);
		const r = detonate(w, O.x, O.y, O.z, never, 5);
		for (const [dx, dy, dz, dir] of cases) {
			const p = r.primed.find((q) => q.x === O.x + dx && q.y === O.y + dy && q.z === O.z + dz);
			expect(p, `${dx},${dy},${dz}`).toEqual({ x: O.x + dx, y: O.y + dy, z: O.z + dz, radius: 0, blockId: tunnel, dir });
		}
		const plain = r.primed.find((q) => q.blockId === tnt)!;
		expect('dir' in plain).toBe(false);
	});

	it('lit: yaw snapped to ±x or ±z along FpCamera\'s forward (−sin yaw, −cos yaw) (catches a sign flip that sends the tunnel back toward the player)', () => {
		expect(yawDir(0)).toBe('nz');
		expect(yawDir(Math.PI / 2)).toBe('nx');
		expect(yawDir(-Math.PI / 2)).toBe('px');
		expect(yawDir(Math.PI)).toBe('pz');
		expect(yawDir(2 * Math.PI + 0.1)).toBe('nz');
		expect(yawDir(-0.7)).toBe('nz');
		expect(yawDir(0.8)).toBe('nx');
	});
});

/**
 * FROZEN COPY of today's detonate() (tnt.ts at 2f3ebde), kept because production no longer contains it (toys spec §4):
 * the sphere must give the same destroyed and primed lists, in the same order, on worlds without toys.
 */
function frozenDetonate(world: World, ox: number, oy: number, oz: number, radius: number, alreadyPrimed: (x: number, y: number, z: number) => boolean): DetonationResult {
	const destroyed: DetonationResult['destroyed'] = [];
	const primed: DetonationResult['primed'] = [];
	const radiusSq = radius * radius;
	if (world.inBounds(ox, oy, oz) && isSolid(world.getBlock(ox, oy, oz))) destroyed.push({ x: ox, y: oy, z: oz });
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dz = -radius; dz <= radius; dz++) {
			for (let dx = -radius; dx <= radius; dx++) {
				if (dx === 0 && dy === 0 && dz === 0) continue;
				if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
				const x = ox + dx;
				const y = oy + dy;
				const z = oz + dz;
				if (!world.inBounds(x, y, z)) continue;
				const id = world.getBlock(x, y, z);
				const spec = tntSpec(id);
				if (spec) {
					if (!alreadyPrimed(x, y, z)) primed.push({ x, y, z, radius: spec.radius, blockId: id });
				} else if (isSolid(id) && (BLOCKS[id]?.hardness ?? 0) > 0) {
					destroyed.push({ x, y, z });
				}
			}
		}
	}
	return { destroyed, primed };
}

describe('sphere regression (toys spec §4)', () => {
	it('plain, Big and Mega give today\'s destroyed and primed lists, in the same order, on a v3 world with TNT, bedrock, water and a lit TNT around (catches a reordered loop, the origin moved to the end, or a dir key on a sphere entry)', () => {
		const w = World.create(3);
		const top = (x: number, z: number) => { for (let y = w.height - 1; y > 0; y--) if (isSolid(w.getBlock(x, y, z))) return y; return 0; };
		const x = 21 * 16 + 8, z = 12 * 16 + 8;
		for (const [oy, label] of [[top(x, z) - 3, 'buried'], [top(x, z) + 1, 'surface']] as const) {
			w.setBlock(x, oy, z, tnt);
			w.setBlock(x + 2, oy, z, tnt);
			w.setBlock(x - 3, oy + 1, z, big);
			w.setBlock(x, oy - 4, z + 1, mega);
			w.setBlock(x + 1, oy - 1, z - 1, bedrock);
			w.setBlock(x - 1, oy, z + 2, water);
			w.setBlock(x + 5, oy, z + 5, tnt);
			const lit = (px: number, py: number, pz: number) => px === x + 5 && py === oy && pz === z + 5;
			for (const radius of [3, 5, 8]) {
				const want = frozenDetonate(w, x, oy, z, radius, lit);
				const got = detonate(w, x, oy, z, lit, radius);
				expect(want.destroyed.length, `${label} r${radius}`).toBeGreaterThan(10);
				expect(got.destroyed, `${label} r${radius}`).toStrictEqual(want.destroyed);
				expect(got.primed, `${label} r${radius}`).toStrictEqual(want.primed);
				expect(got.build ?? got.water ?? got.effect, `${label} r${radius}`).toBeUndefined();
			}
		}
	}, 60_000);
});
