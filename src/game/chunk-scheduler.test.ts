import { describe, it, expect } from 'vitest';
import { planFrame, orderStream, budgetFor, chebyshev, MESH_RADIUS, UNMOUNT_RADIUS, DATA_RADIUS, type FrameInput } from './chunk-scheduler';
import { chunkIndex } from '../engine/world/coords';

const I = (cx: number, cz: number) => chunkIndex(cx, cz);
function clock(costs: number[]) { let t = 0, k = 0; return { now: () => t, mount: (_i: number) => { t += costs[k++ % costs.length]; } }; }
function input(p: Partial<FrameInput>): FrameInput { return { editLane: new Set(), bulk: new Set(), stream: new Set(), playerCx: 10, playerCz: 10, moving: true, initialLoad: false, ...p }; }

describe('chunk scheduler (spec §6.2)', () => {
	it('radii are the named constants', () => { expect([MESH_RADIUS, UNMOUNT_RADIUS, DATA_RADIUS]).toEqual([6, 7, 8]); });

	it('nearest-first is Chebyshev inside orderStream: (3,3) precedes (4,0) (mutant: Euclidean distance inside orderStream — Cheb 3<4 but Eucl 4.24>4.0 would put (4,0) first)', () => {
		const s = new Set([I(14, 10), I(13, 13)]); // (4,0) inserted first, (3,3) second
		expect(orderStream(s, 10, 10)).toEqual([I(13, 13), I(14, 10)]);
		expect(chebyshev(I(13, 13), 10, 10)).toBe(3);
	});

	it('ties keep insertion order, with same-ring chunks inserted non-lexicographically (mutant: sort by (d, cx, cz))', () => {
		const s = new Set([I(11, 9), I(9, 11), I(11, 11), I(9, 9)]); // all ring 1
		expect(orderStream(s, 10, 10)).toEqual([I(11, 9), I(9, 11), I(11, 11), I(9, 9)]);
	});

	it('budget is honoured across two budgets × two costs and a non-uniform sequence (mutants: ignore the budget; precompute floor(budget/cost))', () => {
		for (const [moving, budget] of [[true, 6], [false, 20]] as [boolean, number][]) {
			for (const cost of [2, 5]) {
				const c = clock([cost]);
				const stream = new Set(Array.from({ length: 40 }, (_, k) => I(10 + (k % 6), 10 + Math.floor(k / 6))));
				const r = planFrame(input({ stream, moving }), c.now, c.mount);
				// mounts while elapsed < budget, checked before each mount: ceil(budget/cost) mounts, never fewer than 1
				expect(r.mounts.length).toBe(Math.max(1, Math.ceil(budget / cost)));
			}
		}
		const c = clock([2, 2, 10, 2]); // 2+2=4 < 6 → third mount runs (10) → 14 ≥ 6 → stop: 3 mounts, not floor(6/2)=3 by luck — so also check the 20 budget: 2,2,10,2,2,2 → 20 → stop at 6
		const r = planFrame(input({ stream: new Set(Array.from({ length: 20 }, (_, k) => I(10, 10 + k))), moving: false }), c.now, c.mount);
		expect(r.mounts.length).toBe(6);
	});

	it('mounts at least one chunk when the clock is already past budget (mutant: while (elapsed < budget))', () => {
		let t = 100; const now = () => t; const mount = () => { t += 50; };
		const r = planFrame(input({ stream: new Set([I(10, 11), I(10, 12)]) }), now, mount);
		expect(r.mounts.length).toBe(1);
	});

	it('neighbour work is counted: a mount that costs 40 ms (4 absent neighbours) is the only mount that frame (mutant: neighbour work not counted)', () => {
		const c = clock([40, 1, 1]);
		const r = planFrame(input({ stream: new Set([I(10, 11), I(10, 12), I(10, 13)]), moving: false }), c.now, c.mount);
		expect(r.mounts.length).toBe(1);
	});

	it('edit lane runs first, in full, and suppresses streaming that frame (mutant: edits appended to the stream set)', () => {
		const c = clock([25, 25, 1]);
		const r = planFrame(input({ editLane: new Set([I(3, 3), I(3, 4)]), stream: new Set([I(10, 11)]), moving: false }), c.now, c.mount);
		expect(r.edits).toEqual([I(3, 3), I(3, 4)]);
		expect(r.mounts).toEqual([]);
	});

	it('adaptive budget: 20 ms while still or loading, 6 ms while moving (mutant: constant 6 → initial-load fixture needs > 20 frames)', () => {
		expect(budgetFor(true, false)).toBe(6); expect(budgetFor(false, false)).toBe(20); expect(budgetFor(true, true)).toBe(20);
		const stream = new Set(Array.from({ length: 121 }, (_, k) => I(k % 11, Math.floor(k / 11))));
		let frames = 0;
		while (stream.size > 0 && frames < 200) { const c = clock([9]); const r = planFrame(input({ stream, moving: true, initialLoad: true, playerCx: 5, playerCz: 5 }), c.now, c.mount); for (const i of r.mounts) stream.delete(i); frames++; }
		expect(frames).toBeLessThanOrEqual(41); // 121 chunks / 3 per frame at 9 ms under a 20 ms budget
	});
	it('bulk lane (crafting §7): drained after the edit lane in the SAME frame, before streaming, nearest first (catches today\'s early return after edits, which leaves the bulk lane for a later frame)', () => {
		const log: string[] = [];
		const lane = (i: number, l: string) => { log.push(`${l}:${i}`); };
		const r = planFrame(
			input({ editLane: new Set([I(10, 10)]), bulk: new Set([I(13, 10), I(11, 10)]), stream: new Set([I(10, 11)]), moving: false }),
			() => 0,
			lane,
		);
		expect(log).toEqual([`edit:${I(10, 10)}`, `bulk:${I(11, 10)}`, `bulk:${I(13, 10)}`]); // the far one was inserted first
		expect(r.edits).toEqual([I(10, 10)]);
		expect(r.bulk).toEqual([I(11, 10), I(13, 10)]);
		expect(r.mounts).toEqual([]); // the edit still suppresses streaming
	});

	it('a chunk in both the edit lane and the bulk lane is meshed once, in the edit lane (catches posting it to the worker too: two TNT or an area break and a blast in one tick put a chunk in both lanes; gate 2)', () => {
		const log: string[] = [];
		planFrame(
			input({ editLane: new Set([I(10, 10)]), bulk: new Set([I(10, 10), I(11, 10)]), moving: false }),
			() => 0,
			(i, l) => { log.push(`${l}:${i}`); },
		);
		expect(log).toEqual([`edit:${I(10, 10)}`, `bulk:${I(11, 10)}`]);
	});

	it('bulkMax caps the bulk lane (1 per frame without a worker) and streaming still runs in a frame with no edit (catches draining the whole bulk lane synchronously in one frame)', () => {
		const log: string[] = [];
		const r = planFrame(
			input({ bulk: new Set([I(11, 10), I(12, 10), I(13, 10)]), bulkMax: 1, stream: new Set([I(10, 11)]), moving: false }),
			() => 0,
			(i, l) => { log.push(`${l}:${i}`); },
		);
		expect(r.bulk).toEqual([I(11, 10)]);
		expect(r.mounts).toEqual([I(10, 11)]);
		expect(log).toEqual([`bulk:${I(11, 10)}`, `stream:${I(10, 11)}`]);
	});

	it('a refused bulk post (worker full) is not reported as done and stops both the bulk lane and streaming this frame (catches treating the refusal as a mount: the chunk would leave the lane unmeshed)', () => {
		const calls: number[] = [];
		const r = planFrame(
			input({ bulk: new Set([I(11, 10), I(12, 10), I(13, 10)]), stream: new Set([I(10, 11)]), moving: false }),
			() => 0,
			(i) => { calls.push(i); return i !== I(12, 10); },
		);
		expect(r.bulk).toEqual([I(11, 10)]);
		expect(calls).toEqual([I(11, 10), I(12, 10)]);
		expect(r.mounts).toEqual([]);
	});
});
