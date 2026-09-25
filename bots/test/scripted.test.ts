import { describe, expect, it } from 'vitest';
import { ScriptedBrain, scriptedDecide } from '../src/brain/scripted.js';
import type { Candidate, KidInfo, Pose, Snapshot } from '../src/types.js';

/**
 * Task 2 (spec §6 "Scripted brain", amended by §12b's vertical condition):
 *
 *   follow      if the target kid is > followDist+1 away horizontally, OR |dy| > 1.5, OR moving;
 *   else help_build  if offered;
 *   else watch.
 *
 * A deterministic rule table, run against hand-built `Snapshot` fixtures — independent of Task 3's
 * `candidates()`/`perceive()`, which don't exist yet.
 */

const BOT_POSE: Pose = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };
const FOLLOW_DIST = 2;

function pose(x: number, y: number, z: number): Pose {
	return { x, y, z, yaw: 0, pitch: 0 };
}

function makeKid(overrides: Partial<KidInfo> = {}): KidInfo {
	return {
		name: 'Noah',
		id: 1,
		pose: pose(1, 64, 0),
		velocity: { x: 0, y: 0, z: 0 },
		speedLast0_3s: 0,
		speedLast1s: 0,
		flying: false,
		inLiquid: false,
		lookTarget: null,
		placements: [],
		idleSinceMs: null,
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		nowMs: 1_000_000,
		followDist: FOLLOW_DIST,
		bot: { pose: BOT_POSE, lastActions: [] },
		target: makeKid(),
		others: [],
		stopActiveForTarget: false,
		...overrides,
	};
}

const ALL_CANDIDATES: Candidate[] = ['follow', 'watch', 'help_build', 'wander', 'idle'];

describe('scriptedDecide: follow', () => {
	it('chooses follow when the kid is more than followDist+1 away horizontally', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(FOLLOW_DIST + 1.1, 64, 0) }) });
		const answer = scriptedDecide(snapshot, ALL_CANDIDATES);
		expect(answer.best).toBe('follow');
	});

	it('does not choose follow at exactly followDist+1 (the boundary is exclusive)', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(FOLLOW_DIST + 1, 64, 0), speedLast0_3s: 0 }) });
		const answer = scriptedDecide(snapshot, ['follow', 'watch']);
		expect(answer.best).toBe('watch');
	});

	it('chooses follow when |dy| > 1.5, even close horizontally (the stairs case, §12b)', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(1, 64 + 1.6, 0) }) });
		const answer = scriptedDecide(snapshot, ALL_CANDIDATES);
		expect(answer.best).toBe('follow');
	});

	it('does not choose follow at exactly |dy| = 1.5', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(1, 64 + 1.5, 0) }) });
		const answer = scriptedDecide(snapshot, ['follow', 'watch']);
		expect(answer.best).toBe('watch');
	});

	it('chooses follow when the kid is moving, even close and level', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(1, 64, 0), speedLast0_3s: 0.5 }) });
		const answer = scriptedDecide(snapshot, ALL_CANDIDATES);
		expect(answer.best).toBe('follow');
	});

	it('a kid just under the moving threshold does not trigger follow on speed alone', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(1, 64, 0), speedLast0_3s: 0.49 }) });
		const answer = scriptedDecide(snapshot, ['follow', 'watch']);
		expect(answer.best).toBe('watch');
	});

	it('does not choose follow when it is not among the offered candidates, even if the kid is far', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(50, 64, 0) }) });
		const answer = scriptedDecide(snapshot, ['watch', 'help_build']);
		expect(answer.best).not.toBe('follow');
	});
});

describe('scriptedDecide: help_build and watch', () => {
	it('chooses help_build when follow is not wanted and help_build is offered', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(1, 64, 0) }) });
		const answer = scriptedDecide(snapshot, ['follow', 'watch', 'help_build']);
		expect(answer.best).toBe('help_build');
	});

	it('falls through to watch when help_build is not offered', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(1, 64, 0) }) });
		const answer = scriptedDecide(snapshot, ['follow', 'watch']);
		expect(answer.best).toBe('watch');
	});
});

describe('scriptedDecide: no target kid', () => {
	it('chooses wander when offered', () => {
		const snapshot = makeSnapshot({ target: null });
		const answer = scriptedDecide(snapshot, ['wander', 'idle']);
		expect(answer.best).toBe('wander');
	});

	it('chooses idle when it is the only offered candidate', () => {
		const snapshot = makeSnapshot({ target: null });
		const answer = scriptedDecide(snapshot, ['idle']);
		expect(answer.best).toBe('idle');
	});
});

describe('scriptedDecide: Answer shape', () => {
	it('gives the chosen option probability 1, every other offered option 0, and confidence 1', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(1, 64, 0) }) });
		const offered: Candidate[] = ['follow', 'watch', 'help_build', 'wander', 'idle'];
		const answer = scriptedDecide(snapshot, offered);
		expect(answer.type).toBe('choice');
		expect(answer.best).toBe('help_build');
		expect(answer.probs).toEqual({ follow: 0, watch: 0, help_build: 1, wander: 0, idle: 0 });
		expect(answer.confidence).toBe(1);
	});

	it('is deterministic: the same snapshot and candidates always give the same answer', () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(FOLLOW_DIST + 5, 64, 0) }) });
		const a = scriptedDecide(snapshot, ALL_CANDIDATES);
		const b = scriptedDecide(snapshot, ALL_CANDIDATES);
		expect(a).toEqual(b);
	});
});

describe('ScriptedBrain', () => {
	it('health is always true', async () => {
		const brain = new ScriptedBrain(() => makeSnapshot());
		await expect(brain.health()).resolves.toBe(true);
	});

	it('ask decides from the snapshot supplied by getSnapshot, over the offered options', async () => {
		const snapshot = makeSnapshot({ target: makeKid({ pose: pose(FOLLOW_DIST + 5, 64, 0) }) });
		const brain = new ScriptedBrain(() => snapshot);
		const controller = new AbortController();
		const answer = await brain.ask('Noah is far away.', { type: 'choice', instructions: 'pick one', options: { follow: 'walk to Noah', watch: 'look at Noah' } }, controller.signal);
		expect(answer.best).toBe('follow');
		expect(answer.confidence).toBe(1);
	});

	it('name is "scripted"', () => {
		const brain = new ScriptedBrain(() => makeSnapshot());
		expect(brain.name).toBe('scripted');
	});
});
