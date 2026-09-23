// Headless GameLoop harness for tests (not shipped; nothing under src/ imports it except *.test.ts).
import * as THREE from 'three';
import { GameLoop } from './loop';
import { World } from '../engine/world/world';
import { FpCamera } from '../engine/render/camera';
import type { LightRegistry } from '../engine/render/light-registry';
import type { FaceHighlight } from '../engine/render/face-highlight';
import type { ParticleSystem } from '../engine/render/particles';
import { Player, type Keys } from './player';
import { AIR } from '../data/blocks.data';
import type { Renderer } from '../engine/render/renderer';
import type { Chunk } from '../engine/world/chunk';
import type { ChunkMeshResult } from '../engine/world/mesher';
import { chunkIndex } from '../engine/world/coords';
import type { ChunkJobs } from '../engine/world/chunk-jobs';

/** `jobs` null/undefined → every chunk mounts synchronously; a ChunkJobs → streaming mounts go through it. */
export type MakeLoopOpts = { lights?: LightRegistry | null; highlight?: FaceHighlight | null; seed?: number; jobs?: ChunkJobs | null; particles?: ParticleSystem | null };

/**
 * GameLoop's constructor only builds the LiquidScheduler; it never dereferences the renderer, so a
 * stub keeps tests out of WebGL and off the DOM. The stub captures the tick callback so tests can
 * drive a full tick() headlessly, counts mounts and records the last mesh per chunk index.
 */
export function makeLoop(opts: MakeLoopOpts = {}) {
	const { lights = null, highlight = null, seed, jobs = null, particles = null } = opts;
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
	const cam = new FpCamera();
	const loop = new GameLoop(world, renderer, cam, player, keys, () => [0, 0, 1, 1], particles, null, lights, highlight, jobs);
	loop.start();
	const tick = (dt: number) => tickFn!(dt);
	return { loop, world, player, keys, cam, tick, mounts: () => mounts, meshes: () => meshes };
}
