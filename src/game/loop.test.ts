import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GameLoop } from './loop';
import { World } from '../engine/world/world';
import { FpCamera } from '../engine/render/camera';
import { Player } from './player';
import { AIR, BLOCK_BY_NAME } from '../data/blocks.data';
import { TNT_PRIME_FUSE } from './tnt';
import type { Renderer } from '../engine/render/renderer';
import type { Keys } from './player';

const tnt = BLOCK_BY_NAME['tnt'].id;
const stone = BLOCK_BY_NAME['stone'].id;
const water = BLOCK_BY_NAME['water'].id;

// GameLoop's constructor only builds the LiquidScheduler; it never dereferences
// the renderer, so a stub keeps this test out of WebGL and off the DOM.
function makeLoop() {
	const world = new World(1);
	const chunk = world.ensureChunk(16, 16);
	chunk.blocks.fill(AIR);
	chunk.lights.fill(0);
	chunk.liquidFrontier.clear();

	const renderer = {
		camera: new THREE.PerspectiveCamera(),
		mountChunkMesh: () => {},
		onTick: () => {},
	} as unknown as Renderer;

	const keys = { isDown: () => false, consumePressed: () => false } as unknown as Keys;

	const loop = new GameLoop(
		world,
		renderer,
		new FpCamera(),
		new Player([260, 40, 260]),
		keys,
		() => [0, 0, 1, 1],
	);
	return { loop, world };
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
