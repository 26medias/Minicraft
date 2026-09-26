/**
 * The landscaper's mining: it gets the raw ingredients of a recipe into its own inventory by mining them, one block at
 * a time with the hand's mining time, the way a kid does. brain2's Mine behaviour is bound to its runner, so this is a
 * small standalone routine on the same geometry (brain2's spiral staircase: a 3×3 spiral around a never-broken pillar,
 * no tunnel) and the same safety (judgeSafety per cell: natural cells only, never beside a kid's cell or body, never a
 * cell touching liquid; a Tripwire bound to the dig's planned cells).
 *
 * - A target near the surface (the column's top block or the one under it) is mined from above.
 * - A buried one is reached by a spiral staircase whose 3×3 pillar area is natural, dry, clear overhead, ≥ 12 from any
 *   kid cell and ≥ 24 from any kid; then the vein around it; then the bot climbs back out (escape flight if blocked).
 * - Every block mined goes into the inventory (the stone of the staircase included), and needed ores seen beside the
 *   staircase are mined on the way.
 *
 * Travel goes through the shared navigator (bots/src/nav/); the staircase steps stay plain walks (as brain2's dig).
 */
import { blockId } from 'minicraft-bot';
import type { StopSignal } from '../body/stop-signal.js';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import type { Ownership } from '../brain2/ownership.js';
import { judgeSafety, type KidPos, type Tripwire } from '../brain2/safety.js';
import { climbPath, safeToMine, spiralsFor, spiralStep, type Spiral } from '../brain2/behaviours/spiral.js';
import { escapeTarget } from '../brain2/behaviours/mine.js';
import { navigate } from '../nav/navigate.js';
import { KID_CELL_DIST, KID_POS_DIST, terrainTop } from './blast-plan.js';
import type { Inventory } from './craft.js';

const FACES: ReadonlyArray<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const REACH = 4.5;
const LEASH_STEPS = [32, 64, 96];
const WORLD_TOP = 255;
/** Blocks the staircase floor may be patched with, most-held first. */
const FILL = ['stone', 'dirt', 'deepslate', 'cobblestone', 'granite', 'diorite', 'andesite', 'tuff', 'grass_block'];
/** At most this many targets tried per gather call before it gives up. */
const MAX_TRIES = 8;

export interface GatherCtx {
	body: Body; world: WorldView; own: Ownership; inv: Inventory;
	kidsNow(): KidPos[]; stop: StopSignal; trip: Tripwire; edits: { lastEditT: number | null };
	noEdits: boolean; clock(): number; sleep(ms: number): Promise<void>; stopped(): boolean;
	/** Resolves when the bot may act (the --when players pause); called before every edit. */
	gate(): Promise<void>;
	log(e: Record<string, unknown>): void;
	/** Mines one cell (the hand's time by default; tests pass a shorter one). */
	mine(x: number, y: number, z: number): Promise<boolean>;
	/** The search anchor (spawn, or the foreman's neighbourhood). */
	anchor: { x: number; z: number };
	/** Called after every block added to the inventory (the caller saves). */
	onChange?(): void;
}

const key = (c: Vec3) => `${c.x},${c.y},${c.z}`;
const faces = (c: Vec3): Vec3[] => FACES.map(([dx, dy, dz]) => ({ x: c.x + dx, y: c.y + dy, z: c.z + dz }));
const eyeDist = (p: Vec3, c: Vec3) => Math.hypot(c.x + 0.5 - p.x, c.y + 0.5 - (p.y + 1.6), c.z + 0.5 - p.z);

function wet(w: WorldView, c: Vec3): boolean {
	return faces(c).some((n) => w.isLiquid(w.getBlock(n.x, n.y, n.z)));
}

/**
 * Mines one natural cell with the full safety verdict (waiting out the edit gap). True when it broke; the block goes
 * into the inventory.
 */
export async function mineCell(c: GatherCtx, cell: Vec3): Promise<boolean> {
	await c.gate();
	if (c.stopped()) return false;
	const w = c.world;
	const id = w.getBlock(cell.x, cell.y, cell.z);
	const name = w.blockName(id);
	if (id === 0 || !name || w.isLiquid(id) || name === 'bedrock') return false;
	if (c.own.classify(cell.x, cell.y, cell.z) !== 'natural') return false;
	for (let i = 0; i < 20; i++) {
		const v = judgeSafety({ kind: 'mine', cell }, {
			world: w, own: c.own, kids: c.kidsNow(), stop: c.stop, now: c.clock(), lastEditT: c.edits.lastEditT, noEdits: c.noEdits,
			inventory: {}, halted: c.trip.halted, helpBuild: false, planOwns: () => true,
		});
		if (v.ok) break;
		if (v.reason !== 'edit gap') {
			c.log({ k: 'mine-refused', t: c.clock(), cell, reason: v.reason });
			return false;
		}
		await c.sleep(150);
		if (i === 19) return false;
	}
	let ok = false;
	try {
		ok = await c.mine(cell.x, cell.y, cell.z);
	} catch (err) {
		c.log({ k: 'mine-error', t: c.clock(), err: err instanceof Error ? err.message : String(err) });
	}
	const t = c.clock();
	c.edits.lastEditT = t;
	c.trip.recordEdit(cell, t);
	if (ok) {
		c.inv[name] = (c.inv[name] ?? 0) + 1;
		c.onChange?.();
	}
	c.log({ k: 'mine', t, cell, block: name, ok });
	return ok;
}

/** Places a fill block from the inventory (a staircase floor gap). */
async function fillCell(c: GatherCtx, cell: Vec3): Promise<boolean> {
	const block = FILL.reduce((best, b) => ((c.inv[b] ?? 0) > (c.inv[best] ?? 0) ? b : best), FILL[0]);
	if ((c.inv[block] ?? 0) <= 0) return false;
	await c.gate();
	for (let i = 0; i < 20; i++) {
		const v = judgeSafety({ kind: 'place', cell, block }, {
			world: c.world, own: c.own, kids: c.kidsNow(), stop: c.stop, now: c.clock(), lastEditT: c.edits.lastEditT, noEdits: c.noEdits,
			inventory: c.inv, halted: c.trip.halted, helpBuild: false, planOwns: () => true,
		});
		if (v.ok) break;
		if (v.reason !== 'edit gap' || i === 19) return false;
		await c.sleep(150);
	}
	const ok = await c.body.place(cell.x, cell.y, cell.z, block).catch(() => false);
	const t = c.clock();
	c.edits.lastEditT = t;
	c.trip.recordEdit(cell, t);
	if (ok) {
		c.inv[block]--;
		const id = blockId(block);
		if (id !== null) c.own.ownWrite(cell.x, cell.y, cell.z, id);
		c.onChange?.();
	}
	c.log({ k: 'fill', t, cell, block, ok });
	return ok;
}

/**
 * Gets the body to (x, y, z) (feet): the shared navigator to the column (walk, else fly high), then a straight flight
 * onto the exact point (a hover above a column, or into a hole). False when either leg fails.
 */
export async function travelTo(c: GatherCtx, to: Vec3): Promise<boolean> {
	const nav = await navigate(c.body, c.world, { x: to.x, y: to.y, z: to.z }, { log: c.log, alive: () => !c.stopped() });
	if (!nav.ok) {
		c.log({ k: 'travel-failed', t: c.clock(), to, why: nav.reason });
		return false;
	}
	const p = c.body.pose();
	if (Math.hypot(p.x - to.x, p.y - to.y, p.z - to.z) < 0.3) return true;
	try {
		// Straight up (or down) the column first when it is open, then across onto the point.
		if (to.y > p.y) await c.body.flyTo({ x: p.x, y: to.y, z: p.z });
		return (await c.body.flyTo(to)) === 'arrived';
	} catch (err) {
		c.log({ k: 'travel-blocked', t: c.clock(), to, err: err instanceof Error ? err.message : String(err) });
		return false;
	}
}

/** Whether the pillar area of `sp` qualifies: natural tops, dry, clear overhead, far from kid cells and kids. */
function pillarOk(c: GatherCtx, sp: Spiral): string | null {
	const w = c.world;
	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++) {
			const x = sp.px + dx, z = sp.pz + dz, s = terrainTop(w, x, z);
			if (s < 0 || c.own.classify(x, s, z) !== 'natural') return 'not-natural';
			if (w.isLiquid(w.getBlock(x, s + 1, z))) return 'liquid';
			if (w.isSolid(w.getBlock(x, s + 1, z)) || w.isSolid(w.getBlock(x, s + 2, z))) return 'headroom';
		}
	}
	if (c.own.kidCellWithin(sp.px, sp.pz, KID_CELL_DIST + 1.5)) return 'kid-cells';
	if (c.kidsNow().some((k) => Math.hypot(k.x - sp.px, k.z - sp.pz) <= KID_POS_DIST)) return 'kid';
	return null;
}

type Target = { cell: Vec3; d: number; surface: boolean; sp: Spiral | null };

/** The nearest reachable natural `names` cell around the anchor (widening 32 → 64 → 96), not in `dead`. */
async function findTarget(c: GatherCtx, names: readonly string[], dead: Set<string>): Promise<Target | null> {
	const ids = new Set(names.map((n) => blockId(n)).filter((v): v is number => v !== null));
	const w = c.world, a = c.anchor;
	let inner = -1;
	for (const r of LEASH_STEPS) {
		const cands: Array<{ cell: Vec3; d: number }> = [];
		for (let dx = -r; dx <= r; dx++) {
			for (let dz = -r; dz <= r; dz++) {
				const d = Math.hypot(dx, dz);
				if (d > r || d <= inner) continue;
				const x = Math.floor(a.x) + dx, z = Math.floor(a.z) + dz;
				for (let y = WORLD_TOP; y >= 1; y--) {
					if (!ids.has(w.getBlock(x, y, z))) continue;
					const cell = { x, y, z };
					if (!dead.has(key(cell)) && !wet(w, cell) && c.own.classify(x, y, z) === 'natural') cands.push({ cell, d });
					break;
				}
			}
			if (dx % 16 === 0) await new Promise((res) => setImmediate(res));
		}
		cands.sort((p, q) => p.d - q.d || q.cell.y - p.cell.y);
		for (const cand of cands.slice(0, 200)) {
			const top = terrainTop(w, cand.cell.x, cand.cell.z);
			if (cand.cell.y >= top - 1) {
				// From above: the column's top must be natural and dry, and no kid near.
				if (c.own.kidCellWithin(cand.cell.x, cand.cell.z, KID_CELL_DIST) || c.kidsNow().some((k) => Math.hypot(k.x - cand.cell.x, k.z - cand.cell.z) <= KID_POS_DIST)) continue;
				if (w.isLiquid(w.getBlock(cand.cell.x, top + 1, cand.cell.z))) continue;
				return { ...cand, surface: true, sp: null };
			}
			for (const sp of spiralsFor(cand.cell, (x, z) => terrainTop(w, x, z) + 1)) {
				if (Math.hypot(sp.px - a.x, sp.pz - a.z) > r + 2) continue;
				if (pillarOk(c, sp) === null) return { ...cand, surface: false, sp };
			}
			dead.add(key(cand.cell));
		}
		inner = r;
	}
	return null;
}

/** Mines the face-neighbours of mined cells that are `names`, in reach, dry, natural (and off the staircase). */
async function vein(c: GatherCtx, seeds: Vec3[], names: Set<string>, enough: () => boolean, sp: Spiral | null, max = 16): Promise<number> {
	let n = 0;
	const queue = [...seeds];
	const seen = new Set(queue.map(key));
	while (queue.length && n < max && !enough() && !c.stopped()) {
		const s = queue.shift()!;
		for (const nb of faces(s)) {
			if (seen.has(key(nb))) continue;
			seen.add(key(nb));
			const name = c.world.blockName(c.world.getBlock(nb.x, nb.y, nb.z));
			if (!name || !names.has(name) || (sp && !safeToMine(sp, nb)) || wet(c.world, nb)) continue;
			if (eyeDist(c.body.pose(), nb) > REACH) continue;
			if (await mineCell(c, nb)) {
				n++;
				queue.push(nb);
				if (enough()) break;
			}
		}
	}
	return n;
}

/** A surface target: fly onto its column, mine down to it, then its surface vein. */
async function surfaceMine(c: GatherCtx, t: Target, names: Set<string>, enough: () => boolean): Promise<string | null> {
	const w = c.world;
	const top = terrainTop(w, t.cell.x, t.cell.z);
	if (!(await travelTo(c, { x: t.cell.x + 0.5, y: top + 1, z: t.cell.z + 0.5 }))) return 'unreachable';
	for (let y = top; y >= t.cell.y; y--) {
		const cell = { x: t.cell.x, y, z: t.cell.z };
		if (w.getBlock(cell.x, cell.y, cell.z) === 0) continue;
		if (wet(w, cell)) return 'hazard';
		if (!(await mineCell(c, cell))) return 'refused';
	}
	await vein(c, [t.cell], names, enough, null);
	return null;
}

/** A buried target: the spiral staircase down, the target and its vein, the climb out. */
async function spiralMine(c: GatherCtx, t: Target, names: Set<string>, enough: () => boolean, wanted: () => Set<string>): Promise<string | null> {
	const sp = t.sp!, w = c.world;
	let planned = 16;
	for (let i = 0; i <= sp.lastStep; i++) {
		const st = spiralStep(sp, i);
		planned += st.clear.filter((q) => w.getBlock(q.x, q.y, q.z) !== 0).length + 1;
	}
	c.trip.resetPlan(planned * 2);
	c.log({ k: 'dig', t: c.clock(), target: t.cell, block: w.blockName(w.getBlock(t.cell.x, t.cell.y, t.cell.z)), pillar: { x: sp.px, z: sp.pz, y0: sp.y0 }, steps: sp.lastStep + 1, planned });
	if (!(await travelTo(c, { x: sp.px + 0.5, y: sp.y0, z: sp.pz + 0.5 }))) return 'unreachable';
	let why: string | null = null;
	let dug = 0;
	for (let i = 0; i <= sp.lastStep && !why; i++) {
		if (c.stopped()) return 'stopped';
		const st = spiralStep(sp, i);
		if (w.getBlock(st.floor.x, st.floor.y, st.floor.z) === 0 && !(await fillCell(c, st.floor))) why = 'gap';
		for (const q of [...st.clear].reverse()) {
			if (why) break;
			const v = w.getBlock(q.x, q.y, q.z);
			if (v === 0) continue;
			if (w.isLiquid(v) || wet(w, q)) why = 'hazard';
			else if (!(await mineCell(c, q))) why = 'refused';
		}
		if (why) break;
		// Needed ores beside the step, on the way down.
		const want = wanted();
		if (want.size) await vein(c, st.clear, want, () => wanted().size === 0, sp, 8);
		let walked = false;
		for (let k = 0; k < 2 && !walked; k++) walked = (await c.body.walkTo({ x: st.feet.x + 0.5, z: st.feet.z + 0.5 }).catch(() => 'cancelled')) === 'arrived';
		if (!walked) why = 'stuck';
		else dug = i + 1;
	}
	if (!why) {
		const tv = w.getBlock(t.cell.x, t.cell.y, t.cell.z);
		const tn = w.blockName(tv);
		if (tn && names.has(tn)) {
			if (wet(w, t.cell)) why = 'hazard';
			else if (await mineCell(c, t.cell)) await vein(c, [t.cell], names, enough, sp);
		}
	}
	await climbOut(c, sp, dug);
	return why;
}

async function climbOut(c: GatherCtx, sp: Spiral, dug: number): Promise<void> {
	const path = climbPath(sp, c.body.pose(), dug);
	let fails = 0;
	for (const to of path) {
		let ok = false;
		for (let k = 0; k < 2 && !ok; k++) ok = (await c.body.walkTo(to).catch(() => 'cancelled')) === 'arrived';
		if (!ok) {
			fails++;
			break;
		}
	}
	if (fails === 0) return;
	const e = escapeTarget(sp, c.world, c.own);
	try {
		if (e) await c.body.flyTo(e);
		else await c.body.flyTo({ x: sp.px + 0.5, y: sp.y0 + 3, z: sp.pz + 0.5 });
	} catch (err) {
		c.log({ k: 'climb-failed', t: c.clock(), err: err instanceof Error ? err.message : String(err) });
	}
}

/**
 * Mines until `missing()` is empty (it is recomputed from the inventory after each target). Returns null when done,
 * else why it gave up. Stone is left for last: the staircases bring it up anyway.
 */
export async function gather(c: GatherCtx, missing: () => Array<{ anyOf: string[]; count: number }>): Promise<string | null> {
	const dead = new Set<string>();
	const wanted = () => new Set(missing().flatMap((m) => m.anyOf));
	for (let tries = 0; tries < MAX_TRIES; tries++) {
		if (c.stopped()) return 'stopped';
		if (c.trip.halted) return `halted: ${c.trip.halted}`;
		const short = missing().sort((p, q) => Number(p.anyOf[0] === 'stone') - Number(q.anyOf[0] === 'stone'));
		if (short.length === 0) return null;
		const g = short[0];
		const names = new Set(g.anyOf);
		const have0 = g.anyOf.reduce((s, n) => s + (c.inv[n] ?? 0), 0);
		const enough = () => g.anyOf.reduce((s, n) => s + (c.inv[n] ?? 0), 0) - have0 >= g.count;
		const t = await findTarget(c, g.anyOf, dead);
		if (!t) {
			c.log({ k: 'gather-failed', t: c.clock(), block: g.anyOf[0], why: 'none found' });
			return `no ${g.anyOf[0]} found`;
		}
		c.log({ k: 'gather', t: c.clock(), block: g.anyOf[0], need: g.count, target: t.cell, surface: t.surface, d: Math.round(t.d) });
		const why = t.surface ? await surfaceMine(c, t, names, enough) : await spiralMine(c, t, names, enough, wanted);
		if (why) {
			c.log({ k: 'gather-target-failed', t: c.clock(), block: g.anyOf[0], target: t.cell, why });
			dead.add(key(t.cell));
			if (why === 'stopped') return why;
		}
	}
	return missing().length === 0 ? null : 'too many tries';
}
