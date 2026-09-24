// Multiplayer plan task C3: GameLoop.enqueueRemote / drainRemote (spec §6 "Where remote writes live",
// "Applying remote batches", "Unloaded chunks", "A remote block landing inside the local player").
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeLoop } from './test-loop';
import { AIR, BLOCK_BY_NAME, WATER, isSolid } from '../data/blocks.data';
import { TNT_PRIME_FUSE } from './tnt';
import { ChunkOverlay } from '../engine/world/overlay';
import { LightRegistry } from '../engine/render/light-registry';
import { DATA_RADIUS } from './chunk-scheduler';
import { GameLoop } from './loop';
import { playerBox, cellInBox } from './blast-shapes';
import { colorToInt, type Op } from '../net/protocol';
import { indexOf } from '../engine/world/coords';
import type { World } from '../engine/world/world';
import type { Player } from './player';

const stone = BLOCK_BY_NAME['stone'].id;
const tnt = BLOCK_BY_NAME['tnt'].id;
const lamp = BLOCK_BY_NAME['lamp'].id;

/** A makeLoop() fixture (v1 world, chunk (16,16) cleared) in multiplayer mode. */
function mpLoop(opts: Parameters<typeof makeLoop>[0] = {}) {
	const h = makeLoop(opts);
	const overlay = new ChunkOverlay();
	h.world.overlay = overlay;
	h.loop.mp = { overlay };
	return { ...h, overlay };
}

/** Every solid cell the player's box overlaps (the lift's trigger test). */
function overlapping(world: World, player: Player): Array<[number, number, number]> {
	const box = playerBox(player.position);
	const out: Array<[number, number, number]> = [];
	for (let x = Math.floor(box.min[0]); x <= Math.floor(box.max[0]); x++)
		for (let y = Math.floor(box.min[1]); y <= Math.floor(box.max[1]); y++)
			for (let z = Math.floor(box.min[2]); z <= Math.floor(box.max[2]); z++)
				if (cellInBox(x, y, z, box) && isSolid(world.getBlock(x, y, z))) out.push([x, y, z]);
	return out;
}

describe('T8: a remote mine of primed TNT cancels the local detonation (red: clearBlockEffects skipped)', () => {
	it('the blocks around P are unchanged 5 s after the remote AIR op', () => {
		const { loop, world } = mpLoop();
		const P = { x: 262, y: 30, z: 262 };
		for (let x = P.x - 4; x <= P.x + 4; x++) for (let y = P.y - 4; y <= P.y + 4; y++) for (let z = P.z - 4; z <= P.z + 4; z++) world.setBlock(x, y, z, stone);
		world.setBlock(P.x, P.y, P.z, tnt);
		expect(loop.ignite({ x: P.x, y: P.y, z: P.z, face: 'py' } as never, 0)).toBe(true);
		const before = new Map<string, number>();
		for (let x = P.x - 6; x <= P.x + 6; x++) for (let y = P.y - 6; y <= P.y + 6; y++) for (let z = P.z - 6; z <= P.z + 6; z++) before.set(`${x},${y},${z}`, world.getBlock(x, y, z));
		loop.enqueueRemote([[P.x, P.y, P.z, AIR, 0, 0]]);
		loop.drainRemote();
		expect(world.getBlock(P.x, P.y, P.z)).toBe(AIR);
		for (let t = 0; t < 5; t += 0.05) loop.simulate(0.05);
		expect(5).toBeGreaterThan(TNT_PRIME_FUSE);
		let changed = 0;
		for (const [k, id] of before) {
			if (k === `${P.x},${P.y},${P.z}`) continue;
			const [x, y, z] = k.split(',').map(Number);
			if (world.getBlock(x, y, z) !== id) changed++;
		}
		expect(changed).toBe(0);
	});
});

describe('T14: a remote block landing inside the player lifts him to free space (red: no post-batch overlap check)', () => {
	const cases: Array<{ name: string; pos: [number, number, number]; build: (w: World) => void; op: Op; expectY: number }> = [
		{ name: 'stone in the feet cell', pos: [260.5, 40, 260.5], build: () => {}, op: [260, 40, 260, stone, 0, 0], expectY: 41 },
		{ name: 'stone in the head cell', pos: [260.5, 40, 260.5], build: () => {}, op: [260, 41, 260, stone, 0, 0], expectY: 42 },
		{
			name: 'a 2-high tunnel with stone in the feet cell: up through the ceiling, standing on top',
			pos: [260.5, 40, 260.5],
			build: (w) => {
				for (let x = 258; x <= 262; x++) for (let z = 258; z <= 262; z++) { w.setBlock(x, 39, z, stone); w.setBlock(x, 42, z, stone); }
				for (let x = 258; x <= 262; x++) for (let z = 258; z <= 262; z++) if (x !== 260 || z !== 260) { w.setBlock(x, 40, z, stone); w.setBlock(x, 41, z, stone); }
			},
			op: [260, 40, 260, stone, 0, 0],
			expectY: 43,
		},
		{
			name: 'the box straddles into the next column (feet x = .8, stone at x+1 at feet level)',
			pos: [260.8, 40, 260.5],
			build: () => {},
			op: [261, 40, 260, stone, 0, 0],
			expectY: 41,
		},
	];
	for (const c of cases) {
		it(c.name, () => {
			const { loop, world, player } = mpLoop();
			c.build(world);
			player.position = [...c.pos];
			player.vy = -3;
			expect(overlapping(world, player)).toEqual([]);
			loop.enqueueRemote([c.op]);
			loop.drainRemote();
			expect(world.getBlock(c.op[0], c.op[1], c.op[2])).toBe(stone);
			expect(overlapping(world, player)).toEqual([]);
			expect(player.position[1]).toBe(c.expectY);
			expect(player.position[0]).toBe(c.pos[0]);
			expect(player.position[2]).toBe(c.pos[2]);
			expect(player.vy).toBe(0);
		});
	}

	it('a remote op that does not touch the player leaves him where he is', () => {
		const { loop, player } = mpLoop();
		player.position = [260.5, 40.25, 260.5];
		loop.enqueueRemote([[262, 40, 260, stone, 0, 0]]);
		loop.drainRemote();
		expect(player.position).toEqual([260.5, 40.25, 260.5]);
	});
});

describe('slicing: at most REMOTE_OPS_PER_FRAME ops per drain (spec §6, G1)', () => {
	it('5,000 ops: 2,000 after one drain, all after three', () => {
		const { loop, world } = mpLoop();
		expect(GameLoop.REMOTE_OPS_PER_FRAME).toBe(2000);
		const ops: Op[] = [];
		for (let y = 1; y <= 20 && ops.length < 5000; y++) for (let x = 256; x < 272 && ops.length < 5000; x++) for (let z = 256; z < 272 && ops.length < 5000; z++) ops.push([x, y, z, stone, 0, 0]);
		expect(ops.length).toBe(5000);
		const applied = () => ops.filter(([x, y, z]) => world.getBlock(x, y, z) === stone).length;
		loop.enqueueRemote(ops);
		expect(applied()).toBe(0);
		expect(loop.remotePending).toBe(5000);
		loop.drainRemote();
		expect(applied()).toBe(2000);
		expect(loop.remotePending).toBe(3000);
		loop.drainRemote();
		loop.drainRemote();
		expect(applied()).toBe(5000);
		expect(loop.remotePending).toBe(0);
	});
});

describe('unloaded chunks (spec §6: never ensureChunk; the overlay carries the op)', () => {
	it('an op to an unloaded chunk leaves the chunk count unchanged, updates the overlay, and appears at generation', () => {
		const { loop, world, overlay } = mpLoop();
		const cx = 20, cz = 20, x = cx * 16 + 3, y = 30, z = cz * 16 + 5;
		expect(world.getChunk(cx, cz)).toBeUndefined();
		const n = world.chunkCount;
		loop.enqueueRemote([[x, y, z, stone, 0, 0]]);
		expect(overlay.get(x, y, z)).toEqual([stone, 0, 0]);
		loop.drainRemote();
		expect(world.chunkCount).toBe(n);
		expect(world.getChunk(cx, cz)).toBeUndefined();
		world.ensureChunk(cx, cz);
		expect(world.getBlock(x, y, z)).toBe(stone);
	});
});

describe('eviction: modified chunks are evictable in multiplayer', () => {
	for (const pins of [false, true]) {
		it(`modifiedPins = ${pins}: a modified chunk beyond DATA_RADIUS is ${pins ? 'kept (solo)' : 'dropped'}`, () => {
			const { world, player, tick } = mpLoop();
			world.modifiedPins = pins;
			player.position = [16 * 16 + 8, 60, 16 * 16 + 8];
			const far = DATA_RADIUS + 1;
			const b = world.ensureChunk(16, 16 + far);
			b.modified = true;
			tick(1 / 60);
			if (pins) expect(world.getChunk(16, 16 + far)).toBe(b);
			else expect(world.getChunk(16, 16 + far)).toBeUndefined();
		});
	}
});

describe('lamp colours (gate-2 C3: the registry is updated at receive time, drainRemote only relights)', () => {
	const RED = '#FF0000', BLUE = '#0000FF';
	const litAt = (world: World, x: number, y: number, z: number) => world.getChunk(Math.floor(x / 16), Math.floor(z / 16))!.lights[indexOf(x & 15, y, z & 15)];

	it('an op with a colour registers the lamp at enqueue, before the drain', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world } = mpLoop({ lights });
		loop.enqueueRemote([[260, 30, 262, lamp, 0, colorToInt(RED)]]);
		expect(lights.getColor(260, 30, 262)).toBe(RED);
		expect(world.getBlock(260, 30, 262)).toBe(AIR);
		loop.drainRemote();
		expect(world.getBlock(260, 30, 262)).toBe(lamp);
		expect(litAt(world, 261, 30, 262)).not.toBe(0);
	});

	it('an op with a colour to an UNLOADED chunk registers the lamp too, without loading the chunk', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world } = mpLoop({ lights });
		const x = 20 * 16 + 1, z = 20 * 16 + 1;
		const n = world.chunkCount;
		loop.enqueueRemote([[x, 30, z, lamp, 0, colorToInt(BLUE)]]);
		loop.drainRemote();
		expect(lights.getColor(x, 30, z)).toBe(BLUE);
		expect(world.chunkCount).toBe(n);
	});

	it('an op replacing a lamp with stone unregisters it at enqueue, loaded or not', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world } = mpLoop({ lights });
		world.setBlock(260, 30, 262, lamp);
		lights.add(260, 30, 262, RED);
		const ux = 21 * 16 + 2, uz = 21 * 16 + 2;
		lights.add(ux, 30, uz, RED); // a lamp in an unloaded chunk
		loop.enqueueRemote([[260, 30, 262, stone, 0, 0], [ux, 30, uz, AIR, 0, 0]]);
		expect(lights.getColor(260, 30, 262)).toBeNull();
		expect(lights.getColor(ux, 30, uz)).toBeNull();
		loop.drainRemote();
		expect(world.getBlock(260, 30, 262)).toBe(stone);
	});

	it('stone then a red lamp on the same cell in one batch ends a registered red lamp (the drain must not unregister it)', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world } = mpLoop({ lights });
		world.setBlock(260, 30, 262, lamp);
		lights.add(260, 30, 262, BLUE);
		loop.enqueueRemote([[260, 30, 262, stone, 0, 0], [260, 30, 262, lamp, 0, colorToInt(RED)]]);
		loop.drainRemote();
		expect(world.getBlock(260, 30, 262)).toBe(lamp);
		expect(lights.getColor(260, 30, 262)).toBe(RED);
	});

	it('a colour-only op (same id and fluid) still relights (re-gate: the no-op check never compares colour)', () => {
		const lit = (colour: string, recolour: string | null) => {
			const lights = new LightRegistry(new THREE.Scene());
			const { loop, world } = mpLoop({ lights });
			world.setBlock(260, 30, 262, lamp);
			lights.add(260, 30, 262, colour);
			world.getChunk(16, 16)!.lights.fill(0);
			loop.enqueueRemote([[260, 30, 262, lamp, 0, colorToInt(recolour ?? colour)]]);
			loop.drainRemote();
			expect(lights.getColor(260, 30, 262)).toBe(recolour ?? colour);
			return litAt(world, 261, 30, 262);
		};
		// A plain echo (same colour) is a no-op: nothing relit, the zeroed light stays 0.
		expect(lit(RED, null)).toBe(0);
		// A recolour must relight: the cell next to the lamp carries blue light, equal to a fresh blue lamp's.
		const recoloured = lit(RED, BLUE);
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world } = mpLoop({ lights });
		loop.enqueueRemote([[260, 30, 262, lamp, 0, colorToInt(BLUE)]]);
		loop.drainRemote();
		expect(recoloured).not.toBe(0);
		expect(recoloured).toBe(litAt(world, 261, 30, 262));
	});
});

describe('drainRemote and the mining target', () => {
	it('an op on the block being mined cancels the mine; an op elsewhere does not', () => {
		const { loop, world } = mpLoop();
		world.setBlock(260, 30, 262, stone);
		world.setBlock(262, 30, 262, stone);
		const l = loop as unknown as { mining: unknown };
		l.mining = { target: { x: 260, y: 30, z: 262 }, elapsed: 0.5, duration: 1, blockId: stone };
		loop.enqueueRemote([[262, 30, 262, AIR, 0, 0]]);
		loop.drainRemote();
		expect(loop.miningProgress()).toBe(0.5);
		loop.enqueueRemote([[260, 30, 262, AIR, 0, 0]]);
		loop.drainRemote();
		expect(loop.miningProgress()).toBe(0);
	});
});

describe('tick: where the drain runs (gate-2 + re-gate C3 paused branch)', () => {
	it('unpaused: a tick drains the queue', () => {
		const { loop, world, tick } = mpLoop();
		loop.enqueueRemote([[262, 30, 262, stone, 0, 0]]);
		tick(1 / 60);
		expect(world.getBlock(262, 30, 262)).toBe(stone);
		expect(loop.remotePending).toBe(0);
	});

	it('multiplayer, inventory open (paused): the drain AND the simulation still run', () => {
		const { loop, world, tick } = mpLoop();
		world.setBlock(262, 29, 262, stone);
		world.setBlock(262, 30, 262, WATER);
		loop.paused = true;
		loop.enqueueRemote([[257, 30, 270, stone, 0, 0]]);
		for (let i = 0; i < 120; i++) tick(1 / 60);
		expect(world.getBlock(257, 30, 270)).toBe(stone);
		expect(world.getBlock(263, 30, 262)).toBe(WATER); // spread: simulate ran
	});

	for (const flag of ['mpDisconnected', 'frozenByTimer'] as const) {
		it(`multiplayer, paused and ${flag}: neither the drain nor the simulation runs`, () => {
			const { loop, world, tick } = mpLoop();
			world.setBlock(262, 29, 262, stone);
			world.setBlock(262, 30, 262, WATER);
			loop.paused = true;
			loop[flag] = true;
			loop.enqueueRemote([[257, 30, 270, stone, 0, 0]]);
			for (let i = 0; i < 120; i++) tick(1 / 60);
			expect(world.getBlock(257, 30, 270)).toBe(AIR);
			expect(loop.remotePending).toBe(1);
			expect(world.getBlock(263, 30, 262)).toBe(AIR);
		});
	}

	it('solo, paused: no simulation (unchanged)', () => {
		const { loop, world, tick } = makeLoop();
		world.setBlock(262, 29, 262, stone);
		world.setBlock(262, 30, 262, WATER);
		loop.paused = true;
		for (let i = 0; i < 120; i++) tick(1 / 60);
		expect(world.getBlock(263, 30, 262)).toBe(AIR);
	});

	it('paused multiplayer: the drain runs before flushDirtyChunks (the remote edit is meshed in the same tick)', { timeout: 60_000 }, () => {
		const { loop, tick, mounts } = mpLoop();
		loop.paused = true;
		for (let i = 0; i < 400; i++) tick(1 / 60); // settle the initial load
		const before = mounts();
		loop.enqueueRemote([[262, 30, 262, stone, 0, 0]]);
		tick(1 / 60);
		expect(mounts()).toBeGreaterThan(before);
	});
});
