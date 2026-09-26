/**
 * The village planner bot: never mines, unlimited blocks. It plans a whole village once (the model picks a theme and
 * a layout; the site search puts 3–5 lots near the nearest kid or spawn, every lot passing brain2's site rules), then
 * builds it lot by lot with the builder's move loop: the statue in the plaza first, then each house and the tower,
 * each followed by a path from its door to the plaza (on top of the ground, only into air) and lamps on posts at the
 * path's ends. Every placement goes through the builder's checkPlace (judgeSafety allowFree: kid cells and their
 * buffer, kid body buffer, stop signal, --no-edits, only into air) and a Tripwire; the plan persists, so a restart
 * resumes where it stopped.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blockId } from 'minicraft-bot';
import { StopSignal } from '../body/stop-signal.js';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { Ownership } from '../brain2/ownership.js';
import { Tripwire, type KidPos } from '../brain2/safety.js';
import { LIMITS } from '../brain2/data/limits.data.js';
import { groundTop } from '../brain2/behaviours/site-search.js';
import { templateOf } from '../brain2/behaviours/templates.data.js';
import { approach, checkPlace, constructBuild, eyeDist, makeAsk, PLACE_MAX, type BuilderBuild } from '../builder/builder.js';
import type { ChoiceEngine } from '../builder/engines.js';
import { cellKey, planCells } from '../builder/moves.js';
import { readBuilderRecords } from '../decorator/decor.js';
import type { SharedCells } from '../shared/bot-cells.js';
import { planAvoidBoxes } from '../foreman/plan-file.js';
import { boxOf, doorFronts, lampSpots, planPath, plazaGoal, VillageSearch, type Box, type Col, type LotSpec } from './plan.js';
import { LAYOUTS, THEMES, themeBlocks, themeSlug, type Layout, type VillageTheme } from './themes.data.js';

export interface CellsRec { cells: Array<{ cell: Vec3; block: string }>; placed: string[]; skipped: string[]; status: 'placing' | 'done' | 'abandoned'; why?: string }
export interface VillageLot { spec: LotSpec; build: BuilderBuild; path?: CellsRec; lamps?: CellsRec }
export interface Village {
	id: string; theme: string; layout: Layout; anchor: Vec3; centre: Col; lots: VillageLot[];
	status: 'building' | 'done'; t: number;
}
export interface VillageFile { v: 1; village: Village | null; owned: Record<string, number> }

export function villageStatePath(stateRoot: string, target: string, world: string, name: string): string {
	return join(stateRoot, 'village', target, world, `${name}.json`);
}

export function loadVillageFile(path: string): VillageFile {
	try {
		const f = JSON.parse(readFileSync(path, 'utf8')) as VillageFile;
		if (f && f.v === 1 && f.owned && 'village' in f) return f;
	} catch {
		// missing or unreadable: a fresh file
	}
	return { v: 1, village: null, owned: {} };
}

export function saveVillageFile(path: string, f: VillageFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(f));
	renameSync(tmp, path);
}

const MAX_REACH_FAILS = 4;

export interface VillageOpts {
	name: string; body: Body; world: WorldView; spawn: Vec3;
	primary: ChoiceEngine | null; secondary?: ChoiceEngine | null;
	noEdits: boolean; statePath: string;
	/** The builder bots' records of this world: their builds are avoided. */
	builderDir?: string;
	log: (o: Record<string, unknown>) => void; status?: (line: string) => void;
	rng: () => number; clock?: () => number; paceMs?: number; statusEveryMs?: number; restMs?: number;
	known: ReadonlySet<string>;
	shared?: SharedCells | null;
	/** The site search radius around the anchor (default 64). */
	searchRadius?: number;
	/** The foreman's shared plan (experiment E7): its area is avoided. */
	planPath?: string;
}
export interface VillageStats { placed: number; refused: number; failed: number; lotsDone: number; lotsAbandoned: number; pathsDone: number; lampsDone: number; asks: number; fallbacks: number; current: string }
export interface VillageHandle { stop(): Promise<void>; stats: VillageStats; file: VillageFile; done: Promise<void> }

export function runVillage(o: VillageOpts): VillageHandle {
	const clock = o.clock ?? (() => Date.now());
	const pace = o.paceMs ?? 800;
	const file = loadVillageFile(o.statePath);
	const own = new Ownership(o.world, () => file.owned, o.shared ? () => o.shared!.cells() : undefined);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const trip = new Tripwire();
	const stats: VillageStats = { placed: 0, refused: 0, failed: 0, lotsDone: 0, lotsAbandoned: 0, pathsDone: 0, lampsDone: 0, asks: 0, fallbacks: 0, current: 'starting' };
	let stopped = false;
	const edits = { lastEditT: null as number | null, lastRefusal: '' };
	const wakers = new Set<() => void>();
	const sleep = (ms: number) => new Promise<void>((res) => {
		if (stopped) return res();
		const done = () => {
			clearTimeout(t);
			wakers.delete(done);
			res();
		};
		const t = setTimeout(done, Math.max(0, ms));
		wakers.add(done);
	});
	const save = () => saveVillageFile(o.statePath, file);
	const ask = makeAsk({ primary: o.primary, secondary: o.secondary, clock, log: o.log, stats });
	const themes = THEMES.filter((t) => themeBlocks(t).every((b) => o.known.has(b)));

	const unsubs = [
		o.body.onEdit((e) => {
			const who = stop.onEdit(e, o.body.journal(), clock());
			if (who) o.log({ k: 'stop-signal', kid: who, t: clock() });
			for (const op of own.onEdit(e, o.body.you)) if (op.value === undefined) delete file.owned[op.path[1] as string];
		}),
		o.body.onReconnect(() => own.reset()),
	];
	const kidsNow = (): KidPos[] => o.body.players().filter((p) => !p.bot && p.hasPos).map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z }));
	const onPlaced = (cell: Vec3, id: number) => {
		file.owned[cellKey(cell)] = id;
		own.ownWrite(cell.x, cell.y, cell.z, id);
		o.shared?.append(cell, id);
	};

	function nearestKid(): KidPos | null {
		const p = o.body.pose();
		let best: KidPos | null = null;
		for (const k of kidsNow()) if (!best || Math.hypot(k.x - p.x, k.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z)) best = k;
		return best;
	}
	const themeOf = (v: Village): VillageTheme => themes.find((t) => t.name === v.theme) ?? themes[0];

	async function plan(): Promise<Village | null> {
		if (themes.length === 0) throw new Error('no village theme has only known blocks');
		const kid = nearestKid();
		const anchor = kid ? { x: kid.x, y: kid.y, z: kid.z } : o.spawn;
		const state = [
			`I am ${o.name}, a village planner robot in a block world where a 7-year-old plays.`,
			kid ? `${kid.name} is playing nearby.` : 'No kid is online right now.',
			'I am about to build a small village: a few houses, a lookout tower and a statue in a plaza, joined by paths with lamps.',
		].join(' ');
		const tOpts = Object.fromEntries(themes.map((t) => [themeSlug(t), `${t.name}: ${t.description}`]));
		const tPick = await ask('theme', state, 'Which village style would a 7-year-old be most delighted to find in the morning?', tOpts);
		const theme = themes.find((t) => themeSlug(t) === tPick) ?? themes[Math.floor(o.rng() * themes.length) % themes.length];
		const lOpts = Object.fromEntries(Object.entries(LAYOUTS));
		const lPick = await ask('layout', `${state} The style is ${theme.name}.`, 'How should the houses be arranged around the plaza so the village looks cosy and is fun to walk through?', lOpts);
		const layouts = Object.keys(LAYOUTS) as Layout[];
		const layout = layouts.find((l) => l === lPick) ?? layouts[Math.floor(o.rng() * layouts.length) % layouts.length];
		// Other bots' builds are avoided (as the builder does).
		const avoid = [
			...(o.builderDir ? readBuilderRecords(o.builderDir).builds.map(({ build: b }) => ({ min: b.origin, max: { x: b.origin.x + b.w - 1, y: b.origin.y + b.h - 1, z: b.origin.z + b.d - 1 } })) : []),
			...planAvoidBoxes(o.planPath),
		];
		stats.current = `searching a village site (${theme.name}, ${layout})`;
		const search = new VillageSearch({ layout, theme, anchor, avoid, maxRadius: o.searchRadius ?? 64 }, { world: o.world, own, spawn: o.spawn, kids: kidsNow() });
		for (;;) {
			if (stopped) return null;
			const r = search.step();
			if (r === 'none') {
				o.log({ k: 'search-failed', t: clock(), theme: theme.name, layout, anchor, rejections: search.counts });
				return null;
			}
			if (r) {
				const id = clock().toString(36);
				const lots: VillageLot[] = r.lots.map((l, i) => {
					const t = templateOf(l.spec.template, l.spec.variant);
					const blocks = l.spec.role === 'statue' ? theme.statue.blocks : theme.build;
					const cells = planCells(t, l.site.origin, { name: theme.name, blocks });
					return {
						spec: l.spec,
						build: {
							id: `${id}-${i}`, template: l.spec.template, variant: l.spec.variant, palette: theme.name, origin: l.site.origin, w: t.w, d: t.d, h: t.h,
							cells, placed: [], skipped: [], status: 'building', t: clock(),
						},
					};
				});
				const v: Village = { id, theme: theme.name, layout, anchor, centre: r.centre, lots, status: 'building', t: clock() };
				file.village = v;
				save();
				o.log({
					k: 'village', t: clock(), id, theme: theme.name, layout, anchor, centre: r.centre, n: r.n,
					by: { theme: tPick === themeSlug(theme) ? 'model' : 'fallback', layout: lPick === layout ? 'model' : 'fallback' },
					lots: lots.map((l) => ({ role: l.spec.role, template: l.spec.template, origin: l.build.origin })),
				});
				return v;
			}
			await new Promise((res) => setImmediate(res));
		}
	}

	/** Places a cell list in order (a cell resting on a skipped cell of the same list is skipped too). */
	async function placeCells(rec: CellsRec, what: string): Promise<void> {
		const done = new Set([...rec.placed, ...rec.skipped]);
		trip.resetPlan(Math.max(1, rec.cells.length - rec.placed.length));
		let reachFails = 0;
		let gaveUp = false;
		for (const dc of rec.cells) {
			if (stopped || trip.halted) return;
			const k = cellKey(dc.cell);
			if (done.has(k)) continue;
			stats.current = `${what} ${rec.placed.length}/${rec.cells.length}`;
			const below = cellKey({ ...dc.cell, y: dc.cell.y - 1 });
			if (rec.cells.some((c) => cellKey(c.cell) === below) && !rec.placed.includes(below)) {
				rec.skipped.push(k);
				continue;
			}
			const verdictNow = () => checkPlace(dc.cell, dc.block, { world: o.world, own, kids: kidsNow(), stop, now: clock(), lastEditT: edits.lastEditT, noEdits: o.noEdits, halted: trip.halted, self: o.body.pose() });
			let v = verdictNow();
			if (v.ok) {
				const there = await approach(o.body, o.world, { origin: dc.cell, w: 1, d: 1 }, dc.cell, (e) => o.log({ ...e, t: clock() }));
				if (stopped) return;
				if (!there || eyeDist(o.body.pose(), dc.cell) > PLACE_MAX) {
					stats.failed++;
					o.log({ k: 'unreachable', t: clock(), cell: dc.cell, fails: ++reachFails });
					rec.skipped.push(k);
					if (reachFails >= MAX_REACH_FAILS) {
						gaveUp = true;
						break;
					}
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
				if (v.reason === 'cell not air' || v.reason === 'kid cell buffer' || v.reason === 'own body' || v.reason === 'kid body buffer') {
					rec.skipped.push(k);
					continue;
				}
				await sleep(2000);
				return; // stop signal / no-edits / halted: try again later
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
			const t = clock();
			edits.lastEditT = t;
			trip.recordEdit(dc.cell, t);
			if (ok) {
				rec.placed.push(k);
				const id = blockId(dc.block);
				if (id !== null) onPlaced(dc.cell, id);
				stats.placed++;
			} else {
				rec.skipped.push(k);
				stats.failed++;
			}
			o.log({ k: 'place', t, what, cell: dc.cell, block: dc.block, ok });
			save();
			await sleep(pace);
		}
		if (stopped || trip.halted) return;
		const left = rec.cells.filter((c) => !rec.placed.includes(cellKey(c.cell)) && !rec.skipped.includes(cellKey(c.cell)));
		if (left.length && !gaveUp) return; // a refusal paused it: resume later
		rec.status = rec.placed.length > 0 ? 'done' : 'abandoned';
		rec.why = rec.placed.length > 0 ? 'finished' : 'nothing placed';
		save();
		o.log({ k: `${what.split(' ')[0]}-end`, t: clock(), status: rec.status, placed: rec.placed.length, cells: rec.cells.length });
	}

	/** Every lot footprint as a box (built or not). */
	const lotBoxes = (v: Village): Box[] => v.lots.map((l) => boxOf(l.build.origin, l.spec));
	const inBox = (b: Box, c: Col) => c.x >= b.x0 && c.x <= b.x1 && c.z >= b.z0 && c.z <= b.z1;

	/** The path from a lot's door to the plaza ring, as cells on top of the ground. */
	function pathFor(v: Village, lot: VillageLot): CellsRec {
		const theme = themeOf(v);
		const boxes = lotBoxes(v);
		const statue = boxes[0];
		const lampCols = v.lots.flatMap((l) => l.lamps?.cells ?? []).map((c) => c.cell);
		const blocked = (c: Col) => boxes.some((b) => inBox(b, c)) || lampCols.some((q) => q.x === c.x && q.z === c.z);
		const all = boxes.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), z0: Math.min(a.z0, b.z0), z1: Math.max(a.z1, b.z1) }));
		const bounds = { x0: all.x0 - 4, x1: all.x1 + 4, z0: all.z0 - 4, z1: all.z1 + 4 };
		const cells: CellsRec['cells'] = [];
		for (const from of doorFronts(lot.spec, lot.build.origin)) {
			const cols = planPath(from, plazaGoal(statue), blocked, bounds);
			if (!cols) {
				o.log({ k: 'path-none', t: clock(), lot: lot.build.id, from });
				continue;
			}
			for (const c of cols) {
				const g = groundTop(o.world, c.x, c.z);
				if (g >= 0) cells.push({ cell: { x: c.x, y: g + 1, z: c.z }, block: theme.path });
			}
			break;
		}
		return { cells, placed: [], skipped: [], status: 'placing' };
	}

	/** Lamps (a post with a light on top) beside both ends of a lot's path. */
	function lampsFor(v: Village, lot: VillageLot): CellsRec {
		const theme = themeOf(v);
		const boxes = lotBoxes(v);
		const pathCols = v.lots.flatMap((l) => l.path?.cells ?? []).map((c) => c.cell);
		const doorCols = v.lots.flatMap((l) => doorFronts(l.spec, l.build.origin));
		const blocked = (c: Col) => boxes.some((b) => inBox(b, c)) || pathCols.some((q) => q.x === c.x && q.z === c.z) || doorCols.some((q) => q.x === c.x && q.z === c.z);
		const cols = (lot.path?.cells ?? []).map((c) => ({ x: c.cell.x, z: c.cell.z }));
		const cells: CellsRec['cells'] = [];
		for (const s of lampSpots(cols, blocked)) {
			const g = groundTop(o.world, s.x, s.z);
			if (g < 0) continue;
			cells.push({ cell: { x: s.x, y: g + 1, z: s.z }, block: theme.post }, { cell: { x: s.x, y: g + 2, z: s.z }, block: theme.light });
		}
		return { cells, placed: [], skipped: [], status: 'placing' };
	}

	async function restNear(c: Vec3, ms: number): Promise<void> {
		const until = clock() + ms;
		while (!stopped && clock() < until) {
			const left = until - clock();
			if (o.rng() < 0.6) {
				const a = o.rng() * Math.PI * 2;
				o.body.lookAt(c.x + Math.cos(a) * 8, c.y + 1 + o.rng() * 3, c.z + Math.sin(a) * 8);
			} else {
				const a = o.rng() * Math.PI * 2;
				const x = c.x + 0.5 + Math.cos(a) * (2 + o.rng() * 3), z = c.z + 0.5 + Math.sin(a) * (2 + o.rng() * 3);
				const y = groundTop(o.world, Math.floor(x), Math.floor(z)) + 1;
				if (y > 0) await Promise.race([o.body.flyTo({ x, y, z }).catch(() => undefined), sleep(Math.min(left, 4000))]);
			}
			await sleep(Math.min(until - clock(), 2000 + o.rng() * 2500));
		}
	}

	async function once(): Promise<void> {
		const v = file.village ?? (await plan());
		if (!v) {
			stats.current = 'no village site found; waiting';
			await sleep(10_000);
			return;
		}
		const plaza = { x: v.centre.x, y: v.lots[0].build.origin.y, z: v.centre.z + 2 };
		for (const lot of v.lots) {
			if (stopped || trip.halted) return;
			const b = lot.build;
			if (b.status === 'building') {
				// Re-check the kid rules before starting a lot (a kid may have built nearby since the plan).
				if (b.placed.length === 0 && own.kidCellWithin(b.origin.x + b.w / 2, b.origin.z + b.d / 2, LIMITS.SITE_KID_DIST + Math.max(b.w, b.d) / 2)) {
					b.status = 'abandoned';
					b.why = 'kid cells near the lot';
					save();
					stats.lotsAbandoned++;
					o.log({ k: 'build-end', t: clock(), id: b.id, status: 'abandoned', why: b.why, placed: 0, cells: b.cells.length });
					continue;
				}
				o.log({ k: 'lot', t: clock(), id: b.id, role: lot.spec.role, template: lot.spec.template, origin: b.origin });
				await constructBuild(b, {
					body: o.body, world: o.world, own, stop, trip, kidsNow, ask, log: o.log, save, sleep, clock, pace, noEdits: o.noEdits,
					stopped: () => stopped, stats, edits, onPlaced,
				});
				if (b.status === 'building') return; // stopped or halted: resume later
				if (b.status === 'done') stats.lotsDone++;
				else stats.lotsAbandoned++;
				if (b.status === 'done') await restNear({ x: b.origin.x + b.w / 2, y: b.origin.y, z: b.origin.z + b.d + 2 }, Math.min(o.restMs ?? 30_000, 10_000));
			}
			if (b.status !== 'done' || lot.spec.role === 'statue') continue;
			if (!lot.path) {
				lot.path = pathFor(v, lot);
				save();
				o.log({ k: 'path', t: clock(), lot: b.id, cells: lot.path.cells.length, block: themeOf(v).path });
			}
			if (lot.path.status === 'placing') {
				await placeCells(lot.path, `path to the plaza from the ${lot.spec.role}`);
				if (lot.path.status === 'placing') return;
				if (lot.path.status === 'done') stats.pathsDone++;
			}
			if (lot.path.status !== 'done') continue;
			if (!lot.lamps) {
				lot.lamps = lampsFor(v, lot);
				save();
				o.log({ k: 'lamps', t: clock(), lot: b.id, cells: lot.lamps.cells.length });
			}
			if (lot.lamps.status === 'placing') {
				await placeCells(lot.lamps, `lamps by the ${lot.spec.role} path`);
				if (lot.lamps.status === 'placing') return;
				if (lot.lamps.status === 'done') stats.lampsDone++;
			}
		}
		if (stopped || trip.halted) return;
		if (v.status !== 'done') {
			v.status = 'done';
			save();
			o.log({ k: 'village-end', t: clock(), id: v.id, lots: v.lots.map((l) => `${l.spec.role} ${l.build.status}`) });
			const top = Math.max(...v.lots.map((l) => l.build.origin.y + l.build.h));
			o.body.fx({ kind: 'firework', x: v.centre.x, y: top + 2, z: v.centre.z });
		}
		stats.current = `the ${v.theme} village is finished; resting in the plaza`;
		await restNear(plaza, o.restMs ?? 30_000);
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
				await sleep(5000);
			}
		}
	}

	const statusTimer = o.status
		? setInterval(() => {
			const paused = stop.active(clock()).map((s) => ` | paused near ${s.name} ${Math.ceil(s.remainingMs / 60_000)}m`).join('');
			o.status!(`${o.name}: ${stats.current} | lots ${stats.lotsDone} done, ${stats.lotsAbandoned} abandoned | paths ${stats.pathsDone} | lamps ${stats.lampsDone} | placed ${stats.placed} | engine ${o.primary?.name ?? 'none'} (fallbacks ${stats.fallbacks}/${stats.asks})${paused}${trip.halted ? ' | EDITS HALTED' : ''}`);
		}, o.statusEveryMs ?? 30_000)
		: null;

	o.log({ k: 'start', t: clock(), bot: 'village', name: o.name, primary: o.primary?.name ?? null, secondary: o.secondary?.name ?? null, noEdits: o.noEdits, resume: file.village?.id ?? null });
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
			if (existsSync(dirname(o.statePath)) || file.village) save();
			o.log({ k: 'stop', t: clock(), stats });
		},
	};
}
