// Multiplayer plan task C3, T3 (spec §6 and §10): liquid convergence. Two clients (World + LiquidScheduler each,
// with the multiplayer overlay), a server sequencer with per-client latency, and a single-client reference R.
// Every client ends equal to R, not just to the other client. Ported from the gate-1 probe
// (zz-mp-liquid.probe.test.ts) onto real terrain (World.create), the real World.writeRemote and the §6 echo rule.
import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { ChunkOverlay } from '../engine/world/overlay';
import { AIR, WATER, isLiquid, isSolid } from '../data/blocks.data';
import { LiquidScheduler } from './liquid-scheduler';
import { worldToChunk, indexOf, chunkIndex, WORLD_CHUNKS_Z } from '../engine/world/coords';
import { createPrng, type Prng } from '../engine/prng';
import type { Op } from '../net/protocol';
import { shouldApplyEcho } from '../net/echo';

/** The instrument check: World.writeRemote without the liquid frontier wake (spec rev 1). */
let REMOTE_NO_WAKE = false;

function writeRemoteNoWake(w: World, x: number, y: number, z: number, id: number, fluid: number): boolean {
	if (!w.inBounds(x, y, z)) return false;
	const { cx, cz, lx, lz } = worldToChunk(x, z);
	const c = w.getChunk(cx, cz);
	if (!c) return false;
	const i = indexOf(lx, y, lz);
	const oldFluid = c.fluidMeta.get(i) ?? 0;
	if (c.blocks[i] === id && oldFluid === fluid) return false;
	c.set(lx, y, lz, id);
	if (isLiquid(id)) c.hasLiquid = true;
	if (fluid === 0) c.fluidMeta.delete(i);
	else c.fluidMeta.set(i, fluid);
	if (oldFluid !== fluid) { c.dirty = true; c.rev++; }
	c.modified = true;
	return true;
}

const SETTLE_S = 20;
const MAX_T = 400;
const REF_MAX_T = 90;

class Client {
	readonly w: World;
	readonly s: LiquidScheduler;
	readonly overlay = new ChunkOverlay();
	private touched = new Set<string>();
	private pending = new Map<string, number>();
	private cid = 0;
	lastWrite = -Infinity;

	constructor(seed: number, readonly by: number, preload: Array<[number, number]>) {
		this.w = World.create(seed);
		for (const [cx, cz] of preload) this.w.ensureChunk(cx, cz);
		this.w.overlay = this.overlay;
		this.w.onLocalWrite = (x, y, z) => { this.touched.add(`${x},${y},${z}`); };
		this.s = new LiquidScheduler(this.w, () => {});
	}

	/** Once per tick (MpSync.flushFrame): read id and fluid of every touched cell now. */
	flush(now: number): { by: number; cid: number; ops: Op[] } | null {
		if (this.touched.size === 0) return null;
		const ops: Op[] = [];
		const cid = ++this.cid;
		for (const k of this.touched) {
			const [x, y, z] = k.split(',').map(Number);
			const { cx, cz, lx, lz } = worldToChunk(x, z);
			const c = this.w.getChunk(cx, cz)!;
			ops.push([x, y, z, c.get(lx, y, lz), c.fluidMeta.get(indexOf(lx, y, lz)) ?? 0, 0]);
			this.pending.set(k, cid);
		}
		this.touched.clear();
		this.lastWrite = now;
		return { by: this.by, cid, ops };
	}

	/** MpSync.onEdit + GameLoop.enqueueRemote/drainRemote, reduced to the world: echo rule, overlay at receive, writeRemote. */
	receive(m: { by: number; cid: number; ops: Op[] }): void {
		for (const op of m.ops) {
			const [x, y, z, id, fluid, color] = op;
			if (m.by === this.by && !shouldApplyEcho(this.pending, `${x},${y},${z}`, m.cid)) continue;
			this.overlay.set(x, y, z, id, fluid, color);
			if (REMOTE_NO_WAKE) writeRemoteNoWake(this.w, x, y, z, id, fluid);
			else this.w.writeRemote(x, y, z, id, fluid);
		}
	}
}

type Spot = { x: number; y: number; z: number };
type Action = { t: number; who: 0 | 1; fn: (w: World, p: Spot) => void };
type Scenario = { name: string; actions: Action[]; lat: [number, number]; stopA?: number; stallB?: [number, number] };

const pour = (w: World, p: Spot) => w.setBlock(p.x, p.y, p.z, WATER);
const scenarios: Scenario[] = [
	{ name: '1 pour', lat: [0.02, 0.17], actions: [{ t: 0, who: 0, fn: pour }] },
	{ name: '2 A pours, then leaves at t = 1 s', lat: [0.02, 0.17], stopA: 1.0, actions: [{ t: 0, who: 0, fn: pour }] },
	{
		name: '3 A mines the source while B is still spreading (0.3–1.5 s latency)', lat: [0.3, 1.5], actions: [
			{ t: 0, who: 0, fn: pour },
			{ t: 2.2, who: 0, fn: (w, p) => w.setBlock(p.x, p.y, p.z, AIR) },
		],
	},
	{
		name: '4 B digs next to the puddle, then its tab stalls 3 s and catches up', lat: [0.02, 0.17], stallB: [1.0, 4.0], actions: [
			{ t: 0, who: 0, fn: pour },
			{ t: 0.8, who: 1, fn: (w, p) => { w.setBlock(p.x + 3, p.y - 1, p.z, AIR); w.setBlock(p.x + 3, p.y - 2, p.z, AIR); } },
		],
	},
];

/**
 * Inland surface cells: solid ground, no liquid within 10 blocks, two air cells above. Deterministic per seed, nearest
 * the world centre first.
 */
function* inlandCells(w: World): Generator<Spot> {
	for (let r = 0; r < 200; r += 4) for (let dx = -r; dx <= r; dx += 4) for (const dz of r === 0 ? [0] : [-r, r]) {
		const x = 256 + dx, z = 256 + dz;
		let y = w.height - 2;
		while (y > 1 && w.getBlock(x, y, z) === AIR) y--;
		const g = w.getBlock(x, y, z);
		if (!isSolid(g) || isLiquid(g)) continue;
		let wet = false;
		for (let ax = -10; ax <= 10 && !wet; ax++) for (let az = -10; az <= 10 && !wet; az++) for (let ay = -3; ay <= 2; ay++) if (isLiquid(w.getBlock(x + ax, y + ay, z + az))) { wet = true; break; }
		if (!wet && w.getBlock(x, y + 1, z) === AIR && w.getBlock(x, y + 2, z) === AIR) yield { x, y: y + 1, z };
	}
}

function preloadAround(spot: Spot): Array<[number, number]> {
	const { cx, cz } = worldToChunk(spot.x, spot.z);
	const out: Array<[number, number]> = [];
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push([cx + dx, cz + dz]);
	return out;
}

/**
 * The single-client reference: the same actions at the same times, no network, 1/60 s ticks, until no write for
 * SETTLE_S. null when it never settles: the existing scheduler has limit cycles on some terrain (a flow cell over air
 * that toggles forever, solo too), and a reference with no fixpoint cannot judge convergence, so that spot is skipped.
 */
function runReference(sc: Scenario, seed: number, spot: Spot): World | null {
	const ref = World.create(seed);
	for (const [cx, cz] of preloadAround(spot)) ref.ensureChunk(cx, cz);
	const rs = new LiquidScheduler(ref, () => {});
	let t = 0, refWrite = 0;
	ref.onLocalWrite = () => { refWrite = t; };
	const rdone = sc.actions.map(() => false);
	while (!(rdone.every(Boolean) && t - refWrite >= SETTLE_S)) {
		if (t > REF_MAX_T) return null;
		t += 1 / 60;
		sc.actions.forEach((a, j) => { if (!rdone[j] && a.t <= t) { a.fn(ref, spot); rdone[j] = true; } });
		rs.tick(1 / 60);
	}
	return ref;
}

type DtFn = () => number;
function dtPatterns(r: Prng): DtFn[] {
	return [
		() => 1 / 60,
		() => 1 / 30 + (r.float() - 0.5) * 0.02,
		() => 1 / 144,
		() => (r.float() < 0.1 ? 0.1 : 1 / 60),
	];
}

/** Chunks any world modified, as flat indices. */
function touchedChunks(ws: World[]): number[] {
	const s = new Set<number>();
	for (const w of ws) for (const c of w.modifiedChunks()) s.add(chunkIndex(c.cx, c.cz));
	return [...s].sort((a, b) => a - b);
}

/** Cells (block or fluidMeta) that differ between a and b over the given chunks. ensureChunk rebuilds a missing one (generation + overlay). */
function diffCells(a: World, b: World, chunks: number[]): number {
	let n = 0;
	for (const i of chunks) {
		const cx = Math.floor(i / WORLD_CHUNKS_Z), cz = i % WORLD_CHUNKS_Z;
		const ca = a.ensureChunk(cx, cz), cb = b.ensureChunk(cx, cz);
		for (let k = 0; k < ca.blocks.length; k++) if (ca.blocks[k] !== cb.blocks[k] || (ca.fluidMeta.get(k) ?? 0) !== (cb.fluidMeta.get(k) ?? 0)) n++;
	}
	return n;
}

function runScenario(sc: Scenario, seed: number, run: number) {
	let found: { spot: Spot; ref: World } | null = null, skipped = 0;
	for (const cand of inlandCells(World.create(seed))) {
		const r = runReference(sc, seed, cand);
		if (r) { found = { spot: cand, ref: r }; break; }
		if (++skipped > 20) break;
	}
	if (!found) throw new Error(`${sc.name} seed ${seed}: no inland cell whose reference settles`);
	const { spot, ref } = found;
	const preload = preloadAround(spot);

	const r = createPrng(`c3-${seed}-${run}`);
	const pats = dtPatterns(r);
	const dts: DtFn[] = [pats[run % 4], pats[(run + 2) % 4]];
	const cl = [new Client(seed, 1, preload), new Client(seed, 2, preload)];
	const lat = () => sc.lat[0] + r.float() * (sc.lat[1] - sc.lat[0]);

	const toServer: Array<{ at: number; m: { by: number; cid: number; ops: Op[] } }> = [];
	const toClient: Array<Array<{ at: number; m: { by: number; cid: number; ops: Op[] } }>> = [[], []];
	const clocks = [0, 0];
	const alive = [true, true];
	const done = sc.actions.map(() => false);
	let resumeFrame = false;
	const step = 1 / 240;
	let now = 0;
	const quiet = () => toServer.length === 0 && toClient.every((q) => q.length === 0) && done.every((d, k) => d || !alive[sc.actions[k].who]);
	const lastWrite = () => Math.max(cl[0].lastWrite, cl[1].lastWrite, 0);
	while (!(quiet() && now - lastWrite() >= SETTLE_S)) {
		if (now > MAX_T) throw new Error(`${sc.name} seed ${seed}: no settle by t=${MAX_T}`);
		now += step;
		for (const k of [0, 1] as const) {
			if (!alive[k]) continue;
			while (clocks[k] + 1e-9 < now) {
				if (k === 0 && sc.stopA !== undefined && clocks[0] >= sc.stopA) { alive[0] = false; toClient[0] = []; break; }
				if (k === 1 && sc.stallB && clocks[1] >= sc.stallB[0] && clocks[1] < sc.stallB[1]) { clocks[1] = sc.stallB[1]; resumeFrame = true; continue; }
				// A stalled tab resumes with one clamped frame (renderer.frame clamps dt at 100 ms).
				const dt = k === 1 && resumeFrame ? 0.1 : dts[k]();
				if (k === 1) resumeFrame = false;
				clocks[k] += dt;
				const c = cl[k];
				const inbox = toClient[k].filter((e) => e.at <= clocks[k]);
				toClient[k] = toClient[k].filter((e) => e.at > clocks[k]);
				for (const e of inbox) c.receive(e.m);
				sc.actions.forEach((a, j) => { if (!done[j] && a.who === k && a.t <= clocks[k]) { a.fn(c.w, spot); done[j] = true; } });
				c.s.tick(dt);
				const m = c.flush(clocks[k]);
				if (m) toServer.push({ at: clocks[k] + lat(), m });
			}
		}
		// Server: sequence arrivals in arrival order, fan out to every live client (author included), FIFO per socket.
		toServer.sort((a, b) => a.at - b.at);
		while (toServer.length && toServer[0].at <= now) {
			const { m } = toServer.shift()!;
			for (const k of [0, 1]) {
				if (!alive[k]) continue;
				const last = toClient[k].length ? toClient[k][toClient[k].length - 1].at : 0;
				toClient[k].push({ at: Math.max(last, now + lat()), m });
			}
		}
		// A client's lastWrite is in its own clock; a stalled clock jumps, so compare against global time.
		for (const c of cl) if (c.lastWrite > now) c.lastWrite = now;
	}

	const chunks = touchedChunks([cl[0].w, cl[1].w, ref]);
	// Cells the scenario changed in the reference (vs a pristine generation): the non-vacuity check.
	const refChanged = diffCells(ref, World.create(seed), chunks);
	return {
		dAR: sc.stopA !== undefined ? null : diffCells(cl[0].w, ref, chunks),
		dBR: diffCells(cl[1].w, ref, chunks),
		refChanged,
		spot,
		skipped,
	};
}

const SEEDS = [1, 2, 3, 5, 8, 13];

describe('T3: multiplayer liquid convergence, every client equals the single-client reference', () => {
	for (const sc of scenarios) {
		it(sc.name, { timeout: 60_000 }, () => {
			REMOTE_NO_WAKE = false;
			const lines: string[] = [];
			let bad = 0;
			SEEDS.forEach((seed, run) => {
				const res = runScenario(sc, seed, run);
				lines.push(`seed ${seed} @(${res.spot.x},${res.spot.y},${res.spot.z}): dAR=${res.dAR} dBR=${res.dBR} refChanged=${res.refChanged} skippedSpots=${res.skipped}`);
				if ((res.dAR ?? 0) !== 0 || res.dBR !== 0) bad++;
				// Not vacuous: a pour that is never mined leaves water behind in the reference.
				if (sc.actions.length === 1 || sc.stallB) expect(res.refChanged, lines.join('\n')).toBeGreaterThan(1);
			});
			if (process.env.C3_LOG) process.stdout.write(`${sc.name}\n${lines.join('\n')}\n`);
			expect(bad, lines.join('\n')).toBe(0);
		});
	}

	it('instrument check: with REMOTE_NO_WAKE, scenario 2 (A leaves) goes red', { timeout: 60_000 }, () => {
		REMOTE_NO_WAKE = true;
		try {
			const sc = scenarios[1];
			let bad = 0;
			SEEDS.forEach((seed, run) => {
				const res = runScenario(sc, seed, run);
				if (res.dBR !== 0) bad++;
				if (process.env.C3_LOG) process.stdout.write(`no-wake seed ${seed}: dBR=${res.dBR} refChanged=${res.refChanged}\n`);
			});
			expect(bad).toBeGreaterThan(0);
		} finally {
			REMOTE_NO_WAKE = false;
		}
	});
});
