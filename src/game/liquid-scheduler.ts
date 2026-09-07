// Three-phase liquid scheduler.
//
// Per tick (every TICK_INTERVAL seconds):
//   1. Drain — BFS from every in-world source along same-type liquid; any flow cell
//      the BFS can't reach is "orphan". Of the orphans, only those at the *maximum*
//      current distance are written to AIR this tick — producing a visible ring-by-ring
//      "water flows back" cascade (outermost ring peels first, next tick reveals the
//      new outermost, etc.). Drains commit immediately and are remembered so Phase 2
//      spread can't regenerate what we just decided to drain.
//   2. Spread — from every liquid cell in the tick snapshot: fall vertically if the cell
//      below is AIR (falls never consume budget; sources never vacate; flows only vacate
//      when not fed by a same-type column above). Otherwise spread sideways if the cell's
//      `distance` is below the per-liquid budget (water = 4 hops from source, lava = 2).
//   3. Reaction — for every cell in the snapshot + 6-axis neighbours: if lava touches
//      water, lava becomes OBSIDIAN and all touching water becomes AIR. Single pass,
//      no chaining.
// Finally, decay the frontier of any voxel whose horizontal neighbours are all non-AIR
// (so fully-enclosed pool interiors cost zero per-tick work).
//
// Sources carry no `fluidMeta` entry — the default rule is the storage win, so the
// world-gen ocean creates zero entries and costs zero drain-BFS work per tick.

import type { World } from '../engine/world/world';
import type { Chunk } from '../engine/world/chunk';
import { AIR, OBSIDIAN, WATER, LAVA, isLiquid } from '../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from '../engine/world/coords';

const TICK_INTERVAL = 0.5;
const WATER_BUDGET = 4;
const LAVA_BUDGET = 2;

function budgetFor(id: number): number {
	return id === LAVA ? LAVA_BUDGET : WATER_BUDGET;
}

type Coord = { x: number; y: number; z: number };
type PendingWrite = { x: number; y: number; z: number; id: number; flowDistance: number | null };
// flowDistance: null means "regular write" (clears fluidMeta — used for AIR and source-restoration);
// number means "write as flow with that distance".

export class LiquidScheduler {
	private accumulator = 0;
	private changed = false;

	constructor(
		private world: World,
		private onChunkDirty: (cx: number, cz: number) => void,
		private onBlockChanged: (x: number, y: number, z: number) => void = () => {},
	) {}

	tick(dt: number): boolean {
		this.accumulator += dt;
		if (this.accumulator < TICK_INTERVAL) return false;
		this.accumulator = 0;
		this.changed = false;

		// Snapshot the frontier BEFORE any mutation.
		const snapshot = this.takeSnapshot();

		// Phase 3 first, on snapshot state: identify orphan flow cells (no source
		// reachable via same-type liquid BFS) and IMMEDIATELY drain the outermost ring.
		// Cells drained this way are remembered so Phase 1 doesn't refill them.
		const drainedThisTick = this.applyDrainStep();

		// Phase 1: spread, but skip any AIR cells that we just drained.
		this.applySpreadStep(snapshot, drainedThisTick);

		// Phase 2: reaction — scan snapshot ∪ 6-axis-neighbours for water/lava contact.
		this.applyReactionStep(snapshot);

		// Frontier maintenance — drop fully-enclosed pool interiors.
		this.decayFrontier();

		return this.changed;
	}

	private takeSnapshot(): Coord[] {
		const out: Coord[] = [];
		for (const c of this.world.allChunks()) this.collectFrontier(c, out);
		return out;
	}

	// -----------------------------------------------------------------------------------------

	private applySpreadStep(snapshot: Coord[], drainedThisTick: Set<string>): void {
		const pending: PendingWrite[] = [];
		for (const { x, y, z } of snapshot) {
			const here = this.world.getBlock(x, y, z);
			if (!isLiquid(here)) continue;

			const isSource = !this.isFlowAt(x, y, z);
			const distance = isSource ? 0 : this.flowDistanceAt(x, y, z);
			const budget = budgetFor(here);

			// Fall rule: if the cell directly below is air, propagate downward.
			if (y > 0) {
				const below = this.world.getBlock(x, y - 1, z);
				if (below === AIR && !drainedThisTick.has(`${x},${y - 1},${z}`)) {
					const above = this.world.getBlock(x, y + 1, z);
					const sameTypeAbove = above === here;
					pending.push({ x, y: y - 1, z, id: here, flowDistance: distance });
					// Source never vacates. Flow vacates UNLESS fed by a same-type column above
					// (otherwise the column would flicker).
					if (!isSource && !sameTypeAbove) {
						pending.push({ x, y, z, id: AIR, flowDistance: null });
					}
					continue;
				}
			}

			// Sideways spread: only if budget remains.
			if (distance < budget) {
				const sideDirs: [number, number][] = [
					[1, 0], [-1, 0], [0, 1], [0, -1],
				];
				for (const [dx, dz] of sideDirs) {
					const nx = x + dx, nz = z + dz;
					if (this.world.getBlock(nx, y, nz) !== AIR) continue;
					if (drainedThisTick.has(`${nx},${y},${nz}`)) continue;  // don't refill what we just drained
					pending.push({ x: nx, y, z: nz, id: here, flowDistance: distance + 1 });
				}
			}
		}

		this.commit(pending);
	}

	// -----------------------------------------------------------------------------------------

	private applyReactionStep(snapshot: Coord[]): void {
		if (snapshot.length === 0) return;
		// Visit each snapshot cell + 6-axis neighbours; for any lava cell with a water neighbour,
		// convert lava → obsidian and water → air.
		const visited = new Set<string>();
		const reactionWrites: { x: number; y: number; z: number; id: number }[] = [];

		const offsets: [number, number, number][] = [
			[0, 0, 0],
			[1, 0, 0], [-1, 0, 0],
			[0, 1, 0], [0, -1, 0],
			[0, 0, 1], [0, 0, -1],
		];

		for (const t of snapshot) {
			for (const [dx, dy, dz] of offsets) {
				const x = t.x + dx, y = t.y + dy, z = t.z + dz;
				const k = `${x},${y},${z}`;
				if (visited.has(k)) continue;
				visited.add(k);

				if (this.world.getBlock(x, y, z) !== LAVA) continue;
				// Found lava: check for any adjacent water voxel.
				const lavaWaterPairs: Coord[] = [];
				for (const [ddx, ddy, ddz] of [
					[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
				] as [number, number, number][]) {
					const wx = x + ddx, wy = y + ddy, wz = z + ddz;
					if (this.world.getBlock(wx, wy, wz) === WATER) {
						lavaWaterPairs.push({ x: wx, y: wy, z: wz });
					}
				}
				if (lavaWaterPairs.length === 0) continue;

				reactionWrites.push({ x, y, z, id: OBSIDIAN });
				for (const wp of lavaWaterPairs) reactionWrites.push({ x: wp.x, y: wp.y, z: wp.z, id: AIR });
			}
		}

		const touchedChunks = new Set<string>();
		for (const w of reactionWrites) {
			if (this.world.getBlock(w.x, w.y, w.z) === w.id) continue;
			this.world.setBlock(w.x, w.y, w.z, w.id);
			this.changed = true;
			this.onBlockChanged(w.x, w.y, w.z);
			this.markDirty(touchedChunks, w.x, w.z);
		}
		this.flushDirty(touchedChunks);
	}

	// -----------------------------------------------------------------------------------------

	private applyDrainStep(): Set<string> {
		const drainedThisTick = new Set<string>();
		// Collect all candidate flow cells (across all chunks), grouped by liquid type.
		// A flow cell is orphan iff BFS from a same-type source never reaches it via
		// same-type liquid neighbours (6-axis; column-above counts). To make the cascade
		// visibly peel outside-in ring by ring, we only queue the orphan cells at the
		// *highest* current distance per type — next tick's pass will reveal the next
		// ring as the new outermost.

		// 1. Gather all flow candidates from every chunk's frontier.
		type Candidate = { x: number; y: number; z: number; id: number; distance: number; chunk: Chunk; idx: number };
		const candidates: Candidate[] = [];
		const sources: { x: number; y: number; z: number; id: number }[] = [];
		const flowSet = new Set<string>(); // keys for quick "is this cell a flow candidate" lookup
		for (const c of this.world.allChunks()) {
			const baseX = c.cx * CHUNK_SIZE_X;
			const baseZ = c.cz * CHUNK_SIZE_Z;
			for (const idx of c.liquidFrontier) {
				const { lx, y, lz } = unpackIndex(idx);
				const here = c.get(lx, y, lz);
				if (!isLiquid(here)) continue;
				const x = baseX + lx, z = baseZ + lz;
				if (c.isFlow(lx, y, lz)) {
					candidates.push({ x, y, z, id: here, distance: c.getFlowDistance(lx, y, lz), chunk: c, idx });
					flowSet.add(`${x},${y},${z}`);
				} else {
					sources.push({ x, y, z, id: here });
				}
			}
		}
		if (candidates.length === 0) return drainedThisTick;

		// 2. BFS pass A: seed from every source in the frontier; mark all reachable
		// same-type liquid cells as "alive". This covers the common case where the
		// source is still in the frontier (e.g. perimeter of a freshly-growing puddle).
		const reachable = new Set<string>();
		const queue: { x: number; y: number; z: number; id: number }[] = [];
		for (const s of sources) {
			reachable.add(`${s.x},${s.y},${s.z}`);
			queue.push(s);
		}
		// BFS step-offsets (6-axis).
		const bfsDirs: [number, number, number][] = [
			[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
		];
		// Head-index cursor instead of Array.shift(), which is O(n) per dequeue in V8.
		for (let h = 0; h < queue.length; h++) {
			const n = queue[h];
			for (const [dx, dy, dz] of bfsDirs) {
				const nx = n.x + dx, ny = n.y + dy, nz = n.z + dz;
				const k = `${nx},${ny},${nz}`;
				if (reachable.has(k)) continue;
				if (this.world.getBlock(nx, ny, nz) !== n.id) continue;
				reachable.add(k);
				queue.push({ x: nx, y: ny, z: nz, id: n.id });
			}
		}
		// 3. BFS pass B: for each un-reached candidate, walk outward to build its
		// connected component (same-type liquid cells). If any cell in the component
		// is a source — including a source that decayed out of the frontier because
		// it's fully-enclosed — the whole component is fed, so mark all reachable.
		// Otherwise the whole component is orphan; collect *every* flow cell in it
		// (including interior cells that decayed out of the frontier) so they're all
		// candidates for ring-by-ring drain.
		const extraOrphans: Candidate[] = []; // non-frontier flow cells discovered during BFS
		for (const cand of candidates) {
			const rootK = `${cand.x},${cand.y},${cand.z}`;
			if (reachable.has(rootK)) continue;
			const localSeen = new Set<string>();
			const localFlowCells: { x: number; y: number; z: number; id: number }[] = [];
			const localQueue: { x: number; y: number; z: number; id: number }[] = [{ x: cand.x, y: cand.y, z: cand.z, id: cand.id }];
			localSeen.add(rootK);
			localFlowCells.push({ x: cand.x, y: cand.y, z: cand.z, id: cand.id });
			let foundSource = false;
			for (let h = 0; h < localQueue.length; h++) {
				const n = localQueue[h];
				for (const [dx, dy, dz] of bfsDirs) {
					const nx = n.x + dx, ny = n.y + dy, nz = n.z + dz;
					const k = `${nx},${ny},${nz}`;
					if (localSeen.has(k)) continue;
					if (this.world.getBlock(nx, ny, nz) !== cand.id) continue;
					localSeen.add(k);
					if (!this.isFlowAt(nx, ny, nz)) {
						foundSource = true;
						reachable.add(k);
					} else {
						localFlowCells.push({ x: nx, y: ny, z: nz, id: cand.id });
						localQueue.push({ x: nx, y: ny, z: nz, id: cand.id });
					}
				}
			}
			if (foundSource) {
				for (const k of localSeen) reachable.add(k);
			} else {
				// Entire component is orphan. Collect every flow cell including non-frontier ones.
				for (const fc of localFlowCells) {
					const kfc = `${fc.x},${fc.y},${fc.z}`;
					if (flowSet.has(kfc)) continue;  // already a frontier candidate
					// Find the chunk and idx for this position.
					const cx = Math.floor(fc.x / CHUNK_SIZE_X);
					const cz = Math.floor(fc.z / CHUNK_SIZE_Z);
					const ch = this.world.getChunk(cx, cz);
					if (!ch) continue;
					const lx = ((fc.x % CHUNK_SIZE_X) + CHUNK_SIZE_X) % CHUNK_SIZE_X;
					const lz = ((fc.z % CHUNK_SIZE_Z) + CHUNK_SIZE_Z) % CHUNK_SIZE_Z;
					const idx = lz * CHUNK_SIZE_X + fc.y * CHUNK_SIZE_X * CHUNK_SIZE_Z + lx;
					extraOrphans.push({ x: fc.x, y: fc.y, z: fc.z, id: fc.id, distance: ch.getFlowDistance(lx, fc.y, lz), chunk: ch, idx });
					flowSet.add(kfc);
				}
			}
		}

		// 4. Partition candidates + extra-orphans into orphan buckets by liquid id.
		const orphansByType = new Map<number, Candidate[]>();
		for (const cand of candidates) {
			const k = `${cand.x},${cand.y},${cand.z}`;
			if (reachable.has(k)) continue;
			let arr = orphansByType.get(cand.id);
			if (!arr) { arr = []; orphansByType.set(cand.id, arr); }
			arr.push(cand);
		}
		for (const eo of extraOrphans) {
			let arr = orphansByType.get(eo.id);
			if (!arr) { arr = []; orphansByType.set(eo.id, arr); }
			arr.push(eo);
		}

		// 5. For each type, find max distance among orphans and IMMEDIATELY drain only
		// those at that distance (writes AIR now). Result: one ring per tick, peeling
		// from the outside in. Cells drained are returned so Phase 2 (spread) can skip
		// them as write targets this same tick.
		const touchedChunks = new Set<string>();
		for (const [, arr] of orphansByType) {
			let maxDist = -1;
			for (const o of arr) if (o.distance > maxDist) maxDist = o.distance;
			for (const o of arr) {
				if (o.distance !== maxDist) continue;
				this.world.setBlock(o.x, o.y, o.z, AIR);
				this.changed = true;
				this.onBlockChanged(o.x, o.y, o.z);
				drainedThisTick.add(`${o.x},${o.y},${o.z}`);
				this.markDirty(touchedChunks, o.x, o.z);
			}
		}
		this.flushDirty(touchedChunks);
		return drainedThisTick;
	}

	// -----------------------------------------------------------------------------------------

	private decayFrontier(): void {
		for (const c of this.world.allChunks()) {
			const baseX = c.cx * CHUNK_SIZE_X;
			const baseZ = c.cz * CHUNK_SIZE_Z;
			const toRemove: number[] = [];
			for (const idx of c.liquidFrontier) {
				const { lx, y, lz } = unpackIndex(idx);
				const x = baseX + lx, z = baseZ + lz;
				if (!isLiquid(this.world.getBlock(x, y, z))) {
					toRemove.push(idx);
					continue;
				}
				const neighbours = [
					this.world.getBlock(x + 1, y, z),
					this.world.getBlock(x - 1, y, z),
					this.world.getBlock(x, y - 1, z),
					this.world.getBlock(x, y, z + 1),
					this.world.getBlock(x, y, z - 1),
				];
				const hasAir = neighbours.some((n) => n === AIR);
				if (!hasAir) toRemove.push(idx);
			}
			for (const i of toRemove) c.liquidFrontier.delete(i);
		}
	}

	// -----------------------------------------------------------------------------------------

	private commit(pending: PendingWrite[]): void {
		// Dedup: liquid beats AIR on the same coord; lower flowDistance wins among liquids.
		const map = new Map<string, PendingWrite>();
		for (const w of pending) {
			const k = `${w.x},${w.y},${w.z}`;
			const prev = map.get(k);
			if (prev === undefined) { map.set(k, w); continue; }
			if (prev.id === AIR && w.id !== AIR) { map.set(k, w); continue; }
			if (prev.id !== AIR && w.id !== AIR) {
				const a = prev.flowDistance ?? -1;
				const b = w.flowDistance ?? -1;
				if (b < a) map.set(k, w);
			}
		}

		const touchedChunks = new Set<string>();
		for (const [k, w] of map) {
			const [xs, ys, zs] = k.split(',');
			const x = Number(xs), y = Number(ys), z = Number(zs);
			const current = this.world.getBlock(x, y, z);
			if (current === w.id && !isLiquid(w.id)) continue;
			if (w.flowDistance === null) {
				this.world.setBlock(x, y, z, w.id);
				this.changed = true;
			} else {
				this.world.setBlockFlow(x, y, z, w.id, w.flowDistance);
				this.changed = true;
			}
			this.onBlockChanged(x, y, z);
			this.markDirty(touchedChunks, x, z);
		}
		this.flushDirty(touchedChunks);
	}

	/** Record the chunk containing (x, z) as dirty, plus the adjacent chunk on any side
	 *  where the cell sits on the chunk edge — a liquid face in that neighbour may now
	 *  look into a hole and needs remeshing. */
	private markDirty(touched: Set<string>, x: number, z: number): void {
		const cx = Math.floor(x / CHUNK_SIZE_X);
		const cz = Math.floor(z / CHUNK_SIZE_Z);
		const lx = x - cx * CHUNK_SIZE_X;
		const lz = z - cz * CHUNK_SIZE_Z;
		touched.add(`${cx},${cz}`);
		if (lx === 0) touched.add(`${cx - 1},${cz}`);
		else if (lx === CHUNK_SIZE_X - 1) touched.add(`${cx + 1},${cz}`);
		if (lz === 0) touched.add(`${cx},${cz - 1}`);
		else if (lz === CHUNK_SIZE_Z - 1) touched.add(`${cx},${cz + 1}`);
	}

	private flushDirty(touched: Set<string>): void {
		for (const ck of touched) {
			const [cxs, czs] = ck.split(',');
			this.onChunkDirty(Number(cxs), Number(czs));
		}
	}

	private collectFrontier(c: Chunk, out: Coord[]): void {
		const baseX = c.cx * CHUNK_SIZE_X;
		const baseZ = c.cz * CHUNK_SIZE_Z;
		for (const idx of c.liquidFrontier) {
			const { lx, y, lz } = unpackIndex(idx);
			out.push({ x: baseX + lx, y, z: baseZ + lz });
		}
	}

	private isFlowAt(x: number, y: number, z: number): boolean {
		const cx = Math.floor(x / CHUNK_SIZE_X);
		const cz = Math.floor(z / CHUNK_SIZE_Z);
		const c = this.world.getChunk(cx, cz);
		if (!c) return false;
		const lx = ((x % CHUNK_SIZE_X) + CHUNK_SIZE_X) % CHUNK_SIZE_X;
		const lz = ((z % CHUNK_SIZE_Z) + CHUNK_SIZE_Z) % CHUNK_SIZE_Z;
		return c.isFlow(lx, y, lz);
	}

	private flowDistanceAt(x: number, y: number, z: number): number {
		const cx = Math.floor(x / CHUNK_SIZE_X);
		const cz = Math.floor(z / CHUNK_SIZE_Z);
		const c = this.world.getChunk(cx, cz);
		if (!c) return 0;
		const lx = ((x % CHUNK_SIZE_X) + CHUNK_SIZE_X) % CHUNK_SIZE_X;
		const lz = ((z % CHUNK_SIZE_Z) + CHUNK_SIZE_Z) % CHUNK_SIZE_Z;
		return c.getFlowDistance(lx, y, lz);
	}
}

function unpackIndex(idx: number): { lx: number; y: number; lz: number } {
	const y = Math.floor(idx / (CHUNK_SIZE_X * CHUNK_SIZE_Z));
	const rem = idx - y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
	const lz = Math.floor(rem / CHUNK_SIZE_X);
	const lx = rem - lz * CHUNK_SIZE_X;
	return { lx, y, lz };
}
