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

export interface BuilderBuild {
	id: string; template: string; variant: 'small' | 'medium'; palette: string; origin: Vec3; w: number; d: number; h: number;
	cells: Array<{ cell: Vec3; block: string; role: Role; layer: number }>; placed: string[]; skipped: string[];
	status: 'building' | 'done' | 'abandoned'; t: number; why?: string;
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
const WORLD_TOP_FEET = 254;
const MAX_REACH_FAILS = 5;

export const eyeDist = (p: Vec3, cell: Vec3) => Math.hypot(cell.x + 0.5 - p.x, cell.y + 0.5 - (p.y + 1.6), cell.z + 0.5 - p.z);

const inFootprint = (b: { origin: Vec3; w: number; d: number }, p: { x: number; z: number }, m = 0) =>
	p.x >= b.origin.x - m && p.x < b.origin.x + b.w + m && p.z >= b.origin.z - m && p.z < b.origin.z + b.d + m;

/**
 * Flies to a stand spot just outside the footprint beside `cell`. On a blocked flight (a tree trunk, a wall) it
 * unsticks: straight up through a clear column (+6, +12, +20), across at max(that height, cell.y + 4), then down.
 * Returns true only when the eye ends within PLACE_MAX of the cell centre.
 */
export async function approach(
	body: Body, world: WorldView, b: { origin: Vec3; w: number; d: number }, cell: Vec3, log: (e: Record<string, unknown>) => void = () => undefined,
): Promise<boolean> {
	const p = body.pose();
	const c = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
	if (!inFootprint(b, p, 0.4) && eyeDist(p, cell) <= REACH) return true;
	const sides = [
		{ x: b.origin.x - 1.2, z: c.z }, { x: b.origin.x + b.w + 1.2, z: c.z },
		{ x: c.x, z: b.origin.z - 1.2 }, { x: c.x, z: b.origin.z + b.d + 1.2 },
	].sort((u, v) => Math.hypot(u.x - c.x, u.z - c.z) - Math.hypot(v.x - c.x, v.z - c.z));
	const fly = async (t: Vec3) => (await body.flyTo(t)) === 'arrived';
	const good = () => eyeDist(body.pose(), cell) <= PLACE_MAX;
	for (const s of sides.slice(0, 2)) {
		const y = Math.max(cell.y, groundTop(world, Math.floor(s.x), Math.floor(s.z)) + 1);
		try {
			if (await fly({ x: s.x, y, z: s.z })) return good();
			continue; // cancelled: try the other side
		} catch (err) {
			log({ k: 'fly-blocked', to: s, err: err instanceof Error ? err.message : String(err) });
		}
		// Unstick: straight up through a clear column, across high, then down.
		try {
			const q = body.pose();
			const fx = Math.floor(q.x), fz = Math.floor(q.z), fy = Math.floor(q.y);
			let alt: number | null = null;
			for (const dy of [6, 12, 20]) {
				const hy = Math.min(fy + dy, WORLD_TOP_FEET);
				if (hy <= fy) break;
				let clear = true;
				for (let yy = fy; yy <= hy + 1 && clear; yy++) if (world.getBlock(fx, yy, fz) !== 0) clear = false;
				if (!clear) continue;
				try {
					if (await fly({ x: q.x, y: hy, z: q.z })) {
						alt = hy;
						break;
					}
				} catch {
					// try higher
				}
			}
			if (alt === null) {
				log({ k: 'unstick-failed', at: { x: q.x, y: q.y, z: q.z } });
				continue;
			}
			const cruise = Math.min(Math.max(alt, cell.y + 4), WORLD_TOP_FEET);
			if (cruise > alt && !(await fly({ x: q.x, y: cruise, z: q.z }))) continue;
			if (!(await fly({ x: s.x, y: cruise, z: s.z }))) continue;
			if (await fly({ x: s.x, y, z: s.z })) return good();
		} catch (err) {
			log({ k: 'fly-failed', to: s, err: err instanceof Error ? err.message : String(err) });
		}
	}
	return good() && !inFootprint(b, body.pose(), 0.4);
}
const KID_INSIDE_MAX_MS = 60_000;

export interface BuilderOpts {
	name: string; body: Body; world: WorldView; spawn: Vec3;
	primary: ChoiceEngine | null; secondary?: ChoiceEngine | null;
	noEdits: boolean; statePath: string; log: (o: Record<string, unknown>) => void; status?: (line: string) => void;
	rng: () => number; clock?: () => number; paceMs?: number; statusEveryMs?: number;
	/** The rest after each finished build (default 30 s; the CLI's --rest-sec). It idles visibly near the build meanwhile. */
	restMs?: number;
	/** Block names the catalog knows (the SDK's blockNames()); palettes with an unknown name are dropped. */
	known: ReadonlySet<string>;
}
export interface BuilderStats { placed: number; refused: number; failed: number; buildsDone: number; buildsAbandoned: number; asks: number; fallbacks: number; current: string }
export interface BuilderHandle { stop(): Promise<void>; stats: BuilderStats; file: BuilderFile; done: Promise<void> }

export function runBuilder(o: BuilderOpts): BuilderHandle {
	const clock = o.clock ?? (() => Date.now());
	const pace = o.paceMs ?? 800;
	const file = loadBuilderFile(o.statePath);
	const own = new Ownership(o.world, () => file.owned);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const trip = new Tripwire();
	const stats: BuilderStats = { placed: 0, refused: 0, failed: 0, buildsDone: 0, buildsAbandoned: 0, asks: 0, fallbacks: 0, current: 'starting' };
	let stopped = false;
	let lastEditT: number | null = null;
	let lastRefusal = '';
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

	// Engines: a failing engine is skipped for 60 s after 3 failures in a row.
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
	/** Asks the primary (and, with --compare, the secondary in parallel); null = fall back. */
	async function ask(what: string, state: string, instructions: string, options: Record<string, string>): Promise<string | null> {
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
	}

	function nearestKid(): KidPos | null {
		const p = o.body.pose();
		let best: KidPos | null = null;
		for (const k of kidsNow()) if (!best || Math.hypot(k.x - p.x, k.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z)) best = k;
		return best;
	}

	function avoidBoxes() {
		return file.builds.map((b) => ({ min: b.origin, max: { x: b.origin.x + b.w - 1, y: b.origin.y + b.h - 1, z: b.origin.z + b.d - 1 } }));
	}

	async function pickProject(): Promise<BuilderBuild | null> {
		const recent = file.builds.filter((b) => b.status === 'done').slice(-2).map((b) => b.template);
		let pool = TEMPLATES.filter((t) => !recent.includes(t.name) && palettes(t.name).length > 0);
		if (pool.length === 0) pool = TEMPLATES.filter((t) => palettes(t.name).length > 0);
		const opt = (t: Template) => `${t.name}-${t.variant}`;
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
		const palette = pals[Math.floor(o.rng() * pals.length)];
		const anchor = kid ? { x: kid.x, y: kid.y, z: kid.z } : o.spawn;
		stats.current = `searching a site for ${opt(t)}`;
		const search = new SiteSearch({ w: t.w, d: t.d, h: t.h, anchor, avoid: avoidBoxes() }, { world: o.world, own, spawn: o.spawn, kids: kidsNow() });
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

	const insideBox = inFootprint;

	/** Flies within reach of `cell`; true only when the eye ends within PLACE_MAX of the cell centre. */
	async function reach(b: BuilderBuild, cell: Vec3): Promise<boolean> {
		return approach(o.body, o.world, b, cell, (e) => o.log({ ...e, t: clock() }));
	}

	async function construct(b: BuilderBuild): Promise<void> {
		const plan: PlanCell[] = b.cells;
		const done = new Set<string>([...b.placed, ...b.skipped]);
		trip.resetPlan(Math.max(1, plan.length - b.placed.length));
		let kidInsideSince: number | null = null;
		let reachFails = 0;
		const tag = `${b.variant} ${b.template}`;
		const end = (status: 'done' | 'abandoned', why: string) => {
			b.status = status;
			b.why = why;
			if (status === 'done') stats.buildsDone++;
			else stats.buildsAbandoned++;
			save();
			o.log({ k: 'build-end', t: clock(), id: b.id, status, why, placed: b.placed.length, cells: plan.length });
		};
		while (!stopped) {
			stats.current = `building ${tag} ${b.placed.length}/${plan.length} at ${b.origin.x},${b.origin.z}`;
			if (trip.halted) return;
			const kids = kidsNow();
			if (own.kidCellWithin(b.origin.x + b.w / 2, b.origin.z + b.d / 2, Math.max(b.w, b.d) / 2 + 1)) return end('abandoned', 'kid cells at the site');
			if (kids.some((k) => insideBox(b, k, 1))) {
				kidInsideSince ??= clock();
				if (clock() - kidInsideSince > KID_INSIDE_MAX_MS) return end('abandoned', 'a kid stayed inside the site');
				await sleep(2000);
				continue;
			}
			kidInsideSince = null;
			const p = o.body.pose();
			const eye = { x: p.x, y: p.y + 1.6, z: p.z };
			const moves = candidateMoves(plan, done, o.world, eye);
			if (moves.length === 0) {
				if (b.placed.length >= plan.length / 2) {
					const top = Math.max(...plan.map((c) => c.cell.y)) + 2;
					o.body.fx({ kind: 'firework', x: b.origin.x + b.w / 2, y: top, z: b.origin.z + b.d / 2 });
					return end('done', 'finished');
				}
				return end('abandoned', 'nothing left to place');
			}
			let pick = heuristicPick(moves)!;
			if (moves.length > 1) {
				const options = Object.fromEntries(moves.map((m, i) => [`block-${i + 1}`, describeMove(m, eye)]));
				const state = `I am building a ${tag} with ${b.placed.length} of ${plan.length} blocks placed. I build from the bottom up.`;
				const a = await ask('move', state, 'Which block should the builder place next so the build grows neatly and looks good?', options);
				const i = a ? Number(a.slice('block-'.length)) - 1 : -1;
				if (moves[i]) pick = moves[i];
			}
			const k = cellKey(pick.cell);
			const verdictNow = () => checkPlace(pick.cell, pick.block, {
				world: o.world, own, kids: kidsNow(), stop, now: clock(), lastEditT, noEdits: o.noEdits, halted: trip.halted, self: o.body.pose(),
			});
			let v = verdictNow();
			if (v.ok) {
				const there = await reach(b, pick.cell);
				if (stopped) return;
				// Never place from afar: only after a successful approach, with the eye within PLACE_MAX.
				if (!there || eyeDist(o.body.pose(), pick.cell) > PLACE_MAX) {
					stats.failed++;
					reachFails++;
					o.log({ k: 'unreachable', t: clock(), cell: pick.cell, fails: reachFails, eyeDist: Math.round(eyeDist(o.body.pose(), pick.cell) * 10) / 10 });
					if (reachFails >= MAX_REACH_FAILS) return end('abandoned', 'cannot reach the site');
					await sleep(Math.max(pace, 1000));
					continue;
				}
				reachFails = 0;
				v = verdictNow();
			}
			if (!v.ok) {
				stats.refused++;
				if (v.reason !== lastRefusal) o.log({ k: 'refused', t: clock(), cell: pick.cell, reason: v.reason });
				lastRefusal = v.reason;
				if (v.reason === 'cell not air' || v.reason === 'kid cell buffer') {
					done.add(k);
					b.skipped.push(k);
				} else if (v.reason === 'own body') {
					await o.body.flyTo({ x: o.body.pose().x, y: o.body.pose().y + 3, z: o.body.pose().z }).catch(() => undefined);
				} else {
					await sleep(2000);
				}
				continue;
			}
			lastRefusal = '';
			o.body.lookAt(pick.cell.x + 0.5, pick.cell.y + 0.5, pick.cell.z + 0.5);
			let ok = false;
			try {
				ok = await o.body.place(pick.cell.x, pick.cell.y, pick.cell.z, pick.block);
			} catch (err) {
				o.log({ k: 'place-error', t: clock(), err: err instanceof Error ? err.message : String(err) });
			}
			lastEditT = clock();
			trip.recordEdit(pick.cell, lastEditT);
			done.add(k);
			if (ok) {
				b.placed.push(k);
				const id = blockId(pick.block);
				if (id !== null) {
					file.owned[k] = id;
					own.ownWrite(pick.cell.x, pick.cell.y, pick.cell.z, id);
				}
				stats.placed++;
			} else {
				b.skipped.push(k);
				stats.failed++;
			}
			o.log({ k: 'place', t: lastEditT, id: b.id, cell: pick.cell, block: pick.block, ok });
			save();
			await sleep(pace);
		}
	}

	/** Rests for `ms` while visibly alive: every few seconds a short hop beside the build or a look at it. */
	async function restNear(b: BuilderBuild, ms: number): Promise<void> {
		const until = clock() + ms;
		const cx = b.origin.x + b.w / 2, cz = b.origin.z + b.d / 2;
		while (!stopped && clock() < until) {
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
			let b = resume;
			resume = null;
			try {
				b ??= await pickProject();
				if (!b) {
					stats.current = 'no site found; waiting';
					await sleep(10_000);
					continue;
				}
				await construct(b);
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
