/**
 * Layer 5, expression (spec §5.5, R2, code): gestures on appraisal changes, played only inside some kid's view
 * (the greeting is held up to 20 s for it), at most one per 5 s, plus the style's hop right after a walk arrives.
 * A gesture sets `body.gesture`, which pauses the runner; its `move()` cancels a walk in flight, and the runner
 * reissues that walk once the gesture clears (spec §7.3).
 */
import { EYE_HEIGHT } from 'minicraft-bot';
import type { Body } from '../port.js';
import type { KidInfo, Pose } from '../types.js';
import type { Clock } from './clock.js';
import { GESTURES as G } from './data/gestures.data.js';
import type { Change, Store } from './store.js';
import { styleOf } from './style.js';
import type { State, Vec3, WorldEvent } from './types.js';

export type GestureName = 'double-hop' | 'slow-turn' | 'back-off' | 'turn-hop' | 'turn-away' | 'look-at' | 'stomp-off' | 'greeting';
export interface GestureCue { name: GestureName; target?: Vec3; player?: string; firework?: boolean; holdMs?: number }

/** The bot's chest above its feet: what a kid sees. */
const CHEST = 0.9;
const DEG = Math.PI / 180;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
/** The yaw that faces along (dx, dz) (yaw 0 faces −z, as the SDK's view direction). */
const yawAlong = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

/** In view (spec §5.5): within 20 blocks of the kid's eye, ±50° of his yaw and ±35° of his pitch. */
export function inView(bot: Vec3, kid: { pose: Pose }): boolean {
	const k = kid.pose;
	const v = { x: bot.x - k.x, y: bot.y + CHEST - (k.y + EYE_HEIGHT), z: bot.z - k.z };
	const d = Math.hypot(v.x, v.y, v.z);
	if (d > G.VIEW_RANGE) return false;
	if (d < 1e-6) return true;
	if (Math.abs(wrap(yawAlong(v.x, v.z) - k.yaw)) > G.VIEW_YAW_DEG * DEG) return false;
	return Math.abs(Math.atan2(v.y, Math.hypot(v.x, v.z)) - k.pitch) <= G.VIEW_PITCH_DEG * DEG;
}

const centre = (c: Vec3): Vec3 => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });

/** The gesture table (spec §5.5, rev 3), first match wins; only changes caused by an appraisal count. */
export function gestureFor(changes: Change[], s: Readonly<State>): GestureCue | null {
	const app = changes.filter((c) => c.cause.kind === 'appraisal');
	if (app.length === 0) return null;
	const delta = (path: string): number => app.filter((c) => c.path === path && typeof c.new === 'number' && typeof c.old === 'number')
		.reduce((n, c) => n + (c.new as number) - (c.old as number), 0);
	// The burst, as the appraise expert writes it in the cause: `kind[:detail]#id` per event.
	const burst = [...new Set(app.map((c) => c.cause.why ?? ''))].join(' ').match(/\S+#\d+/g) ?? [];
	const keys = burst.map((b) => b.slice(0, b.lastIndexOf('#')));
	const events = burst.map((b) => s.events.find((e) => e.id === Number(b.slice(b.lastIndexOf('#') + 1)))).filter((e): e is WorldEvent => !!e);
	const has = (k: string): boolean => keys.includes(k);
	const relDeltas = (axis: string) => [...new Set(app.map((c) => new RegExp(`^relations\\.(.+)\\.axes\\.${axis}\\.value$`).exec(c.path)?.[1]).filter((p): p is string => !!p))]
		.map((p) => ({ player: p, d: delta(`relations.${p}.axes.${axis}.value`) }));

	if (delta('emotions.mood.value') >= G.MOOD_UP) {
		const done = events.find((e) => e.kind === 'outcome' && e.detail === 'done');
		const entry = done ? (s.memory.past.find((p) => p.outcome === 'done' && p.endedT === done.t) ?? s.memory.past[0]) : undefined;
		return { name: 'double-hop', firework: entry?.behaviour === 'build' && entry.outcome === 'done' };
	}
	if (delta('emotions.mood.value') <= G.MOOD_DOWN) return { name: 'slow-turn' };
	if (delta('emotions.confidence.value') <= G.CONFIDENCE_DOWN && !has('player-near') && !has('player-arrived')) {
		const cause = events.find((e) => e.cell) ?? events.find((e) => e.player);
		return { name: 'back-off', target: cause?.cell ? centre(cause.cell) : undefined, player: cause?.cell ? undefined : cause?.player };
	}
	const fond = relDeltas('affection').find((x) => x.d >= G.AFFECTION_UP);
	if (fond) return { name: 'turn-hop', player: fond.player };
	const hurt = relDeltas('grievance').find((x) => x.d <= G.GRIEVANCE_DOWN);
	if (hurt) return { name: 'turn-away', player: hurt.player, holdMs: G.TURN_AWAY_MS };
	if (delta('emotions.curiosity.value') >= G.CURIOSITY_UP || has('found')) {
		const thing = events.find((e) => e.kind === 'found' && e.cell) ?? events.find((e) => e.cell);
		if (thing?.cell) return { name: 'look-at', target: centre(thing.cell), holdMs: thing.block?.endsWith('_ore') ? G.ORE_LOOK_MS : G.LOOK_MS };
	}
	if (s.emotions.patience.value < G.PATIENCE_LOW && has('outcome:failed')) return { name: 'stomp-off' };
	for (const e of events) {
		if (e.kind === 'player-arrived' && e.player && (s.relations[e.player]?.axes.affection.value ?? 0) >= G.GREETING_AFFECTION) {
			return { name: 'greeting', player: e.player, holdMs: G.GREETING_HOLD_MS };
		}
	}
	return null;
}

/** One step of a gesture: run `dt` ms after the previous one finished; a returned promise (a walk) is waited for. */
interface Step { dt: number; run: () => void | Promise<unknown> }
interface Running { name: GestureName; steps: Step[]; i: number; nextAt: number; waiting: boolean; deadline: number }

export interface ExpressionDeps {
	store: Store; body: Body; clock: Clock; kids: () => KidInfo[];
	/** The runner's lastArrivalT (the style hop right after a walk arrives). */
	lastArrivalT?: () => number;
	/** The runner's busy flag: the hop never moves while an action (a walk) is in flight, since move() cancels it. */
	busy?: () => boolean;
}

export class Expression {
	private due: GestureCue | null = null;
	private greeting: { cue: GestureCue; until: number } | null = null;
	private running: Running | null = null;
	private lastGestureT = -Infinity;
	private hoppedFor = -Infinity;
	private landing: { at: number; pose: Pose } | null = null;

	constructor(private readonly d: ExpressionDeps) {}

	/** Store subscriber input. */
	onChanges(cs: Change[]): void {
		const cue = gestureFor(cs, this.d.store.state);
		if (!cue) return;
		if (cue.name === 'greeting') this.greeting = { cue, until: this.d.clock() + (cue.holdMs ?? G.GREETING_HOLD_MS) };
		else this.due = cue;
	}

	/** Every 100 ms: starts a due gesture (sets body.gesture), advances a running one, clears it when finished. */
	async tick(): Promise<void> {
		const now = this.d.clock();
		if (this.running) {
			this.due = null;                                      // skipped, not queued
			this.advance(now);
			return;
		}
		const pose = this.d.body.pose();
		const rateOk = now - this.lastGestureT >= G.EVERY_MS;
		if (this.due) {
			const cue = this.due;
			this.due = null;
			if (rateOk && this.d.kids().some((k) => inView(pose, k))) return this.start(cue, now);
		}
		if (this.greeting) {
			const g = this.greeting;
			const kid = this.d.kids().find((k) => k.name === g.cue.player);
			if (now > g.until || !kid) this.greeting = null;
			else if (rateOk && inView(pose, kid)) {
				this.greeting = null;
				return this.start(g.cue, now);
			}
		}
		this.stepHop(now);
	}

	// ── the style hop (not a gesture: no rate limit, no pause) ──

	private stepHop(now: number): void {
		const body = this.d.body;
		const busy = this.d.busy?.() ?? false;
		if (this.landing && now >= this.landing.at) {
			if (!busy) body.move(this.landing.pose);              // a walk in flight lands the bot itself: never cancel it
			this.landing = null;
		}
		const at = this.d.lastArrivalT?.() ?? -Infinity;
		const s = this.d.store.state;
		if (at === this.hoppedFor || now - at >= G.STEP_HOP_WINDOW_MS || busy || s.body.gesture || !styleOf(s).hopBetweenSteps) return;
		this.hoppedFor = at;
		const p = body.pose();
		body.move({ ...p, y: p.y + G.STEP_HOP_Y });
		this.landing = { at: now + G.HOP_MS, pose: p };
	}

	// ── running gestures ──

	private start(cue: GestureCue, now: number): void {
		const steps = this.program(cue);
		if (steps.length === 0) return;
		this.lastGestureT = now;
		this.landing = null;
		this.d.store.apply([{ path: ['body', 'gesture'], value: cue.name }], { kind: 'gesture', by: 'expression', why: cue.name });
		this.running = { name: cue.name, steps, i: 0, nextAt: now + steps[0].dt, waiting: false, deadline: now + G.MAX_MS };
		this.advance(now);
	}

	private advance(now: number): void {
		const r = this.running!;
		while (!r.waiting && r.i < r.steps.length && now >= r.nextAt && now < r.deadline) {
			const out = r.steps[r.i++].run();
			if (out instanceof Promise) {
				r.waiting = true;
				const resume = () => {
					r.waiting = false;
					r.nextAt = this.d.clock() + (r.steps[r.i]?.dt ?? 0);
				};
				out.then(resume, resume);
				return;
			}
			r.nextAt += r.steps[r.i]?.dt ?? 0;
		}
		if (now >= r.deadline || (!r.waiting && r.i >= r.steps.length)) {
			this.running = null;
			this.d.store.apply([{ path: ['body', 'gesture'], value: null }], { kind: 'gesture', by: 'expression', why: 'done' });
		}
	}

	/** The moves of a gesture, resolved against the pose and the kids at its start. */
	private program(cue: GestureCue): Step[] {
		const body = this.d.body;
		const p0 = body.pose();
		const kids = this.d.kids();
		const kidOf = (name?: string) => kids.find((k) => k.name === name);
		const yawTo = (t: { x: number; z: number }) => yawAlong(t.x - p0.x, t.z - p0.z);
		const move = (patch: Partial<Pose>): void => body.move({ ...body.pose(), ...patch });
		const hop = (dt: number): Step[] => [
			{ dt, run: () => move({ y: p0.y + G.HOP_Y }) },
			{ dt: G.HOP_MS, run: () => move({ y: p0.y }) },
		];
		/** A turn: 12 moves with a changing yaw. */
		const turn = (to: number, stepMs: number = G.TURN_STEP_MS, full = false): Step[] => {
			const diff = full ? 2 * Math.PI : wrap(to - p0.yaw);
			return Array.from({ length: G.TURN_STEPS }, (_, i) => ({ dt: i === 0 ? 0 : stepMs, run: () => move({ yaw: p0.yaw + (diff * (i + 1)) / G.TURN_STEPS }) }));
		};
		const pause = (ms: number): Step => ({ dt: ms, run: () => {} });
		const walk = (dt: number, to: { x: number; z: number }): Step => ({ dt, run: () => body.walkTo(to) });
		const away = (from: { x: number; z: number } | null, dist: number) => {
			let dx = p0.x - (from?.x ?? p0.x - Math.sin(p0.yaw)), dz = p0.z - (from?.z ?? p0.z - Math.cos(p0.yaw));
			const n = Math.hypot(dx, dz) || 1;
			dx /= n;
			dz /= n;
			return { x: p0.x + dx * dist, z: p0.z + dz * dist };
		};
		switch (cue.name) {
			case 'double-hop': {
				const fx: Step[] = cue.firework ? [{ dt: 0, run: () => body.fx({ kind: 'firework', x: p0.x, y: p0.y + 2, z: p0.z }) }] : [];
				return [...fx, ...hop(0), ...hop(G.HOP_MS)];
			}
			case 'slow-turn':
				return [...turn(0, G.SLOW_TURN_MS / G.TURN_STEPS, true), pause(G.SLOW_TURN_PAUSE_MS)];
			case 'back-off': {
				const from = cue.target ?? kidOf(cue.player)?.pose ?? null;
				return [walk(0, away(from, G.BACK_OFF))];
			}
			case 'turn-hop': {
				const k = kidOf(cue.player);
				return k ? [...turn(yawTo(k.pose)), ...hop(G.TURN_STEP_MS)] : [];
			}
			case 'turn-away': {
				const k = kidOf(cue.player);
				return k ? [...turn(yawTo(k.pose) + Math.PI), pause(cue.holdMs ?? G.TURN_AWAY_MS)] : [];
			}
			case 'look-at': {
				const t = cue.target;
				if (!t) return [];
				const hold = cue.holdMs ?? G.LOOK_MS;
				if (hold < G.ORE_LOOK_MS) return [{ dt: 0, run: () => body.lookAt(t.x, t.y, t.z) }, pause(hold)];
				// An uncovered ore: stand beside it, facing it.
				const d = Math.hypot(p0.x - t.x, p0.z - t.z) || 1;
				const spot = { x: t.x + ((p0.x - t.x) / d) * 1.5, z: t.z + ((p0.z - t.z) / d) * 1.5 };
				return [walk(0, spot), { dt: 0, run: () => body.lookAt(t.x, t.y, t.z) }, pause(hold)];
			}
			case 'stomp-off': {
				// Perpendicular to the direction of the nearest kid, so it doesn't read as leaving him (rev 3).
				const k = [...kids].sort((a, b) => Math.hypot(a.pose.x - p0.x, a.pose.z - p0.z) - Math.hypot(b.pose.x - p0.x, b.pose.z - p0.z))[0];
				let dx = k ? k.pose.x - p0.x : -Math.sin(p0.yaw), dz = k ? k.pose.z - p0.z : -Math.cos(p0.yaw);
				const n = Math.hypot(dx, dz) || 1;
				[dx, dz] = [-dz / n, dx / n];
				const to = { x: p0.x + dx * G.STOMP_OFF, z: p0.z + dz * G.STOMP_OFF };
				return [{ dt: 0, run: () => move({ yaw: yawAlong(dx, dz) }) }, walk(G.TURN_STEP_MS, to)];
			}
			case 'greeting': {
				const k = kidOf(cue.player);
				if (!k) return [];
				const spot = { x: k.pose.x - Math.sin(k.pose.yaw) * G.GREETING_IN_FRONT, z: k.pose.z - Math.cos(k.pose.yaw) * G.GREETING_IN_FRONT };
				return [...turn(yawTo(k.pose)), walk(G.TURN_STEP_MS, spot), ...hop(0)];
			}
		}
	}
}
