import { beforeEach, describe, expect, it } from 'vitest';
import { CRAFTED_ONLY, blockId, isLiquidId } from 'minicraft-bot';
import { COMPASS, paramsBuild, paramsExplore, paramsMine, paramsPlayer, resetCompany, sampleCompany } from '../../src/brain2/params.js';
import { initialState } from '../../src/brain2/store.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { LIMITS } from '../../src/brain2/data/limits.data.js';
import type { Build, Dig, Relation, State, WorldEvent } from '../../src/brain2/types.js';
import type { KidInfo } from '../../src/types.js';

const Y = 200;
function kid(name: string, x: number, z: number): KidInfo {
	return {
		name, id: 7, pose: { x, y: Y, z, yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, speedLast0_3s: 0, speedLast1s: 0,
		flying: false, inLiquid: false, lookTarget: null, lookBlock: null, lookDistance: null, lookHeldMs: 0, miningCell: null,
		placements: [], idleSinceMs: null,
	};
}
function rel(minutes: number, affection = 0): Relation {
	const a = (value: number) => ({ value, band: 'neutral' as const, deltas: [] });
	return { axes: { affection: a(affection), cooperation: a(0), respect: a(0), grievance: a(0) }, metSessions: 1, minutesTogether: minutes, lastSeenT: 0 };
}
const base = (): State => structuredClone(initialState(PIP, { x: 0, y: Y, z: 0, yaw: 0, pitch: 0 })) as State;

beforeEach(() => resetCompany());

describe('params.player (spec §5.4)', () => {
	// Red if the pick follows affection (or total minutes) instead of the minutes gained in the last 10 min.
	it('the least-recent-company kid wins over the more-liked kid', () => {
		const s = base();
		s.relations = { Noah: rel(40, 0.9), Mia: rel(50, 0) };
		sampleCompany(s, 0);
		// 8 minutes later: Noah gained 6 minutes of company, Mia 1 (Mia has more minutes in total).
		s.relations = { Noah: rel(46, 0.9), Mia: rel(51, 0) };
		sampleCompany(s, 480_000);
		const kids = [kid('Noah', 3, 0), kid('Mia', 10, 0)];
		expect(paramsPlayer(s, kids, 480_000)).toBe('Mia');
	});

	// Red if the named kid is ignored, or named when absent.
	it('a named kid wins; ties go to the nearest; no kid → null', () => {
		const s = base();
		s.relations = { Noah: rel(0), Mia: rel(0) };
		sampleCompany(s, 0);
		const kids = [kid('Noah', 9, 0), kid('Mia', 3, 0)];
		expect(paramsPlayer(s, kids, 1000, 'Noah')).toBe('Noah');
		expect(paramsPlayer(s, kids, 1000, 'Zed')).toBe('Mia');   // absent → the tie → the nearest
		expect(paramsPlayer(s, [], 1000)).toBeNull();
	});
});

describe('params.explore (spec §5.4, §6)', () => {
	// Red if the score ignores `explored`, or the waypoints leave the leash.
	it('prefers unexplored chunks and keeps every waypoint within the leash', () => {
		const s = base();
		const anchor = { x: 256, y: Y, z: 256 };
		// Explore every chunk within 48 blocks except the ones straight east of the anchor.
		for (let cx = 12; cx <= 19; cx++) for (let cz = 12; cz <= 19; cz++) {
			const eastRay = cz === 16 && cx >= 16;
			if (!eastRay) s.explored[`${cx},${cz}`] = true;
		}
		const r = paramsExplore(s, anchor, { x: 250, y: Y, z: 250 });
		expect(r.dir).toEqual([1, 0]);
		expect(r.waypoints.length).toBeGreaterThan(1);
		for (const w of r.waypoints) expect(Math.hypot(w.x - anchor.x, w.z - anchor.z)).toBeLessThanOrEqual(LIMITS.LEASH + 1e-9);
		// Everything unexplored: the first compass direction (north, −z) wins the tie.
		expect(paramsExplore(base(), anchor, anchor).dir).toEqual(COMPASS[0]);
		// Waypoints are 12 apart along the ray from the bot.
		const w = paramsExplore(base(), anchor, anchor).waypoints;
		expect(w[0]).toMatchObject({ x: 256, z: 244 });
		expect(w[1]).toMatchObject({ x: 256, z: 232 });
		expect(w.at(-1)!.z).toBeCloseTo(256 - LIMITS.LEASH);
	});
});

describe('params.mine (spec §5.4)', () => {
	const need = (id: number, block: string): WorldEvent => ({ id, kind: 'need', t: 0, block, detail: block, salient: true });
	// Red if the order paused dig → need → favourite is broken.
	it('a paused dig first, then need, then the favourite', () => {
		const s = base();
		expect(paramsMine(s)).toEqual({ block: PIP.favouriteBlock });
		s.events = [need(1, 'sand'), need(2, 'big_tnt')];
		expect(paramsMine(s)).toEqual({ block: PIP.favouriteBlock });   // the latest need isn't a worldgen block
		s.events = [need(1, 'big_tnt'), need(2, 'sand')];
		expect(paramsMine(s)).toEqual({ block: 'sand' });
		s.digs = [{ id: 'd1', block: 'iron_ore', status: 'paused' } as Dig];
		expect(paramsMine(s)).toEqual({ block: 'iron_ore' });
	});
});

describe('params.build (spec §5.4)', () => {
	// Red if a CRAFTED_ONLY, liquid, ore or leaves block becomes a material, or renew isn't set at the cap.
	it('never a CRAFTED_ONLY, liquid or ore material; renew at 3 standing', () => {
		const s = base();
		s.inventory = { big_tnt: 99, water: 90, iron_ore: 80, oak_leaves: 70, stone: 30, dirt: 20, sand: 10, oak_log: 5, gravel: 0 };
		const p = paramsBuild(s);
		expect(p.materials).toEqual({ wall: 'stone', roof: 'dirt', floor: 'sand', accent: 'oak_log' });
		for (const m of Object.values(p.materials)) {
			expect(CRAFTED_ONLY).not.toContain(m);
			expect(m!.endsWith('_ore')).toBe(false);
			expect(isLiquidId(blockId(m!)!)).toBe(false);
		}
		expect(p.template).toBe(PIP.favouriteTemplate);
		expect(p.variant).toBe('small');
		expect(p.renew).toBe(false);
		const b = (id: string, status: Build['status']): Build => ({ id, template: 'house', variant: 'small', origin: { x: 0, y: 0, z: 0 }, cells: [], status });
		s.builds = [b('a', 'done'), b('b', 'done'), b('c', 'reverted'), b('d', 'building')];
		expect(paramsBuild(s).renew).toBe(true);
		// Enough for the medium: 1.2 × its cells.
		s.inventory = { stone: 1000 };
		expect(paramsBuild(s)).toMatchObject({ variant: 'medium', materials: { wall: 'stone', roof: 'stone', floor: 'stone', accent: 'stone' } });
		s.inventory = { water: 5 };
		expect(paramsBuild(s).materials).toEqual({});
	});
});
