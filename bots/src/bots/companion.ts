/**
 * The companion loop (spec §6, §12a, §12b). Every `tickMs`, never overlapping:
 *
 * 1. Take a snapshot. With no kid, decide `wander`/`idle` by script, without asking the brain.
 * 2. Build the candidates, then ask the brain `next` over them, with a timeout (AbortSignal).
 * 3. Confidence is max(p) over the offered options, computed here. Below `minConfidence`: `follow` when
 *    offered, else `watch`. A failed ask (timeout, error, an answer outside the candidates) falls back
 *    to the script (`fallback:<err>`); 5 in a row → scripted for the rest of the session.
 * 4. Act: `follow` is the standing intent (act.ts, never awaited); leaving it stops with
 *    `move(pose())`; `watch` looks; `help_build` spends its line at once (ruling R2), re-reads N right
 *    before `place`, and places only if N is still AIR and outside every kid; `wander` is an awaited
 *    walk capped at 4 s; `idle` does nothing.
 * 5. Log one JSONL line (log.ts). A status line (status.ts) every `statusEveryMs`.
 */
import type { Brain, Answer, Choice } from '../brain/brain.js';
import { scriptedDecide } from '../brain/scripted.js';
import type { CompanionTuning } from '../config.js';
import type { Body, WorldView } from '../port.js';
import type { Candidate, Snapshot } from '../types.js';
import { createFollowState, followTick, landTick, observeKid, stopMoving, watchPoint } from '../body/act.js';
import type { FollowState } from '../body/act.js';
import { markLineUsed, planCandidates, VERTICAL_FOLLOW } from '../body/candidates.js';
import type { CandidatePlan, EditGuard } from '../body/candidates.js';
import { forbiddenByKids } from '../body/guard.js';
import type { Logger } from '../body/log.js';
import { createPerception, perceive, recordAction, renderText } from '../body/perceive.js';
import { formatStatus } from '../body/status.js';
import type { Status } from '../body/status.js';
import { StopSignal } from '../body/stop-signal.js';

/** Failures in a row after which the brain is given up for the session. */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** `wander` walks are capped at this. */
export const WANDER_CAP_MS = 4000;
/** Fix round 1: beyond `followDist + FOLLOW_FLOOR_MARGIN` horizontally (or `VERTICAL_FOLLOW`
 *  vertically — same threshold `candidates.ts` uses to offer `follow` at all), the bot must close
 *  the gap: the brain is not asked, so it can never leave a kid behind by picking `watch`/`idle` out
 *  there. The brain still decides everything inside that band. */
export const FOLLOW_FLOOR_MARGIN = 3;
const AIR = 0;

export interface CompanionConfig {
	companion: CompanionTuning;
	noEdits: boolean;
	/** The brain's timeout per ask (ms). */
	brainTimeoutMs: number;
	/** The bot's name, for the status line. */
	name?: string;
}

export interface CompanionDeps {
	body: Body;
	world: WorldView;
	/** The brain to ask; `null` = `--brain scripted` (the script decides every tick). */
	brain: Brain | null;
	config: CompanionConfig;
	log: Logger;
	clock: () => number;
	rng: () => number;
	/** The session seed, logged with every decision. */
	seed?: number;
	/** Where status lines go (default: nowhere). */
	status?: (line: string) => void;
}

export interface CompanionHandle {
	stop(): Promise<void>;
	/** The current status line. */
	statusLine(): string;
	/** Counters, for tests and the exit summary. */
	readonly stats: { ticks: number; fallbacks: number; editsUsed: number; hops: number; scriptedSession: boolean };
}

/** A small seeded PRNG (mulberry32): the session's wander randomness. */
export function seededRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

class TimeoutError extends Error {
	override readonly name = 'TimeoutError';
	constructor(ms: number) {
		super(`the brain took longer than ${ms} ms`);
	}
}

class InvalidAnswerError extends Error {
	override readonly name = 'InvalidAnswerError';
}

/** Fix round 1, Part 2: each description names the observable cue that action is FOR, not just what
 *  the bot would do — measured to raise near-band accuracy on real Laya (see
 *  `test/fixtures/laya-near-band-labels.json` and `~/Projects/AI/BRAINS.md`). */
function describe(c: Candidate, s: Snapshot, plan: CandidatePlan): string {
	const kid = s.target?.name ?? 'the kid';
	switch (c) {
		case 'follow':
			return `${kid} is walking away — follow.`;
		case 'watch':
			return `Watch ${kid}.`;
		case 'help_build':
			return `${kid} placed blocks in a line — add the next ${plan.helpBuild?.block ?? 'block'}.`;
		case 'wander':
			return 'Walk around nearby.';
		case 'idle':
			return 'Wait.';
	}
}

const INSTRUCTIONS =
	'You are a companion robot in a block game with a child. If the child is moving away from you, choose follow. If the child just placed blocks in a row and is aiming at the next spot in that line, choose help_build. Otherwise choose watch.';

/** Exported for the Task 6 fix-round-1 measurement fixture (`test/fixtures/laya-near-band-labels.json`):
 *  builds the exact `Choice` the loop sends to a real brain, from a `Snapshot`/`CandidatePlan`, so a
 *  wording change here is measured with the production text, never a hand-copied approximation. */
export function question(s: Snapshot, plan: CandidatePlan): Choice {
	const options: Record<string, string> = {};
	for (const c of plan.candidates) options[c] = describe(c, s, plan);
	return { type: 'choice', instructions: INSTRUCTIONS, options };
}

/**
 * Fix round 1: true when the target kid is far enough (or steep enough) that `follow` must win
 * outright, without asking the brain — the loop's own safety floor under whatever the real brain
 * says. Requires `follow` to actually be offered (spec §6/§12b's own condition for that is a
 * strict subset of this one, so in practice it always is whenever this is true, but the check stays
 * explicit and defensive). Pure: reads only `s` and `offered`.
 */
export function followFloorTriggers(s: Snapshot, offered: readonly Candidate[]): boolean {
	const kid = s.target;
	if (!kid || !offered.includes('follow')) return false;
	const bot = s.bot.pose;
	const horizontal = Math.hypot(kid.pose.x - bot.x, kid.pose.z - bot.z);
	const vertical = Math.abs(kid.pose.y - bot.y);
	return horizontal > s.followDist + FOLLOW_FLOOR_MARGIN || vertical > VERTICAL_FOLLOW;
}

/** max(p) over the offered options (a missing option counts as 0). Never the brain's own field. */
export function confidenceOf(answer: Answer, offered: readonly Candidate[]): number {
	let max = 0;
	for (const c of offered) {
		const p = answer.probs?.[c];
		if (typeof p === 'number' && Number.isFinite(p) && p > max) max = p;
	}
	return max;
}

function errorCode(err: unknown): string {
	if (err instanceof TimeoutError) return 'timeout';
	if (err instanceof InvalidAnswerError) return 'invalid';
	if (err instanceof Error && err.name === 'AbortError') return 'timeout';
	return 'error';
}

export function runCompanion(deps: CompanionDeps): CompanionHandle {
	const { body, world, brain, config, log, clock, rng } = deps;
	const tuning = config.companion;
	const seed = deps.seed ?? 0;
	const brainName = brain?.name ?? 'scripted';

	const stop = new StopSignal(tuning.stopMs);
	const perception = createPerception(body, {
		tuning: { followDist: tuning.followDist, idleSwitchMs: tuning.idleSwitchMs, minTargetMs: tuning.minTargetMs },
		clock,
		stop,
	});
	const offStop = body.onEdit((edit) => {
		const who = stop.onEdit(edit, body.journal(), clock());
		if (who) log.event('stop', { kid: who, untilMs: clock() + tuning.stopMs });
	});
	const spawn = body.pose();
	const guard: EditGuard = {
		noEdits: config.noEdits,
		budgetLeft: tuning.editBudget,
		editEveryMs: tuning.editEveryMs,
		lastEditMs: null,
		usedLines: new Set(),
		wanderTether: tuning.wanderTether,
		anchor: { x: spawn.x, y: spawn.y, z: spawn.z },
		rng,
	};
	const follow: FollowState = createFollowState();
	const stats = { ticks: 0, fallbacks: 0, editsUsed: 0, hops: 0, scriptedSession: false };
	let consecutiveFailures = 0;
	let prevAction: Candidate | null = null;
	let lastSnapshot: Snapshot | null = null;
	let lastTargetName: string | null = null;
	let lastStatusMs = -Infinity;

	let stopped = false;
	let wake: (() => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const stopWaiters: (() => void)[] = [];
	const stoppedPromise = new Promise<void>((r) => stopWaiters.push(r));

	function sleep(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			wake = resolve;
			timer = setTimeout(() => {
				timer = null;
				wake = null;
				resolve();
			}, ms);
		});
	}

	function status(): Status {
		const s = lastSnapshot;
		return {
			name: config.name ?? 'Bot',
			action: prevAction,
			target: s?.target?.name ?? null,
			mode: prevAction === 'follow' ? follow.mode : null,
			switchedFrom: s?.switchedFrom ?? null,
			brain: brainName,
			scriptedSession: stats.scriptedSession,
			fallbacks: stats.fallbacks,
			editsUsed: stats.editsUsed,
			editBudget: tuning.editBudget,
			hops: follow.hops,
			stops: stop.active(clock()),
		};
	}

	async function ask(text: string, choice: Choice, offered: Candidate[]): Promise<Answer> {
		const ac = new AbortController();
		let t: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise<never>((_, reject) => {
			t = setTimeout(() => {
				ac.abort();
				reject(new TimeoutError(config.brainTimeoutMs));
			}, config.brainTimeoutMs);
		});
		const asked = brain!.ask(text, choice, ac.signal);
		asked.catch(() => undefined); // settled after the race is lost: never an unhandled rejection
		try {
			const answer = await Promise.race([asked, timeout]);
			if (!answer || typeof answer.best !== 'string' || !offered.includes(answer.best as Candidate) || typeof answer.probs !== 'object' || answer.probs === null) {
				throw new InvalidAnswerError(`the answer is not one of the candidates: ${JSON.stringify(answer)}`);
			}
			return answer;
		} finally {
			if (t !== null) clearTimeout(t);
		}
	}

	async function wander(spot: { x: number; z: number }): Promise<string> {
		let capTimer: ReturnType<typeof setTimeout> | null = null;
		const cap = new Promise<'cap'>((r) => {
			capTimer = setTimeout(() => r('cap'), WANDER_CAP_MS);
		});
		const walk = body.walkTo(spot).then(
			(r) => r as string,
			(err: unknown) => (err instanceof Error && err.name === 'BlockedError' ? 'blocked' : 'error'),
		);
		const r = await Promise.race([walk, cap, stoppedPromise.then(() => 'stopped')]);
		if (capTimer !== null) clearTimeout(capTimer);
		if (r === 'cap' || r === 'stopped') body.move(body.pose());
		return `wander ${r}`;
	}

	async function helpBuild(plan: CandidatePlan, now: number): Promise<string> {
		const hb = plan.helpBuild;
		if (!hb) return 'no-plan';
		// Ruling R2: the line is spent as soon as it is chosen, whatever the re-check says.
		markLineUsed(guard, hb.line);
		if (config.noEdits || guard.noEdits || world.mustMine || guard.budgetLeft <= 0) return 'edits-off';
		const n = hb.cell;
		// The re-check and the place run in the same macrotask (no await in between).
		if (world.getBlock(n.x, n.y, n.z) !== AIR) {
			log.event('help_build-recheck', { cell: n, why: 'not-air' });
			return 'recheck-failed: N is not air';
		}
		const kids = body.players().filter((p) => !p.bot && p.hasPos);
		if (forbiddenByKids(n, kids)) {
			log.event('help_build-recheck', { cell: n, why: 'kid' });
			return 'recheck-failed: N is next to a kid';
		}
		// A stop that started during the ask (the kid broke a bot block) cancels the place.
		const target = lastSnapshot?.target?.name ?? null;
		if (target !== null && stop.activeFor(target, clock())) {
			log.event('help_build-recheck', { cell: n, why: 'stop' });
			return 'recheck-failed: stop signal';
		}
		body.lookAt(n.x + 0.5, n.y + 0.5, n.z + 0.5);
		const placed = body.place(n.x, n.y, n.z, hb.block);
		guard.lastEditMs = now;
		const ok = await placed;
		if (!ok) return `place-refused ${hb.block} at ${n.x},${n.y},${n.z}`;
		guard.budgetLeft--;
		stats.editsUsed++;
		return `placed ${hb.block} at ${n.x},${n.y},${n.z}`;
	}

	async function act(action: Candidate, s: Snapshot, plan: CandidatePlan, now: number): Promise<string> {
		switch (action) {
			case 'follow': {
				if (!s.target) return 'no-target';
				const kids = [s.target, ...s.others].map((k) => k.pose);
				return followTick(follow, body, world, { kid: s.target, kids, followDist: tuning.followDist, now });
			}
			case 'watch': {
				if (!s.target) return 'no-target';
				const p = watchPoint(s.target);
				body.lookAt(p.x, p.y, p.z);
				const land = landTick(follow, body, world, s.target, now);
				return `look ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}${land ? `; ${land}` : ''}`;
			}
			case 'help_build':
				return helpBuild(plan, now);
			case 'wander':
				return plan.wander ? wander(plan.wander) : 'no-spot';
			case 'idle':
				return 'idle';
		}
	}

	async function tick(index: number): Promise<void> {
		const now = clock();
		const { snapshot } = perceive(perception, body, world, now);
		lastSnapshot = snapshot;
		if (snapshot.target) guard.anchor = { x: snapshot.target.pose.x, y: snapshot.target.pose.y, z: snapshot.target.pose.z };
		const targetName = snapshot.target?.name ?? null;
		if (targetName !== lastTargetName) {
			log.event('target', { from: lastTargetName, to: targetName, switchedFrom: snapshot.switchedFrom });
			lastTargetName = targetName;
		}
		const plan = planCandidates(snapshot, world, guard);
		const offered = plan.candidates;
		const text = renderText(snapshot);
		const kidsPresent = snapshot.target !== null || snapshot.others.length > 0;

		let action: Candidate;
		let reason: string;
		let raw: unknown = null;
		let decidedBy = brainName;
		let latency = 0;
		if (!kidsPresent || brain === null) {
			action = scriptedDecide(snapshot, offered).best as Candidate;
			reason = 'scripted';
			decidedBy = 'scripted';
		} else if (stats.scriptedSession) {
			action = scriptedDecide(snapshot, offered).best as Candidate;
			// Ruling R-c: the count stops here; the status line shows SCRIPTED-FALLBACK instead.
			reason = 'fallback:session';
			decidedBy = 'scripted';
		} else if (followFloorTriggers(snapshot, offered)) {
			// Fix round 1: out of reach — follow wins outright, and the brain is never asked this
			// tick. Not a fallback: no failure counter moves, and the brain is still trusted for
			// every following tick inside the band.
			action = 'follow';
			reason = 'rule:follow-floor';
		} else {
			const t0 = clock();
			try {
				const answer = await ask(text, question(snapshot, plan), offered);
				latency = clock() - t0;
				raw = answer;
				consecutiveFailures = 0;
				if (confidenceOf(answer, offered) < tuning.minConfidence) {
					action = offered.includes('follow') ? 'follow' : 'watch';
					reason = 'low-confidence';
				} else {
					action = answer.best as Candidate;
					reason = 'brain';
				}
			} catch (err) {
				latency = clock() - t0;
				raw = { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
				reason = `fallback:${errorCode(err)}`;
				decidedBy = 'scripted';
				action = scriptedDecide(snapshot, offered).best as Candidate;
				stats.fallbacks++;
				consecutiveFailures++;
				if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !stats.scriptedSession) {
					stats.scriptedSession = true;
					log.event('scripted-fallback', { failures: consecutiveFailures });
				}
			}
			if (stopped) return;
		}

		// Leaving follow stops the walk or flight (the SDK has no cancel).
		if (prevAction === 'follow' && action !== 'follow') stopMoving(follow, body);
		observeKid(follow, snapshot.target, now);
		let result: string;
		try {
			result = await act(action, snapshot, plan, clock());
		} catch (err) {
			result = `error: ${err instanceof Error ? err.message : String(err)}`;
		}
		recordAction(perception, action);
		prevAction = action;
		stats.hops = follow.hops;
		stats.ticks = index + 1;
		log.decision({ seed, tick: index, t: now, snapshot, text, candidates: offered, brain: decidedBy, raw, action, reason, result, latency });
	}

	const done = (async () => {
		for (let i = 0; !stopped; i++) {
			const t0 = clock();
			try {
				await tick(i);
			} catch (err) {
				log.event('tick-error', { tick: i, error: err instanceof Error ? err.message : String(err) });
			}
			if (clock() - lastStatusMs >= tuning.statusEveryMs) {
				lastStatusMs = clock();
				deps.status?.(formatStatus(status()));
			}
			if (stopped) break;
			await sleep(Math.max(0, tuning.tickMs - (clock() - t0)));
		}
	})();

	return {
		async stop() {
			if (!stopped) {
				stopped = true;
				for (const w of stopWaiters) w();
				if (timer !== null) clearTimeout(timer);
				wake?.();
			}
			await done;
			perception.unsubscribe();
			offStop();
		},
		statusLine: () => formatStatus(status()),
		stats,
	};
}
