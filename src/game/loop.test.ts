import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GameLoop } from './loop';
import { World } from '../engine/world/world';
import { FpCamera } from '../engine/render/camera';
import { LightRegistry } from '../engine/render/light-registry';
import { FaceHighlight, HIGHLIGHT_EPS } from '../engine/render/face-highlight';
import { Player } from './player';
import { AIR, BLOCK_BY_NAME } from '../data/blocks.data';
import { TNT_PRIME_FUSE } from './tnt';
import type { Renderer } from '../engine/render/renderer';
import type { Keys } from './player';
import { indexOf } from '../engine/world/coords';

const tnt = BLOCK_BY_NAME['tnt'].id;
const stone = BLOCK_BY_NAME['stone'].id;
const water = BLOCK_BY_NAME['water'].id;
const lamp = BLOCK_BY_NAME['lamp'].id;
const dirt = BLOCK_BY_NAME['dirt'].id;

// GameLoop's constructor only builds the LiquidScheduler; it never dereferences
// the renderer, so a stub keeps this test out of WebGL and off the DOM. The stub
// captures the tick callback so tests can drive a full tick() headlessly.
function makeLoop(lights: LightRegistry | null = null, highlight: FaceHighlight | null = null) {
	const world = new World(1);
	const chunk = world.ensureChunk(16, 16);
	chunk.blocks.fill(AIR);
	chunk.lights.fill(0);
	chunk.liquidFrontier.clear();

	let tickFn: ((dt: number) => void) | null = null;
	let mounts = 0;
	const renderer = {
		camera: new THREE.PerspectiveCamera(),
		mountChunkMesh: () => {
			mounts++;
		},
		onTick: (fn: (dt: number) => void) => {
			tickFn = fn;
		},
	} as unknown as Renderer;

	const keys: Keys = { forward: false, back: false, left: false, right: false, jump: false };
	const player = new Player([260, 40, 260]);

	const loop = new GameLoop(
		world,
		renderer,
		new FpCamera(),
		player,
		keys,
		() => [0, 0, 1, 1],
		null,
		null,
		lights,
		highlight,
	);
	loop.start();
	const tick = (dt: number) => tickFn!(dt);
	return { loop, world, player, keys, tick, mounts: () => mounts };
}

describe('GameLoop.onWorldMutated', () => {
	it('fires when primed TNT detonates', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, tnt);
		world.setBlock(261, 40, 260, stone);

		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};

		expect(loop.ignite({ x: 260, y: 40, z: 260 } as never)).toBe(true);
		loop.simulate(TNT_PRIME_FUSE + 0.1);

		expect(world.getBlock(261, 40, 260)).toBe(AIR);
		expect(mutations).toBeGreaterThan(0);
	});

	it('fires when liquid spreads', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, water);

		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};

		loop.simulate(1.0);

		expect(mutations).toBeGreaterThan(0);
	});

	it('does not fire on ticks that change nothing', () => {
		const { loop } = makeLoop();

		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};

		for (let i = 0; i < 20; i++) loop.simulate(0.016);

		expect(mutations).toBe(0);
	});
});

describe('GameLoop.paused', () => {
	it('stops physics and simulation but keeps loading chunks', () => {
		const { loop, world, player, keys, tick, mounts } = makeLoop();
		world.setBlock(260, 30, 260, tnt);
		world.setBlock(261, 30, 260, stone);
		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};
		expect(loop.ignite({ x: 260, y: 30, z: 260 } as never)).toBe(true);

		keys.forward = true;
		loop.paused = true;
		const before = [...player.position];
		// Each tick loads/meshes chunks (~50 ms), so use few, long ticks:
		// Player.update sub-steps internally and 3 × 1 s > TNT_PRIME_FUSE (2.5 s).
		for (let i = 0; i < 3; i++) tick(1.0);
		expect(player.position).toEqual(before);
		expect(mutations).toBe(0);
		expect(world.getBlock(261, 30, 260)).toBe(stone);
		expect(mounts()).toBeGreaterThan(0);

		loop.paused = false;
		for (let i = 0; i < 3; i++) tick(1.0);
		expect(player.position).not.toEqual(before);
		expect(mutations).toBeGreaterThan(0);
		expect(world.getBlock(261, 30, 260)).toBe(AIR);
	}, 30_000);
});

describe('GameLoop.replaceBlock', () => {
	const hit = (x: number, y: number, z: number) =>
		({ x, y, z, face: 'py', distance: 1 }) as const;

	it('overwrites the block and fires onWorldMutated once', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, stone);
		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};
		expect(loop.replaceBlock(hit(260, 40, 260), dirt, '#ffffff')).toBe(true);
		expect(world.getBlock(260, 40, 260)).toBe(dirt);
		expect(mutations).toBe(1);
	});

	it('is a true no-op for a same-block replace', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, stone);
		const chunk = world.ensureChunk(16, 16);
		chunk.modified = false;
		chunk.liquidFrontier.clear();
		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};
		expect(loop.replaceBlock(hit(260, 40, 260), stone, '#ffffff')).toBe(false);
		expect(chunk.modified).toBe(false);
		expect(chunk.liquidFrontier.size).toBe(0);
		expect(mutations).toBe(0);
	});

	it('cancels a primed TNT fuse', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, tnt);
		world.setBlock(261, 40, 260, stone);
		expect(loop.ignite(hit(260, 40, 260))).toBe(true);
		expect(loop.replaceBlock(hit(260, 40, 260), dirt, '#ffffff')).toBe(true);
		loop.simulate(TNT_PRIME_FUSE + 0.1);
		// detonate() ignores what sits at the origin, so a leaked fuse still
		// destroys the neighbour.
		expect(world.getBlock(261, 40, 260)).toBe(stone);
		expect(world.getBlock(260, 40, 260)).toBe(dirt);
	});

	it('registers a replaced-in lamp and lights the chunk in its colour', () => {
		// updateLightsForBlockChange reads the colour through lights.getColor and
		// packs it into chunk.lights, so a lamp registered *after* the light
		// update would be lit white. Compare a red lamp against a white one.
		const lit = (color: string) => {
			const lights = new LightRegistry(new THREE.Scene());
			const { loop, world } = makeLoop(lights);
			world.setBlock(260, 40, 260, stone);
			const chunk = world.ensureChunk(16, 16);
			chunk.lights.fill(0);
			expect(loop.replaceBlock(hit(260, 40, 260), lamp, color)).toBe(true);
			expect(lights.getColor(260, 40, 260)).toBe(color);
			return chunk.lights[indexOf(4, 40, 4)];
		};
		const red = lit('#ff0000');
		const white = lit('#ffffff');
		expect(red).not.toBe(0);
		expect(white).not.toBe(0);
		expect(red).not.toBe(white);
	});

	it('unregisters a lamp replaced by stone', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world } = makeLoop(lights);
		world.setBlock(260, 40, 260, lamp);
		lights.add(260, 40, 260, '#ff8800');
		expect(loop.replaceBlock(hit(260, 40, 260), stone, '#ffffff')).toBe(true);
		expect(lights.getColor(260, 40, 260)).toBeNull();
	});

	it('cancels in-progress mining on the replaced cell', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world, player, tick } = makeLoop(lights);
		// Player at (260, 40, 260), eye y = 41.6, yaw 0 looks toward -z.
		player.flying = true; // no gravity, so the eye stays put
		world.setBlock(260, 41, 257, stone);
		loop.setLeftMouseDown(true);
		tick(0.05); // starts mining
		tick(0.05); // accumulates
		expect(loop.miningProgress()).toBeGreaterThan(0);

		expect(loop.replaceBlock(hit(260, 41, 257), lamp, '#ff8800')).toBe(true);
		expect(loop.miningProgress()).toBe(0);

		// Mouse still held: mining restarts on the lamp and eventually breaks it
		// (lamp hardness 0.3). A stale mining record would finish with stone's id
		// and skip lights.remove, orphaning the light.
		for (let i = 0; i < 40 && world.getBlock(260, 41, 257) !== AIR; i++) tick(0.05);
		expect(world.getBlock(260, 41, 257)).toBe(AIR);
		expect(lights.getColor(260, 41, 257)).toBeNull();
	});
});

describe('GameLoop face highlight', () => {
	function makeHighlight() {
		const scene = new THREE.Scene();
		const h = new FaceHighlight(scene);
		const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
		return { h, group };
	}

	it('shows the aimed face within reach and hides it beyond reach or when paused', () => {
		const { h, group } = makeHighlight();
		const { loop, world, player, tick } = makeLoop(null, h);
		player.flying = true;
		// yaw 0 looks toward -z from eye (260, 41.6, 260); reach is 6.
		world.setBlock(260, 41, 257, stone);
		tick(0.05);
		expect(group.visible).toBe(true);
		expect(group.position.z).toBeCloseTo(258 + HIGHLIGHT_EPS, 6); // pz face of the block at z=257

		loop.paused = true;
		tick(0.05);
		expect(group.visible).toBe(false);
		loop.paused = false;
		// Re-show before the out-of-reach step, so the final assertion can only
		// pass if the tick actually hides the group again.
		tick(0.05);
		expect(group.visible).toBe(true);

		world.setBlock(260, 41, 257, AIR);
		// Reach is inclusive (raycastVoxel loops while t <= 6): a block whose near
		// face is 6.0 away is still hit. z=251 puts the face at 9.0, clearly out.
		world.setBlock(260, 41, 251, stone);
		tick(0.05);
		expect(group.visible).toBe(false);
	});
});
