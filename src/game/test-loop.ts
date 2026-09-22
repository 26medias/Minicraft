// Headless GameLoop harness for tests (not shipped; nothing under src/ imports it except *.test.ts).
import * as THREE from 'three';
import { GameLoop } from './loop';
import { World } from '../engine/world/world';
import { FpCamera } from '../engine/render/camera';
import type { LightRegistry } from '../engine/render/light-registry';
import type { FaceHighlight } from '../engine/render/face-highlight';
import { Player, type Keys } from './player';
import { AIR } from '../data/blocks.data';
import type { Renderer } from '../engine/render/renderer';
import type { Chunk } from '../engine/world/chunk';
import type { ChunkMeshResult } from '../engine/world/mesher';
import { chunkIndex } from '../engine/world/coords';

export type MakeLoopOpts = { lights?: LightRegistry | null; highlight?: FaceHighlight | null; seed?: number };
// Task 5 adds `jobs?: ChunkJobs | null` to MakeLoopOpts and passes it as GameLoop's last constructor argument.

/**
 * GameLoop's constructor only builds the LiquidScheduler; it never dereferences the renderer, so a
 * stub keeps tests out of WebGL and off the DOM. The stub captures the tick callback so tests can
 * drive a full tick() headlessly, counts mounts and records the last mesh per chunk index.
 */
export function makeLoop(opts: MakeLoopOpts = {}) {
	const { lights = null, highlight = null, seed } = opts;
	// seed undefined → today's fixture: v1 world (64-high) with chunk (16,16) cleared. seed given → World.create(seed): 256-high v3 world.
	const world = seed === undefined ? new World(1) : World.create(seed);
	if (seed === undefined) {
		const c = world.ensureChunk(16, 16);
		c.blocks.fill(AIR);
		c.lights.fill(0);
		c.liquidFrontier.clear();
	}
	let tickFn: ((dt: number) => void) | null = null;
	let mounts = 0;
	const meshes = new Map<number, ChunkMeshResult>();
	const renderer = {
		camera: new THREE.PerspectiveCamera(),
		mountChunkMesh: (c: Chunk, m: ChunkMeshResult) => {
			mounts++;
			meshes.set(chunkIndex(c.cx, c.cz), m);
		},
		unmountChunk: (cx: number, cz: number) => {
			meshes.delete(chunkIndex(cx, cz));
		},
		onTick: (fn: (dt: number) => void) => {
			tickFn = fn;
		},
	} as unknown as Renderer;
	const keys: Keys = { forward: false, back: false, left: false, right: false, jump: false };
	const player = new Player(seed === undefined ? [260, 40, 260] : [256.5, 200, 256.5]);
	const loop = new GameLoop(world, renderer, new FpCamera(), player, keys, () => [0, 0, 1, 1], null, null, lights, highlight);
	loop.start();
	const tick = (dt: number) => tickFn!(dt);
	return { loop, world, player, keys, tick, mounts: () => mounts, meshes: () => meshes };
}
