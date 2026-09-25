import { describe, expect, it } from 'vitest';
import { crackStage, RemoteMining, MINE_TIMEOUT_GRACE_MS } from './crack';
import { BLOCK_BY_NAME } from '../data/blocks.data';

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
		expect(m.active(2000, stoneEverywhere)).toEqual([
			{ by: 7, x: 10, y: 64, z: 12, stage: 5, blockId: STONE, cells: [{ x: 10, y: 64, z: 12 }] },
		]);
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

describe('RemoteMining area cracks (spec: friends see every block an area tool is cracking)', () => {
	const stone = BLOCK_BY_NAME['stone'].id;
	const water = BLOCK_BY_NAME['water'].id;
	const AIR_ID = BLOCK_BY_NAME['air'].id;
	const IRON = 4; // 3x3x1 on the hit face (crafting.data)
	const key = (c: { x: number; y: number; z: number }) => `${c.x},${c.y},${c.z}`;

	/** Real ids so isRemovableId's solid/hardness lookup means something: stone in a 3x3 face at
	 * z 12, except (9,63,12) is air and (11,63,12) is water — both must be skipped. */
	function getBlock(x: number, y: number, z: number): number {
		if (z !== 12 || x < 9 || x > 11 || y < 63 || y > 65) return AIR_ID;
		if (x === 9 && y === 63) return AIR_ID;
		if (x === 11 && y === 63) return water;
		return stone;
	}

	it('a multi-block tool with a valid face: cells is the removable area (air/liquid skipped, target included)', () => {
		const m = new RemoteMining();
		m.start(7, 10, 64, 12, 2000, stone, 0, IRON, 'pz');
		const active = m.active(1000, getBlock);
		expect(active).toHaveLength(1);
		const cells = active[0].cells.map(key).sort();
		expect(cells).toContain(key({ x: 10, y: 64, z: 12 })); // the target
		expect(cells).not.toContain(key({ x: 9, y: 63, z: 12 })); // air
		expect(cells).not.toContain(key({ x: 11, y: 63, z: 12 })); // water
		expect(cells.length).toBeGreaterThan(1);
	});

	it('no tool: cells is just the target', () => {
		const m = new RemoteMining();
		m.start(7, 10, 64, 12, 2000, stone, 0);
		expect(m.active(1000, getBlock)[0].cells).toEqual([{ x: 10, y: 64, z: 12 }]);
	});

	it('an unknown face: cells is just the target (never crashes on a bad string from the wire)', () => {
		const m = new RemoteMining();
		m.start(7, 10, 64, 12, 2000, stone, 0, IRON, 'sideways' as never);
		expect(m.active(1000, getBlock)[0].cells).toEqual([{ x: 10, y: 64, z: 12 }]);
	});

	it('an unknown tool tier: cells is just the target', () => {
		const m = new RemoteMining();
		m.start(7, 10, 64, 12, 2000, stone, 0, 99, 'pz');
		expect(m.active(1000, getBlock)[0].cells).toEqual([{ x: 10, y: 64, z: 12 }]);
	});
});
