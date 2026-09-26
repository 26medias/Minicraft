/**
 * The landscaper bot: it makes flat ground for the other bots (and the kid) to build on, with the game's own toys.
 * Loop: take an open 'flat-needed' post or a kid's red marker from the shared board, else pick a hilly patch near the
 * foreman's neighbourhood (or spawn) itself — the model chooses among ≤ 3 candidate 16 × 16 squares; plan the flatten
 * TNT centres covering the square; for each blast: mine the recipe's raw ingredients into its own inventory, craft a
 * Flattening TNT by the Craft tab's rules, dig a hole so the TNT sits on natural ground at the floor level, place it,
 * prime it (fx), wait the game's fuse, and apply the game's own blast cells — filtered to natural cells, and dropped
 * whole when any is within 12 of a kid cell, within 24 of a kid, or touches liquid — as batched edits with an fx boom.
 * When the square is done it posts 'flattened' (region, floor, requester) on the board. A flat-needed request's size is
 * honoured: a square of that side, flat all over at one floor. No rest between the blasts of one area; between areas it
 * lands, readies the next TNT, and idles on the ground (the shared wanderer), never hovering.
 *
 * Safety: mining goes through judgeSafety and a Tripwire per dig; a blast's removals go through a plan-bound budget
 * (exactly the filtered cells, nothing else, or the session halts). `--when players` pauses everything (no model
 * calls, no edits) while no kid is online; a lit fuse is always finished.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blastCells, blockId, tntSpec, WORLDGEN_BLOCKS, type Face } from 'minicraft-bot';
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
import { AREA, blastWorld, ColumnTops, filterBlast, kidCellsNear, KID_CELL_DIST, MIN_SPOT_REMOVE, spotKey as cellKey, terrainTop, type AreaPlan } from './blast-plan.js';
import { searchAreas } from './area-search.js';
import { LagMonitor, Slicer } from '../shared/slice.js';
import { craftUpTo, rawShortfall, type Inventory } from './craft.js';
import { gather, mineCell, travelTo, type GatherCtx } from './gather.js';
import type { SharedCells } from '../shared/bot-cells.js';
import { idlePaused, PresenceGate, type WhenMode } from '../shared/when.js';
import { flyLeg, landingFor } from '../nav/navigate.js';
import { pickWanderSpot, wanderer } from '../nav/wander.js';
import { minutesUntilSlot, msUntilSlot, windowCount, windowReached } from '../shared/cap.js';

export const DEFAULT_MAX_BLASTS = 15;
const TOY = 'flatten_tnt';
const TOY_ID = blockId(TOY)!;
const FUSE_MS = tntSpec(TOY)!.fuse * 1000;
export { SEARCH_RADII, SPAWN_CLEAR } from './area-search.js';
/** An area tried (picked) is not picked again, nor any square overlapping it, for this long. */
export const TRIED_AREA_MS = 60 * 60_000;
/** The rest between areas when `--rest-sec` is not given (between blasts of one area there is none). */
export const LANDSCAPER_REST_SEC = 15;

export interface LandscapeArea extends AreaPlan {
	id: string; status: 'active' | 'done' | 'abandoned'; t: number; why?: string;
	/** Indices of spots blasted (or skipped). */
	done: number[];
	/** Indices of spots skipped (their filtered blast was too small, or tried before): no TNT placed. */
	skipped?: number[];
	/** The board post it answers, if any. */
	post?: string; requester?: string;
}
export interface BlastRecord { t: number; area: string; tnt: Vec3; removed: number; planned: number; dropped?: string }
export interface LandscaperFile {
	v: 1; inv: Inventory; areas: LandscapeArea[]; blasts: BlastRecord[]; crafts: Array<{ t: number; recipes: string[] }>;
	/** The cells it last wrote (a mined or blasted cell: 0), so its own work never counts as a kid's. */
	owned: Record<string, number>;
	/** `--grant-ores` was applied to this file (once per file: restarts never re-grant). */
	granted?: boolean;
	/** Every area picked (never re-picked, nor overlapped, within TRIED_AREA_MS). */
	triedAreas: Array<{ x0: number; z0: number; size: number; t: number }>;
	/** Every blast spot tried ("x,y,z", its TNT cell: a TNT placed, or the spot skipped): never blasted again. */
	triedSpots: string[];
}

/** The TNT toys the landscaper crafts; `--grant-ores` covers their raw ingredients. */
const GRANT_TOYS = ['flatten_tnt', 'tunnel_tnt'];
/** What `--grant-ores` grants: every generated ore, and the raw (mined) ingredients of the toys, by the game's recipes. */
export function grantList(): string[] {
	const out = new Set(WORLDGEN_BLOCKS.filter((n) => n.endsWith('_ore')));
	for (const toy of GRANT_TOYS) for (const m of rawShortfall(toy, 1, {})) out.add(m.anyOf[0]);
	return [...out].sort();
}

export function landscaperStatePath(stateRoot: string, target: string, world: string, name: string): string {
	return join(stateRoot, 'landscaper', target, world, `${name}.json`);
}
export function loadLandscaperFile(path: string): LandscaperFile {
	try {
		const f = JSON.parse(readFileSync(path, 'utf8')) as LandscaperFile;
		if (f && f.v === 1 && f.inv && Array.isArray(f.areas)) return { ...f, owned: f.owned ?? {}, triedAreas: f.triedAreas ?? [], triedSpots: f.triedSpots ?? [] };
	} catch {
		// fresh
	}
	return { v: 1, inv: {}, areas: [], blasts: [], crafts: [], owned: {}, triedAreas: [], triedSpots: [] };
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
	/** The rest between areas (default LANDSCAPER_REST_SEC); none between the blasts of one area. */
	restMs?: number;
	/** The TNT fuse it waits (default: the game's); tests shorten it. */
	fuseMs?: number;
	/** Blasts in all (counted from the state file, so across restarts); default 6. */
	maxBlasts?: number;
	/** 'players': act only while a kid is online (resume 5 s after one joins). */
	when?: WhenMode;
	/** Mines one cell (default body.mine: the hand's time); `face` is the face it hits. */
	mine?: (x: number, y: number, z: number, face?: Face) => Promise<boolean>;
	/** The pickaxe tier it mines with (`--pickaxe`, default 0: the hand); a multi-block tier also breaks the area. */
	pickaxe?: number;
	/** `--grant-ores N`: at the first start of this state file, N of each ore and TNT raw ingredient into the inventory. */
	grantOres?: number;
	/** Breaks a batch of cells as one edit (BotClient.breakMany). */
	breakMany: (cells: ReadonlyArray<{ x: number; y: number; z: number; expect?: number }>) => Promise<Vec3[]>;
	/** The side of the squares it levels (default AREA, 16; the e2e uses 8: one TNT). */
	areaSize?: number;
	/** The shared bot-cell registry: its writes are appended (so other bots never take them for a kid's); others' count as bot cells. */
	shared?: SharedCells | null;
}
export interface LandscaperStats { blasts: number; dropped: number; removed: number; mined: number; crafted: number; areasDone: number; asks: number; fallbacks: number; current: string }
export interface LandscaperHandle { stop(): Promise<void>; stats: LandscaperStats; file: LandscaperFile; done: Promise<void> }

export function runLandscaper(o: LandscaperOpts): LandscaperHandle {
	const clock = o.clock ?? (() => Date.now());
	const file = loadLandscaperFile(o.statePath);
	const own = new Ownership(o.world, () => file.owned, o.shared ? () => o.shared!.cells() : undefined);
	/** Records its own writes: the state file, ownership, and the shared registry. */
	const wrote = (cells: readonly Vec3[], id: number) => {
		for (const c of cells) {
			file.owned[`${c.x},${c.y},${c.z}`] = id;
			own.ownWrite(c.x, c.y, c.z, id);
		}
		o.shared?.appendMany(cells, id);
	};
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

	// The --when players pause (the shared PresenceGate: 5 s debounce, logs paused/resumed): no model calls, no edits.
	const presence = new PresenceGate({ mode: o.when ?? 'always', players: () => o.body.players(), clock, log: (e) => o.log({ ...e, t: clock() }) });
	async function gate(): Promise<void> {
		while (!stopped && presence.paused()) {
			stats.current = 'paused: no players online';
			await idlePaused(o.body, sleep, o.rng);
		}
	}

	/** The terrain tops of columns it has looked at (reused across searches), kept true by every edit event. */
	const tops = new ColumnTops(o.world);
	const unsubs = [
		o.body.onEdit((e) => {
			for (const c of e.cells) tops.invalidate(c.x, c.z);
			const who = stop.onEdit(e, o.body.journal(), clock());
			if (who) o.log({ k: 'stop-signal', kid: who, t: clock() });
			for (const op of own.onEdit(e, o.body.you)) if (op.value === undefined) delete file.owned[op.path[1] as string];
		}),
		o.body.onReconnect(() => {
			own.reset();
			tops.clear();
		}),
	];

	const anchor = (): Vec3 => {
		const plan = o.planPath ? readPlan(o.planPath) : null;
		return plan ? { ...plan.anchor } : o.spawn;
	};

	const gctx: GatherCtx = {
		body: o.body, world: o.world, own, inv: file.inv, kidsNow, stop, trip, edits, noEdits: o.noEdits, clock, sleep,
		stopped: () => stopped || halted() !== null, gate, log: o.log, mine: o.mine ?? ((x, y, z) => o.body.mine(x, y, z)),
		tier: o.pickaxe ?? 0, breakMany: o.breakMany,
		anchor: o.spawn, onWrite: (cell, id) => wrote([cell], id), onChange: () => {
			stats.mined++;
			save();
		},
	};

	const watcher = new MarkerWatcher({
		name: o.name, body: o.body, world: o.world, boardPath: o.boardPath, log: o.log, clock,
		isKid: (x, y, z) => own.classify(x, y, z) === 'kid',
		active: () => o.when !== 'players' || hasPlayer(),
	});

	/**
	 * The candidate squares around `a`, best first: the nearest ring (SEARCH_RADII) that has any. `req` (a board
	 * request's side): squares of that side, the whole square flat at the floor when done, and all of it (not only its
	 * centre) at least SPAWN_CLEAR from spawn.
	 */
	async function candidates(a: { x: number; z: number }, req?: number): Promise<AreaPlan[]> {
		const size = req ?? o.areaSize ?? AREA;
		const now = clock();
		const busy = [...file.areas.filter((x) => x.status !== 'abandoned'), ...file.triedAreas.filter((x) => now - x.t < TRIED_AREA_MS)];
		const tried = new Set(file.triedSpots);
		const slicer = new Slicer();
		const t0 = clock();
		const r = await searchAreas({
			world: o.world, classify: (x, y, z) => own.classify(x, y, z), tops, spawn: o.spawn, kids: kidsNow(), busy,
			skipSpot: (x, y, z) => tried.has(cellKey(x, y, z)), alive: () => !stopped, slicer,
		}, a, size, req);
		o.log({ k: 'area-search', t: clock(), anchor: a, radius: r.radius, size, found: r.found.length, rejections: r.rejections, candidates: r.candidates, ms: clock() - t0, slices: slicer.yields, longestSliceMs: Math.round(slicer.longest) });
		return r.found;
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
		// A flat-needed request's size is honoured: a square of that side, flat all over at one floor.
		const req = src?.type === 'flat-needed' && src.size ? Math.max(src.size, o.areaSize ?? AREA) : undefined;
		const cands = (await candidates(a, req)).slice(0, 3);
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
				return [`area-${i + 1}`, `a ${c.range > 6 ? 'steep' : c.range > 3 ? 'hilly' : 'bumpy'} patch ${d} blocks ${dirName(cx - a.x, cz - a.z)} (${c.removes} blocks to blast, ${c.spots.length} TNT${(c.layers ?? 1) > 1 ? ` in ${c.layers} layers` : ''})`];
			}));
			const state = `I am ${o.name}, a landscaper robot. I blow away hills with Flattening TNT so my friends can build houses on flat ground. ${src ? `Someone asked for flat ground here (${src.type}).` : 'Nobody asked yet; I pick a spot near the village.'}`;
			const choice = await ask('area', state, 'Pick the patch that would make the nicest flat building ground for the least blasting.', options);
			const i = choice ? Number(choice.slice('area-'.length)) - 1 : -1;
			if (cands[i]) pick = cands[i];
		}
		const area: LandscapeArea = { ...pick, id: clock().toString(36), status: 'active', t: clock(), done: [], post: src?.id, requester: src?.requester };
		file.areas.push(area);
		file.triedAreas.push({ x0: area.x0, z0: area.z0, size: area.size, t: area.t });
		save();
		o.log({ k: 'area', t: clock(), id: area.id, x0: area.x0, z0: area.z0, size: area.size, L: area.L, spots: area.spots.map((s) => s.tnt), removes: area.removes, removableFiltered: area.removableFiltered, range: area.range, floor: area.L, layers: area.layers ?? 1, post: area.post ?? null });
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
			wrote([cell], TOY_ID);
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
			wrote(got, 0);
			save();
		}
	}

	const filterCtx = (tnt: Vec3) => {
		const classify = (x: number, y: number, z: number) => own.classify(x, y, z);
		return { world: o.world, classify, kids: kidsNow(), kidCells: kidCellsNear(o.world, classify, tnt.x - 8, tnt.z - 8, tnt.x + 8, tnt.z + 8, KID_CELL_DIST + 1) };
	};

	/** The filtered cells a blast at `tnt` would remove now. */
	const filteredNow = (tnt: Vec3) => filterBlast(blastCells(blastWorld(o.world), TOY, tnt).destroyed, filterCtx(tnt));
	const spotKey = (tnt: Vec3) => cellKey(tnt.x, tnt.y, tnt.z);

	/**
	 * One blast at spot `i` of `area`: null when done (or dropped for safety), `{ skipped }` when the spot is not worth a
	 * TNT (tried before, or its filtered blast removes fewer than MIN_SPOT_REMOVE cells: nothing placed), else why it
	 * could not go ahead.
	 */
	async function blast(area: LandscapeArea, i: number): Promise<string | null | { skipped: string }> {
		const spot = area.spots[i];
		const tnt = spot.tnt;
		const w = o.world;
		// 0. Worth a TNT? Never the same spot twice; never a blast that would remove (almost) nothing.
		if (file.triedSpots.includes(spotKey(tnt))) return { skipped: 'spot tried before' };
		const first = filteredNow(tnt);
		if (first.dropped) return `unsafe now: ${first.dropped}`;
		if (first.remove.length < MIN_SPOT_REMOVE) return { skipped: `filtered blast removes ${first.remove.length} < ${MIN_SPOT_REMOVE}` };
		// 1. A TNT in the inventory: mine the ingredients, craft.
		const noToy = await ensureToy();
		if (noToy) return noToy;
		await gate();
		if (stopped || halted()) return 'stopped';
		// 2. Is it still safe? (Kids move; the world changes.)
		const pre = filteredNow(tnt);
		if (pre.dropped) return `unsafe now: ${pre.dropped}`;
		if (pre.remove.length < MIN_SPOT_REMOVE) return { skipped: `filtered blast removes ${pre.remove.length} < ${MIN_SPOT_REMOVE}` };
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
		file.triedSpots.push(spotKey(tnt));
		save();
		// Out of the blast: straight up above its top, off to the side.
		const out = { x: tnt.x + 0.5 + 9, y: tnt.y + 16, z: tnt.z + 0.5 };
		await o.body.flyTo({ x: tnt.x + 0.5, y: out.y, z: tnt.z + 0.5 }).catch(() => undefined);
		await o.body.flyTo(out).catch(() => undefined);
		o.body.lookAt(tnt.x + 0.5, tnt.y + 0.5, tnt.z + 0.5);
		const again = filteredNow(tnt);
		if (again.dropped || (o.when === 'players' && !hasPlayer())) {
			await takeBack(tnt);
			return `not lit: ${again.dropped ?? 'no players online'}`;
		}
		if (again.remove.length < MIN_SPOT_REMOVE) {
			await takeBack(tnt);
			return { skipped: `not lit: filtered blast removes ${again.remove.length} < ${MIN_SPOT_REMOVE}` };
		}
		// 5. Prime (the kids see the fuse), wait the game's fuse — never cut short, even by a stop.
		o.body.fx({ kind: 'prime', x: tnt.x, y: tnt.y, z: tnt.z, tier: TOY_ID });
		o.log({ k: 'prime', t: clock(), area: area.id, tnt, fuseMs: FUSE_MS });
		stats.current = `TNT ${i + 1}/${area.spots.length} lit at ${tnt.x},${tnt.z}`;
		await new Promise((r) => setTimeout(r, o.fuseMs ?? FUSE_MS));
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
		wrote(removed, 0);
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
				type: 'flattened', region: { x0: a.x0, z0: a.z0, x1: a.x0 + a.size - 1, z1: a.z0 + a.size - 1, y: a.L }, size: a.size, floor: a.L,
				requester: a.requester ?? o.name, note: `flattened by ${o.name}: heights ${h.lo}..${h.hi}`, key: `flattened-${o.name}-${a.id}`,
			}, clock());
			if (a.post) complete(o.boardPath, a.post, o.name, clock(), { note: `flattened ${a.x0},${a.z0} (${a.size}×${a.size})` });
		} catch (err) {
			o.log({ k: 'board-error', t: clock(), err: err instanceof Error ? err.message : String(err) });
		}
		o.log({ k: 'flattened', t: clock(), id: a.id, x0: a.x0, z0: a.z0, size: a.size, lo: h.lo, hi: h.hi });
		o.body.fx({ kind: 'firework', x: a.x0 + a.size / 2, y: h.hi + 4, z: a.z0 + a.size / 2 });
	}

	const wand = wanderer(o.body, o.world, { rng: o.rng, clock, log: (e) => o.log({ ...e, t: clock() }) });

	/** Down onto the ground under it (the navigator's landing) when it is in the air: it never idles hovering. */
	async function land(): Promise<void> {
		const p = o.body.pose();
		const to = landingFor(o.world, { x: p.x, z: p.z });
		if (p.y - to.y <= 0.5) return;
		await flyLeg(o.body, to, { alive: () => !stopped }).catch(() => undefined);
	}

	/** Idles `ms` on the ground: landed first, then short wanders (the shared wanderer) and looks around. */
	async function idle(ms: number): Promise<void> {
		await land();
		const until = clock() + ms;
		const c = o.body.pose();
		while (!stopped && clock() < until) {
			if (o.rng() < 0.4) await wand.go(pickWanderSpot(o.world, { x: c.x, z: c.z }, o.rng, 2, 6), () => !stopped && clock() < until);
			const q = o.body.pose(), a = o.rng() * Math.PI * 2;
			o.body.lookAt(q.x + Math.cos(a) * 8, q.y + 1 + o.rng() * 2, q.z + Math.sin(a) * 8);
			await sleep(Math.max(0, Math.min(until - clock(), 2000 + o.rng() * 2000)));
		}
	}

	/** The blast timestamps counting toward the hourly cap (a dropped blast placed nothing: it never counts). */
	const blastTimes = (): number[] => file.blasts.filter((b) => !b.dropped).map((b) => b.t);

	/** The rest between areas: on the ground, the next area picked and its TNT made ready meanwhile, then idling out the rest. */
	async function rest(): Promise<void> {
		const until = clock() + (o.restMs ?? LANDSCAPER_REST_SEC * 1000);
		stats.current = 'resting between areas';
		await land();
		if (!windowReached(blastTimes(), clock(), maxBlasts) && !stopped && !halted()) {
			const next = file.areas.find((a) => a.status === 'active') ?? await pickArea();
			if (next && (file.inv[TOY] ?? 0) < 1) {
				gctx.anchor = { x: next.x0 + next.size / 2, z: next.z0 + next.size / 2 };
				stats.current = `getting a TNT ready for the next area ${next.id}`;
				const why = await ensureToy();
				if (why) o.log({ k: 'precraft-failed', t: clock(), area: next.id, why });
				await land();
			}
		}
		stats.current = 'resting between areas';
		await idle(Math.max(0, until - clock()));
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
					await idle(5000);
					continue;
				}
				const nowT = clock();
				if (windowReached(blastTimes(), nowT, maxBlasts)) {
					const n = windowCount(blastTimes(), nowT);
					const nextMin = minutesUntilSlot(msUntilSlot(blastTimes(), nowT, maxBlasts));
					stats.current = `hourly limit reached (${n}/${maxBlasts}), next in ${nextMin} min`;
					await idle(60_000);
					continue;
				}
				const area = file.areas.find((a) => a.status === 'active') ?? await pickArea();
				if (!area) {
					stats.current = 'no area to flatten; waiting';
					await idle(10_000);
					continue;
				}
				gctx.anchor = { x: area.x0 + area.size / 2, z: area.z0 + area.size / 2 };
				// Never mine in (or beside) a square being levelled: a staircase there would leave holes under the floor.
				gctx.avoid = file.areas.filter((a) => a.status !== 'abandoned').map((a) => ({ x0: a.x0 - 2, z0: a.z0 - 2, x1: a.x0 + a.size + 1, z1: a.z0 + a.size + 1 }));
				const i = area.spots.findIndex((_, k) => !area.done.includes(k));
				if (i < 0) {
					if (area.spots.length > 0 && (area.skipped?.length ?? 0) === area.spots.length) {
						area.status = 'abandoned';
						area.why = 'every spot skipped: nothing worth blasting';
						save();
					} else {
						finishArea(area);
						await rest();
					}
					continue;
				}
				if (area.post) renew(o.boardPath, area.post, o.name, clock());
				const why = await blast(area, i);
				if (why === 'stopped' || stopped) continue;
				if (why && typeof why === 'object') {
					o.log({ k: 'blast-skipped', t: clock(), area: area.id, spot: i, tnt: area.spots[i].tnt, reason: why.skipped });
					if (!file.triedSpots.includes(spotKey(area.spots[i].tnt))) file.triedSpots.push(spotKey(area.spots[i].tnt));
					area.done.push(i);
					(area.skipped ??= []).push(i);
					if (area.done.length === area.spots.length) {
						if (area.skipped.length === area.spots.length) {
							area.status = 'abandoned';
							area.why = 'every spot skipped: nothing worth blasting';
							o.log({ k: 'area-dropped', t: clock(), area: area.id, why: area.why });
							if (area.post) complete(o.boardPath, area.post, o.name, clock(), { status: 'open', note: area.why });
						} else {
							finishArea(area);
							save();
							await rest();
						}
					}
					save();
					continue;
				}
				if (why) {
					o.log({ k: 'blast-failed', t: clock(), area: area.id, spot: i, why });
					area.status = 'abandoned';
					area.why = why;
					if (area.post) complete(o.boardPath, area.post, o.name, clock(), { status: 'open', note: why });
					save();
					await idle(10_000);
					continue;
				}
				area.done.push(i);
				save();
				// Between the blasts of one area: straight on to the next (its TNT, its hole). The rest is between areas.
				if (area.done.length === area.spots.length) {
					finishArea(area);
					await rest();
				}
			} catch (err) {
				o.log({ k: 'error', t: clock(), err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
				await sleep(5000);
			}
		}
	}

	// The event-loop guard: a blocked loop starves the socket (pings, poses) until the server drops it.
	const lag = new LagMonitor((ms) => o.log({ k: 'lag', t: clock(), ms, doing: stats.current }));
	const statusTimer = o.status
		? setInterval(() => {
			o.status!(`${o.name}: ${stats.current} | blasts ${stats.blasts} (dropped ${stats.dropped}), removed ${stats.removed} | mined ${stats.mined} | areas ${stats.areasDone} | engine ${o.primary?.name ?? 'none'} (fallbacks ${stats.fallbacks}/${stats.asks})${halted() ? ' | EDITS HALTED' : ''}`);
		}, o.statusEveryMs ?? 30_000)
		: null;

	if (o.grantOres && o.grantOres > 0 && !file.granted) {
		const granted = grantList();
		for (const n of granted) file.inv[n] = (file.inv[n] ?? 0) + o.grantOres;
		file.granted = true;
		save();
		o.log({ k: 'grant', t: clock(), each: o.grantOres, blocks: granted });
	}
	o.log({ k: 'start', t: clock(), pickaxe: o.pickaxe ?? 0, name: o.name, primary: o.primary?.name ?? null, secondary: o.secondary?.name ?? null, noEdits: o.noEdits, when: o.when ?? 'always', maxBlasts, inv: file.inv });
	const done = loop();
	return {
		stats,
		file,
		done,
		async stop() {
			stopped = true;
			for (const w of [...wakers]) w();
			if (statusTimer) clearInterval(statusTimer);
			lag.stop();
			await done;
			watcher.stop();
			for (const u of unsubs) u();
			if (existsSync(dirname(o.statePath)) || file.areas.length) save();
			o.log({ k: 'stop', t: clock(), stats });
		},
	};
}
