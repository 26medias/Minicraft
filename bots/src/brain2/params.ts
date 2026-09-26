/**
 * The code parameter experts (spec §5.4): who to be with, where to explore, what to mine and what to build.
 * They are the code fallbacks of the model experts (part 2); every output is valid by construction.
 */
import { CRAFTED_ONLY, WORLDGEN_BLOCKS, blockId, isLiquidId } from 'minicraft-bot';
import type { KidInfo } from '../types.js';
import type { BuildParams } from './behaviours/build.js';
import { TEMPLATES, templateOf, type Role, type Template } from './behaviours/templates.data.js';
import { LIMITS } from './data/limits.data.js';
import type { State, Vec3 } from './types.js';

const CHUNK = 16;
/** Company is measured over this window (spec §5.4 `params.player`). */
const COMPANY_WINDOW_MS = 10 * 60_000;
/** One company sample per kid at most this often, so the ring stays small (10 min / 5 s = 120 per kid). */
const SAMPLE_EVERY_MS = 5_000;
/** Explore waypoints are this far apart (spec §6 Explore). */
export const WAYPOINT_STEP = 12;
const MAX_WAYPOINTS = 8;

// ── params.player ──

interface CompanySample { t: number; name: string; minutes: number }
/** The module-level ring of minutesTogether samples, fed by sampleCompany (the caller, every tick). */
let company: CompanySample[] = [];

/** Records each known kid's minutesTogether (called every tick by paramsPlayer's caller). */
export function sampleCompany(s: Readonly<State>, now: number): void {
	company = company.filter((x) => now - x.t <= COMPANY_WINDOW_MS);
	for (const [name, rel] of Object.entries(s.relations)) {
		const last = [...company].reverse().find((x) => x.name === name);
		if (!last || now - last.t >= SAMPLE_EVERY_MS) company.push({ t: now, name, minutes: rel.minutesTogether });
	}
}

/** Clears the ring (a new session, and tests). */
export function resetCompany(): void {
	company = [];
}

/** Minutes gained with `name` in the last 10 min: now's minutesTogether minus the oldest sample in the window. */
function gained(s: Readonly<State>, name: string, now: number): number {
	const cur = s.relations[name]?.minutesTogether ?? 0;
	const first = company.find((x) => x.name === name && now - x.t <= COMPANY_WINDOW_MS);
	return first ? Math.max(0, cur - first.minutes) : 0;
}

/**
 * `params.player` (spec §5.4): the named kid if present; else the kid present with the fewest minutes together
 * gained in the last 10 min; ties → the nearest. null with no kid present.
 */
export function paramsPlayer(s: Readonly<State>, kids: KidInfo[], now: number, named?: string): string | null {
	if (named && kids.some((k) => k.name === named)) return named;
	if (kids.length === 0) return null;
	const p = s.body.pose;
	const ranked = kids
		.map((k) => ({ name: k.name, g: gained(s, k.name, now), d: Math.hypot(k.pose.x - p.x, k.pose.z - p.z) }))
		.sort((a, b) => (Math.abs(a.g - b.g) > 1e-9 ? a.g - b.g : a.d - b.d));
	return ranked[0].name;
}

// ── params.explore ──

const S = Math.SQRT1_2;
/** The 8 compass directions in tie order N, NE, E, SE, S, SW, W, NW (north is −z, as yaw 0 faces). */
export const COMPASS: Array<[number, number]> = [[0, -1], [S, -S], [1, 0], [S, S], [0, 1], [-S, S], [-1, 0], [-S, -S]];

export const chunkKey = (x: number, z: number): string => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;

/** Points every 12 blocks from `pose` along `dir`, clamped to the leash circle around `anchor`; y is filled at walk time. */
export function waypointsAlong(dir: [number, number], anchor: Vec3, pose: Vec3): Vec3[] {
	const out: Vec3[] = [];
	for (let k = 1; k <= MAX_WAYPOINTS; k++) {
		let x = pose.x + dir[0] * WAYPOINT_STEP * k, z = pose.z + dir[1] * WAYPOINT_STEP * k;
		const d = Math.hypot(x - anchor.x, z - anchor.z);
		const clamped = d > LIMITS.LEASH;
		if (clamped) {
			x = anchor.x + ((x - anchor.x) * LIMITS.LEASH) / d;
			z = anchor.z + ((z - anchor.z) * LIMITS.LEASH) / d;
		}
		const prev = out.at(-1) ?? pose;
		if (Math.hypot(x - prev.x, z - prev.z) >= 1) out.push({ x, y: pose.y, z });
		if (clamped) break;
	}
	return out;
}

/**
 * `params.explore` (spec §5.4, §6): the compass direction with the most unexplored chunks among the 4 sampled along
 * the ray from the anchor (at LEASH/4 … LEASH); ties by N, NE, E, … (no rng). Waypoints every 12 blocks
 * from the bot along it, within the leash.
 */
export function paramsExplore(s: Readonly<State>, anchor: Vec3, pose: Vec3): { dir: [number, number]; waypoints: Vec3[] } {
	let best = COMPASS[0], bestScore = -1;
	for (const dir of COMPASS) {
		let score = 0;
		for (let i = 1; i <= 4; i++) {
			const r = (LIMITS.LEASH * i) / 4;
			if (!s.explored[chunkKey(anchor.x + dir[0] * r, anchor.z + dir[1] * r)]) score++;
		}
		if (score > bestScore) {
			best = dir;
			bestScore = score;
		}
	}
	return { dir: best, waypoints: waypointsAlong(best, anchor, pose) };
}

// ── params.mine ──

/** `params.mine` (spec §5.4): a paused dig's block; else the latest salient `need` block if it is a worldgen block; else the favourite. */
export function paramsMine(s: Readonly<State>): { block: string } {
	const paused = s.digs.find((d) => d.status === 'paused');
	if (paused) return { block: paused.block };
	const need = [...s.events].reverse().find((e) => e.kind === 'need' && e.salient && e.block);
	if (need?.block && WORLDGEN_BLOCKS.includes(need.block)) return { block: need.block };
	return { block: s.personality.favouriteBlock ?? 'stone' };
}

// ── params.build ──

/** A block the bot may build with (spec §5.4): worldgen, not CRAFTED_ONLY, not a liquid, not an ore, not leaves. */
export function buildMaterial(name: string): boolean {
	const v = blockId(name);
	return WORLDGEN_BLOCKS.includes(name) && !CRAFTED_ONLY.includes(name) && !name.endsWith('_ore') && !name.endsWith('_leaves')
		&& v !== null && !isLiquidId(v);
}

/** Builds that still count toward the cap (the runtime check in Build also asks the world whether they stand). */
export function standingBuilds(s: Readonly<State>): number {
	return s.builds.filter((b) => b.status !== 'dismantled' && b.status !== 'reverted').length;
}

/** Held building blocks, most first (ties by name). */
function heldMaterials(s: Readonly<State>): Array<[string, number]> {
	return Object.entries(s.inventory)
		.filter(([n, c]) => c > 0 && buildMaterial(n))
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Cells per role in a template. */
function roleCounts(t: Template): Partial<Record<Role, number>> {
	const n: Partial<Record<Role, number>> = {};
	for (const c of t.cells) n[c.role] = (n[c.role] ?? 0) + 1;
	return n;
}

/** Whether `materials` covers every role's cells of `t` from `held` (roles sharing a block add up). */
function covers(t: Template, materials: BuildParams['materials'], held: Array<[string, number]>): boolean {
	const want: Record<string, number> = {};
	for (const [role, n] of Object.entries(roleCounts(t)) as Array<[Role, number]>) {
		const m = materials[role] ?? materials.wall;
		if (!m) return false;
		want[m] = (want[m] ?? 0) + n;
	}
	const have = Object.fromEntries(held);
	return Object.entries(want).every(([m, n]) => (have[m] ?? 0) >= n);
}

/**
 * Materials for `t` that the held blocks cover, or null. First the order by count (wall = the most held, roof, floor,
 * accent = the least held); if that runs short, each role from the largest down takes the block that fits it most
 * tightly (the fewest left that still covers it).
 */
function materialsFor(t: Template, held: Array<[string, number]>): BuildParams['materials'] | null {
	if (held.length === 0) return null;
	const wall = held[0][0];
	const byCount: BuildParams['materials'] = { wall, roof: held[1]?.[0] ?? wall, floor: held[2]?.[0] ?? wall, accent: held.at(-1)?.[0] ?? wall };
	if (covers(t, byCount, held)) return byCount;
	const left = new Map(held);
	const out: BuildParams['materials'] = {};
	const roles = (Object.entries(roleCounts(t)) as Array<[Role, number]>).sort((a, b) => b[1] - a[1]);
	for (const [role, n] of roles) {
		const fits = [...left.entries()].filter(([, c]) => c >= n);
		if (fits.length === 0) return null;
		const [m, c] = fits.reduce((best, e) => (e[1] < best[1] ? e : best));
		out[role] = m;
		left.set(m, c - n);
	}
	out.wall ??= wall;
	for (const role of ['roof', 'floor', 'accent'] as const) out[role] ??= out.wall;
	return out;
}

/**
 * `params.build` (spec §5.4): the favourite template (else house), `medium` only with ≥ 1.2 × its cells held;
 * materials from the held building blocks by count (wall, roof, floor, accent = the least held); renew at the cap.
 * Only a build the held blocks can finish is offered (the mask's "not feasible", spec §5.3): the materials must
 * cover every cell. When the favourite's small can't be covered, the largest other small template that can is
 * offered instead, except at the cap (renew: the favourite only). When none can, `materials` is empty and the
 * selection masks Build (Mine supplies the blocks).
 */
export function paramsBuild(s: Readonly<State>): BuildParams {
	const favourite = s.personality.favouriteTemplate ?? 'house';
	const renew = standingBuilds(s) >= LIMITS.MAX_STANDING_BUILDS;
	const held = heldMaterials(s);
	const total = held.reduce((n, [, c]) => n + c, 0);
	const medium = templateOf(favourite, 'medium');
	if (total >= 1.2 * medium.cells.length) {
		const m = materialsFor(medium, held);
		if (m) return { template: favourite, variant: 'medium', materials: m, renew };
	}
	// At the cap a build renews (takes the oldest apart): only for the favourite, never to swap one small statue for
	// another (brain2-productive: creepers dismantled and rebuilt every few minutes, the tower never reached).
	const others = renew ? [] : TEMPLATES.filter((t) => t.variant === 'small' && t.name !== favourite).sort((a, b) => b.cells.length - a.cells.length);
	const smalls = [templateOf(favourite, 'small'), ...others];
	for (const t of smalls) {
		const m = materialsFor(t, held);
		if (m) return { template: t.name, variant: 'small', materials: m, renew };
	}
	return { template: favourite, variant: 'small', materials: {}, renew };
}
