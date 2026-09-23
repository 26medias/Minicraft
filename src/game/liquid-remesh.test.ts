import { describe, it, expect } from 'vitest';
import { makeLoop } from './test-loop';
import { BLOCK_BY_NAME } from '../data/blocks.data';

type Lanes = { editLane: Set<number>; bulkLane: Set<number> };

describe('liquid light updates go to the bulk lane (final review: a lake refilling a Mega crater re-meshed 4 chunks per liquid tick on the main thread)', () => {
	it('flowing water never puts chunks in the synchronous edit lane (catches the scheduler light callback going through applyLightUpdate\'s edit routing)', () => {
		const h = makeLoop();
		const lanes = h.loop as unknown as Lanes;
		const stone = BLOCK_BY_NAME['stone'].id, water = BLOCK_BY_NAME['water'].id;
		// A stone floor across the cleared chunk (16,16); water poured at its +x border so light changes reach chunk (17,16).
		for (let x = 256; x <= 271; x++) for (let z = 256; z <= 271; z++) h.world.setBlock(x, 39, z, stone);
		for (let i = 0; i < 10; i++) h.tick(0.05); // settle the placement edits
		expect(lanes.editLane.size).toBe(0);
		h.world.setBlock(270, 40, 264, water);
		let sawBulk = false;
		for (let i = 0; i < 40; i++) {
			h.loop.simulate(0.05);
			expect(lanes.editLane.size).toBe(0);
			if (lanes.bulkLane.size > 0) sawBulk = true;
		}
		expect(h.world.getBlock(269, 40, 264)).toBe(water); // it really flowed
		expect(sawBulk).toBe(true);
	});
});
