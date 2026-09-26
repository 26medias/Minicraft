/**
 * The decorator bot: it never mines and never builds anything big; it decorates around the builder bots' builds.
 * It loops: read every builder record of this world (all bots) → the model picks one of the ≤ 4 nearest builds → ≤ 3
 * candidate decorations (decor.ts) → the model picks one → place it cell by cell, flying within reach like the
 * builder (approach) → rest with an idle look-around → again. Every placement goes through the builder's checkPlace
 * (brain2's judgeSafety with allowFree: only into air, kid cells and their buffer, kid body buffer, stop signal,
 * --no-edits) and a Tripwire; its decorations and the cells it owns persist in a small JSON file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blockId } from 'minicraft-bot';
import { StopSignal } from '../body/stop-signal.js';
import type { Body, WorldView } from '../port.js';
import { Ownership } from '../brain2/ownership.js';
import { Tripwire, type KidPos } from '../brain2/safety.js';
import { LIMITS } from '../brain2/data/limits.data.js';
import { groundTop } from '../brain2/behaviours/site-search.js';
import { approach, checkPlace, eyeDist, PLACE_MAX } from '../builder/builder.js';
import type { ChoiceEngine } from '../builder/engines.js';
import { cellKey } from '../builder/moves.js';
import type { SharedCells } from '../shared/bot-cells.js';
import { capCount, capReached, countsTowardCap, DEFAULT_MAX_DECORATIONS } from '../shared/cap.js';
import { candidateDecorations, niceBuild, readBuilderRecords, type DecorCell, type DecorKind, type KnownBuild } from './decor.js';

export interface DecorRecord {
	id: string; bot: string; buildId: string; kind: DecorKind; description: string; cells: DecorCell[];
	placed: string[]; skipped: string[]; status: 'placing' | 'done' | 'abandoned'; t: number; why?: string;
}
export interface DecoratorFile { v: 1; decorations: DecorRecord[]; owned: Record<string, number> }

export function decoratorStatePath(stateRoot: string, target: string, world: string, name: string): string {
	return join(stateRoot, 'decorator', target, world, `${name}.json`);
}
export function builderDir(stateRoot: string, target: string, world: string): string {
	return join(stateRoot, 'builder', target, world);
}

export function loadDecoratorFile(path: string): DecoratorFile {
	try {
		const f = JSON.parse(readFileSync(path, 'utf8')) as DecoratorFile;
		if (f && f.v === 1 && Array.isArray(f.decorations) && f.owned) return f;
	} catch {
		// missing or unreadable: a fresh file
	}
	return { v: 1, decorations: [], owned: {} };
}

export function saveDecoratorFile(path: string, f: DecoratorFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(f));
	renameSync(tmp, path);
}

const MAX_REACH_FAILS = 4;

export interface DecoratorOpts {
	name: string; body: Body; world: WorldView;
	primary: ChoiceEngine | null; secondary?: ChoiceEngine | null;
	noEdits: boolean; statePath: string; builderDir: string;
	log: (o: Record<string, unknown>) => void; status?: (line: string) => void;
	rng: () => number; clock?: () => number; paceMs?: number; statusEveryMs?: number;
	/** The rest after each decoration (the CLI's --rest-sec). */
	restMs?: number;
	known: ReadonlySet<string>;
	/** The shared bot-cell registry: placed cells are appended; other bots' cells count as bot cells. */
	shared?: SharedCells | null;
	/** Stop decorating after this many decorations (counted from the persisted records, so across restarts; default 40). */
	maxDecorations?: number;
}
export interface DecoratorStats { placed: number; refused: number; failed: number; done: number; abandoned: number; asks: number; fallbacks: number; current: string }
export interface DecoratorHandle { stop(): Promise<void>; stats: DecoratorStats; file: DecoratorFile; done: Promise<void> }

export function runDecorator(o: DecoratorOpts): DecoratorHandle {
	const clock = o.clock ?? (() => Date.now());
	const pace = o.paceMs ?? 800;
	const file = loadDecoratorFile(o.statePath);
	let builderOwned: Record<string, number> = {};
	// Builder cells count as bot cells (never "kid"), so the kid-cell buffer does not refuse the ground beside them.
	let merged: Record<string, number> = {};
	const refreshMerged = () => {
		merged = { ...builderOwned, ...file.owned };
	};
	refreshMerged();
	const own = new Ownership(o.world, () => merged, o.shared ? () => o.shared!.cells() : undefined);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const trip = new Tripwire();
	const stats: DecoratorStats = { placed: 0, refused: 0, failed: 0, done: 0, abandoned: 0, asks: 0, fallbacks: 0, current: 'starting' };
	let stopped = false;
	let lastEditT: number | null = null;
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
	const save = () => saveDecoratorFile(o.statePath, file);
	const maxDecorations = o.maxDecorations ?? DEFAULT_MAX_DECORATIONS;
	let capLogged = false;

	const unsubs = [
		o.body.onEdit((e) => {
			const who = stop.onEdit(e, o.body.journal(), clock());
			if (who) o.log({ k: 'stop-signal', kid: who, t: clock() });
			for (const op of own.onEdit(e, o.body.you)) if (op.value === undefined) {
				delete file.owned[op.path[1] as string];
				delete merged[op.path[1] as string];
			}
		}),
		o.body.onReconnect(() => own.reset()),
	];
	const kidsNow = (): KidPos[] => o.body.players().filter((p) => !p.bot && p.hasPos).map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z }));

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
			if (++h.fails >= 3) {
				h.until = clock() + 60_000;
				h.fails = 0;
			}
			health.set(e.name, h);
			return { engine: e.name, error: err instanceof Error ? err.message : String(err), ms: clock() - t0 };
		}
	}
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

	const decoCount = (b: KnownBuild) => file.decorations.filter((d) => d.buildId === b.build.id && d.bot === b.bot && d.status !== 'abandoned').length;
	const fullUntil = new Map<string, number>();

	async function pickBuild(builds: KnownBuild[]): Promise<KnownBuild | null> {
		const p = o.body.pose();
		const centre = (b: KnownBuild) => ({ x: b.build.origin.x + b.build.w / 2, z: b.build.origin.z + b.build.d / 2 });
		const dist = (b: KnownBuild) => Math.hypot(centre(b).x - p.x, centre(b).z - p.z);
		const pool = builds.filter((b) => (fullUntil.get(`${b.bot}/${b.build.id}`) ?? 0) <= clock() && decoCount(b) < 5)
			.sort((a, b) => dist(a) - dist(b)).slice(0, 4);
		if (pool.length === 0) return null;
		if (pool.length === 1) return pool[0];
		const options = Object.fromEntries(pool.map((b, i) => [`build-${i + 1}`, `a ${niceBuild(b.build)} by ${b.bot}, ${Math.round(dist(b))} blocks away, decorated ${decoCount(b)} time${decoCount(b) === 1 ? '' : 's'}`]));
		const state = `I am ${o.name}, a decorator robot in a block world where a 7-year-old plays. The builder robots made these builds; I add lights, flowers, bushes, paths and little gardens around them.`;
		const a = await ask('build', state, 'Which build should the decorator make prettier next?', options);
		const i = a ? Number(a.slice('build-'.length)) - 1 : -1;
		if (pool[i]) return pool[i];
		// Fallback: the least decorated, then the nearest.
		return [...pool].sort((a, b) => decoCount(a) - decoCount(b) || dist(a) - dist(b))[0];
	}

	async function place(rec: DecorRecord, kb: KnownBuild): Promise<void> {
		const done = new Set([...rec.placed, ...rec.skipped]);
		trip.resetPlan(Math.max(1, rec.cells.length - rec.placed.length));
		let reachFails = 0;
		const end = (status: 'done' | 'abandoned', why: string) => {
			rec.status = status;
			rec.why = why;
			if (status === 'done') stats.done++;
			else stats.abandoned++;
			save();
			o.log({ k: 'decoration-end', t: clock(), id: rec.id, status, why, placed: rec.placed.length, cells: rec.cells.length });
		};
		for (const dc of rec.cells) {
			if (stopped || trip.halted) return;
			const k = cellKey(dc.cell);
			if (done.has(k)) continue;
			stats.current = `decorating the ${niceBuild(kb.build)} by ${kb.bot}: ${rec.kind} ${rec.placed.length}/${rec.cells.length}`;
			const below = cellKey({ ...dc.cell, y: dc.cell.y - 1 });
			if (rec.cells.some((c) => cellKey(c.cell) === below) && !rec.placed.includes(below)) {
				rec.skipped.push(k);
				continue; // its support was skipped
			}
			const verdictNow = () => checkPlace(dc.cell, dc.block, { world: o.world, own, kids: kidsNow(), stop, now: clock(), lastEditT, noEdits: o.noEdits, halted: trip.halted, self: o.body.pose() });
			let v = verdictNow();
			if (v.ok) {
				const there = await approach(o.body, o.world, kb.build, dc.cell, (e) => o.log({ ...e, t: clock() }));
				if (stopped) return;
				if (!there || eyeDist(o.body.pose(), dc.cell) > PLACE_MAX) {
					stats.failed++;
					o.log({ k: 'unreachable', t: clock(), cell: dc.cell, fails: ++reachFails });
					if (reachFails >= MAX_REACH_FAILS) return end('abandoned', 'cannot reach');
					rec.skipped.push(k);
					continue;
				}
				v = verdictNow();
				if (!v.ok && v.reason === 'own body') {
					await o.body.flyTo({ x: o.body.pose().x, y: o.body.pose().y + 3, z: o.body.pose().z }).catch(() => undefined);
					v = verdictNow();
				}
			}
			if (!v.ok) {
				stats.refused++;
				o.log({ k: 'refused', t: clock(), cell: dc.cell, reason: v.reason });
				rec.skipped.push(k);
				if (v.reason !== 'cell not air' && v.reason !== 'kid cell buffer' && v.reason !== 'own body') return end('abandoned', v.reason);
				continue;
			}
			// The last word before the write: only into air.
			if (o.world.getBlock(dc.cell.x, dc.cell.y, dc.cell.z) !== 0) {
				rec.skipped.push(k);
				continue;
			}
			o.body.lookAt(dc.cell.x + 0.5, dc.cell.y + 0.5, dc.cell.z + 0.5);
			let ok = false;
			try {
				ok = await o.body.place(dc.cell.x, dc.cell.y, dc.cell.z, dc.block);
			} catch (err) {
				o.log({ k: 'place-error', t: clock(), err: err instanceof Error ? err.message : String(err) });
			}
			lastEditT = clock();
			trip.recordEdit(dc.cell, lastEditT);
			if (ok) {
				rec.placed.push(k);
				const id = blockId(dc.block);
				if (id !== null) {
					file.owned[k] = id;
					merged[k] = id;
					own.ownWrite(dc.cell.x, dc.cell.y, dc.cell.z, id);
					o.shared?.append(dc.cell, id);
				}
				stats.placed++;
			} else {
				rec.skipped.push(k);
				stats.failed++;
			}
			o.log({ k: 'place', t: lastEditT, id: rec.id, cell: dc.cell, block: dc.block, ok });
			save();
			await sleep(pace);
		}
		if (!stopped && !trip.halted) end(rec.placed.length > 0 ? 'done' : 'abandoned', rec.placed.length > 0 ? 'finished' : 'nothing placed');
	}

	async function restNear(b: KnownBuild['build'], ms: number): Promise<void> {
		const until = clock() + ms;
		const cx = b.origin.x + b.w / 2, cz = b.origin.z + b.d / 2;
		while (!stopped && clock() < until) {
			const left = until - clock();
			if (o.rng() < 0.6) {
				// Look around: at the build, or out at the view.
				const a = o.rng() * Math.PI * 2;
				if (o.rng() < 0.5) o.body.lookAt(b.origin.x + o.rng() * b.w, b.origin.y + o.rng() * b.h, b.origin.z + o.rng() * b.d);
				else o.body.lookAt(o.body.pose().x + Math.cos(a) * 10, o.body.pose().y + 1, o.body.pose().z + Math.sin(a) * 10);
			} else {
				const a = o.rng() * Math.PI * 2;
				const rad = Math.max(b.w, b.d) / 2 + 2 + o.rng() * 3;
				const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
				const y = groundTop(o.world, Math.floor(x), Math.floor(z)) + 1;
				if (y > 0) await Promise.race([o.body.flyTo({ x, y, z }).catch(() => undefined), sleep(Math.min(left, 4000))]);
			}
			await sleep(Math.min(until - clock(), 2000 + o.rng() * 2500));
		}
	}

	async function once(): Promise<void> {
		const recs = readBuilderRecords(o.builderDir);
		builderOwned = recs.owned;
		refreshMerged();
		const resume = file.decorations.find((d) => d.status === 'placing');
		if (resume) {
			const kb = recs.builds.find((b) => b.bot === resume.bot && b.build.id === resume.buildId);
			if (kb) {
				await place(resume, kb);
				return;
			}
			resume.status = 'abandoned';
			resume.why = 'build gone';
			save();
		}
		if (capReached(file.decorations, maxDecorations)) {
			// Past the cap: no more edits, only a wander and a look around near a build it decorated.
			const n = capCount(file.decorations);
			if (!capLogged) o.log({ k: 'cap-reached', t: clock(), decorations: n, max: maxDecorations });
			capLogged = true;
			stats.current = `decoration cap reached (${n}/${maxDecorations}); wandering near the builds`;
			const mine = file.decorations.filter(countsTowardCap);
			const d = mine[Math.floor(o.rng() * mine.length) % Math.max(1, mine.length)];
			const kbd = d && recs.builds.find((b) => b.bot === d.bot && b.build.id === d.buildId);
			if (kbd) await restNear(kbd.build, 60_000);
			else await sleep(10_000);
			return;
		}
		const kb = await pickBuild(recs.builds);
		if (!kb) {
			stats.current = recs.builds.length ? 'every build is decorated; waiting' : 'no builder builds yet; waiting';
			await sleep(15_000);
			return;
		}
		const used = file.decorations.filter((d) => d.buildId === kb.build.id && d.bot === kb.bot).map((d) => d.kind);
		const cands = candidateDecorations(kb.build, {
			world: o.world, own, kids: kidsNow(), stop, now: clock(), lastEditT, noEdits: o.noEdits,
			allBuilds: recs.builds.map((x) => x.build), known: o.known, rng: o.rng,
		}, used);
		if (cands.length === 0) {
			fullUntil.set(`${kb.bot}/${kb.build.id}`, clock() + 10 * 60_000);
			o.log({ k: 'no-candidates', t: clock(), bot: kb.bot, build: kb.build.id });
			await sleep(2000);
			return;
		}
		let chosen = cands[0];
		if (cands.length > 1) {
			const options = Object.fromEntries(cands.map((d, i) => [`deco-${i + 1}`, d.description]));
			const state = `I am decorating a ${niceBuild(kb.build)} built by ${kb.bot}. It has ${used.length} decoration${used.length === 1 ? '' : 's'} so far${used.length ? ` (${used.join(', ')})` : ''}.`;
			const a = await ask('decoration', state, 'Which decoration would make a 7-year-old smile most when he walks past this build?', options);
			const i = a ? Number(a.slice('deco-'.length)) - 1 : -1;
			chosen = cands[i] ?? cands[Math.floor(o.rng() * cands.length) % cands.length];
		}
		const rec: DecorRecord = {
			id: clock().toString(36), bot: kb.bot, buildId: kb.build.id, kind: chosen.kind, description: chosen.description,
			cells: chosen.cells, placed: [], skipped: [], status: 'placing', t: clock(),
		};
		file.decorations.push(rec);
		save();
		o.log({ k: 'decoration', t: clock(), id: rec.id, bot: kb.bot, build: kb.build.id, kind: rec.kind, description: rec.description, cells: rec.cells.length });
		await place(rec, kb);
		if (rec.status === 'done' && !stopped) {
			stats.current = `resting after ${rec.kind} at the ${niceBuild(kb.build)}`;
			await restNear(kb.build, o.restMs ?? 30_000);
		}
	}

	async function loop(): Promise<void> {
		let haltedLogged = false;
		while (!stopped) {
			if (trip.halted) {
				if (!haltedLogged) o.log({ k: 'EDITS-HALTED', t: clock(), why: trip.halted });
				haltedLogged = true;
				stats.current = `EDITS HALTED (${trip.halted})`;
				await sleep(5000);
				continue;
			}
			try {
				await once();
			} catch (err) {
				o.log({ k: 'error', t: clock(), err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
				const cur = file.decorations.find((d) => d.status === 'placing');
				if (cur) {
					cur.status = 'abandoned';
					cur.why = 'error';
					save();
				}
				await sleep(5000);
			}
		}
	}

	const statusTimer = o.status
		? setInterval(() => {
			o.status!(`${o.name}: ${stats.current} | decorations ${stats.done} done, ${stats.abandoned} abandoned | placed ${stats.placed} | engine ${o.primary?.name ?? 'none'} (fallbacks ${stats.fallbacks}/${stats.asks})${trip.halted ? ' | EDITS HALTED' : ''}`);
		}, o.statusEveryMs ?? 30_000)
		: null;

	o.log({ k: 'start', t: clock(), bot: 'decorator', name: o.name, primary: o.primary?.name ?? null, secondary: o.secondary?.name ?? null, noEdits: o.noEdits, decorations: file.decorations.length });
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
			if (existsSync(dirname(o.statePath)) || file.decorations.length) save();
			o.log({ k: 'stop', t: clock(), stats });
		},
	};
}
