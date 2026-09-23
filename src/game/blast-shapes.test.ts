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

const glass = BLOCK_BY_NAME['glass'].id;
const bomb = BLOCK_BY_NAME['block_bomb'].id, fireworks = BLOCK_BY_NAME['fireworks'].id, lake = BLOCK_BY_NAME['lake_tnt'].id;
/** The player's box standing at feet (O.x + 5.5, O.y, O.z + 0.5): it overlaps exactly (O.x + 5, O.y, O.z) and (O.x + 5, O.y + 1, O.z). */
const PLAYER = { min: [O.x + 5.2, O.y, O.z + 0.2] as [number, number, number], max: [O.x + 5.8, O.y + 1.8, O.z + 0.8] as [number, number, number] };

describe('dome (toys spec §3.5)', () => {
	it('glass goes only into AIR cells of the 4.5 < d ≤ 5.5 shell: 350 in open air; its own cell is removed; nothing is primed (catches a dome over solid blocks or water, a solid ball, or one that chains TNT)', () => {
		const w = emptyWorld();
		w.setBlock(O.x, O.y, O.z, bomb);
		const open = detonate(w, O.x, O.y, O.z, never, 5, { shape: 'dome' });
		expect(open.build!.blockId).toBe(glass);
		expect(open.build!.cells).toHaveLength(350);
		for (const c of open.build!.cells) {
			const d2 = (c.x - O.x) ** 2 + (c.y - O.y) ** 2 + (c.z - O.z) ** 2;
			expect(d2).toBeGreaterThan(20.25);
			expect(d2).toBeLessThanOrEqual(30.25);
		}
		// A part-built area: stone, water and a TNT on the shell, a TNT inside.
		w.setBlock(O.x + 5, O.y, O.z, stone);
		w.setBlock(O.x - 5, O.y, O.z, water);
		w.setBlock(O.x, O.y + 5, O.z, tnt);
		w.setBlock(O.x + 2, O.y, O.z, tnt);
		const r = detonate(w, O.x, O.y, O.z, never, 5, { shape: 'dome' });
		const k = keys(r.build!.cells);
		expect(r.build!.cells).toHaveLength(347);
		for (const c of [[O.x + 5, O.y, O.z], [O.x - 5, O.y, O.z], [O.x, O.y + 5, O.z]]) expect(k.has(c.join(',')), c.join(',')).toBe(false);
		for (const c of r.build!.cells) expect(w.getBlock(c.x, c.y, c.z)).toBe(AIR);
		expect(r.destroyed).toEqual([O]);
		expect(r.primed).toEqual([]);
		expect(r.water ?? r.effect).toBeUndefined();
	});

	it('no glass in a cell the player\'s box overlaps (catches glass sealed into his body)', () => {
		const w = emptyWorld();
		w.setBlock(O.x, O.y, O.z, bomb);
		const r = detonate(w, O.x, O.y, O.z, never, 5, { shape: 'dome', player: PLAYER });
		const k = keys(r.build!.cells);
		expect(r.build!.cells).toHaveLength(348);
		expect(k.has(`${O.x + 5},${O.y},${O.z}`)).toBe(false);
		expect(k.has(`${O.x + 5},${O.y + 1},${O.z}`)).toBe(false);
		expect(k.has(`${O.x + 5},${O.y + 2},${O.z}`)).toBe(true); // just above his head: glass
	});
});

describe('firework (toys spec §3.3)', () => {
	it('removes only its own cell, primes nothing, and asks for the firework effect (catches a firework that blasts like TNT or chains its neighbours)', () => {
		const w = emptyWorld();
		w.setBlock(O.x, O.y, O.z, fireworks);
		w.setBlock(O.x + 1, O.y, O.z, stone);
		w.setBlock(O.x, O.y + 1, O.z, tnt);
		w.setBlock(O.x - 1, O.y, O.z, fireworks);
		const r = detonate(w, O.x, O.y, O.z, never, 0, { shape: 'firework' });
		expect(r).toStrictEqual({ destroyed: [O], primed: [], effect: 'firework' });
	});
});

describe('lake (toys spec §3.7)', () => {
	const flatGround = (w: World) => fill(w, O.x - 10, O.x + 10, O.y - 10, O.y - 1, O.z - 10, O.z + 10, stone);
	const run = (w: World) => { w.setBlock(O.x, O.y, O.z, lake); return detonate(w, O.x, O.y, O.z, never, 4, { shape: 'lake' }); };
	const layers = (cells: Cell[]) => {
		const m = new Map<number, number>();
		for (const c of cells) m.set(c.y - O.y, (m.get(c.y - O.y) ?? 0) + 1);
		return Object.fromEntries([...m].sort((a, b) => b[0] - a[0]));
	};
	/** Every water cell sits on water or post-blast solid, with water or post-blast solid on all four sides. */
	const sealed = (w: World, r: { destroyed: Cell[]; water?: Cell[] }) => {
		const wet = keys(r.water ?? []), gone = keys(r.destroyed);
		const holds = (x: number, y: number, z: number) => wet.has(`${x},${y},${z}`) || (!gone.has(`${x},${y},${z}`) && isSolid(w.getBlock(x, y, z)));
		for (const { x, y, z } of r.water ?? [])
			for (const [nx, ny, nz] of [[x, y - 1, z], [x + 1, y, z], [x - 1, y, z], [x, y, z + 1], [x, y, z - 1]])
				expect(holds(nx, ny, nz), `water ${x},${y},${z} open at ${nx},${ny},${nz}`).toBe(true);
	};

	it('the crater is the radius-4 sphere, exactly as today\'s detonate at radius 4 (catches a lake with its own crater shape)', () => {
		const w = emptyWorld();
		flatGround(w);
		const r = run(w);
		const sphere = detonate(w, O.x, O.y, O.z, never, 4);
		expect(r.destroyed).toEqual(sphere.destroyed);
	});

	it('flat ground: 59 water cells in 3 layers, 37 + 21 + 1, all inside the crater, top at y − 2 (catches rimY = rim top, which floods the layer the TNT sat on)', () => {
		const w = emptyWorld();
		flatGround(w);
		const r = run(w);
		expect(r.water).toHaveLength(59);
		expect(layers(r.water!)).toEqual({ '-2': 37, '-3': 21, '-4': 1 });
		const crater = keys(r.destroyed);
		for (const c of r.water!) expect(crater.has(key(c))).toBe(true);
		sealed(w, r);
	});

	it('floating ground (an island whose edge is inside the ring): no water (catches a rim ring at radius 4, which stands on the island itself)', () => {
		const w = emptyWorld();
		for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++)
			if (dx * dx + dz * dz <= 20) fill(w, O.x + dx, O.x + dx, O.y - 6, O.y - 1, O.z + dz, O.z + dz, stone);
		const r = run(w);
		expect(r.destroyed.length).toBeGreaterThan(50);
		expect(r.water).toEqual([]);
	});

	it('a 1-step slope (ground at y − 1 for dx ≤ 0, y − 2 for dx ≥ 1): water only up to the low rim, y − 3, and sealed (catches the high rim setting the level)', () => {
		const w = emptyWorld();
		fill(w, O.x - 10, O.x, O.y - 10, O.y - 1, O.z - 10, O.z + 10, stone);
		fill(w, O.x + 1, O.x + 10, O.y - 10, O.y - 2, O.z - 10, O.z + 10, stone);
		const r = run(w);
		expect(layers(r.water!)).toEqual({ '-3': 21, '-4': 1 });
		sealed(w, r);
	});

	it('a 2-step slope (ground at y − 1 for dx ≤ 0, y − 3 for dx ≥ 1): only the bottom cell, nothing touching the open side (catches max instead of min over the rim: 22 cells, level with the low ground)', () => {
		const w = emptyWorld();
		fill(w, O.x - 10, O.x, O.y - 10, O.y - 1, O.z - 10, O.z + 10, stone);
		fill(w, O.x + 1, O.x + 10, O.y - 10, O.y - 3, O.z - 10, O.z + 10, stone);
		const r = run(w);
		expect(r.water).toEqual([{ x: O.x, y: O.y - 4, z: O.z }]);
		sealed(w, r);
	});

	it('a cave under the crater: erosion empties the lake, 0 water and no spill (catches a lake without erosion, or erosion that ignores the cell below)', () => {
		const w = emptyWorld();
		flatGround(w);
		for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++)
			if (dx * dx + dz * dz <= 9) fill(w, O.x + dx, O.x + dx, O.y - 7, O.y - 5, O.z + dz, O.z + dz, AIR);
		const r = run(w);
		expect(r.water).toEqual([]);
	});

	it('buried in solid ground: 4 layers and never more, 104 cells, none at or above the TNT\'s y (catches the level set at the rim top)', () => {
		const w = emptyWorld();
		fill(w, O.x - 10, O.x + 10, O.y - 10, O.y + 5, O.z - 10, O.z + 10, stone);
		const r = run(w);
		expect(layers(r.water!)).toEqual({ '-1': 45, '-2': 37, '-3': 21, '-4': 1 });
		const ys = r.water!.map((c) => c.y);
		expect(Math.max(...ys) - Math.min(...ys) + 1).toBeLessThanOrEqual(4);
		sealed(w, r);
	});

	it('next to his build (Review Focus 2): a wall on the ring and a cellar dug beside the crater — no water in the layer that touches the cellar, every water cell sealed (catches erosion that counts an air cell outside the crater as a wall)', () => {
		const w = emptyWorld();
		flatGround(w);
		const cobble = BLOCK_BY_NAME['cobblestone'].id;
		// His house: a cobblestone wall standing on the ring at dx = 5, and its cellar under it, dx 4..8, y − 4..y − 2.
		// The crater cell (O.x + 3, O.y − 2, O.z) touches the cellar at (O.x + 4, O.y − 2, O.z).
		fill(w, O.x + 5, O.x + 5, O.y, O.y + 3, O.z - 3, O.z + 3, cobble);
		fill(w, O.x + 4, O.x + 8, O.y - 4, O.y - 2, O.z - 2, O.z + 2, AIR);
		const r = run(w);
		sealed(w, r);
		for (const c of r.water!) expect(c.x - O.x, key(c)).toBeLessThan(4);
		expect(layers(r.water!)).toEqual({ '-3': 21, '-4': 1 });
	});

	it('chain rule: a TNT in the crater is primed, not removed, and gets no water (catches a lake that removes or floods TNT)', () => {
		const w = emptyWorld();
		flatGround(w);
		w.setBlock(O.x + 1, O.y - 2, O.z, tnt);
		const r = run(w);
		expect(r.primed).toEqual([{ x: O.x + 1, y: O.y - 2, z: O.z, radius: 3, blockId: tnt }]);
		expect(keys(r.destroyed).has(`${O.x + 1},${O.y - 2},${O.z}`)).toBe(false);
		expect(r.water).toHaveLength(58);
		expect(keys(r.water!).has(`${O.x + 1},${O.y - 2},${O.z}`)).toBe(false);
	});
});
