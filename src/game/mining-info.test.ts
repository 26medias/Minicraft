import { describe, expect, it } from 'vitest';
import { makeLoop } from './test-loop';
import { BLOCK_BY_NAME, AIR } from '../data/blocks.data';
import type { FaceHighlight } from '../engine/render/face-highlight';

const stone = BLOCK_BY_NAME['stone'].id;
const water = BLOCK_BY_NAME['water'].id;

type Cell = { x: number; y: number; z: number };
const key = (c: Cell) => `${c.x},${c.y},${c.z}`;

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

	it('single-block tool: cells is just the target', () => {
		const { loop, world, player, tick } = makeLoop();
		player.flying = true;
		world.setBlock(260, 41, 257, stone);
		loop.setLeftMouseDown(true);
		tick(0.05);
		tick(0.05);
		const info = loop.miningInfo()!;
		expect(info.cells).toEqual([{ x: 260, y: 41, z: 257 }]);
	});

	it('area tool: cells covers every highlighted block, includes the target, and excludes air/liquid (spec: cracks on every block an area tool will break)', () => {
		const calls: Array<{ cells: Cell[]; multi: boolean }> = [];
		const highlight = {
			show: () => {},
			hide: () => {},
			setCells: (cells: readonly Cell[], multi: boolean) => { calls.push({ cells: [...cells], multi }); },
		} as unknown as FaceHighlight;
		const { loop, world, player, tick } = makeLoop({ highlight });
		player.flying = true;
		player.tools = { owned: [0, 4], equipped: 4 }; // Iron: 3x3x1 on the hit face
		for (let x = 259; x <= 261; x++) for (let y = 40; y <= 42; y++) world.setBlock(x, y, 257, stone);
		world.setBlock(259, 40, 257, AIR); // excluded: air
		world.setBlock(261, 40, 257, water); // excluded: liquid

		loop.setLeftMouseDown(true);
		tick(0.05); // starts mining, also runs the highlight's setCells
		tick(0.05);

		const info = loop.miningInfo()!;
		const highlighted = calls.at(-1)!.cells.map(key).sort();
		expect(calls.at(-1)!.multi).toBe(true);
		expect(info.cells.map(key).sort()).toEqual(highlighted);
		expect(info.cells.length).toBeGreaterThan(1);
		expect(info.cells.map(key)).toContain(key({ x: 260, y: 41, z: 257 }));
		for (const excluded of [{ x: 259, y: 40, z: 257 }, { x: 261, y: 40, z: 257 }]) {
			expect(info.cells.map(key)).not.toContain(key(excluded));
		}
	});
});
