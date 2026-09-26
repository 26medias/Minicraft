/**
 * The landscaper bot: it makes flat ground for the other bots (and the kid) to build on, with the game's own toys.
 * Loop: take an open 'flat-needed' post or a kid's red marker from the shared board, else pick a hilly patch near the
 * foreman's neighbourhood (or spawn) itself — the model chooses among ≤ 3 candidate 16 × 16 squares; plan the flatten
 * TNT centres covering the square; for each blast: mine the recipe's raw ingredients into its own inventory, craft a
 * Flattening TNT by the Craft tab's rules, dig a hole so the TNT sits on natural ground at the floor level, place it,
 * prime it (fx), wait the game's fuse, and apply the game's own blast cells — filtered to natural cells, and dropped
 * whole when any is within 12 of a kid cell, within 24 of a kid, or touches liquid — as batched edits with an fx boom.
 * When the square is done it posts 'flattened' on the board.
 *
 * Safety: mining goes through judgeSafety and a Tripwire per dig; a blast's removals go through a plan-bound budget
 * (exactly the filtered cells, nothing else, or the session halts). `--when players` pauses everything (no model
 * calls, no edits) while no kid is online; a lit fuse is always finished.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blastCells, blockId, tntSpec } from 'minicraft-bot';
import { StopSignal } from '../body/stop-signal.js';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { Ownership } from '../brain2/ownership.js';
import { judgeSafety, Tripwire, type KidPos } from '../brain2/safety.js';
import { LIMITS } from '../brain2/data/limits.data.js';
import type { ChoiceEngine } from '../builder/engines.js';
import { makeAsk } from '../builder/builder.js';
import { readPlan } from '../foreman/plan-file.js';
import { claimNext, complete, post, renew, type Post } from '../board/board.js';
import { MarkerWatcher } from '../board/markers.js';
import { AREA, blastWorld, evaluateArea, filterBlast, kidCellsNear, KID_CELL_DIST, scoreArea, terrainTop, type AreaPlan } from './blast-plan.js';
import { craftUpTo, rawShortfall, type Inventory } from './craft.js';
import { gather, mineCell, travelTo, type GatherCtx } from './gather.js';

export const DEFAULT_MAX_BLASTS = 6;
const TOY = 'flatten_tnt';
const TOY_ID = blockId(TOY)!;
const FUSE_MS = tntSpec(TOY)!.fuse * 1000;
/** Candidate squares: origins on an 8-block grid within this of the anchor. */
const SEARCH_R = 48;
const RESUME_AFTER_PLAYER_MS = 5000;

export interface LandscapeArea extends AreaPlan {
	id: string; status: 'active' | 'done' | 'abandoned'; t: number; why?: string;
	/** Indices of spots blasted (or skipped). */
	done: number[];
	/** The board post it answers, if any. */
	post?: string; requester?: string;
}
export interface BlastRecord { t: number; area: string; tnt: Vec3; removed: number; planned: number; dropped?: string }
export interface LandscaperFile { v: 1; inv: Inventory; areas: LandscapeArea[]; blasts: BlastRecord[]; crafts: Array<{ t: number; recipes: string[] }> }

export function landscaperStatePath(stateRoot: string, target: string, world: string, name: string): string {
	return join(stateRoot, 'landscaper', target, world, `${name}.json`);
}
export function loadLandscaperFile(path: string): LandscaperFile {
	try {
		const f = JSON.parse(readFileSync(path, 'utf8')) as LandscaperFile;
		if (f && f.v === 1 && f.inv && Array.isArray(f.areas)) return f;
	} catch {
		// fresh
	}
	return { v: 1, inv: {}, areas: [], blasts: [], crafts: [] };
}
export function saveLandscaperFile(path: string, f: LandscaperFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(f));
	renameSync(tmp, path);
}

/**
 * The plan-bound budget for blast edits: a blast may remove exactly the cells planned for it, each once. Anything else
 * (an unplanned cell, a second pass, more than planned) halts every edit for the session.
 */
export class BlastBudget {
	private planned = new Set<string>();
	halted: string | null = null;
	plan(cells: readonly Vec3[]): void {
		this.planned = new Set(cells.map((c) => `${c.x},${c.y},${c.z}`));
	}
	get size(): number {
		return this.planned.size;
	}
	/** Accounts for cells about to be (or just) removed; false (and halted) on any cell not planned. */
	spend(cells: readonly Vec3[]): boolean {
		for (const c of cells) {
			const k = `${c.x},${c.y},${c.z}`;
			if (!this.planned.delete(k)) {
				this.halted ??= `blast budget: unplanned cell ${k}`;
				return false;
			}
		}
		return true;
	}
}

export interface LandscaperOpts {
	name: string; body: Body; world: WorldView; spawn: Vec3;
	primary: ChoiceEngine | null; secondary?: ChoiceEngine | null;
	noEdits: boolean; statePath: string; boardPath: string; planPath?: string;
	log: (o: Record<string, unknown>) => void; status?: (line: string) => void;
	rng: () => number; clock?: () => number; statusEveryMs?: number;
	/** The rest between blasts (default 30 s). */
	restMs?: number;
	/** Blasts in all (counted from the state file, so across restarts); default 6. */
	maxBlasts?: number;
	/** 'players': act only while a kid is online (resume 5 s after one joins). */
	when?: 'always' | 'players';
	/** Mines one cell (default body.mine: the hand's time). */
	mine?: (x: number, y: number, z: number) => Promise<boolean>;
	/** Breaks a batch of cells as one edit (BotClient.breakMany). */
	breakMany: (cells: ReadonlyArray<{ x: number; y: number; z: number; expect?: number }>) => Promise<Vec3[]>;
}
export interface LandscaperStats { blasts: number; dropped: number; removed: number; mined: number; crafted: number; areasDone: number; asks: number; fallbacks: number; current: string }
export interface LandscaperHandle { stop(): Promise<void>; stats: LandscaperStats; file: LandscaperFile; done: Promise<void> }

export function runLandscaper(o: LandscaperOpts): LandscaperHandle {
	const clock = o.clock ?? (() => Date.now());
	const file = loadLandscaperFile(o.statePath);
	const owned: Record<string, number> = {};
	const own = new Ownership(o.world, () => owned);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const trip = new Tripwire();
	const budget = new BlastBudget();
	const maxBlasts = o.maxBlasts ?? DEFAULT_MAX_BLASTS;
	const stats: LandscaperStats = { blasts: 0, dropped: 0, removed: 0, mined: 0, crafted: 0, areasDone: 0, asks: 0, fallbacks: 0, current: 'starting' };
	const edits = { lastEditT: null as number | null };
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
	const save = () => saveLandscaperFile(o.statePath, file);
	const kidsNow = (): KidPos[] => o.body.players().filter((p) => !p.bot && p.hasPos).map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z }));
	const hasPlayer = () => o.body.players().some((p) => !p.bot);
	const ask = makeAsk({ primary: o.primary, secondary: o.secondary, clock, log: o.log, stats });
	const halted = () => trip.halted ?? budget.halted;

	// The --when players pause: no model calls, no edits while no kid is online; resume 5 s after one joins.
	let paused = false;
	async function gate(): Promise<void> {
		if (o.when !== 'players') return;
		for (;;) {
			if (stopped) return;
			if (!hasPlayer()) {
				if (!paused) {
					paused = true;
					o.log({ k: 'paused', t: clock(), why: 'no players online' });
				}
				stats.current = 'paused: no players online';
				await sleep(1000);
				continue;
			}
			if (!paused) return;
			await sleep(RESUME_AFTER_PLAYER_MS);
			if (hasPlayer()) {
				paused = false;
				o.log({ k: 'resumed', t: clock() });
				return;
			}
		}
	}

	const unsubs = [
		o.body.onEdit((e) => {
			const who = stop.onEdit(e, o.body.journal(), clock());
			if (who) o.log({ k: 'stop-signal', kid: who, t: clock() });
			own.onEdit(e, o.body.you);
		}),
		o.body.onReconnect(() => own.reset()),
	];

	const anchor = (): Vec3 => {
		const plan = o.planPath ? readPlan(o.planPath) : null;
		return plan ? { ...plan.anchor } : o.spawn;
	};

	const gctx: GatherCtx = {
		body: o.body, world: o.world, own, inv: file.inv, kidsNow, stop, trip, edits, noEdits: o.noEdits, clock, sleep,
		stopped: () => stopped || halted() !== null, gate, log: o.log, mine: o.mine ?? ((x, y, z) => o.body.mine(x, y, z)),
		anchor: o.spawn, onChange: () => {
			stats.mined++;
			save();
		},
	};

	const watcher = new MarkerWatcher({
		name: o.name, body: o.body, world: o.world, boardPath: o.boardPath, log: o.log, clock,
		isKid: (x, y, z) => own.classify(x, y, z) === 'kid',
		active: () => o.when !== 'players' || hasPlayer(),
	});

	/** The candidate squares around `a`, best first. */
	async function candidates(a: { x: number; z: number }): Promise<AreaPlan[]> {
		const classify = (x: number, y: number, z: number) => own.classify(x, y, z);
		const kidCells = kidCellsNear(o.world, classify, a.x - SEARCH_R, a.z - SEARCH_R, a.x + SEARCH_R + AREA, a.z + SEARCH_R + AREA, KID_CELL_DIST + 8);
		const kids = kidsNow();
		const busy = file.areas.filter((x) => x.status !== 'abandoned');
		const out: AreaPlan[] = [];
		const rejections: Record<string, number> = {};
		for (let dx = -SEARCH_R; dx <= SEARCH_R; dx += 8) {
			for (let dz = -SEARCH_R; dz <= SEARCH_R; dz += 8) {
				if (stopped) return [];
				const x0 = Math.floor(a.x) + dx - AREA / 2, z0 = Math.floor(a.z) + dz - AREA / 2;
				if (busy.some((b) => x0 < b.x0 + b.size + 4 && x0 + AREA + 4 > b.x0 && z0 < b.z0 + b.size + 4 && z0 + AREA + 4 > b.z0)) continue;
				const r = evaluateArea(o.world, x0, z0, AREA, { classify, kidCells, kids });
				if (typeof r === 'string') rejections[r] = (rejections[r] ?? 0) + 1;
				else if (r.range >= 2) out.push(r);
				else rejections['already flat'] = (rejections['already flat'] ?? 0) + 1;
				await new Promise((res) => setImmediate(res));
			}
		}
		out.sort((p, q) => scoreArea(q, a) - scoreArea(p, a));
		o.log({ k: 'area-search', t: clock(), anchor: a, found: out.length, rejections });
		return out;
	}

	const dirName = (dx: number, dz: number) => {
		const ns = dz < -4 ? 'north' : dz > 4 ? 'south' : '';
		const ew = dx < -4 ? 'west' : dx > 4 ? 'east' : '';
		return ns || ew ? `${ns}${ns && ew ? '-' : ''}${ew}` : 'right here';
	};

	/** The next area: a board request first (flat-needed, then a kid's red marker), else the bot's own pick. */
	async function pickArea(): Promise<LandscapeArea | null> {
		let src: Post | null = null;
		try {
			src = claimNext(o.boardPath, 'flat-needed', o.name, clock()) ?? claimNext(o.boardPath, 'kid-marker', o.name, clock(), (p) => p.marker === 'flatten');
		} catch (err) {
			o.log({ k: 'board-error', t: clock(), err: err instanceof Error ? err.message : String(err) });
		}
		const a = src?.center ?? (src?.region ? { x: (src.region.x0 + src.region.x1) / 2, y: 0, z: (src.region.z0 + src.region.z1) / 2 } : anchor());
		stats.current = src ? `looking at ${src.type} ${src.id}` : 'looking for a hilly patch';
		const cands = (await candidates(a)).slice(0, 3);
		if (cands.length === 0) {
			if (src) complete(o.boardPath, src.id, o.name, clock(), { note: 'no safe area to flatten near it' });
			return null;
		}
		let pick = cands[0];
		if (cands.length > 1) {
			await gate();
			const options = Object.fromEntries(cands.map((c, i) => {
				const cx = c.x0 + c.size / 2, cz = c.z0 + c.size / 2;
				const d = Math.round(Math.hypot(cx - a.x, cz - a.z));
				return [`area-${i + 1}`, `a ${c.range > 6 ? 'steep' : c.range > 3 ? 'hilly' : 'bumpy'} patch ${d} blocks ${dirName(cx - a.x, cz - a.z)} (${c.removes} blocks to blast, ${c.spots.length} TNT)`];
			}));
			const state = `I am ${o.name}, a landscaper robot. I blow away hills with Flattening TNT so my friends can build houses on flat ground. ${src ? `Someone asked for flat ground here (${src.type}).` : 'Nobody asked yet; I pick a spot near the village.'}`;
			const choice = await ask('area', state, 'Pick the patch that would make the nicest flat building ground for the least blasting.', options);
			const i = choice ? Number(choice.slice('area-'.length)) - 1 : -1;
			if (cands[i]) pick = cands[i];
		}
		const area: LandscapeArea = { ...pick, id: clock().toString(36), status: 'active', t: clock(), done: [], post: src?.id, requester: src?.requester };
		file.areas.push(area);
		save();
		o.log({ k: 'area', t: clock(), id: area.id, x0: area.x0, z0: area.z0, size: area.size, L: area.L, spots: area.spots.map((s) => s.tnt), removes: area.removes, range: area.range, post: area.post ?? null });
		return area;
	}

	/** Mines and crafts until one Flattening TNT is in the inventory. */
	async function ensureToy(): Promise<string | null> {
		if ((file.inv[TOY] ?? 0) >= 1) return null;
		const missing = () => rawShortfall(TOY, 1, file.inv);
		if (missing().length) {
			stats.current = `mining ${missing().map((m) => `${m.count} ${m.anyOf[0]}`).join(', ')}`;
			o.log({ k: 'ingredients', t: clock(), need: missing(), inv: { ...file.inv } });
			const why = await gather(gctx, missing);
			if (why) return why;
		}
		const crafted = craftUpTo(TOY, 1, file.inv);
		if (!crafted) return 'craft failed';
		stats.crafted++;
		file.crafts.push({ t: clock(), recipes: crafted });
		save();
		o.log({ k: 'craft', t: clock(), recipes: crafted, inv: { ...file.inv } });
		return null;
	}

	/** Places a block from the inventory after the safety verdict (waiting out the edit gap). */
	async function placeToy(cell: Vec3): Promise<boolean> {
		for (let i = 0; i < 20; i++) {
			const v = judgeSafety({ kind: 'place', cell, block: TOY }, {
				world: o.world, own, kids: kidsNow(), stop, now: clock(), lastEditT: edits.lastEditT, noEdits: o.noEdits,
				inventory: file.inv, halted: halted(), helpBuild: false, planOwns: () => true,
			});
			if (v.ok) break;
			if (v.reason !== 'edit gap' || i === 19) {
				o.log({ k: 'place-refused', t: clock(), cell, reason: v.reason });
				return false;
			}
			await sleep(150);
		}
		const ok = await o.body.place(cell.x, cell.y, cell.z, TOY).catch(() => false);
		edits.lastEditT = clock();
		trip.recordEdit(cell, edits.lastEditT);
		if (ok) {
			file.inv[TOY]--;
			owned[`${cell.x},${cell.y},${cell.z}`] = TOY_ID;
			own.ownWrite(cell.x, cell.y, cell.z, TOY_ID);
			save();
		}
		return ok;
	}

	/** Takes an unlit TNT back (a blast that can't go ahead): the cell is the bot's own. */
	async function takeBack(cell: Vec3): Promise<void> {
		if (o.world.getBlock(cell.x, cell.y, cell.z) !== TOY_ID) return;
		budget.plan([cell]);
		const got = await o.breakMany([{ ...cell, expect: TOY_ID }]);
		budget.spend(got);
		if (got.length) {
			file.inv[TOY] = (file.inv[TOY] ?? 0) + 1;
			delete owned[`${cell.x},${cell.y},${cell.z}`];
			save();
		}
	}

	const filterCtx = (tnt: Vec3) => {
		const classify = (x: number, y: number, z: number) => own.classify(x, y, z);
		return { world: o.world, classify, kids: kidsNow(), kidCells: kidCellsNear(o.world, classify, tnt.x - 8, tnt.z - 8, tnt.x + 8, tnt.z + 8, KID_CELL_DIST + 1) };
	};

	/** One blast at spot `i` of `area`: null when done (or dropped for safety), else why it could not go ahead. */
	async function blast(area: LandscapeArea, i: number): Promise<string | null> {
		const spot = area.spots[i];
		const tnt = spot.tnt;
		const w = o.world;
		// 1. A TNT in the inventory: mine the ingredients, craft.
		const noToy = await ensureToy();
		if (noToy) return noToy;
		await gate();
		if (stopped || halted()) return 'stopped';
		// 2. Is it still safe? (Kids move; the world changes.)
		const pre = filterBlast(blastCells(blastWorld(w), TOY, tnt).destroyed, filterCtx(tnt));
		if (pre.dropped) return `unsafe now: ${pre.dropped}`;
		// 3. The hole: dig from the column's top down to the TNT cell, standing in it.
		stats.current = `digging the hole for TNT ${i + 1}/${area.spots.length} at ${tnt.x},${tnt.z}`;
		const top = terrainTop(w, tnt.x, tnt.z);
		if (!w.isSolid(w.getBlock(tnt.x, tnt.y - 1, tnt.z)) || own.classify(tnt.x, tnt.y - 1, tnt.z) !== 'natural') return 'no natural floor';
		if (!(await travelTo(gctx, { x: tnt.x + 0.5, y: Math.max(top + 1, tnt.y + 1), z: tnt.z + 0.5 }))) return 'cannot reach the spot';
		for (let y = Math.max(top, tnt.y); y >= tnt.y; y--) {
			if (w.getBlock(tnt.x, y, tnt.z) === 0) continue;
			if (!(await mineCell(gctx, { x: tnt.x, y, z: tnt.z }))) return 'hole refused';
			if (y > tnt.y) await o.body.flyTo({ x: tnt.x + 0.5, y, z: tnt.z + 0.5 }).catch(() => undefined);
		}
		// 4. Place it, then only light it when the blast can be finished (a kid online, in --when players).
		await gate();
		if (stopped || halted()) return 'stopped';
		o.body.lookAt(tnt.x + 0.5, tnt.y + 0.5, tnt.z + 0.5);
		if (!(await placeToy(tnt))) return 'place refused';
		// Out of the blast: straight up above its top, off to the side.
		const out = { x: tnt.x + 0.5 + 9, y: tnt.y + 16, z: tnt.z + 0.5 };
		await o.body.flyTo({ x: tnt.x + 0.5, y: out.y, z: tnt.z + 0.5 }).catch(() => undefined);
		await o.body.flyTo(out).catch(() => undefined);
		o.body.lookAt(tnt.x + 0.5, tnt.y + 0.5, tnt.z + 0.5);
		const again = filterBlast(blastCells(blastWorld(w), TOY, tnt).destroyed, filterCtx(tnt));
		if (again.dropped || (o.when === 'players' && !hasPlayer())) {
			await takeBack(tnt);
			return `not lit: ${again.dropped ?? 'no players online'}`;
		}
		// 5. Prime (the kids see the fuse), wait the game's fuse — never cut short, even by a stop.
		o.body.fx({ kind: 'prime', x: tnt.x, y: tnt.y, z: tnt.z, tier: TOY_ID });
		o.log({ k: 'prime', t: clock(), area: area.id, tnt, fuseMs: FUSE_MS });
		stats.current = `TNT ${i + 1}/${area.spots.length} lit at ${tnt.x},${tnt.z}`;
		await new Promise((r) => setTimeout(r, FUSE_MS));
		// 6. The game's cells now, filtered again: a kid who walked up drops the whole blast.
		const { destroyed } = blastCells(blastWorld(w), TOY, tnt);
		const f = filterBlast(destroyed, filterCtx(tnt));
		if (f.dropped) {
			stats.dropped++;
			file.blasts.push({ t: clock(), area: area.id, tnt, removed: 0, planned: 0, dropped: f.dropped });
			await takeBack(tnt);
			o.body.fx({ kind: 'boom', x: tnt.x, y: tnt.y, z: tnt.z, tier: TOY_ID });
			o.log({ k: 'blast-dropped', t: clock(), area: area.id, tnt, why: f.dropped });
			save();
			return null;
		}
		const ids = new Map(f.remove.map((c) => [`${c.x},${c.y},${c.z}`, w.getBlock(c.x, c.y, c.z)]));
		const cells = [{ ...tnt, expect: TOY_ID }, ...f.remove.map((c) => ({ ...c, expect: ids.get(`${c.x},${c.y},${c.z}`)! }))];
		budget.plan(cells);
		const removed = await o.breakMany(cells);
		if (!budget.spend(removed)) {
			o.log({ k: 'EDITS-HALTED', t: clock(), why: budget.halted });
			return 'halted';
		}
		o.body.fx({ kind: 'boom', x: tnt.x, y: tnt.y, z: tnt.z, tier: TOY_ID });
		delete owned[`${tnt.x},${tnt.y},${tnt.z}`];
		// The game counts what a blast removes (the TNT itself excepted).
		let n = 0;
		for (const c of removed) {
			if (c.x === tnt.x && c.y === tnt.y && c.z === tnt.z) continue;
			const name = w.blockName(ids.get(`${c.x},${c.y},${c.z}`) ?? 0);
			if (name) file.inv[name] = (file.inv[name] ?? 0) + 1;
			n++;
		}
		stats.blasts++;
		stats.removed += n;
		file.blasts.push({ t: clock(), area: area.id, tnt, removed: n, planned: f.remove.length });
		save();
		o.log({ k: 'blast', t: clock(), area: area.id, tnt, removed: n, planned: f.remove.length, destroyed: destroyed.length });
		return null;
	}

	/** Heights of the area's square now: min and max terrain top. */
	function heights(a: LandscapeArea): { lo: number; hi: number } {
		let lo = Infinity, hi = -Infinity;
		for (let x = a.x0; x < a.x0 + a.size; x++) for (let z = a.z0; z < a.z0 + a.size; z++) {
			const t = terrainTop(o.world, x, z);
			lo = Math.min(lo, t);
			hi = Math.max(hi, t);
		}
		return { lo, hi };
	}

	function finishArea(a: LandscapeArea): void {
		const h = heights(a);
		a.status = 'done';
		a.why = `heights ${h.lo}..${h.hi}`;
		stats.areasDone++;
		save();
		try {
			post(o.boardPath, {
				type: 'flattened', region: { x0: a.x0, z0: a.z0, x1: a.x0 + a.size - 1, z1: a.z0 + a.size - 1, y: h.hi }, size: a.size,
				requester: a.requester ?? o.name, note: `flattened by ${o.name}: heights ${h.lo}..${h.hi}`, key: `flattened-${o.name}-${a.id}`,
			}, clock());
			if (a.post) complete(o.boardPath, a.post, o.name, clock(), { note: `flattened ${a.x0},${a.z0} (${a.size}×${a.size})` });
		} catch (err) {
			o.log({ k: 'board-error', t: clock(), err: err instanceof Error ? err.message : String(err) });
		}
		o.log({ k: 'flattened', t: clock(), id: a.id, x0: a.x0, z0: a.z0, size: a.size, lo: h.lo, hi: h.hi });
		o.body.fx({ kind: 'firework', x: a.x0 + a.size / 2, y: h.hi + 4, z: a.z0 + a.size / 2 });
	}

	async function loop(): Promise<void> {
		let haltedLogged = false;
		watcher.scan(anchor(), 64);
		while (!stopped) {
			try {
				await gate();
				if (stopped) break;
				if (halted()) {
					if (!haltedLogged) o.log({ k: 'EDITS-HALTED', t: clock(), why: halted() });
					haltedLogged = true;
					stats.current = `EDITS HALTED (${halted()})`;
					await sleep(5000);
					continue;
				}
				if (file.blasts.filter((b) => !b.dropped).length >= maxBlasts) {
					stats.current = `blast cap reached (${maxBlasts}); resting`;
					await sleep(60_000);
					continue;
				}
				const area = file.areas.find((a) => a.status === 'active') ?? await pickArea();
				if (!area) {
					stats.current = 'no area to flatten; waiting';
					await sleep(10_000);
					continue;
				}
				gctx.anchor = { x: area.x0 + area.size / 2, z: area.z0 + area.size / 2 };
				const i = area.spots.findIndex((_, k) => !area.done.includes(k));
				if (i < 0) {
					finishArea(area);
					continue;
				}
				if (area.post) renew(o.boardPath, area.post, o.name, clock());
				const why = await blast(area, i);
				if (why === 'stopped' || stopped) continue;
				if (why) {
					o.log({ k: 'blast-failed', t: clock(), area: area.id, spot: i, why });
					area.status = 'abandoned';
					area.why = why;
					if (area.post) complete(o.boardPath, area.post, o.name, clock(), { status: 'open', note: why });
					save();
					await sleep(10_000);
					continue;
				}
				area.done.push(i);
				save();
				if (area.done.length === area.spots.length) finishArea(area);
				stats.current = 'resting between blasts';
				await sleep(o.restMs ?? 30_000);
			} catch (err) {
				o.log({ k: 'error', t: clock(), err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
				await sleep(5000);
			}
		}
	}

	const statusTimer = o.status
		? setInterval(() => {
			o.status!(`${o.name}: ${stats.current} | blasts ${stats.blasts} (dropped ${stats.dropped}), removed ${stats.removed} | mined ${stats.mined} | areas ${stats.areasDone} | engine ${o.primary?.name ?? 'none'} (fallbacks ${stats.fallbacks}/${stats.asks})${halted() ? ' | EDITS HALTED' : ''}`);
		}, o.statusEveryMs ?? 30_000)
		: null;

	o.log({ k: 'start', t: clock(), name: o.name, primary: o.primary?.name ?? null, secondary: o.secondary?.name ?? null, noEdits: o.noEdits, when: o.when ?? 'always', maxBlasts, inv: file.inv });
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
			watcher.stop();
			for (const u of unsubs) u();
			if (existsSync(dirname(o.statePath)) || file.areas.length) save();
			o.log({ k: 'stop', t: clock(), stats });
		},
	};
}
