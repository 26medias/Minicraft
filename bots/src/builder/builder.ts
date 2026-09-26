/**
 * The builder bot: only builds, never mines, unlimited blocks. It loops: pick a project (the model chooses among the
 * templates, else random-weighted) → find a site (brain2's SiteSearch, anchored on the nearest kid or world spawn) →
 * build it one block at a time (the model picks among ≤ 3 supported cells, else lowest-then-nearest) → a firework →
 * again. Every placement goes through brain2's judgeSafety (kid cells and their 1-block buffer, kid body buffer, stop
 * signal, --no-edits, only into air) and a Tripwire; the builds and the cells it owns persist in a small JSON file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blockId } from 'minicraft-bot';
import { inBodyBox } from '../body/guard.js';
import { StopSignal } from '../body/stop-signal.js';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { Ownership } from '../brain2/ownership.js';
import { judgeSafety, Tripwire, type KidPos, type Verdict } from '../brain2/safety.js';
import { LIMITS } from '../brain2/data/limits.data.js';
import { SiteSearch, groundTop } from '../brain2/behaviours/site-search.js';
import { TEMPLATES, type Role, type Template } from '../brain2/behaviours/templates.data.js';
import type { ChoiceEngine } from './engines.js';
import { candidateMoves, cellKey, describeMove, heuristicPick, planCells, type PlanCell } from './moves.js';
import { palettesFor, type Palette } from './palettes.data.js';
import { flyLeg, navigate, StuckWatchdog } from '../nav/navigate.js';
import type { SharedCells } from '../shared/bot-cells.js';
import { capCount, capReached, countsTowardCap, DEFAULT_MAX_BUILDS } from '../shared/cap.js';
import { claimLot, planAvoidBoxes, updateLot, type PlanLot } from '../foreman/plan-file.js';
import { endLot, fitsLot, lotSite, rejectStatus, renewClaim } from '../foreman/join.js';
import { showtimeOf } from '../nav/showtime.js';
import { idlePaused, PresenceGate, type WhenMode } from '../shared/when.js';

export interface BuilderBuild {
	id: string; template: string; variant: 'small' | 'medium'; palette: string; origin: Vec3; w: number; d: number; h: number;
	cells: Array<{ cell: Vec3; block: string; role: Role; layer: number }>; placed: string[]; skipped: string[];
	status: 'building' | 'done' | 'abandoned'; t: number; why?: string;
	/** --join-plan: the foreman's lot this build stands on. */
	lot?: string;
}
export interface BuilderFile { v: 1; builds: BuilderBuild[]; owned: Record<string, number> }

export function builderStatePath(stateRoot: string, target: string, world: string, name: string): string {
	return join(stateRoot, 'builder', target, world, `${name}.json`);
}

export function loadBuilderFile(path: string): BuilderFile {
	try {
		const f = JSON.parse(readFileSync(path, 'utf8')) as BuilderFile;
		if (f && f.v === 1 && Array.isArray(f.builds) && f.owned) return f;
	} catch {
		// missing or unreadable: a fresh file
	}
	return { v: 1, builds: [], owned: {} };
}

/** Atomic: a temp file beside it, then rename. */
export function saveBuilderFile(path: string, f: BuilderFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(f));
	renameSync(tmp, path);
}

/** The safety verdict for one free placement (brain2's judgeSafety with allowFree), plus the bot's own body. */
export function checkPlace(cell: Vec3, block: string, c: {
	world: WorldView; own: Ownership; kids: KidPos[]; stop: StopSignal; now: number; lastEditT: number | null; noEdits: boolean; halted: string | null; self?: Vec3;
}): Verdict {
	const v = judgeSafety({ kind: 'place', cell, block, free: true }, {
		world: c.world, own: c.own, kids: c.kids, stop: c.stop, now: c.now, lastEditT: c.lastEditT, noEdits: c.noEdits,
		inventory: {}, halted: c.halted, helpBuild: false, planOwns: () => true, allowFree: true,
	});
	if (!v.ok) return v;
	if (c.self && inBodyBox(cell, [c.self])) return { ok: false, tier: 'safety', reason: 'own body', planVeto: false };
	return v;
}

const NICE: Record<string, string> = {
	house: 'a little house with a door and windows', tower: 'a tall lookout tower with a door', wall: 'a garden wall',
	creeper: 'a creeper statue', person: 'a statue of a person', heart: 'a big heart statue',
};
const WEIGHT: Record<string, number> = { house: 3, tower: 2, wall: 1, creeper: 2, person: 1, heart: 2 };
const REACH = 4.5;
/** Never place a block when the eye is farther than this from the cell centre. */
export const PLACE_MAX = 5;
const MAX_REACH_FAILS = 5;

export const eyeDist = (p: Vec3, cell: Vec3) => Math.hypot(cell.x + 0.5 - p.x, cell.y + 0.5 - (p.y + 1.6), cell.z + 0.5 - p.z);

const inFootprint = (b: { origin: Vec3; w: number; d: number }, p: { x: number; z: number }, m = 0) =>
	p.x >= b.origin.x - m && p.x < b.origin.x + b.w + m && p.z >= b.origin.z - m && p.z < b.origin.z + b.d + m;

/**
 * Gets within reach of `cell` from a stand spot just outside the footprint (the two sides nearest the cell), through
 * the shared navigator (nav/navigate.ts: walk, else brain2's flight to the column, else fly high) and the bot's stuck
 * watchdog. A bot already hovering, or a stand spot in the air (a tall build's upper layers), flies straight there
 * first; after landing it rises to the cell's height. Returns true only when the eye ends within PLACE_MAX of the cell
 * centre. Movement is code: no model is asked.
 */
export async function approach(
	body: Body, world: WorldView, b: { origin: Vec3; w: number; d: number }, cell: Vec3, log: (e: Record<string, unknown>) => void = () => undefined,
): Promise<boolean> {
	const wd = StuckWatchdog.for(body, world);
	const p = body.pose();
	const c = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
	if (!inFootprint(b, p, 0.4) && eyeDist(p, cell) <= REACH) {
		wd.reached();
		return true;
	}
	const sides = [
		{ x: b.origin.x - 1.2, z: c.z }, { x: b.origin.x + b.w + 1.2, z: c.z },
		{ x: c.x, z: b.origin.z - 1.2 }, { x: c.x, z: b.origin.z + b.d + 1.2 },
	].sort((u, v) => Math.hypot(u.x - c.x, u.z - c.z) - Math.hypot(v.x - c.x, v.z - c.z));
	const good = () => eyeDist(body.pose(), cell) <= PLACE_MAX;
	const done = () => {
		wd.reached();
		return true;
	};
	for (const s of sides.slice(0, 2)) {
		const ground = groundTop(world, Math.floor(s.x), Math.floor(s.z)) + 1;
		const y = Math.max(cell.y, ground);
		const q = body.pose();
		const reach = world.groundY(q.x, q.z, q.y);
		const hovering = reach === null || q.y - reach > 0.25;
		if (hovering || y > ground) {
			try {
				if ((await flyLeg(body, { x: s.x, y, z: s.z })) === 'arrived' && good()) return done();
			} catch (err) {
				log({ k: 'fly-blocked', to: s, err: err instanceof Error ? err.message : String(err) });
			}
		}
		const nav = await navigate(body, world, { x: s.x, y: ground, z: s.z }, { log, watchdog: wd });
		if (!nav.ok) {
			log({ k: 'nav-failed', to: s, why: nav.reason });
			if (nav.reason.startsWith('stuck')) return false; // the watchdog's last resort: this approach is dropped
			continue;
		}
		if (body.pose().y < y - 0.01) {
			try {
				await flyLeg(body, { x: body.pose().x, y, z: body.pose().z });
			} catch (err) {
				log({ k: 'fly-blocked', to: { ...s, y }, err: err instanceof Error ? err.message : String(err) });
			}
		}
		if (good()) return done();
	}
	return good() && !inFootprint(b, body.pose(), 0.4) ? done() : false;
}
const KID_INSIDE_MAX_MS = 60_000;

export interface BuilderOpts {
	/** `--when` (default 'always'): with 'players', paused while no non-bot player is online (shared/when.ts). */
	when?: WhenMode;
	name: string; body: Body; world: WorldView; spawn: Vec3;
	primary: ChoiceEngine | null; secondary?: ChoiceEngine | null;
	noEdits: boolean; statePath: string; log: (o: Record<string, unknown>) => void; status?: (line: string) => void;
	rng: () => number; clock?: () => number; paceMs?: number; statusEveryMs?: number;
	/** The rest after each finished build (default 30 s; the CLI's --rest-sec). It idles visibly near the build meanwhile. */
	restMs?: number;
	/** Block names the catalog knows (the SDK's blockNames()); palettes with an unknown name are dropped. */
	known: ReadonlySet<string>;
	/** The shared bot-cell registry: placed cells are appended; other bots' cells count as bot cells. */
	shared?: SharedCells | null;
	/** Stop building after this many builds (counted from the persisted records, so across restarts; default 12). */
	maxBuilds?: number;
	/** The foreman's shared plan (experiment E7): its area is avoided by the own site search. */
	planPath?: string;
	/** --join-plan: claim the plan's next open lot first; the own site search only when none is left. */
	joinPlan?: boolean;
}
export interface BuilderStats { placed: number; refused: number; failed: number; buildsDone: number; buildsAbandoned: number; asks: number; fallbacks: number; current: string }
export interface BuilderHandle { stop(): Promise<void>; stats: BuilderStats; file: BuilderFile; done: Promise<void> }

export function runBuilder(o: BuilderOpts): BuilderHandle {
	const clock = o.clock ?? (() => Date.now());
	// The stuck watchdog every approach on this body shares (nav/navigate.ts): its `unstick` lines go to this bot's log.
	StuckWatchdog.for(o.body, o.world).log = (e) => o.log({ ...e, t: clock() });
	const gate = new PresenceGate({ mode: o.when ?? 'always', players: () => o.body.players(), clock, log: (e) => o.log({ ...e, t: clock() }) });
	const paused = () => gate.paused();
	const pace = o.paceMs ?? 800;
	const file = loadBuilderFile(o.statePath);
	const own = new Ownership(o.world, () => file.owned, o.shared ? () => o.shared!.cells() : undefined);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const trip = new Tripwire();
	const stats: BuilderStats = { placed: 0, refused: 0, failed: 0, buildsDone: 0, buildsAbandoned: 0, asks: 0, fallbacks: 0, current: 'starting' };
	let stopped = false;
	const wakers = new Set<() => void>();
	const sleep = (ms: number) => new Promise<void>((res) => {
		if (stopped) return res();
		const done = () => {
			clearTimeout(t);
			wakers.delete(done);
			res();
		};
		const t = setTimeout(done, ms);
		wakers.add(done);
	});
	const save = () => saveBuilderFile(o.statePath, file);
	const maxBuilds = o.maxBuilds ?? DEFAULT_MAX_BUILDS;
	const palettes = (t: string): Palette[] => palettesFor(t).filter((p) => Object.values(p.blocks).every((b) => o.known.has(b)));

	const unsubs = [
		o.body.onEdit((e) => {
			const who = stop.onEdit(e, o.body.journal(), clock());
			if (who) o.log({ k: 'stop-signal', kid: who, t: clock() });
			for (const op of own.onEdit(e, o.body.you)) if (op.value === undefined) delete file.owned[op.path[1] as string];
		}),
		o.body.onReconnect(() => own.reset()),
	];

	const kidsNow = (): KidPos[] => o.body.players().filter((p) => !p.bot && p.hasPos).map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z }));

	const ask = makeAsk({ primary: o.primary, secondary: o.secondary, clock, log: o.log, stats, paused });

	function nearestKid(): KidPos | null {
		const p = o.body.pose();
		let best: KidPos | null = null;
		for (const k of kidsNow()) if (!best || Math.hypot(k.x - p.x, k.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z)) best = k;
		return best;
	}

	function ownBoxes() {
		return file.builds.map((b) => ({ min: b.origin, max: { x: b.origin.x + b.w - 1, y: b.origin.y + b.h - 1, z: b.origin.z + b.d - 1 } }));
	}
	function avoidBoxes() {
		return [...ownBoxes(), ...planAvoidBoxes(o.planPath)];
	}

	const opt = (t: Template) => `${t.name}-${t.variant}`;
	const usable = (t: Template) => palettes(t.name).length > 0;

	/** The template (the model's pick, else random-weighted) and palette among `fit`, not one of the last two kinds built. */
	async function chooseTemplate(fit: (t: Template) => boolean): Promise<{ t: Template; palette: Palette; picked: string | null } | null> {
		const recent = file.builds.filter((b) => b.status === 'done').slice(-2).map((b) => b.template);
		let pool = TEMPLATES.filter((t) => !recent.includes(t.name) && usable(t) && fit(t));
		if (pool.length === 0) pool = TEMPLATES.filter((t) => usable(t) && fit(t));
		if (pool.length === 0) return null;
		const options = Object.fromEntries(pool.map((t) => [opt(t), `${t.variant === 'small' ? 'a small' : 'a bigger'} ${NICE[t.name].replace(/^an? /, '')} (${t.cells.length} blocks)`]));
		const kid = nearestKid();
		const p = o.body.pose();
		const last = file.builds.filter((b) => b.status === 'done').at(-1);
		const state = [
			`I am ${o.name}, a builder robot in a block world where a 7-year-old plays.`,
			kid ? `${kid.name} is ${Math.round(Math.hypot(kid.x - p.x, kid.z - p.z))} blocks away.` : 'No kid is online right now.',
			last ? `Last I built a ${last.variant} ${last.template}.` : 'I have not built anything yet.',
			`I have built ${file.builds.filter((b) => b.status === 'done').length} things here.`,
		].join(' ');
		const picked = await ask('project', state, 'Pick the build a 7-year-old would be most delighted to find next to him in the morning.', options);
		let t = pool.find((x) => opt(x) === picked);
		if (!t) {
			const total = pool.reduce((s, x) => s + (WEIGHT[x.name] ?? 1), 0);
			let r = o.rng() * total;
			t = pool.find((x) => (r -= WEIGHT[x.name] ?? 1) < 0) ?? pool[pool.length - 1];
		}
		const pals = palettes(t.name);
		return { t, palette: pals[Math.floor(o.rng() * pals.length)], picked };
	}

	/** --join-plan: a build on the foreman's next open lot; null (no plan, no lot left) or 'rejected' (the lot failed the rules now). */
	async function pickLot(): Promise<BuilderBuild | null | 'rejected' | 'wait'> {
		if (!o.planPath) return null;
		let lot: PlanLot | null = null;
		try {
			lot = claimLot(o.planPath, o.name, clock(), (l) => TEMPLATES.some((t) => usable(t) && fitsLot(l, t)));
		} catch (err) {
			o.log({ k: 'lot-error', t: clock(), err: err instanceof Error ? err.message : String(err) });
		}
		if (!lot) return null;
		const l = lot;
		const c = await chooseTemplate((t) => fitsLot(l, t));
		const site = c ? lotSite(l, c.t, { world: o.world, own, spawn: o.spawn, kids: kidsNow(), avoid: ownBoxes() }) : 'builds';
		if (!c || typeof site === 'string') {
			const status = c && typeof site === 'string' ? rejectStatus(site) : 'open';
			updateLot(o.planPath, l.id, o.name, clock(), { status, why: typeof site === 'string' ? site : 'nothing fits' });
			o.log({ k: 'lot-rejected', t: clock(), lot: l.id, why: typeof site === 'string' ? site : 'nothing fits', status });
			return c && status === 'open' ? 'wait' : 'rejected';
		}
		const b: BuilderBuild = {
			id: `${clock().toString(36)}`, template: c.t.name, variant: c.t.variant, palette: c.palette.name, origin: site.origin, w: c.t.w, d: c.t.d, h: c.t.h,
			cells: planCells(c.t, site.origin, c.palette), placed: [], skipped: [], status: 'building', t: clock(), lot: l.id,
		};
		file.builds.push(b);
		save();
		updateLot(o.planPath, l.id, o.name, clock(), { design: opt(c.t), buildId: b.id });
		o.log({ k: 'project', t: clock(), id: b.id, template: opt(c.t), palette: c.palette.name, origin: site.origin, lot: l.id, by: c.picked === opt(c.t) ? 'model' : 'fallback' });
		return b;
	}

	async function pickProject(): Promise<BuilderBuild | null> {
		// --join-plan: the plan's lots first (a dropped lot: the next one; a kid on it: wait); the own search when none is left.
		for (let i = 0; o.joinPlan && i < 12 && !stopped; i++) {
			const r = await pickLot();
			if (r === 'rejected') continue;
			if (r === 'wait') return null; // a kid is on the lot: try again after the pause
			if (r) return r;
			break;
		}
		if (stopped) return null;
		const c = await chooseTemplate(() => true);
		if (!c) return null;
		const { t, palette, picked } = c;
		const kid = nearestKid();
		const anchor = kid ? { x: kid.x, y: kid.y, z: kid.z } : o.spawn;
		stats.current = `searching a site for ${opt(t)}`;
		const search = new SiteSearch({ w: t.w, d: t.d, h: t.h, anchor, avoid: avoidBoxes(), showtime: showtimeOf(o.body) }, { world: o.world, own, spawn: o.spawn, kids: kidsNow() });
		for (;;) {
			if (stopped) return null;
			const r = search.step();
			if (r === 'none') {
				o.log({ k: 'search-failed', t: clock(), template: opt(t), anchor, rejections: search.rejections });
				return null;
			}
			if (r) {
				const cells = planCells(t, r.origin, palette);
				const b: BuilderBuild = {
					id: `${clock().toString(36)}`, template: t.name, variant: t.variant, palette: palette.name, origin: r.origin, w: t.w, d: t.d, h: t.h,
					cells, placed: [], skipped: [], status: 'building', t: clock(),
				};
				file.builds.push(b);
				save();
				o.log({ k: 'project', t: clock(), id: b.id, template: opt(t), palette: palette.name, origin: r.origin, anchor, by: picked === opt(t) ? 'model' : 'fallback', radius: search.radius });
				return b;
			}
			await new Promise((res) => setImmediate(res));
		}
	}

	const edits = { lastEditT: null as number | null, lastRefusal: '' };
	const construct = async (b: BuilderBuild) => {
		// A lot build renews its claim while it runs (and at once: a restart resumes it), then ends the lot.
		const plan = b.lot && o.planPath ? o.planPath : null;
		if (plan) {
			try {
				updateLot(plan, b.lot!, o.name, clock(), {});
			} catch {
				// the renewal timer retries
			}
		}
		const stopRenew = plan ? renewClaim(plan, b.lot!, o.name, clock, o.log) : null;
		try {
			await constructBuild(b, {
				body: o.body, world: o.world, own, stop, trip, kidsNow, ask, log: o.log, save, sleep, clock, pace, noEdits: o.noEdits,
				stopped: () => stopped || paused(), stats, edits,
				onPlaced: (cell, id) => {
					file.owned[cellKey(cell)] = id;
					own.ownWrite(cell.x, cell.y, cell.z, id);
					o.shared?.append(cell, id);
				},
			});
		} finally {
			stopRenew?.();
		}
		if (plan) endLot(plan, b.lot!, o.name, clock(), b.status, b.why, o.log);
	};

	/** Rests for `ms` while visibly alive: every few seconds a short hop beside the build or a look at it. */
	async function restNear(b: BuilderBuild, ms: number): Promise<void> {
		const until = clock() + ms;
		const cx = b.origin.x + b.w / 2, cz = b.origin.z + b.d / 2;
		while (!stopped && !paused() && clock() < until) {
			const left = until - clock();
			const r = o.rng();
			if (r < 0.5) {
				// Look at a random spot on the build.
				o.body.lookAt(b.origin.x + o.rng() * b.w, b.origin.y + o.rng() * b.h, b.origin.z + o.rng() * b.d);
			} else {
				// A short hop to a spot just outside the footprint (never inside it).
				const a = o.rng() * Math.PI * 2;
				const rad = Math.max(b.w, b.d) / 2 + 1.5 + o.rng() * 2;
				const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
				const y = groundTop(o.world, Math.floor(x), Math.floor(z)) + 1;
				if (y > 0) await Promise.race([o.body.flyTo({ x, y, z }).catch(() => undefined), sleep(Math.min(left, 4000))]);
				if (stopped) return;
				o.body.lookAt(cx, b.origin.y + b.h / 2, cz);
			}
			await sleep(Math.min(until - clock(), 2500 + o.rng() * 2500));
		}
	}


	let capLogged = false;
	/** Past the build cap: no more edits, only a wander and a look around near one of its builds. */
	async function capped(): Promise<void> {
		const n = capCount(file.builds);
		if (!capLogged) o.log({ k: 'cap-reached', t: clock(), builds: n, max: maxBuilds });
		capLogged = true;
		stats.current = `build cap reached (${n}/${maxBuilds}); wandering near my builds`;
		const mine = file.builds.filter(countsTowardCap);
		const b = mine[Math.floor(o.rng() * mine.length) % Math.max(1, mine.length)];
		if (b) await restNear(b, 60_000);
		else await sleep(10_000);
	}

	async function loop(): Promise<void> {
		let resume = file.builds.find((b) => b.status === 'building') ?? null;
		let haltedLogged = false;
		while (!stopped) {
			if (trip.halted) {
				if (!haltedLogged) o.log({ k: 'EDITS-HALTED', t: clock(), why: trip.halted });
				haltedLogged = true;
				stats.current = `EDITS HALTED (${trip.halted})`;
				await sleep(5000);
				continue;
			}
			if (paused()) {
				stats.current = 'paused: no player online';
				await idlePaused(o.body, sleep, o.rng);
				continue;
			}
			let b = resume;
			resume = null;
			try {
				if (!b && capReached(file.builds, maxBuilds)) {
					await capped();
					continue;
				}
				b ??= await pickProject();
				if (!b) {
					stats.current = 'no site found; waiting';
					await sleep(10_000);
					continue;
				}
				await construct(b);
				if (b.status === 'building') {
					resume = b; // paused, halted or stopped mid-build: resumed later
					continue;
				}
				if (b.status === 'done') stats.buildsDone++;
				else if (b.status === 'abandoned') stats.buildsAbandoned++;
				if (b.status === 'done' && !stopped) {
					stats.current = `resting after the ${b.variant} ${b.template}`;
					await restNear(b, o.restMs ?? 30_000);
				}
			} catch (err) {
				o.log({ k: 'error', t: clock(), err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
				if (b && b.status === 'building') {
					b.status = 'abandoned';
					b.why = 'error';
					save();
					if (b.lot && o.planPath) endLot(o.planPath, b.lot, o.name, clock(), b.status, b.why, o.log);
				}
				await sleep(5000);
			}
		}
	}

	const statusTimer = o.status
		? setInterval(() => {
			const paused = stop.active(clock()).map((s) => ` | paused near ${s.name} ${Math.ceil(s.remainingMs / 60_000)}m`).join('');
			o.status!(`${o.name}: ${stats.current} | builds ${stats.buildsDone} done, ${stats.buildsAbandoned} abandoned | placed ${stats.placed} | engine ${o.primary?.name ?? 'none'} (fallbacks ${stats.fallbacks}/${stats.asks})${paused}${trip.halted ? ' | EDITS HALTED' : ''}`);
		}, o.statusEveryMs ?? 30_000)
		: null;

	o.log({ k: 'start', t: clock(), name: o.name, primary: o.primary?.name ?? null, secondary: o.secondary?.name ?? null, noEdits: o.noEdits, builds: file.builds.length });
	const done = loop();
	return {
		stats,
		file,
		done,
		async stop() {
			stopped = true;
			for (const w of [...wakers]) w();
			if (statusTimer) clearInterval(statusTimer);
			await done;
			for (const u of unsubs) u();
			if (existsSync(dirname(o.statePath)) || file.builds.length) save();
			o.log({ k: 'stop', t: clock(), stats });
		},
	};
}

type Ask = (what: string, state: string, instructions: string, options: Record<string, string>) => Promise<string | null>;

/**
 * The choice asker shared by the builder and the village bot: asks the primary (and, with --compare, the secondary in
 * parallel), logs a `decision` line, returns the primary's choice or null (= fall back). A failing engine is skipped
 * for 60 s after 3 failures in a row.
 */
export function makeAsk(o: {
	primary: ChoiceEngine | null; secondary?: ChoiceEngine | null; clock: () => number; log: (e: Record<string, unknown>) => void;
	stats: { asks: number; fallbacks: number };
	/** --when players: no model call while paused (null: the caller falls back). */
	paused?: () => boolean;
}): Ask {
	const { clock, stats } = o;
	const health = new Map<string, { fails: number; until: number }>();
	const usable = (e: ChoiceEngine | null | undefined): e is ChoiceEngine => !!e && (health.get(e.name)?.until ?? 0) <= clock();
	async function askOne(e: ChoiceEngine, state: string, instructions: string, options: Record<string, string>) {
		const t0 = clock();
		try {
			const a = await e.choose(state, instructions, options);
			health.set(e.name, { fails: 0, until: 0 });
			return { engine: e.name, choice: a.choice, probs: a.probs, ms: clock() - t0 };
		} catch (err) {
			const h = health.get(e.name) ?? { fails: 0, until: 0 };
			h.fails++;
			if (h.fails >= 3) {
				h.until = clock() + 60_000;
				h.fails = 0;
			}
			health.set(e.name, h);
			return { engine: e.name, error: err instanceof Error ? err.message : String(err), ms: clock() - t0 };
		}
	}
	return async (what, state, instructions, options) => {
		if (o.paused?.()) return null;
		stats.asks++;
		const p = usable(o.primary) ? askOne(o.primary, state, instructions, options) : null;
		const s = usable(o.secondary) ? askOne(o.secondary, state, instructions, options) : null;
		const [pa, sa] = await Promise.all([p, s]);
		const choice = pa && 'choice' in pa ? pa.choice ?? null : null;
		if (choice === null) stats.fallbacks++;
		o.log({
			k: 'decision', what, t: clock(), state, instructions, options, primary: pa ?? { engine: o.primary?.name ?? null, skipped: true },
			...(o.secondary ? { secondary: sa ?? { engine: o.secondary.name, skipped: true }, agree: !!(pa && sa && 'choice' in pa && 'choice' in sa && pa.choice === sa.choice) } : {}),
			fallback: choice === null,
		});
		return choice;
	};
}

export interface ConstructCtx {
	body: Body; world: WorldView; own: Ownership; stop: StopSignal; trip: Tripwire; kidsNow: () => KidPos[]; ask: Ask;
	log: (e: Record<string, unknown>) => void; save: () => void; sleep: (ms: number) => Promise<void>; clock: () => number;
	pace: number; noEdits: boolean; stopped: () => boolean;
	stats: { placed: number; refused: number; failed: number; current: string };
	/** Mutable across builds: the last edit time (for the safety verdict) and the last refusal logged. */
	edits: { lastEditT: number | null; lastRefusal: string };
	/** A cell was placed (ok): record ownership (and the shared registry). */
	onPlaced: (cell: Vec3, id: number) => void;
}

/**
 * The builder's move loop for one build: the model picks among ≤ 3 supported cells (else lowest-then-nearest), each
 * placement judged by checkPlace, placed only after an approach within PLACE_MAX. Sets b.status to done/abandoned when
 * it ends (a stop leaves it 'building' to resume).
 */
export async function constructBuild(b: BuilderBuild, c: ConstructCtx): Promise<void> {
	const o = c;
	const clock = c.clock;
	const plan: PlanCell[] = b.cells;
	const done = new Set<string>([...b.placed, ...b.skipped]);
	c.trip.resetPlan(Math.max(1, plan.length - b.placed.length));
	let kidInsideSince: number | null = null;
	let reachFails = 0;
	const tag = `${b.variant} ${b.template}`;
	const end = (status: 'done' | 'abandoned', why: string) => {
		b.status = status;
		b.why = why;
		c.save();
		o.log({ k: 'build-end', t: clock(), id: b.id, status, why, placed: b.placed.length, cells: plan.length });
	};
	while (!c.stopped()) {
		c.stats.current = `building ${tag} ${b.placed.length}/${plan.length} at ${b.origin.x},${b.origin.z}`;
		if (c.trip.halted) return;
		const kids = c.kidsNow();
		if (c.own.kidCellWithin(b.origin.x + b.w / 2, b.origin.z + b.d / 2, Math.max(b.w, b.d) / 2 + 1)) return end('abandoned', 'kid cells at the site');
		if (kids.some((k) => inFootprint(b, k, 1))) {
			kidInsideSince ??= clock();
			if (clock() - kidInsideSince > KID_INSIDE_MAX_MS) return end('abandoned', 'a kid stayed inside the site');
			await c.sleep(2000);
			continue;
		}
		kidInsideSince = null;
		const p = o.body.pose();
		const eye = { x: p.x, y: p.y + 1.6, z: p.z };
		const moves = candidateMoves(plan, done, o.world, eye);
		if (moves.length === 0) {
			if (b.placed.length >= plan.length / 2) {
				const top = Math.max(...plan.map((q) => q.cell.y)) + 2;
				o.body.fx({ kind: 'firework', x: b.origin.x + b.w / 2, y: top, z: b.origin.z + b.d / 2 });
				return end('done', 'finished');
			}
			return end('abandoned', 'nothing left to place');
		}
		let pick = heuristicPick(moves)!;
		if (moves.length > 1) {
			const options = Object.fromEntries(moves.map((m, i) => [`block-${i + 1}`, describeMove(m, eye)]));
			const state = `I am building a ${tag} with ${b.placed.length} of ${plan.length} blocks placed. I build from the bottom up.`;
			const a = await c.ask('move', state, 'Which block should the builder place next so the build grows neatly and looks good?', options);
			const i = a ? Number(a.slice('block-'.length)) - 1 : -1;
			if (moves[i]) pick = moves[i];
		}
		const k = cellKey(pick.cell);
		const verdictNow = () => checkPlace(pick.cell, pick.block, {
			world: o.world, own: c.own, kids: c.kidsNow(), stop: c.stop, now: clock(), lastEditT: c.edits.lastEditT, noEdits: c.noEdits, halted: c.trip.halted, self: o.body.pose(),
		});
		let v = verdictNow();
		if (v.ok) {
			const there = await approach(o.body, o.world, b, pick.cell, (e) => o.log({ ...e, t: clock() }));
			if (c.stopped()) return;
			// Never place from afar: only after a successful approach, with the eye within PLACE_MAX.
			if (!there || eyeDist(o.body.pose(), pick.cell) > PLACE_MAX) {
				c.stats.failed++;
				reachFails++;
				o.log({ k: 'unreachable', t: clock(), cell: pick.cell, fails: reachFails, eyeDist: Math.round(eyeDist(o.body.pose(), pick.cell) * 10) / 10 });
				if (reachFails >= MAX_REACH_FAILS) return end('abandoned', 'cannot reach the site');
				await c.sleep(Math.max(c.pace, 1000));
				continue;
			}
			reachFails = 0;
			v = verdictNow();
		}
		if (!v.ok) {
			c.stats.refused++;
			if (v.reason !== c.edits.lastRefusal) o.log({ k: 'refused', t: clock(), cell: pick.cell, reason: v.reason });
			c.edits.lastRefusal = v.reason;
			if (v.reason === 'cell not air' || v.reason === 'kid cell buffer') {
				done.add(k);
				b.skipped.push(k);
			} else if (v.reason === 'own body') {
				await o.body.flyTo({ x: o.body.pose().x, y: o.body.pose().y + 3, z: o.body.pose().z }).catch(() => undefined);
			} else {
				await c.sleep(2000);
			}
			continue;
		}
		c.edits.lastRefusal = '';
		o.body.lookAt(pick.cell.x + 0.5, pick.cell.y + 0.5, pick.cell.z + 0.5);
		let ok = false;
		try {
			ok = await o.body.place(pick.cell.x, pick.cell.y, pick.cell.z, pick.block);
		} catch (err) {
			o.log({ k: 'place-error', t: clock(), err: err instanceof Error ? err.message : String(err) });
		}
		const t = clock();
		c.edits.lastEditT = t;
		c.trip.recordEdit(pick.cell, t);
		done.add(k);
		if (ok) {
			b.placed.push(k);
			const id = blockId(pick.block);
			if (id !== null) c.onPlaced(pick.cell, id);
			c.stats.placed++;
		} else {
			b.skipped.push(k);
			c.stats.failed++;
		}
		o.log({ k: 'place', t, id: b.id, cell: pick.cell, block: pick.block, ok });
		c.save();
		await c.sleep(c.pace);
	}
}
