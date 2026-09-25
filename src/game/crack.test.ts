import { describe, expect, it } from 'vitest';
import { crackStage, RemoteMining, MINE_TIMEOUT_GRACE_MS } from './crack';

describe('crackStage', () => {
	it('walks 0..9 over the mining duration and clamps at both ends', () => {
		expect(crackStage(0, 1000)).toBe(0);
		expect(crackStage(99, 1000)).toBe(0);
		expect(crackStage(100, 1000)).toBe(1);
		expect(crackStage(550, 1000)).toBe(5);
		expect(crackStage(999, 1000)).toBe(9);
		expect(crackStage(5000, 1000)).toBe(9);
		expect(crackStage(-5, 1000)).toBe(0);
	});

	it('an instant block (duration 0) shows the last stage, never NaN', () => {
		expect(crackStage(0, 0)).toBe(9);
	});
});

describe('RemoteMining', () => {
	const STONE = 1;
	const stoneEverywhere = () => STONE;

	it('a started mine is active with its stage; stop clears it', () => {
		const m = new RemoteMining();
		m.start(7, 10, 64, 12, 2000, STONE, 1000);
		expect(m.active(2000, stoneEverywhere)).toEqual([{ by: 7, x: 10, y: 64, z: 12, stage: 5, blockId: STONE }]);
		m.stop(7);
		expect(m.active(2100, stoneEverywhere)).toEqual([]);
	});

	it('a new start from the same player replaces the old target', () => {
		const m = new RemoteMining();
		m.start(7, 1, 1, 1, 1000, STONE, 0);
		m.start(7, 2, 2, 2, 1000, STONE, 0);
		expect(m.active(0, stoneEverywhere).map((a) => a.x)).toEqual([2]);
	});

	it('the mine ends when the block changes (the break landed, or anyone replaced it)', () => {
		const m = new RemoteMining();
		m.start(7, 10, 64, 12, 2000, STONE, 0);
		expect(m.active(500, () => 0 /* air now */)).toEqual([]);
		// And it stays gone even if the block comes back.
		expect(m.active(600, stoneEverywhere)).toEqual([]);
	});

	it('times out at duration + grace when the miner vanishes without a stop', () => {
		const m = new RemoteMining();
		m.start(7, 10, 64, 12, 2000, STONE, 0);
		expect(m.active(2000 + MINE_TIMEOUT_GRACE_MS - 1, stoneEverywhere)).toHaveLength(1);
		expect(m.active(2000 + MINE_TIMEOUT_GRACE_MS, stoneEverywhere)).toEqual([]);
	});

	it('forget(player) drops that player only', () => {
		const m = new RemoteMining();
		m.start(7, 1, 1, 1, 1000, STONE, 0);
		m.start(8, 2, 2, 2, 1000, STONE, 0);
		m.forget(7);
		expect(m.active(0, stoneEverywhere).map((a) => a.by)).toEqual([8]);
	});
});
