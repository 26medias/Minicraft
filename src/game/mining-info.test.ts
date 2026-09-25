import { describe, expect, it } from 'vitest';
import { makeLoop } from './test-loop';
import { BLOCK_BY_NAME } from '../data/blocks.data';

const stone = BLOCK_BY_NAME['stone'].id;

describe('GameLoop.miningInfo (cracks)', () => {
	it('is null when idle, describes the target while mining, and clears on release', () => {
		const { loop, world, player, tick } = makeLoop();
		// Player at (260, 40, 260), eye y = 41.6, yaw 0 looks toward -z (same fixture as loop.test.ts).
		player.flying = true;
		world.setBlock(260, 41, 257, stone);
		expect(loop.miningInfo()).toBeNull();

		loop.setLeftMouseDown(true);
		tick(0.05); // starts mining
		tick(0.05);
		const info = loop.miningInfo()!;
		expect(info).toMatchObject({ x: 260, y: 41, z: 257, blockId: stone });
		expect(info.durationMs).toBeGreaterThan(0);
		expect(info.elapsedMs).toBeGreaterThan(0);
		expect(info.elapsedMs).toBeLessThan(info.durationMs);

		loop.setLeftMouseDown(false);
		expect(loop.miningInfo()).toBeNull();
	});
});
