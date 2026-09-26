// The landscaper's pickaxe (--pickaxe): the tool's mining time, and a multi-block tier's area break filtered by safety.
import { describe, expect, it } from 'vitest';
import { blockId, blockName, isLiquidId, isSolidId, miningDuration, PICKAXES } from 'minicraft-bot';
import type { Body, WorldView } from '../../src/port.js';
import type { Vec3 } from '../../src/types.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Tripwire } from '../../src/brain2/safety.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import { areaExtras, hitFace, mineCell, type GatherCtx } from '../../src/landscaper/gather.js';
import { grantList, loadLandscaperFile } from '../../src/landscaper/landscaper.js';
import type { Inventory } from '../../src/landscaper/craft.js';

const STONE = blockId('stone')!, RED = blockId('red_wool')!, WATER = blockId('water')!;
const TOP = 60;

/** Solid stone up to y 60, air above; overrides; `edited` cells are a kid's. */
class FlatWorld implements WorldView {
	mustMine = false;
	cells = new Map<string, number>();
	edited = new Set<string>();
	getBlock(x: number, y: number, z: number): number {
		return this.cells.get(`${x},${y},${z}`) ?? (y <= TOP && y > 0 ? STONE : 0);
	}
	set(x: number, y: number, z: number, id: number, edited = false): void {
		this.cells.set(`${x},${y},${z}`, id);
		if (edited) this.edited.add(`${x},${y},${z}`);
	}
	blockName = (id: number) => blockName(id);
	isSolid = (id: number) => isSolidId(id);
	isLiquid = (id: number) => isLiquidId(id);
	groundY = () => null;
	raycast = () => null;
	generatedBlock = () => 0;
	isEdited = (x: number, y: number, z: number) => this.edited.has(`${x},${y},${z}`);
	editedCellsInChunk = (cx: number, cz: number): Array<[number, number, number]> =>
		[...this.edited].map((k) => k.split(',').map(Number) as [number, number, number]).filter(([x, , z]) => Math.floor(x / 16) === cx && Math.floor(z / 16) === cz);
}

/** The bot stands at (10.5, 61, 10.5) (eye 62.6); the target (11, 60, 10) is the ground beside it: face py. */
function ctx(w: FlatWorld, tier: number, kids: Array<{ name: string; x: number; y: number; z: number }> = []) {
	const inv: Inventory = {};
	const owned: Record<string, number> = {};
	const own = new Ownership(w, () => owned);
	const trip = new Tripwire();
	trip.resetPlan(4);
	const batches: Vec3[][] = [];
	let t = 1_000_000;
	const c: GatherCtx = {
		body: { pose: () => ({ x: 10.5, y: 61, z: 10.5, yaw: 0, pitch: 0 }) } as unknown as Body,
		world: w, own, inv, kidsNow: () => kids, stop: new StopSignal(600_000), trip, edits: { lastEditT: null },
		noEdits: false, clock: () => (t += 1000), sleep: async () => undefined, stopped: () => false, gate: async () => undefined,
		log: () => undefined, anchor: { x: 0, z: 0 },
		mine: async (x, y, z) => {
			w.set(x, y, z, 0);
			return true;
		},
		tier,
		breakMany: async (cells) => {
			const out = cells.filter((q) => w.getBlock(q.x, q.y, q.z) === q.expect).map(({ x, y, z }) => ({ x, y, z }));
			for (const q of out) w.set(q.x, q.y, q.z, 0);
			batches.push(out);
			return out;
		},
		onWrite: (cell, id) => {
			owned[`${cell.x},${cell.y},${cell.z}`] = id;
		},
	};
	return { c, inv, trip, batches };
}
const target = { x: 11, y: TOP, z: 10 };

describe('landscaper pickaxe', () => {
	it('iron mines stone faster than the hand', () => {
		const iron = PICKAXES.find((p) => p.name === 'iron')!.tier;
		const h = 1.5;
		expect(miningDuration(h, iron, 'armed')).toBeLessThan(miningDuration(h, 0, 'none'));
	});

	it('the hit face is the one facing the eye', () => {
		expect(hitFace({ x: 10.5, y: 62.6, z: 10.5 }, target)).toBe('py');
		expect(hitFace({ x: 14, y: 60.5, z: 10.5 }, target)).toBe('px');
		expect(hitFace({ x: 11.5, y: 60.5, z: 6 }, target)).toBe('nz');
	});

	it('iron: the target and its 8 area cells broken, all into the inventory; one batch, the tripwire not tripped', async () => {
		const w = new FlatWorld();
		const { c, inv, trip, batches } = ctx(w, 4);
		expect(await mineCell(c, target, () => true)).toBe(true);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(8);
		expect(inv).toEqual({ stone: 9 });
		for (let x = 10; x <= 12; x++) for (let z = 9; z <= 11; z++) expect(w.getBlock(x, TOP, z)).toBe(0);
		expect(w.getBlock(11, TOP - 1, 10)).toBe(STONE);
		// A plan of 4 edits: 9 cells would overrun it, but the batch is added to the plan.
		expect(trip.halted).toBeNull();
	});

	it('the hand (and no area filter) breaks only the target', async () => {
		const w = new FlatWorld();
		const hand = ctx(w, 0);
		expect(await mineCell(hand.c, target, () => true)).toBe(true);
		expect(hand.batches).toHaveLength(0);
		expect(hand.inv).toEqual({ stone: 1 });
		const w2 = new FlatWorld();
		const noArea = ctx(w2, 4);
		expect(await mineCell(noArea.c, target)).toBe(true);
		expect(noArea.inv).toEqual({ stone: 1 });
	});

	it('a kid cell inside the 3×3 area: it is never broken (nor anything within 12 of it)', () => {
		const w = new FlatWorld();
		w.set(12, TOP, 11, RED, true);
		const { c } = ctx(w, 4);
		const extras = areaExtras(c, target, 'py');
		expect(extras.some((q) => q.x === 12 && q.z === 11)).toBe(false);
		expect(extras).toEqual([]);
	});

	it('a kid cell 12 away: only the area cells within 12 of it are dropped', () => {
		const w = new FlatWorld();
		w.set(24, TOP, 10, RED, true);
		const { c } = ctx(w, 4);
		const extras = areaExtras(c, target, 'py');
		// Only (12, 10) is within 12 (hypot 12); (12, 9) and (12, 11) are 12.04 away.
		expect(extras).toHaveLength(7);
		expect(extras.some((q) => q.x === 12 && q.z === 10)).toBe(false);
	});

	it('a kid within 24, liquid, bedrock and non-natural cells are all left', () => {
		const w = new FlatWorld();
		const kidNear = ctx(w, 4, [{ name: 'Noah', x: 34, y: 61, z: 10 }]);
		// A kid at x 34: only (10, 9) and (10, 11) are more than 24 away.
		expect(areaExtras(kidNear.c, target, 'py')).toEqual([{ x: 10, y: TOP, z: 9 }, { x: 10, y: TOP, z: 11 }]);
		const w2 = new FlatWorld();
		w2.set(10, TOP + 1, 9, WATER); // touches (10, 60, 9)
		w2.set(12, TOP, 9, blockId('bedrock')!);
		const { c } = ctx(w2, 4);
		const extras = areaExtras(c, target, 'py');
		expect(extras.some((q) => q.x === 10 && q.z === 9)).toBe(false);
		expect(extras.some((q) => q.x === 12 && q.z === 9)).toBe(false);
		expect(extras).toHaveLength(6);
	});

	it('--grant-ores: every generated ore and the TNT raw ingredients; a fresh file has not been granted', () => {
		const g = grantList();
		expect(g).toEqual(expect.arrayContaining(['coal_ore', 'redstone_ore', 'sand', 'stone', 'deepslate_coal_ore']));
		expect(g.every((n) => blockId(n) !== null)).toBe(true);
		expect(loadLandscaperFile('/nonexistent/x.json').granted).toBeUndefined();
	});
});
