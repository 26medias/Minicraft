// Pure minimap geometry and terrain colouring (spec §7.6). No DOM: the canvas lives in minimap.ts.
import { AIR, isLiquid } from '../data/blocks.data';
import type { Chunk } from '../engine/world/chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from '../engine/world/coords';

/** The map covers a radius of 48 blocks around the player. */
export const MAP_RADIUS_BLOCKS = 48;
/** The terrain image is 97 × 97 cells: the player's column plus 48 on each side. */
export const MAP_CELLS = MAP_RADIUS_BLOCKS * 2 + 1;
/** Columns in unloaded chunks (or outside the world). */
export const DARK_GREY = [40, 40, 40] as const;
/** Liquids are drawn at 70% over the block beneath them. */
export const LIQUID_ALPHA = 0.7;
/** At most this many chunk column rebuilds per frame. */
export const MAX_REBUILDS_PER_FRAME = 4;

/**
 * Where another player at (ox, oz) appears on the map, relative to its centre, in pixels: x to the
 * right, y down. The map rotates with the player, so forward is up. `yaw` is the camera's
 * (camera.ts: forward = (−sin yaw, −cos yaw), right = (cos yaw, −sin yaw)). A player beyond
 * `radiusBlocks` is pinned to the rim in their direction.
 */
export function toMap(
	px: number,
	pz: number,
	yaw: number,
	ox: number,
	oz: number,
	radiusBlocks: number,
	radiusPx: number,
): { x: number; y: number; clamped: boolean } {
	const dx = ox - px;
	const dz = oz - pz;
	const sin = Math.sin(yaw);
	const cos = Math.cos(yaw);
	const forward = -dx * sin - dz * cos;
	const right = dx * cos - dz * sin;
	const dist = Math.hypot(dx, dz);
	const clamped = dist > radiusBlocks;
	const scale = clamped ? radiusPx / dist : radiusPx / radiusBlocks;
	return { x: right * scale, y: -forward * scale, clamped };
}

/**
 * The canvas rotation that turns the north-up terrain image (x right = +x, y down = +z) into the
 * forward-up map. It matches `toMap` for every yaw (tested).
 */
export function mapRotation(yaw: number): number {
	return yaw;
}

/** ▲ when the other player is more than 8 blocks above, ▼ more than 8 below. */
export function heightArrow(dy: number): '▲' | '▼' | '' {
	if (dy > 8) return '▲';
	if (dy < -8) return '▼';
	return '';
}

/** A block's minimap colour from the table built by `buildColorTable`. */
export function columnColor(topId: number, table: Uint8Array): [number, number, number] {
	const o = topId * 3;
	return [table[o], table[o + 1], table[o + 2]];
}

/** Per-chunk column summary: the highest non-air block, and what a liquid sits on. */
export type ColumnEntry = {
	rev: number;
	/** Highest non-air block per column, at `lz * 16 + lx`; AIR for an empty column. */
	top: Uint16Array;
	/** For a liquid top: the first non-air, non-liquid block below it (AIR if none). */
	floor: Uint16Array;
};

/** The highest layer holding any non-air block, or −1; reads two cells at a time when aligned. */
function highestNonEmptyLayer(blocks: Uint16Array, height: number): number {
	const layer = CHUNK_SIZE_X * CHUNK_SIZE_Z;
	if (blocks.byteOffset % 4 === 0) {
		const words = new Uint32Array(blocks.buffer, blocks.byteOffset, blocks.length >> 1);
		const perLayer = layer >> 1;
		for (let y = height - 1; y >= 0; y--) {
			const base = y * perLayer;
			for (let i = 0; i < perLayer; i++) if (words[base + i] !== 0) return y;
		}
		return -1;
	}
	for (let y = height - 1; y >= 0; y--) {
		const base = y * layer;
		for (let i = 0; i < layer; i++) if (blocks[base + i] !== AIR) return y;
	}
	return -1;
}

function buildColumns(chunk: Chunk): ColumnEntry {
	const layer = CHUNK_SIZE_X * CHUNK_SIZE_Z;
	const top = new Uint16Array(layer);
	const floor = new Uint16Array(layer);
	// 0 = looking for the top, 1 = under a liquid looking for its floor, 2 = done.
	const state = new Uint8Array(layer);
	const blocks = chunk.blocks;
	let open = layer;
	// Layer by layer from the sky down: contiguous reads, and it stops once every column is done.
	for (let y = highestNonEmptyLayer(blocks, chunk.height); y >= 0 && open > 0; y--) {
		const base = y * layer;
		for (let col = 0; col < layer; col++) {
			const s = state[col];
			if (s === 2) continue;
			const id = blocks[base + col];
			if (id === AIR) continue;
			if (s === 0) {
				top[col] = id;
				if (isLiquid(id)) state[col] = 1;
				else { state[col] = 2; open--; }
			} else if (!isLiquid(id)) {
				floor[col] = id;
				state[col] = 2;
				open--;
			}
		}
	}
	return { rev: chunk.rev, top, floor };
}

/**
 * Column summaries per chunk, invalidated by `rev`. Keyed by the chunk object, so an evicted and
 * regenerated chunk (a new object, maybe the same rev) is never served another's columns.
 */
export class ColumnCache {
	private entries = new WeakMap<Chunk, ColumnEntry>();

	/** Rebuilds stale or missing entries, in the given order, at most `budget` of them. Returns the count. */
	prepare(chunks: readonly Chunk[], budget: number): number {
		let rebuilt = 0;
		for (const c of chunks) {
			if (rebuilt >= budget) break;
			const e = this.entries.get(c);
			if (e && e.rev === c.rev) continue;
			this.entries.set(c, buildColumns(c));
			rebuilt++;
		}
		return rebuilt;
	}

	/** The last built entry, possibly stale; undefined when never built. */
	lookup(chunk: Chunk): ColumnEntry | undefined {
		return this.entries.get(chunk);
	}
}

/** What the map reads from the world. `getChunk` must never create a chunk. */
export type MapWorld = {
	getChunk(cx: number, cz: number): Chunk | undefined;
};

/**
 * Paints the north-up terrain image (MAP_CELLS², RGBA) centred on the player's column, after
 * rebuilding at most `budget` stale chunks, nearest first. Unloaded or not-yet-built chunks are
 * dark grey.
 */
export function fillMap(
	img: Uint8ClampedArray,
	world: MapWorld,
	px: number,
	pz: number,
	cache: ColumnCache,
	table: Uint8Array,
	budget: number,
): void {
	const x0 = Math.floor(px) - MAP_RADIUS_BLOCKS;
	const z0 = Math.floor(pz) - MAP_RADIUS_BLOCKS;
	const cxMin = Math.floor(x0 / CHUNK_SIZE_X);
	const czMin = Math.floor(z0 / CHUNK_SIZE_Z);
	const cxMax = Math.floor((x0 + MAP_CELLS - 1) / CHUNK_SIZE_X);
	const czMax = Math.floor((z0 + MAP_CELLS - 1) / CHUNK_SIZE_Z);
	const spanX = cxMax - cxMin + 1;
	const spanZ = czMax - czMin + 1;
	const grid: (Chunk | undefined)[] = new Array(spanX * spanZ);
	const loaded: Chunk[] = [];
	for (let cx = cxMin; cx <= cxMax; cx++) {
		for (let cz = czMin; cz <= czMax; cz++) {
			const c = world.getChunk(cx, cz);
			grid[(cx - cxMin) * spanZ + (cz - czMin)] = c;
			if (c) loaded.push(c);
		}
	}
	const pcx = px / CHUNK_SIZE_X - 0.5;
	const pcz = pz / CHUNK_SIZE_Z - 0.5;
	loaded.sort((a, b) => Math.hypot(a.cx - pcx, a.cz - pcz) - Math.hypot(b.cx - pcx, b.cz - pcz));
	cache.prepare(loaded, budget);

	const entries: (ColumnEntry | undefined)[] = grid.map((c) => (c ? cache.lookup(c) : undefined));
	for (let j = 0; j < MAP_CELLS; j++) {
		const wz = z0 + j;
		const cz = Math.floor(wz / CHUNK_SIZE_Z);
		const lz = wz - cz * CHUNK_SIZE_Z;
		for (let i = 0; i < MAP_CELLS; i++) {
			const wx = x0 + i;
			const cx = Math.floor(wx / CHUNK_SIZE_X);
			const lx = wx - cx * CHUNK_SIZE_X;
			const o = (j * MAP_CELLS + i) * 4;
			img[o + 3] = 255;
			const e = entries[(cx - cxMin) * spanZ + (cz - czMin)];
			if (!e) {
				img[o] = DARK_GREY[0]; img[o + 1] = DARK_GREY[1]; img[o + 2] = DARK_GREY[2];
				continue;
			}
			const col = lz * CHUNK_SIZE_X + lx;
			const top = e.top[col];
			const t = top * 3;
			const floor = e.floor[col];
			if (floor !== AIR) {
				const f = floor * 3;
				img[o] = Math.round(LIQUID_ALPHA * table[t] + (1 - LIQUID_ALPHA) * table[f]);
				img[o + 1] = Math.round(LIQUID_ALPHA * table[t + 1] + (1 - LIQUID_ALPHA) * table[f + 1]);
				img[o + 2] = Math.round(LIQUID_ALPHA * table[t + 2] + (1 - LIQUID_ALPHA) * table[f + 2]);
			} else {
				img[o] = table[t]; img[o + 1] = table[t + 1]; img[o + 2] = table[t + 2];
			}
		}
	}
}
