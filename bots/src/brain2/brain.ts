/**
 * `runBrain2` (spec §10 step 2, §8, §6): wires the store, the scheduler and its code experts, perception, the
 * behaviour runner, selection, expression and persistence into one 100 ms beat. Code engines only until part 2.
 */
import { mkdirSync } from 'node:fs';
import { worldSpawn } from 'minicraft-bot';
import { StopSignal } from '../body/stop-signal.js';
import type { Port } from '../port.js';
import { appraiseExpert } from './appraisal.js';
import { resetSeenBlocks } from './behaviours/explore.js';
import { topSolid } from './behaviours/site-search.js';
import type { Clock } from './clock.js';
import { LIMITS } from './data/limits.data.js';
import { bandsPatch, decayPatch } from './emotions.js';
import { every, type Engines, type Expert } from './experts/expert.js';
import { Expression } from './expression.js';
import { BrainLog, rotateLogs, type LogLine } from './log.js';
import { Ownership } from './ownership.js';
import { paramsBuild, paramsExplore, paramsMine, paramsPlayer, resetCompany } from './params.js';
import { createPerceiver } from './perception.js';
import { BrainSaver, loadBrainFile, loadedPatch } from './persist.js';
import { BehaviourRunner } from './runner.js';
import { Tripwire } from './safety.js';
import { Scheduler } from './scheduler.js';
import { SelectionController } from './selection.js';
import { Store, initialState, type Cause, type Change, type Patch } from './store.js';
import type { Build, Dig, Personality, State, Vec3 } from './types.js';

export interface Brain2Deps {
	port: Port; clock: Clock; wall: () => number; rng: () => number; seed: number;
	personality: Personality; statePaths: { brainFile: string; logDir: string }; meta: { worldUuid: string; bot: string; target: string; live: boolean };
	world: { seed: number; gen: number };     // for worldSpawn
	engines: () => Engines;                   // { laya: null, llm: null } until part 2
	noEdits: boolean; logWrite: (line: string) => void; status?: (line: string) => void;
	/** Experiment E2: select.social and select.situational ask `engines().jev` (their code rules are the fallbacks). */
	jev?: boolean;
	/** Tests: no timers; the test calls step(). Production: a 100 ms setTimeout chain calls step(). */
	manual?: boolean;
}
export interface Brain2Handle {
	/** One 100 ms beat: scheduler.tick(), runner.tick() (not awaited, its rejection logged as `runner-error`), expression.tick(), saver.tick(). */
	step(): Promise<void>;
	stop(): Promise<void>;
	store: Store; scheduler: Scheduler; runner: BehaviourRunner;
	/** The live cell ownership (tests: reconnect rebuilds it). */
	own: Ownership;
	/** The kid's stop signals (the TUI shows them). */
	stopSignal: StopSignal;
	/** The world spawn used by Build and Mine as their anchor of last resort (spec §6). */
	spawn: { x: number; y: number; z: number };
	/** Writes one `event` line to the brain log (the CLI's crash guards). */
	event(kind: string, data?: unknown): void;
	/** Writes the brain file now, synchronously (an uncaught exception, before the process exits). */
	flush(): void;
}

const BEAT_MS = 100;
const PERCEIVE_MS = 500;
const DECAY_MS = 500;
const STATUS_EVERY_MS = 30_000;
/** Today's companion tuning, which the legacy pose tracker under perception v2 still reads (bots.config.ts). */
const TUNING = { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 };

const PERSIST: Cause = { kind: 'persist', by: 'brain-file' };

/**
 * The state after `patch`'s emotion and relation values, for bandsPatch (the decay expert returns decay and bands
 * as one patch, computed against one state: nothing else can write in between).
 */
function withValues(s: Readonly<State>, patch: Patch): State {
	const emotions = { ...s.emotions };
	const relations = { ...s.relations };
	for (const op of patch) {
		const [head, a, b, c] = op.path;
		if (head === 'emotions') emotions[a as keyof State['emotions']] = { ...emotions[a as keyof State['emotions']], value: op.value as number };
		else if (head === 'relations' && b === 'axes') {
			const r = relations[a];
			relations[a] = { ...r, axes: { ...r.axes, [c]: { ...r.axes[c as keyof typeof r.axes], value: op.value as number } } };
		}
	}
	return { ...s, emotions, relations };
}

function boxOf(cells: Vec3[]): { min: Vec3; max: Vec3 } | null {
	if (cells.length === 0) return null;
	const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y), zs = cells.map((c) => c.z);
	return { min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) }, max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) } };
}

/** A new build or dig in one change: logged as a `plan` event (criterion 7's plan-time check reads it). */
function planEvents(c: Change): Array<{ kind: 'build' | 'mine'; data: Record<string, unknown> }> {
	if (c.path === 'builds' && Array.isArray(c.new)) {
		// A new build, or a replanned one (same id, new origin).
		const old = new Map(((c.old ?? []) as Build[]).map((b) => [b.id, JSON.stringify(b.origin)]));
		return (c.new as Build[]).filter((b) => old.get(b.id) !== JSON.stringify(b.origin)).map((b) => ({
			kind: 'build' as const,
			data: { id: b.id, template: b.template, variant: b.variant, site: b.origin, cells: b.cells.length, box: boxOf(b.cells.map((c) => c.cell)) },
		}));
	}
	if (c.path === 'digs' && Array.isArray(c.new)) {
		const old = new Set(((c.old ?? []) as Dig[]).map((d) => d.id));
		return (c.new as Dig[]).filter((d) => !old.has(d.id)).map((d) => ({
			kind: 'mine' as const,
			data: { id: d.id, block: d.block, pillar: { x: d.spiral.px, y: d.spiral.y0, z: d.spiral.pz }, target: d.target },
		}));
	}
	return [];
}

export function runBrain2(d: Brain2Deps): Brain2Handle {
	const { body, world } = d.port;
	const clock = d.clock;
	// Module state from a previous session in this process (tests; a restarted brain): a fresh session.
	resetSeenBlocks();
	resetCompany();

	// 7. Logs: rotate, then the meta line first.
	mkdirSync(d.statePaths.logDir, { recursive: true });
	rotateLogs(d.statePaths.logDir);
	const log = new BrainLog(d.logWrite);
	const event = (kind: string, data?: unknown) => log.write({ k: 'event', t: clock(), kind, data });
	log.write({ k: 'meta', v: 1, t: clock(), bot: d.meta.bot, world: d.meta.worldUuid, personality: d.personality.name, seed: d.seed, wallStart: d.wall() });

	// 1. Spawn: the world's spawn column, not the join pose.
	const pose = body.pose();
	const sp = worldSpawn(d.world.seed, d.world.gen);
	// groundY scans only 64 below nearY + 2, and the surface is often lower than 255 − 64: start at the top solid block.
	const top = topSolid(world, sp.x, sp.z);
	const spawn = { x: sp.x, y: (top >= 0 ? world.groundY(sp.x, sp.z, top + 1) : null) ?? pose.y, z: sp.z };

	// 2. The store. The initial state is logged whole, so replay starts from exactly it; every change after is logged.
	const initial = initialState(d.personality, pose);
	event('initial', { state: initial, spawn, target: d.meta.target, live: d.meta.live });
	const store = new Store(initial, clock);
	const unsubs: Array<() => void> = [];
	unsubs.push(store.subscribe((cs) => log.changes(cs)));
	const loaded = loadBrainFile(d.statePaths.brainFile, { worldUuid: d.meta.worldUuid, bot: d.meta.bot }, d.wall());
	if (loaded.file) {
		store.apply(loadedPatch(loaded.file, d.wall()), PERSIST);
		store.apply(bandsPatch(store.state), PERSIST);         // halving leaves the bands stale
	}
	event('brain-file', { note: loaded.note, path: d.statePaths.brainFile });

	// 3. The parts.
	const own = new Ownership(world, () => store.state.owned);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const stopStarted = new Map<string, number>();
	// Subscribed BEFORE the perceiver, so a stop started by an edit is known when perception reads that edit.
	unsubs.push(body.onEdit((e) => {
		const now = clock();
		const kid = stop.onEdit(e, body.journal(), now);
		if (kid) {
			stopStarted.set(kid, now);
			event('stop-signal', { kid, untilMs: LIMITS.STOP_SIGNAL_MS });
		}
	}));
	const perceiver = createPerceiver({ body, world, own, store, tuning: TUNING, clock, stopStartedAt: (kid) => stopStarted.get(kid) ?? null });
	const tripwire = new Tripwire();
	const runner = new BehaviourRunner({
		store, body, world, own, perceiver, tripwire, stop, clock, noEdits: () => d.noEdits, fit: async () => 'yes',
		log: (kind, data) => event(kind, data), rng: d.rng, spawn,
	});
	const selection = new SelectionController({
		store, clock, kidsNow: () => perceiver.kids(), stop, noEdits: () => d.noEdits, runner, log: (l: LogLine) => log.write(l),
		params: { player: paramsPlayer, explore: paramsExplore, mine: paramsMine, build: paramsBuild }, jev: d.jev,
	});
	const expression = new Expression({ store, body, clock, kids: () => perceiver.kids(), lastArrivalT: () => runner.lastArrivalT, busy: () => runner.busy });
	const saver = new BrainSaver(d.statePaths.brainFile, { worldUuid: d.meta.worldUuid, bot: d.meta.bot }, d.wall);
	const scheduler = new Scheduler({
		store, clock, engines: d.engines,
		// A code expert that wrote nothing is not worth a line (select.request alone would write 10 a second), and
		// perceive/decay would only repeat their change lines (half the log with a kid around).
		onCall: (l) => {
			const quiet = l.engine === 'code' && !l.fallback && (l.patch.length === 0 || l.expert === 'perceive' || l.expert === 'decay');
			if (!quiet) log.write({ k: 'call', t: clock(), ...l });
		},
	});

	// 4. Experts. perceive and decay compute in merge(), against the state they patch: the runner's un-awaited tick
	// may apply between run() and merge(), and a patch computed earlier would overwrite its events.
	const perceive: Expert<null, null> = {
		name: 'perceive', layer: 1, trigger: every(PERCEIVE_MS), engine: 'code', priority: 0,
		reads: () => null, materialKey: () => '', run: async () => null, fallback: () => null,
		merge: () => ({ patch: perceiver.tick(clock()), cause: { kind: 'perception', by: 'perceive' } }),
	};
	const pending = new Map<string, number>();
	const decay: Expert<null, null> = {
		name: 'decay', layer: 1, trigger: every(DECAY_MS), engine: 'code', priority: 0,
		reads: () => null, materialKey: () => '', run: async () => null, fallback: () => null,
		merge: (_p, s) => {
			const p = decayPatch(s, DECAY_MS, pending, clock());
			return { patch: p.length ? [...p, ...bandsPatch(withValues(s, p))] : [], cause: { kind: 'decay', by: 'decay' } };
		},
	};
	for (const e of [perceive, decay, appraiseExpert, selection.request, selection.social, selection.situational, selection.merge] as Expert[]) scheduler.register(e);

	// 5. Subscriptions.
	unsubs.push(store.subscribe((cs) => expression.onChanges(cs)));
	unsubs.push(store.subscribe((cs) => {
		for (const c of cs) {
			for (const p of planEvents(c)) event('plan', { behaviour: p.kind, ...p.data });
			if (c.path === 'body.editsHalted' && c.new) {
				event('EDITS-HALTED', { reason: c.new });
				d.status?.(`EDITS HALTED: ${String(c.new)}`);
			}
		}
	}));
	unsubs.push(body.onReconnect(() => {
		own.reset();
		event('reconnect', {});
	}));

	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastStatus = clock();

	const status = (): void => {
		const s = store.state;
		const b = s.behaviour;
		const kids = perceiver.kids().map((k) => k.name).join(', ') || '-';
		d.status?.(`${b ? `${b.kind}${b.params.kid ? ` ${String(b.params.kid)}` : ''}` : 'idle'}; mood ${s.emotions.mood.band}, stimulation ${s.emotions.stimulation.band}; kids ${kids}; inventory ${Object.values(s.inventory).reduce((n, v) => n + v, 0)}${s.body.editsHalted ? `; EDITS HALTED (${s.body.editsHalted})` : ''}`);
	};

	const step = async (): Promise<void> => {
		if (stopped) return;
		await scheduler.tick();
		const drained = own.drainPending();                     // lazy verification's drops, every beat
		if (drained.length) store.apply(drained, { kind: 'perception', by: 'ownership' });
		runner.tick().catch((err: unknown) => event('runner-error', { error: err instanceof Error ? err.message : String(err) }));
		await expression.tick();                                // after the runner: a hop follows an arrival
		saver.tick(store.state);
		const now = clock();
		if (now - lastStatus >= STATUS_EVERY_MS) {
			lastStatus = now;
			status();
		}
	};

	const loop = async (): Promise<void> => {
		if (stopped) return;
		try {
			await step();
		} catch (err) {
			event('step-error', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
		}
		if (!stopped) timer = setTimeout(() => void loop(), BEAT_MS);
	};
	if (!d.manual) timer = setTimeout(() => void loop(), BEAT_MS);

	return {
		step, store, scheduler, runner, own, stopSignal: stop, spawn, event,
		flush: () => saver.flush(store.state),
		async stop() {
			if (stopped) return;
			stopped = true;
			if (timer) clearTimeout(timer);
			try {
				runner.end('interrupted', 'shutdown');
			} finally {
				saver.flush(store.state);
				event('stop', {});
				for (const u of unsubs) u();
				perceiver.close();
			}
		},
	};
}
