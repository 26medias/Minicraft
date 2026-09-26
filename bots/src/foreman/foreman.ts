/**
 * The foreman bot (experiment E7): never mines, unlimited blocks. It lays out one neighbourhood per world (layout.ts:
 * 4–10 lots on a road grid anchored on world spawn, widening its search radius (32/64/96) when nothing fits, every
 * lot passing brain2's site rules), writes it to the
 * shared plan (plan-file.ts) for builder/architect bots started with --join-plan, and builds the roads (gravel and
 * cobblestone on top of the ground, only into air) and the lamps itself. Every placement goes through the builder's
 * checkPlace (judgeSafety allowFree: kid cells and their buffer, kid body buffer, stop signal, --no-edits, only into
 * air) and a Tripwire. Its progress persists in its own state file, so a restart resumes the roads. Once they are done
 * it stays online, wandering along the streets and looking at the lots: no more edits.
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
import { approach, checkPlace, eyeDist, PLACE_MAX } from '../builder/builder.js';
import { cellKey } from '../builder/moves.js';
import { readBuilderRecords } from '../decorator/decor.js';
import type { SharedCells } from '../shared/bot-cells.js';
import { areaD, areaW, NeighbourhoodSearch, ROWS } from './layout.js';
import { createPlan, readPlan, type NeighbourhoodPlan, type PlanCell } from './plan-file.js';
import { StuckWatchdog } from '../nav/navigate.js';

export interface Progress { placed: string[]; skipped: string[]; status: 'placing' | 'done' }
export interface ForemanFile { v: 1; planId: string | null; roads: Progress; lamps: Progress; owned: Record<string, number> }

export function foremanStatePath(stateRoot: string, target: string, world: string, name: string): string {
	return join(stateRoot, 'foreman', target, world, `${name}.json`);
}

const fresh = (): Progress => ({ placed: [], skipped: [], status: 'placing' });

export function loadForemanFile(path: string): ForemanFile {
	try {
		const f = JSON.parse(readFileSync(path, 'utf8')) as ForemanFile;
		if (f && f.v === 1 && f.owned && f.roads && f.lamps) return f;
	} catch {
		// missing or unreadable: a fresh file
	}
	return { v: 1, planId: null, roads: fresh(), lamps: fresh(), owned: {} };
}

export function saveForemanFile(path: string, f: ForemanFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(f));
	renameSync(tmp, path);
}

const MAX_REACH_FAILS = 6;

export interface ForemanOpts {
	name: string; body: Body; world: WorldView; spawn: Vec3;
	noEdits: boolean; statePath: string; planPath: string;
	/** The builder bots' records of this world: their builds are avoided. */
	builderDir?: string;
	log: (o: Record<string, unknown>) => void; status?: (line: string) => void;
	rng: () => number; clock?: () => number; paceMs?: number; statusEveryMs?: number;
	shared?: SharedCells | null;
	searchRadius?: number;
}
export interface ForemanStats { placed: number; refused: number; failed: number; roadsDone: boolean; lampsDone: boolean; lotsBuilt: number; lots: number; current: string }
export interface ForemanHandle { stop(): Promise<void>; stats: ForemanStats; file: ForemanFile; done: Promise<void> }

export function runForeman(o: ForemanOpts): ForemanHandle {
	const clock = o.clock ?? (() => Date.now());
	// The stuck watchdog every approach on this body shares (nav/navigate.ts): its `unstick` lines go to this bot's log.
	StuckWatchdog.for(o.body, o.world).log = (e) => o.log({ ...e, t: clock() });
	const pace = o.paceMs ?? 800;
	const file = loadForemanFile(o.statePath);
	const own = new Ownership(o.world, () => file.owned, o.shared ? () => o.shared!.cells() : undefined);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const trip = new Tripwire();
	const stats: ForemanStats = { placed: 0, refused: 0, failed: 0, roadsDone: false, lampsDone: false, lotsBuilt: 0, lots: 0, current: 'starting' };
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
		const t = setTimeout(done, Math.max(0, ms));
		wakers.add(done);
	});
	const save = () => saveForemanFile(o.statePath, file);
	const unsubs = [
		o.body.onEdit((e) => {
			const who = stop.onEdit(e, o.body.journal(), clock());
			if (who) o.log({ k: 'stop-signal', kid: who, t: clock() });
			for (const op of own.onEdit(e, o.body.you)) if (op.value === undefined) delete file.owned[op.path[1] as string];
		}),
		o.body.onReconnect(() => own.reset()),
	];
	const kidsNow = (): KidPos[] => o.body.players().filter((p) => !p.bot && p.hasPos).map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z }));

	/** The world's plan: the one on disk, else a new one laid out now (null when no site fits yet). Always anchored on world spawn, never the kid, so the neighbourhood stays put across restarts and kid movement. */
	async function thePlan(): Promise<NeighbourhoodPlan | null> {
		const cur = readPlan(o.planPath);
		if (cur) return cur;
		const anchor = o.spawn;
		const avoid = o.builderDir ? readBuilderRecords(o.builderDir).builds.map(({ build: b }) => ({ min: b.origin, max: { x: b.origin.x + b.w - 1, y: b.origin.y + b.h - 1, z: b.origin.z + b.d - 1 } })) : [];
		stats.current = 'searching a neighbourhood site';
		const search = new NeighbourhoodSearch({ anchor, avoid, radii: o.searchRadius ? [o.searchRadius] : undefined }, { world: o.world, own, spawn: o.spawn, kids: kidsNow() });
		for (;;) {
			if (stopped) return null;
			const r = search.step();
			if (r === 'none') {
				o.log({ k: 'search-failed', t: clock(), anchor, rejections: search.counts });
				return null;
			}
			if (r) {
				const p: NeighbourhoodPlan = {
					v: 1, id: clock().toString(36), foreman: o.name, t: clock(), anchor, corner: r.corner, cols: r.cols, rows: ROWS,
					lots: r.lots, roads: r.roads, lamps: r.lamps,
				};
				const won = createPlan(o.planPath, p);
				o.log({ k: 'plan', t: clock(), id: won.id, mine: won.id === p.id, corner: won.corner, cols: won.cols, lots: won.lots.map((l) => ({ id: l.id, origin: l.origin })), roads: won.roads.length, lamps: won.lamps.length / 2 });
				return won;
			}
			await new Promise((res) => setImmediate(res));
		}
	}

	/** Places a cell list in order (a cell resting on a skipped cell of the same list is skipped too). */
	async function placeCells(cells: readonly PlanCell[], rec: Progress, what: string): Promise<void> {
		const done = new Set([...rec.placed, ...rec.skipped]);
		trip.resetPlan(Math.max(1, cells.length - rec.placed.length));
		let reachFails = 0;
		for (const dc of cells) {
			if (stopped || trip.halted) return;
			const k = cellKey(dc.cell);
			if (done.has(k)) continue;
			stats.current = `${what} ${rec.placed.length}/${cells.length}`;
			const below = cellKey({ ...dc.cell, y: dc.cell.y - 1 });
			if (cells.some((c) => cellKey(c.cell) === below) && !rec.placed.includes(below)) {
				rec.skipped.push(k);
				done.add(k);
				continue;
			}
			const verdictNow = () => checkPlace(dc.cell, dc.block, { world: o.world, own, kids: kidsNow(), stop, now: clock(), lastEditT, noEdits: o.noEdits, halted: trip.halted, self: o.body.pose() });
			let v = verdictNow();
			if (v.ok) {
				const there = await approach(o.body, o.world, { origin: dc.cell, w: 1, d: 1 }, dc.cell, (e) => o.log({ ...e, t: clock() }));
				if (stopped) return;
				if (!there || eyeDist(o.body.pose(), dc.cell) > PLACE_MAX) {
					stats.failed++;
					o.log({ k: 'unreachable', t: clock(), cell: dc.cell, fails: ++reachFails });
					rec.skipped.push(k);
					done.add(k);
					if (reachFails >= MAX_REACH_FAILS) {
						reachFails = 0;
						await sleep(5000);
					}
					continue;
				}
				reachFails = 0;
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
					done.add(k);
					continue;
				}
				await sleep(2000);
				return; // stop signal / no-edits / halted: try again later
			}
			// The last word before the write: only into air.
			if (o.world.getBlock(dc.cell.x, dc.cell.y, dc.cell.z) !== 0) {
				rec.skipped.push(k);
				done.add(k);
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
			done.add(k);
			if (ok) {
				rec.placed.push(k);
				const id = blockId(dc.block);
				if (id !== null) {
					file.owned[k] = id;
					own.ownWrite(dc.cell.x, dc.cell.y, dc.cell.z, id);
					o.shared?.append(dc.cell, id);
				}
				stats.placed++;
			} else {
				rec.skipped.push(k);
				stats.failed++;
			}
			o.log({ k: 'place', t: lastEditT, what, cell: dc.cell, block: dc.block, ok });
			save();
			await sleep(pace);
		}
		if (stopped || trip.halted) return;
		rec.status = 'done';
		save();
		o.log({ k: `${what.split(' ')[0]}-end`, t: clock(), placed: rec.placed.length, skipped: rec.skipped.length, cells: cells.length });
	}

	/** No more edits: a stroll along the streets, looking at the lots. */
	async function wander(p: NeighbourhoodPlan, ms: number): Promise<void> {
		const until = clock() + ms;
		const cx = p.corner.x + areaW(p.cols) / 2, cz = p.corner.z + areaD(p.rows) / 2;
		while (!stopped && clock() < until) {
			if (o.rng() < 0.5 && p.roads.length) {
				const r = p.roads[Math.floor(o.rng() * p.roads.length) % p.roads.length].cell;
				const y = groundTop(o.world, r.x, r.z) + 1;
				if (y > 0) await Promise.race([o.body.flyTo({ x: r.x + 0.5, y, z: r.z + 0.5 }).catch(() => undefined), sleep(4000)]);
			} else {
				const l = p.lots[Math.floor(o.rng() * p.lots.length) % p.lots.length];
				o.body.lookAt(l.origin.x + l.w / 2, l.origin.y + 2, l.origin.z + l.d / 2);
			}
			if (stopped) return;
			if (o.rng() < 0.2) o.body.lookAt(cx, o.body.pose().y + 1.6, cz);
			await sleep(Math.min(until - clock(), 2500 + o.rng() * 2500));
		}
	}

	async function once(): Promise<void> {
		const p = await thePlan();
		if (!p) {
			stats.current = 'no neighbourhood site found; waiting';
			await sleep(60_000);
			return;
		}
		if (file.planId !== p.id) {
			file.planId = p.id;
			file.roads = fresh();
			file.lamps = fresh();
			save();
		}
		stats.lots = p.lots.length;
		stats.lotsBuilt = p.lots.filter((l) => l.status === 'built').length;
		if (file.roads.status === 'placing') {
			await placeCells(p.roads, file.roads, 'roads of the neighbourhood');
			if (file.roads.status === 'placing') return;
		}
		stats.roadsDone = true;
		if (file.lamps.status === 'placing') {
			await placeCells(p.lamps, file.lamps, 'lamps along the streets');
			if (file.lamps.status === 'placing') return;
			const top = Math.max(...p.lots.map((l) => l.origin.y)) + 6;
			o.body.fx({ kind: 'firework', x: p.corner.x + areaW(p.cols) / 2, y: top, z: p.corner.z + areaD(p.rows) / 2 });
		}
		stats.lampsDone = true;
		stats.current = `streets done; ${stats.lotsBuilt}/${stats.lots} lots built; strolling`;
		await wander(p, 60_000);
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
			o.status!(`${o.name}: ${stats.current} | roads ${file.roads.placed.length}${stats.roadsDone ? ' done' : ''} | lamps ${file.lamps.placed.length / 2}${stats.lampsDone ? ' done' : ''} | lots built ${stats.lotsBuilt}/${stats.lots} | placed ${stats.placed}${paused}${trip.halted ? ' | EDITS HALTED' : ''}`);
		}, o.statusEveryMs ?? 30_000)
		: null;

	o.log({ k: 'start', t: clock(), bot: 'foreman', name: o.name, noEdits: o.noEdits, plan: o.planPath, resume: file.planId });
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
			if (existsSync(dirname(o.statePath)) || file.planId) save();
			o.log({ k: 'stop', t: clock(), stats });
		},
	};
}
