/**
 * Explore {direction} (spec §6): walk waypoints about 12 blocks apart in the least-explored direction within the
 * leash, looking around; 60–120 s, or done on a `found` (spec §4.4: a block type seen for the first time this
 * session). No edits.
 */
import { EYE_HEIGHT, WORLDGEN_BLOCKS } from 'minicraft-bot';
import type { Action, Vec3, WorldEvent } from '../types.js';
import type { Patch } from '../store.js';
import { SALIENCE } from '../data/salience.data.js';
import { paramsExplore, waypointsAlong } from '../params.js';
import { anchorOf } from './build.js';
import { bodyTop, topSolid } from './site-search.js';
import type { Behaviour, BehaviourCtx, Next } from './behaviour.js';

export interface ExploreParams { dir?: [number, number] }
export interface ExplorePlan {
	dir: [number, number]; waypoints: Vec3[]; idx: number; anchor: Vec3;
	until: number; lastLook: number; blocked: number;
	/** The newest event id at plan time: a `found` above it was written during the behaviour. */
	floor: number;
}

/** Blocked walks or flights before the behaviour gives up (spec §6). */
const MAX_BLOCKED = 3;
/** Columns this close to an arrived waypoint are read for `found`; salient things this close are looked at. */
const SCAN_R = 8;
const CHUNK = 16;

/** Block types seen this session (spec §4.4). Module-level: runBrain2 clears it at start. */
let seenBlocks = new Set<string>();
export function resetSeenBlocks(): void {
	seenBlocks = new Set();
}
/** Marks block types as seen (tests, and anything else that sees blocks). */
export function markSeen(names: Iterable<string>): void {
	for (const n of names) seenBlocks.add(n);
}

const maxEventId = (ctx: BehaviourCtx): number => ctx.state.events.reduce((m, e) => Math.max(m, e.id), 0);

/** Look at the newest salient thing within 8 blocks (an event's cell, else the nearest kid), else a random yaw. */
function lookTarget(ctx: BehaviourCtx): Vec3 {
	const p = ctx.pose;
	const near = (c: Vec3) => Math.hypot(c.x + 0.5 - p.x, c.y + 0.5 - p.y, c.z + 0.5 - p.z) <= SCAN_R;
	const ev = [...ctx.state.events].reverse().find((e) => e.salient && e.cell && near(e.cell));
	if (ev?.cell) return { x: ev.cell.x + 0.5, y: ev.cell.y + 0.5, z: ev.cell.z + 0.5 };
	const kid = ctx.kids
		.map((k) => ({ k, d: Math.hypot(k.pose.x - p.x, k.pose.y - p.y, k.pose.z - p.z) }))
		.filter((x) => x.d <= SCAN_R)
		.sort((a, b) => a.d - b.d)[0]?.k;
	if (kid) return { x: kid.pose.x, y: kid.pose.y + EYE_HEIGHT, z: kid.pose.z };
	const yaw = ctx.rng() * 2 * Math.PI;
	return { x: p.x - Math.sin(yaw) * 5, y: p.y + EYE_HEIGHT, z: p.z - Math.cos(yaw) * 5 };
}

/** A walk to the waypoint, or a flight when its ground is unknown or more than 1 above the bot's (spec §6). */
function goTo(wp: Vec3, ctx: BehaviourCtx): Action {
	const w = ctx.world, p = ctx.pose;
	const x = Math.floor(wp.x), z = Math.floor(wp.z);
	const top = topSolid(w, x, z);
	const ground = top >= 0 ? w.groundY(x, z, top + 1) : null;
	const here = w.groundY(Math.floor(p.x), Math.floor(p.z), p.y) ?? p.y;
	// The flight lands above every column under the body: a waypoint on a column edge overlaps the neighbour (bodyTop).
	const bt = bodyTop(w, wp.x, wp.z);
	if (ground === null || ground > here + 1) return { kind: 'fly', to: { x: wp.x, y: Math.max(ground ?? Math.max(p.y, top + 1), bt + 1), z: wp.z } };
	return { kind: 'walk', to: { x: wp.x, z: wp.z }, speed: ctx.style.walkSpeed };
}

/** The waypoint's chunk and the 8 around it, as `explored` writes. */
function exploredPatch(wp: Vec3, ctx: BehaviourCtx): Patch {
	const cx = Math.floor(wp.x / CHUNK), cz = Math.floor(wp.z / CHUNK);
	const out: Patch = [];
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
		const k = `${cx + dx},${cz + dz}`;
		if (!ctx.state.explored[k]) out.push({ path: ['explored', k], value: true });
	}
	return out;
}

/** One `found` per worldgen block type on the surface within 8 columns of the waypoint that this session hasn't seen. */
function foundPatch(wp: Vec3, ctx: BehaviourCtx): Patch {
	const w = ctx.world;
	const fresh: WorldEvent[] = [];
	for (let x = Math.floor(wp.x - SCAN_R); x <= Math.ceil(wp.x + SCAN_R); x++) {
		for (let z = Math.floor(wp.z - SCAN_R); z <= Math.ceil(wp.z + SCAN_R); z++) {
			if (Math.hypot(x + 0.5 - wp.x, z + 0.5 - wp.z) > SCAN_R) continue;
			const y = topSolid(w, x, z);
			if (y < 0) continue;
			const name = w.blockName(w.getBlock(x, y, z));
			if (!name || !WORLDGEN_BLOCKS.includes(name) || seenBlocks.has(name)) continue;
			seenBlocks.add(name);
			// ctx.event builds a whole events list per call: take each new event and append them together (as Mine).
			const p = ctx.event({ kind: 'found', cell: { x, y, z }, block: name });
			fresh.push((p[0].value as WorldEvent[]).at(-1)!);
		}
	}
	if (fresh.length === 0) return [];
	return [{ path: ['events'], value: [...ctx.state.events, ...fresh].slice(-SALIENCE.KEEP_MAX) }];
}

export const explore: Behaviour<ExploreParams, ExplorePlan> = {
	kind: 'explore',
	typicalMs: [60_000, 120_000],
	plan(p, ctx) {
		const anchor = anchorOf(ctx);
		const pose = { x: ctx.pose.x, y: ctx.pose.y, z: ctx.pose.z };
		const leg = p.dir ? { dir: p.dir, waypoints: waypointsAlong(p.dir, anchor, pose) } : paramsExplore(ctx.state, anchor, pose);
		return {
			dir: leg.dir, waypoints: leg.waypoints, idx: 0, anchor,
			until: ctx.now + 60_000 + ctx.rng() * 60_000, lastLook: -Infinity, blocked: 0, floor: maxEventId(ctx),
		};
	},
	next(pl, ctx): Next {
		if (ctx.state.events.some((e) => e.kind === 'found' && e.id > pl.floor)) return 'done';
		if (ctx.now >= pl.until) return 'done';
		if (pl.blocked >= MAX_BLOCKED) return { failed: 'stuck' };
		if (pl.idx >= pl.waypoints.length) {
			// The leg is walked: the next leg goes the least-explored way from here.
			const pose = { x: ctx.pose.x, y: ctx.pose.y, z: ctx.pose.z };
			let leg = paramsExplore(ctx.state, pl.anchor, pose);
			if (leg.waypoints.length === 0) {
				// At the leash edge facing out: head back across the circle, through the anchor.
				const dx = pl.anchor.x - pose.x, dz = pl.anchor.z - pose.z, d = Math.hypot(dx, dz);
				const back: [number, number] = d > 0 ? [dx / d, dz / d] : leg.dir;
				leg = { dir: back, waypoints: waypointsAlong(back, pl.anchor, pose) };
			}
			pl.dir = leg.dir;
			pl.waypoints = leg.waypoints;
			pl.idx = 0;
			if (pl.waypoints.length === 0) return 'done';
		}
		if (ctx.now - pl.lastLook >= ctx.style.lookEveryMs) return { kind: 'look', at: lookTarget(ctx) };
		return goTo(pl.waypoints[pl.idx], ctx);
	},
	plannedEdits: () => 0,
	owns: () => false,
	onResult(pl, a, ok, ctx) {
		if (a.kind === 'look') pl.lastLook = ctx.now;
		if (a.kind !== 'walk' && a.kind !== 'fly') return [];
		if (!ok) {
			pl.blocked++;
			return [];
		}
		const wp = pl.waypoints[pl.idx];
		pl.idx++;
		if (!wp) return [];
		return [...exploredPatch(wp, ctx), ...foundPatch(wp, ctx)];
	},
};
