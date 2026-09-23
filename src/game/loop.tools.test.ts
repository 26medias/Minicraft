import { describe, it, expect } from 'vitest';
import { makeLoop } from './test-loop';
import { applyRemoved } from './place';
import { areaCells } from './tools';
import { AIR, BLOCK_BY_NAME } from '../data/blocks.data';
import { TNT_PRIME_FUSE } from './tnt';
import type { FaceHighlight } from '../engine/render/face-highlight';
import type { PickaxeTier } from '../data/crafting.data';

const id = (n: string) => BLOCK_BY_NAME[n].id;
const stone = id('stone'), glass = id('glass'), water = id('water'), bedrock = id('bedrock'), tnt = id('tnt');

type Harness = ReturnType<typeof makeLoop>;

/** Player inside the cleared chunk (16,16), off block boundaries, flying; yaw 0 looks −z at y 41. */
function fixture(tier: PickaxeTier, highlight: FaceHighlight | null = null): Harness {
	const h = makeLoop({ highlight });
	h.player.flying = true;
	h.player.position = [264.5, 40, 270.5];
	h.player.tools = { owned: tier === 0 ? [0] : [0, tier], equipped: tier };
	return h;
}
function fill(h: Harness, xs: [number, number], ys: [number, number], zs: [number, number], block: number) {
	for (let x = xs[0]; x <= xs[1]; x++) for (let y = ys[0]; y <= ys[1]; y++) for (let z = zs[0]; z <= zs[1]; z++) h.world.setBlock(x, y, z, block);
}
/** Duration of the mine the next tick starts: one tick starts it, one 0.1 s tick accumulates. NaN if it already finished. */
function measure(h: Harness): number {
	h.tick(0.01);
	h.tick(0.1);
	const p = h.loop.miningProgress();
	return p > 0 ? 0.1 / p : NaN;
}
function mineUntilAir(h: Harness, x: number, y: number, z: number) {
	for (let i = 0; i < 80 && h.world.getBlock(x, y, z) !== AIR; i++) h.tick(0.05);
	expect(h.world.getBlock(x, y, z)).toBe(AIR);
}
/** Iron, button down, the 3×3 glass face at z 267 broken; the z 266 layer stays for the next swing. */
function afterFirstIronBreak(): Harness {
	const h = fixture(4);
	fill(h, [263, 265], [40, 42], [267, 267], glass);
	fill(h, [262, 269], [40, 42], [266, 266], glass);
	h.loop.setLeftMouseDown(true);
	mineUntilAir(h, 264, 41, 267);
	return h;
}

describe('mining time with floors (spec §5; catches one floor for every break, a floor that never re-arms while held or on a switch, and a floor keyed to solid cells)', () => {
	it('Iron aimed at a lone glass block surrounded by air still gets the 0.4 s floor', () => {
		const h = fixture(4);
		h.world.setBlock(264, 41, 267, glass);
		h.loop.setLeftMouseDown(true);
		expect(measure(h)).toBeCloseTo(0.4, 6);
	}, 30_000);

	it('0.4 s on the first break after a press, then 0.25 s on a held break inside the previous area', () => {
		const h = afterFirstIronBreak();
		for (let x = 263; x <= 265; x++) for (let y = 40; y <= 42; y++) expect(h.world.getBlock(x, y, 267)).toBe(AIR);
		expect(h.world.getBlock(264, 41, 266)).toBe(glass);
		expect(measure(h)).toBeCloseTo(0.25, 6);
	}, 30_000);

	it('back to 0.4 s when the held aim leaves the previous area: sideways, or a layer skipped', () => {
		const side = afterFirstIronBreak();
		side.player.position = [268.5, 40, 270.5]; // aim now (268, 41, 266): outside x 263–265
		expect(measure(side)).toBeCloseTo(0.4, 6);

		const deep = afterFirstIronBreak();
		fill(deep, [262, 269], [40, 42], [266, 266], AIR);
		deep.world.setBlock(264, 41, 264, glass); // two layers past the break
		expect(measure(deep)).toBeCloseTo(0.4, 6);
	}, 60_000);

	it('re-armed on release: a new press after a held break is 0.4 s again', () => {
		const h = afterFirstIronBreak();
		h.loop.setLeftMouseDown(false);
		h.loop.setLeftMouseDown(true);
		expect(measure(h)).toBeCloseTo(0.4, 6);
	}, 30_000);

	it('re-armed when P switches to another multi-block tier while the button is held', () => {
		const h = afterFirstIronBreak();
		h.player.tools = { owned: [0, 4, 5], equipped: 5 };
		h.loop.onPickaxeChanged();
		expect(measure(h)).toBeCloseTo(0.4, 6);
	}, 30_000);

	it('no floor for single-cell tiers: Stone pickaxe on glass is 0.2 / 1.5', () => {
		const h = fixture(2);
		h.world.setBlock(264, 41, 267, glass);
		h.loop.setLeftMouseDown(true);
		expect(measure(h)).toBeCloseTo(0.2 / 1.5, 6);
	}, 30_000);
});

describe('P mid-mine (spec §5)', () => {
	it('resets the mining timer and restarts at the new tier\'s time (catches a switch that keeps the elapsed time or the old duration)', () => {
		const h = fixture(0);
		h.player.tools = { owned: [0, 1], equipped: 0 };
		h.world.setBlock(264, 41, 267, stone);
		h.loop.setLeftMouseDown(true);
		expect(measure(h)).toBeCloseTo(1.2, 6);
		h.player.tools = { owned: [0, 1], equipped: 1 };
		h.loop.onPickaxeChanged();
		expect(h.loop.miningProgress()).toBe(0);
		expect(measure(h)).toBeCloseTo(1.2 / 1.15, 6);
	}, 30_000);
});

describe('area highlight (spec §5)', () => {
	it('receives the equipped tier\'s area bounds, multi true from Copper up (catches a highlight fed the aimed cell only)', () => {
		const calls: Array<[number[], number[], boolean]> = [];
		const stub = {
			show: () => {},
			hide: () => {},
			setArea: (min: readonly number[], max: readonly number[], multi: boolean) => { calls.push([[...min], [...max], multi]); },
		} as unknown as FaceHighlight;
		const h = fixture(4, stub);
		h.world.setBlock(264, 41, 267, glass);
		h.tick(0.01);
		expect(calls.at(-1)).toEqual([[263, 40, 267], [265, 42, 267], true]);
		h.player.tools = { owned: [0, 4, 6], equipped: 6 };
		h.tick(0.01);
		expect(calls.at(-1)).toEqual([[263, 40, 265], [265, 42, 267], true]);
		h.player.tools = { owned: [0, 4, 6], equipped: 0 };
		h.tick(0.01);
		expect(calls.at(-1)).toEqual([[264, 41, 267], [264, 41, 267], false]);
	}, 30_000);
});

describe('area mining (spec §5, §11 loop)', () => {
	it('Diamond on a stone wall: exactly the 27 cells behind the aimed face are AIR, and all 27 are counted (catches depth toward the player, and area breaks not reaching onBlocksRemoved)', () => {
		const h = fixture(6);
		fill(h, [261, 267], [38, 44], [262, 267], stone);
		h.loop.onBlockBroken = (ev) => { applyRemoved(h.player, [ev.blockId], false); };
		h.loop.onBlocksRemoved = (removed) => { applyRemoved(h.player, removed.map((r) => r.blockId), false); };
		h.loop.setLeftMouseDown(true);
		mineUntilAir(h, 264, 41, 267);
		const inArea = new Set(areaCells({ x: 264, y: 41, z: 267 }, 'pz', 6).map((c) => `${c.x},${c.y},${c.z}`));
		expect(inArea.size).toBe(27);
		for (let x = 261; x <= 267; x++) for (let y = 38; y <= 44; y++) for (let z = 262; z <= 267; z++)
			expect(h.world.getBlock(x, y, z), `${x},${y},${z}`).toBe(inArea.has(`${x},${y},${z}`) ? AIR : stone);
		expect(h.player.inventory).toEqual({ stone: 27 });
	}, 30_000);

	it('skips bedrock and liquids, removes (and counts) a primed TNT without letting it go off (catches an area break that ignites or keeps the fuse)', () => {
		const h = fixture(6);
		h.player.position = [264.5, 45, 264.5];
		h.cam.pitch = -1.5; // nearly straight down: aim at the top face of (264, 41, 264), depth runs −y
		fill(h, [262, 266], [40, 41], [262, 266], stone);
		fill(h, [262, 266], [39, 39], [262, 266], bedrock);
		h.world.setBlock(263, 40, 263, water);
		h.world.setBlock(265, 40, 265, tnt);
		expect(h.loop.ignite({ x: 265, y: 40, z: 265, face: 'py', distance: 1 })).toBe(true);
		h.loop.onBlocksRemoved = (removed) => { applyRemoved(h.player, removed.map((r) => r.blockId), false); };
		h.loop.setLeftMouseDown(true);
		mineUntilAir(h, 264, 41, 264);
		h.loop.setLeftMouseDown(false);
		expect(h.player.inventory).toEqual({ stone: 16, tnt: 1 });
		for (let x = 263; x <= 265; x++) for (let z = 263; z <= 265; z++) expect(h.world.getBlock(x, 39, z)).toBe(bedrock);
		expect(h.world.getBlock(265, 40, 265)).toBe(AIR);
		h.loop.simulate(TNT_PRIME_FUSE + 0.5);
		expect(h.world.getBlock(266, 40, 265)).toBe(stone); // ring cell next to the old TNT: no blast
		expect(h.world.getBlock(266, 39, 265)).toBe(bedrock);
	}, 30_000);

	it('out-of-bounds cells of an area at the world edge are skipped (catches a removeBlocks that writes or counts outside the world)', () => {
		const h = fixture(7);
		h.world.setBlock(0, 30, 300, stone);
		h.world.setBlock(1, 30, 300, stone);
		const cells = areaCells({ x: 0, y: 30, z: 300 }, 'px', 7); // depth runs −x: x 0 … −4
		expect(cells.filter((c) => c.x < 0)).toHaveLength(100);
		const { removed } = h.loop.removeBlocks(cells, { x: 0, y: 30, z: 300 });
		expect(removed.every((r) => r.x >= 0)).toBe(true);
		expect(removed.some((r) => r.x === 0 && r.y === 30 && r.z === 300)).toBe(true);
		expect(h.world.getBlock(1, 30, 300)).toBe(stone); // not in a −x area
	});
});
