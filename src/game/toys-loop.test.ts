// Toys spec §6 "Loop tests": the blast toys through GameLoop (ignite → fuse → detonateAt → removeBlocks / placeBlocks).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeLoop } from './test-loop';
import { AIR, BLOCK_BY_NAME, type BlockId } from '../data/blocks.data';
import { countOf, onRemoved } from './inventory';
import type { Inventory } from '../data/crafting.data';
import { TNT_CHAIN_FUSE } from './tnt';
import { detonate } from './blast-shapes';
import type { World } from '../engine/world/world';
import type { ParticleSystem } from '../engine/render/particles';

const tnt = BLOCK_BY_NAME['tnt'].id, stone = BLOCK_BY_NAME['stone'].id, water = BLOCK_BY_NAME['water'].id, glass = BLOCK_BY_NAME['glass'].id;
const tunnel = BLOCK_BY_NAME['tunnel_tnt'].id, flatten = BLOCK_BY_NAME['flatten_tnt'].id, lake = BLOCK_BY_NAME['lake_tnt'].id;
const bomb = BLOCK_BY_NAME['block_bomb'].id, fireworks = BLOCK_BY_NAME['fireworks'].id;
const O = { x: 264, y: 30, z: 264 };
const at = (p: { x: number; y: number; z: number }) => ({ ...p, face: 'py' as const, distance: 1 });
/** Yaw that looks along +x (FpCamera forward = (−sin yaw, 0, −cos yaw)). */
const YAW_PX = -Math.PI / 2;
const FUSE = 3; // every toy but Fireworks (1 s)

function fill(w: World, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, id: BlockId): void {
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) w.setBlock(x, y, z, id);
}

/** makeLoop with chunks 14..18 cleared (x and z 224..303 open air) and counts wired as main.ts wires them. */
function toyLoop() {
	const h = makeLoop();
	for (let cx = 14; cx <= 18; cx++) for (let cz = 14; cz <= 18; cz++) {
		const c = h.world.ensureChunk(cx, cz);
		c.blocks.fill(AIR);
		c.lights.fill(0);
		c.liquidFrontier.clear();
	}
	let inv: Inventory = {};
	const calls: number[] = [];
	h.loop.onBlocksRemoved = (removed) => {
		calls.push(removed.length);
		inv = onRemoved(inv, removed.map((r) => r.blockId)).inv;
	};
	const primedCount = () => (h.loop as unknown as { primedTnt: Map<string, unknown> }).primedTnt.size;
	return { ...h, inv: () => inv, calls, primedCount };
}

describe('origin (toys spec §2, §6)', () => {
	for (const [name, id] of [['Tunnel', tunnel], ['Flatten', flatten]] as const) {
		it(`a lone ${name} goes off exactly once: its cell is AIR and nothing stays primed (catches the TNT re-priming itself every 0.1 s forever)`, () => {
			const h = toyLoop();
			h.world.setBlock(O.x, O.y, O.z, id);
			h.world.setBlock(O.x + 2, O.y, O.z, stone);
			expect(h.loop.ignite(at(O), YAW_PX)).toBe(true);
			h.loop.simulate(FUSE + 0.1);
			expect(h.world.getBlock(O.x, O.y, O.z)).toBe(AIR);
			expect(h.world.getBlock(O.x + 2, O.y, O.z)).toBe(AIR);
			for (let i = 0; i < 10; i++) h.loop.simulate(TNT_CHAIN_FUSE + 0.01);
			expect(h.primedCount()).toBe(0);
			expect(h.calls).toEqual([1]);
		});
	}
});

describe('counts (toys spec §2, §6)', () => {
	const cases: Array<[string, BlockId, (w: World) => void]> = [
		['tunnel_tnt', tunnel, (w) => fill(w, O.x - 2, O.x + 30, O.y - 1, O.y + 3, O.z - 2, O.z + 2, stone)],
		['flatten_tnt', flatten, (w) => fill(w, O.x - 8, O.x + 8, O.y - 1, O.y + 14, O.z - 8, O.z + 8, stone)],
		['lake_tnt', lake, (w) => fill(w, O.x - 10, O.x + 10, O.y - 10, O.y - 1, O.z - 10, O.z + 10, stone)],
	];
	for (const [name, id, build] of cases) {
		it(`${name} adds every stone it removed and never its own cell (catches counting the origin, or not counting a toy's blast)`, () => {
			const h = toyLoop();
			build(h.world);
			h.world.setBlock(O.x, O.y, O.z, id);
			const shape = BLOCK_BY_NAME[name].tnt!.shape;
			const want = detonate(h.world, O.x, O.y, O.z, () => false, BLOCK_BY_NAME[name].tnt!.radius, { shape, dir: 'px' }).destroyed.length - 1;
			expect(want).toBeGreaterThan(50);
			h.loop.ignite(at(O), YAW_PX);
			h.loop.simulate(FUSE + 0.1);
			expect(countOf(h.inv(), 'stone')).toBe(want);
			expect(countOf(h.inv(), name)).toBe(0);
		});
	}
});

describe('chain rule in the loop (toys spec §2, §6)', () => {
	const cases: Array<[string, BlockId, (w: World) => void, { x: number; y: number; z: number }]> = [
		['Tunnel', tunnel, (w) => fill(w, O.x - 2, O.x + 30, O.y, O.y + 2, O.z - 2, O.z + 2, stone), { x: O.x + 6, y: O.y + 1, z: O.z }],
		['Flatten', flatten, () => undefined, { x: O.x + 3, y: O.y + 6, z: O.z }],
		['Lake', lake, (w) => fill(w, O.x - 10, O.x + 10, O.y - 10, O.y - 1, O.z - 10, O.z + 10, stone), { x: O.x + 1, y: O.y - 2, z: O.z }],
	];
	for (const [name, id, build, t] of cases) {
		it(`a TNT inside a ${name} blast is primed, not removed and not counted, then goes off itself (catches a toy that removes TNT in its shape)`, () => {
			const h = toyLoop();
			build(h.world);
			h.world.setBlock(O.x, O.y, O.z, id);
			h.world.setBlock(t.x, t.y, t.z, tnt);
			h.loop.ignite(at(O), YAW_PX);
			h.loop.simulate(FUSE + 0.1);
			expect(h.world.getBlock(t.x, t.y, t.z)).toBe(tnt);
			expect(h.primedCount()).toBe(1);
			h.loop.simulate(TNT_CHAIN_FUSE + 0.05);
			expect(h.world.getBlock(t.x, t.y, t.z)).toBe(AIR);
			expect(countOf(h.inv(), 'tnt')).toBe(0);
		});
	}
});

describe('tunnel direction in the loop (toys spec §3.4)', () => {
	const cases: Array<[number, string, [number, number]]> = [
		[YAW_PX, 'px', [1, 0]], [Math.PI / 2, 'nx', [-1, 0]], [Math.PI, 'pz', [0, 1]], [0, 'nz', [0, -1]],
	];
	for (const [yaw, dir, [ax, az]] of cases) {
		it(`lit facing ${dir}: the tunnel runs ${dir}, away from the player (catches ignite ignoring the yaw, or a flipped direction)`, () => {
			const h = toyLoop();
			h.world.setBlock(O.x, O.y, O.z, tunnel);
			for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) h.world.setBlock(O.x + 10 * sx, O.y, O.z + 10 * sz, stone);
			h.loop.ignite(at(O), yaw);
			h.loop.simulate(FUSE + 0.1);
			for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const want = sx === ax && sz === az ? AIR : stone;
				expect(h.world.getBlock(O.x + 10 * sx, O.y, O.z + 10 * sz), `${sx},${sz}`).toBe(want);
			}
		});
	}

	it('chained: a Tunnel 2 south of a TNT runs south (pz), its stored direction (catches detonateAt dropping the chained dir, which would default to px)', () => {
		const h = toyLoop();
		h.world.setBlock(O.x, O.y, O.z, tnt);
		h.world.setBlock(O.x, O.y, O.z + 2, tunnel);
		h.world.setBlock(O.x, O.y, O.z + 12, stone);
		h.world.setBlock(O.x + 10, O.y, O.z + 2, stone);
		h.loop.ignite(at(O), YAW_PX);
		h.loop.simulate(2.6);
		h.loop.simulate(TNT_CHAIN_FUSE + 0.05);
		expect(h.world.getBlock(O.x, O.y, O.z + 2)).toBe(AIR);
		expect(h.world.getBlock(O.x, O.y, O.z + 12)).toBe(AIR);
		expect(h.world.getBlock(O.x + 10, O.y, O.z + 2)).toBe(stone);
	});
});

describe('a Tunnel lit while he stands in its line (Review Focus 1)', () => {
	it('he stands in a 1 × 2 pocket 5 ahead of it: the tunnel opens 3 × 3 around him, his floor stays, and he walks back out (catches a tunnel centred on the TNT\'s y, which digs his floor away, and ignite ignoring the yaw, which leaves him sealed in)', () => {
		const h = toyLoop();
		fill(h.world, O.x - 3, O.x + 3, O.y - 1, O.y + 4, O.z - 30, O.z + 3, stone);
		h.world.setBlock(O.x, O.y, O.z, tunnel);
		// Yaw 0 faces −z. His pocket is 5 blocks along −z: feet at (O.x, O.y, O.z − 5), head one above.
		h.world.setBlock(O.x, O.y, O.z - 5, AIR);
		h.world.setBlock(O.x, O.y + 1, O.z - 5, AIR);
		h.player.position = [O.x + 0.5, O.y, O.z - 5 + 0.5];
		h.loop.ignite(at(O), 0);
		h.loop.simulate(FUSE + 0.1);
		for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy <= 2; dy++) for (let dz = -6; dz <= 0; dz++)
			expect(h.world.getBlock(O.x + dx, O.y + dy, O.z + dz), `${dx},${dy},${dz}`).toBe(AIR);
		expect(h.world.getBlock(O.x, O.y - 1, O.z - 5)).toBe(stone);
		// He walks back toward where the TNT sat (+z) for one second: free to move, still on the tunnel floor.
		h.keys.forward = true;
		const fwd = new THREE.Vector3(0, 0, 1), right = new THREE.Vector3(-1, 0, 0);
		for (let i = 0; i < 60; i++) h.player.update(1 / 60, h.world, h.keys, fwd, right);
		expect(h.player.position[2]).toBeGreaterThan(O.z - 5 + 0.5 + 2);
		expect(h.player.position[1]).toBeCloseTo(O.y, 1);
	});
});

describe('Block Bomb in the loop (toys spec §3.5, §6)', () => {
	it('in a part-built area only AIR becomes glass; counts unchanged; the player\'s cells stay AIR; a TNT on the shell is not primed (catches detonateAt ignoring build, or blasting the dome as a sphere)', () => {
		const h = toyLoop();
		h.player.position = [O.x + 5.5, O.y, O.z + 0.5];
		h.world.setBlock(O.x, O.y, O.z, bomb);
		h.world.setBlock(O.x - 5, O.y, O.z, stone);
		h.world.setBlock(O.x, O.y + 5, O.z, tnt);
		h.world.setBlock(O.x + 2, O.y, O.z, stone); // inside the dome: untouched
		h.loop.ignite(at(O), YAW_PX);
		h.loop.simulate(FUSE + 0.1);
		expect(h.world.getBlock(O.x, O.y, O.z)).toBe(AIR);
		expect(h.world.getBlock(O.x - 5, O.y, O.z)).toBe(stone);
		expect(h.world.getBlock(O.x + 2, O.y, O.z)).toBe(stone);
		expect(h.world.getBlock(O.x, O.y + 5, O.z)).toBe(tnt);
		expect(h.world.getBlock(O.x + 5, O.y, O.z)).toBe(AIR);
		expect(h.world.getBlock(O.x + 5, O.y + 1, O.z)).toBe(AIR);
		expect(h.world.getBlock(O.x, O.y - 5, O.z)).toBe(glass);
		let n = 0;
		for (let x = O.x - 6; x <= O.x + 6; x++) for (let y = O.y - 6; y <= O.y + 6; y++) for (let z = O.z - 6; z <= O.z + 6; z++) if (h.world.getBlock(x, y, z) === glass) n++;
		expect(n).toBe(350 - 2 - 2); // the stone and the TNT on the shell, and the player's two cells
		expect(h.calls).toEqual([]);
		expect(h.primedCount()).toBe(0);
	});
});

describe('Lake TNT in the loop (toys spec §3.7, §6)', () => {
	const waterCells = (w: World) => {
		const out: string[] = [];
		for (let x = O.x - 12; x <= O.x + 12; x++) for (let y = O.y - 12; y <= O.y + 2; y++) for (let z = O.z - 12; z <= O.z + 12; z++)
			if (w.getBlock(x, y, z) === water) out.push(`${x},${y},${z}`);
		return out;
	};
	const settle = (h: ReturnType<typeof toyLoop>) => { for (let i = 0; i < 100; i++) h.loop.simulate(0.05); };

	it('flat ground: after the liquids settle, 59 water cells, every one inside the crater (catches detonateAt dropping the water, or water that spreads)', () => {
		const h = toyLoop();
		fill(h.world, O.x - 10, O.x + 10, O.y - 10, O.y - 1, O.z - 10, O.z + 10, stone);
		h.world.setBlock(O.x, O.y, O.z, lake);
		h.loop.ignite(at(O), YAW_PX);
		h.loop.simulate(FUSE + 0.1);
		settle(h);
		const cells = waterCells(h.world);
		expect(cells).toHaveLength(59);
		for (const k of cells) {
			const [x, y, z] = k.split(',').map(Number);
			expect((x - O.x) ** 2 + (y - O.y) ** 2 + (z - O.z) ** 2, k).toBeLessThanOrEqual(16);
		}
	});

	it('a cave under the crater: no water anywhere after the liquids settle (catches water written without the erosion rule, which pours into the cave)', () => {
		const h = toyLoop();
		fill(h.world, O.x - 10, O.x + 10, O.y - 10, O.y - 1, O.z - 10, O.z + 10, stone);
		fill(h.world, O.x - 2, O.x + 2, O.y - 7, O.y - 5, O.z - 2, O.z + 2, AIR);
		h.world.setBlock(O.x, O.y, O.z, lake);
		h.loop.ignite(at(O), YAW_PX);
		h.loop.simulate(FUSE + 0.1);
		settle(h);
		expect(waterCells(h.world)).toEqual([]);
	});
});

describe('Fireworks in the loop (toys spec §3.3, §6)', () => {
	it('its block becomes AIR, nothing is counted, no other block changes, its TNT neighbour is not primed (catches a firework that blasts like TNT)', () => {
		const h = toyLoop();
		h.world.setBlock(O.x, O.y, O.z, fireworks);
		h.world.setBlock(O.x + 1, O.y, O.z, stone);
		h.world.setBlock(O.x, O.y - 1, O.z, stone);
		h.world.setBlock(O.x - 1, O.y, O.z, tnt);
		const snap = () => {
			const out: number[] = [];
			for (let x = O.x - 4; x <= O.x + 4; x++) for (let y = O.y - 4; y <= O.y + 4; y++) for (let z = O.z - 4; z <= O.z + 4; z++)
				if (x !== O.x || y !== O.y || z !== O.z) out.push(h.world.getBlock(x, y, z));
			return out;
		};
		const before = snap();
		h.loop.ignite(at(O), YAW_PX);
		h.loop.simulate(1.1);
		expect(h.world.getBlock(O.x, O.y, O.z)).toBe(AIR);
		expect(snap()).toEqual(before);
		expect(h.calls).toEqual([]);
		expect(h.primedCount()).toBe(0);
	});
});

describe('Fireworks effect (toys spec §3.3)', () => {
	/** A particle stub that records what detonateAt asks for. */
	function withParticles() {
		const shots: number[][] = [];
		const particles = {
			spawnBreak: () => undefined,
			spawnFirework: (x: number, y: number, z: number, big: boolean) => { shots.push([x, y, z, big ? 1 : 0]); },
			tick: () => undefined,
		} as unknown as ParticleSystem;
		const h = makeLoop({ particles });
		for (let cx = 15; cx <= 17; cx++) for (let cz = 15; cz <= 17; cz++) {
			const c = h.world.ensureChunk(cx, cz);
			c.blocks.fill(AIR);
			c.lights.fill(0);
			c.liquidFrontier.clear();
		}
		return { ...h, shots };
	}

	it('lit: one big firework from the centre of its cell (catches detonateAt ignoring the effect)', () => {
		const h = withParticles();
		h.world.setBlock(O.x, O.y, O.z, fireworks);
		h.loop.ignite(at(O), 0);
		h.loop.simulate(1.1);
		expect(h.shots).toEqual([[O.x + 0.5, O.y + 0.5, O.z + 0.5, 1]]);
	});

	it('chained: a firework primed by a TNT fires the same way; the TNT itself makes no firework (catches the effect on every blast, or only on a lit firework)', () => {
		const h = withParticles();
		h.world.setBlock(O.x, O.y, O.z, tnt);
		h.world.setBlock(O.x + 2, O.y, O.z, fireworks);
		h.loop.ignite(at(O), 0);
		h.loop.simulate(2.6);
		expect(h.shots).toEqual([]);
		h.loop.simulate(TNT_CHAIN_FUSE + 0.05);
		expect(h.world.getBlock(O.x + 2, O.y, O.z)).toBe(AIR);
		expect(h.shots).toEqual([[O.x + 2.5, O.y + 0.5, O.z + 0.5, 1]]);
	});

	it('a mixed chain (Review Focus 5): a TNT lights a Fireworks and a Tunnel, the Tunnel lights a TNT, that TNT lights a second Fireworks; each goes off exactly once with its own effect and nothing stays primed (catches an origin that re-primes itself, a firework on every blast, and a chained Tunnel that forgets its direction)', () => {
		const h = withParticles();
		const primed = () => (h.loop as unknown as { primedTnt: Map<string, unknown> }).primedTnt.size;
		h.world.setBlock(O.x, O.y, O.z, tnt);
		h.world.setBlock(O.x - 2, O.y, O.z, fireworks);       // in the TNT's radius
		h.world.setBlock(O.x, O.y, O.z + 2, tunnel);          // in the TNT's radius: chained, it runs pz
		h.world.setBlock(O.x, O.y, O.z + 10, tnt);            // in the tunnel's line
		h.world.setBlock(O.x + 3, O.y, O.z + 10, fireworks);  // in the second TNT's radius, outside the tunnel
		h.world.setBlock(O.x, O.y + 1, O.z + 20, stone);      // pz marker: the tunnel digs it
		h.world.setBlock(O.x + 20, O.y + 1, O.z + 2, stone);  // px marker: a Tunnel that lost its dir would dig this
		h.loop.ignite(at(O), 0);
		h.loop.simulate(2.6);
		expect(h.shots).toEqual([]);
		expect(primed()).toBe(2); // the Fireworks and the Tunnel
		h.loop.simulate(TNT_CHAIN_FUSE + 0.05);
		expect(h.shots).toEqual([[O.x - 1.5, O.y + 0.5, O.z + 0.5, 1]]);
		expect(h.world.getBlock(O.x, O.y + 1, O.z + 20)).toBe(AIR);
		expect(h.world.getBlock(O.x + 20, O.y + 1, O.z + 2)).toBe(stone);
		for (let i = 0; i < 20; i++) h.loop.simulate(TNT_CHAIN_FUSE + 0.01);
		expect(h.shots).toEqual([[O.x - 1.5, O.y + 0.5, O.z + 0.5, 1], [O.x + 3.5, O.y + 0.5, O.z + 10.5, 1]]);
		for (const [x, z] of [[O.x, O.z], [O.x - 2, O.z], [O.x, O.z + 2], [O.x, O.z + 10], [O.x + 3, O.z + 10]]) expect(h.world.getBlock(x, O.y, z), `${x},${z}`).toBe(AIR);
		expect(primed()).toBe(0);
	});
});
