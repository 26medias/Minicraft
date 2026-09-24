// DEV-only oracles for the two-client end-to-end suite (plan I2, scripts/mp-e2e.ts). main.ts exposes
// them on `window.__mc` under `import.meta.env.DEV`, so none of this reaches the built bundle.
import * as THREE from 'three';
import { World } from '../engine/world/world';
import { ChunkOverlay } from '../engine/world/overlay';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, WORLD_CHUNKS_X, WORLD_CHUNKS_Z, type WorldHeight } from '../engine/world/coords';
import type { Renderer } from '../engine/render/renderer';
import { FpCamera } from '../engine/render/camera';
import { GameLoop } from '../game/loop';
import { Player, type Keys } from '../game/player';
import type { BlockId } from '../data/blocks.data';

/** FNV-1a (32-bit) step over one byte. */
function fnv(h: number, byte: number): number {
	return Math.imul(h ^ (byte & 0xff), 0x01000193) >>> 0;
}

function fnvU32(h: number, v: number): number {
	h = fnv(h, v);
	h = fnv(h, v >>> 8);
	h = fnv(h, v >>> 16);
	return fnv(h, v >>> 24);
}

/**
 * The world hash of a set of chunks (plan I2): FNV-1a over each chunk's `blocks`, then its
 * `fluidMeta` entries sorted by cell index. The chunks are hashed in the order given. null when
 * one of them is not loaded: the oracle never generates a chunk in a live game.
 */
export function worldHash(world: World, chunks: ReadonlyArray<readonly [number, number]>): string | null {
	let h = 0x811c9dc5;
	for (const [cx, cz] of chunks) {
		const c = world.getChunk(cx, cz);
		if (!c) return null;
		h = fnvU32(h, cx);
		h = fnvU32(h, cz);
		const b = c.blocks;
		for (let i = 0; i < b.length; i++) {
			h = fnv(h, b[i]);
			h = fnv(h, b[i] >>> 8);
		}
		const fluid = [...c.fluidMeta.entries()].filter(([, v]) => v !== 0).sort((p, q) => p[0] - q[0]);
		for (const [i, v] of fluid) {
			h = fnvU32(h, i);
			h = fnv(h, v);
		}
	}
	return h.toString(16).padStart(8, '0');
}

/** Every overlay cell, flat like a snapshot: [x, y, z, id, fluid, color, …]. The base of a replay. */
export function overlayCells(overlay: ChunkOverlay): number[] {
	const out: number[] = [];
	// ChunkOverlay keeps its cells private; this DEV oracle reads them without widening its API.
	const chunks = (overlay as unknown as { chunks: Map<number, Map<number, [number, number, number]>> }).chunks;
	const layer = CHUNK_SIZE_X * CHUNK_SIZE_Z;
	for (const [ci, cells] of chunks) {
		const cx = Math.floor(ci / WORLD_CHUNKS_Z);
		const cz = ci - cx * WORLD_CHUNKS_Z;
		for (const [i, [id, fluid, color]] of cells) {
			const y = Math.floor(i / layer);
			const r = i - y * layer;
			const lz = Math.floor(r / CHUNK_SIZE_X);
			const lx = r - lz * CHUNK_SIZE_X;
			out.push(cx * CHUNK_SIZE_X + lx, y, cz * CHUNK_SIZE_Z + lz, id, fluid, color);
		}
	}
	return out;
}

/** One action of a single-client replay, at `t` seconds after the start. */
export type RefAction =
	| { t: number; kind: 'set'; x: number; y: number; z: number; id: number }
	| { t: number; kind: 'ignite'; x: number; y: number; z: number };

export type RefReplayOpts = {
	seed: number;
	height: number;
	gen: number;
	/** The overlay before the first action ({@link overlayCells} of a client, taken then). */
	base: ArrayLike<number>;
	/** The chunks to load and hash (the scenario's neighbourhood). */
	chunks: ReadonlyArray<readonly [number, number]>;
	/** Where the reference's (motionless) player stands: near the spot, outside any blast. */
	player: [number, number, number];
	/** Quiet time that counts as settled, simulated seconds. */
	settleS?: number;
	/** Give up (null) when it has not settled by then: some terrain has liquid limit cycles (C3, T3). */
	maxS?: number;
};

export type RefReplayResult = { hash: string; settledAt: number; writes: number };

/**
 * The E2/E3 reference (plan I2): a fresh World from the seed plus the base overlay, the given
 * actions replayed by ONE client — a headless GameLoop, so TNT and liquids run through the game's
 * own `simulate` — in fixed 1/60 s steps until nothing was written for `settleS`. Returns the
 * {@link worldHash} of `chunks`, or null when it never settles.
 */
export function refReplay(actions: readonly RefAction[], o: RefReplayOpts): RefReplayResult | null {
	const settleS = o.settleS ?? 20;
	const maxS = o.maxS ?? 120;
	const world = new World(o.seed, { height: o.height as WorldHeight, genVersion: o.gen, saveVersion: 3 });
	const overlay = new ChunkOverlay();
	overlay.loadSnapshot(Int32Array.from(o.base));
	world.overlay = overlay;
	for (const [cx, cz] of o.chunks) {
		if (cx >= 0 && cx < WORLD_CHUNKS_X && cz >= 0 && cz < WORLD_CHUNKS_Z) world.ensureChunk(cx, cz);
	}
	// GameLoop never dereferences the renderer outside tick(); simulate() alone drives liquids and TNT.
	const renderer = {
		camera: new THREE.PerspectiveCamera(),
		mountChunkMesh: () => {},
		unmountChunk: () => {},
		onTick: () => {},
	} as unknown as Renderer;
	const keys: Keys = { forward: false, back: false, left: false, right: false, jump: false, sneak: false };
	const player = new Player(o.player, world.height);
	const loop = new GameLoop(world, renderer, new FpCamera(), player, keys, () => [0, 0, 1, 1]);
	const dt = 1 / 60;
	let t = 0;
	let lastWrite = 0;
	let writes = 0;
	world.onLocalWrite = () => {
		lastWrite = t;
		writes++;
	};
	const done = actions.map(() => false);
	while (!(done.every(Boolean) && t - lastWrite >= settleS)) {
		if (t > maxS) return null;
		t += dt;
		actions.forEach((a, k) => {
			if (done[k] || a.t > t) return;
			done[k] = true;
			if (a.kind === 'set') world.setBlock(a.x, a.y, a.z, a.id as BlockId);
			else loop.ignite({ x: a.x, y: a.y, z: a.z, face: 'py' } as Parameters<GameLoop['ignite']>[0], 0);
			lastWrite = t;
		});
		loop.simulate(dt);
	}
	const hash = worldHash(world, o.chunks);
	return hash === null ? null : { hash, settledAt: t, writes };
}
