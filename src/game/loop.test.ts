import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { makeLoop } from './test-loop';
import { DATA_RADIUS as DATA_RADIUS_T } from '../engine/world/radii';
import { LightRegistry } from '../engine/render/light-registry';
import { FaceHighlight, HIGHLIGHT_EPS } from '../engine/render/face-highlight';
import { AIR, BLOCK_BY_NAME } from '../data/blocks.data';
import { TNT_PRIME_FUSE } from './tnt';
import { chunkIndex, indexOf } from '../engine/world/coords';
import { fillChunkLights } from '../engine/world/lighting';
import { readFileSync, existsSync } from 'node:fs';
import { ChunkJobs } from '../engine/world/chunk-jobs';
import { inlineWorkerFactory } from '../engine/world/chunk-jobs.test-utils';
import { buildUvTable, type AtlasJson } from '../engine/render/uv-table';
import { spawnV3 } from '../engine/world/v3/spawn';

if (!existsSync('public/atlas.json')) throw new Error('public/atlas.json missing: run npm run build-atlas (it is gitignored)');
const table = buildUvTable(JSON.parse(readFileSync('public/atlas.json', 'utf8')) as AtlasJson);
const flush = () => new Promise((r) => setTimeout(r, 0));
function fnvBytes(a: ArrayBufferView): number {
	const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	let h = 2166136261 >>> 0;
	for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
	return h;
}
/** Tick until the stream set and the worker are both drained (or maxTicks). Each tick is followed by a macrotask turn so the inline worker's microtasks run. */
async function drain(h: ReturnType<typeof makeLoop>, maxTicks = 600) {
	for (let k = 0; k < maxTicks; k++) {
		h.tick(1 / 60);
		await flush();
		if (h.loop.stats.streamQueue === 0 && h.loop.stats.workerInFlight === 0 && k > 5) return;
	}
	throw new Error(`stream did not drain in ${maxTicks} ticks`);
}
function picksAround(seed: number): number[] {
	const s = spawnV3(seed);
	const pcx = Math.floor(s.x / 16), pcz = Math.floor(s.z / 16);
	const out: number[] = [];
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(chunkIndex(pcx + dx, pcz + dz));
	return out;
}

const tnt = BLOCK_BY_NAME['tnt'].id;
const stone = BLOCK_BY_NAME['stone'].id;
const water = BLOCK_BY_NAME['water'].id;
const lamp = BLOCK_BY_NAME['lamp'].id;
const dirt = BLOCK_BY_NAME['dirt'].id;

describe('GameLoop.onWorldMutated', () => {
	it('fires when primed TNT detonates', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, tnt);
		world.setBlock(261, 40, 260, stone);

		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};

		expect(loop.ignite({ x: 260, y: 40, z: 260 } as never, 0)).toBe(true);
		loop.simulate(TNT_PRIME_FUSE + 0.1);

		expect(world.getBlock(261, 40, 260)).toBe(AIR);
		expect(mutations).toBeGreaterThan(0);
	});

	it('fires when liquid spreads', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, water);

		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};

		loop.simulate(1.0);

		expect(mutations).toBeGreaterThan(0);
	});

	it('does not fire on ticks that change nothing', () => {
		const { loop } = makeLoop();

		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};

		for (let i = 0; i < 20; i++) loop.simulate(0.016);

		expect(mutations).toBe(0);
	});
});

describe('GameLoop.paused', () => {
	it('stops physics and simulation but keeps loading chunks', () => {
		const { loop, world, player, keys, tick } = makeLoop();
		world.setBlock(260, 30, 260, tnt);
		world.setBlock(261, 30, 260, stone);
		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};
		expect(loop.ignite({ x: 260, y: 30, z: 260 } as never, 0)).toBe(true);

		keys.forward = true;
		loop.paused = true;
		const before = [...player.position];
		const chunksBefore = world.chunkCount;
		// Each tick loads/meshes chunks (~50 ms), so use few, long ticks:
		// Player.update sub-steps internally and 3 × 1 s > TNT_PRIME_FUSE (2.5 s).
		for (let i = 0; i < 3; i++) tick(1.0);
		expect(player.position).toEqual(before);
		expect(mutations).toBe(0);
		expect(world.getBlock(261, 30, 260)).toBe(stone);
		// Loading continues while paused. Neighbour generation is paced per frame, so the first mount may
		// need more than these 3 frames; the property is that chunks keep being generated.
		expect(world.chunkCount).toBeGreaterThan(chunksBefore);

		loop.paused = false;
		for (let i = 0; i < 3; i++) tick(1.0);
		expect(player.position).not.toEqual(before);
		expect(mutations).toBeGreaterThan(0);
		expect(world.getBlock(261, 30, 260)).toBe(AIR);
	}, 30_000);
});

describe('GameLoop.replaceBlock', () => {
	const hit = (x: number, y: number, z: number) =>
		({ x, y, z, face: 'py', distance: 1 }) as const;

	it('overwrites the block and fires onWorldMutated once', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, stone);
		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};
		expect(loop.replaceBlock(hit(260, 40, 260), dirt, '#ffffff')).toBe(true);
		expect(world.getBlock(260, 40, 260)).toBe(dirt);
		expect(mutations).toBe(1);
	});

	it('is a true no-op for a same-block replace', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, stone);
		const chunk = world.ensureChunk(16, 16);
		chunk.modified = false;
		chunk.liquidFrontier.clear();
		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};
		expect(loop.replaceBlock(hit(260, 40, 260), stone, '#ffffff')).toBe(false);
		expect(chunk.modified).toBe(false);
		expect(chunk.liquidFrontier.size).toBe(0);
		expect(mutations).toBe(0);
	});

	it('cancels a primed TNT fuse', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, tnt);
		world.setBlock(261, 40, 260, stone);
		expect(loop.ignite(hit(260, 40, 260), 0)).toBe(true);
		expect(loop.replaceBlock(hit(260, 40, 260), dirt, '#ffffff')).toBe(true);
		loop.simulate(TNT_PRIME_FUSE + 0.1);
		// detonate() ignores what sits at the origin, so a leaked fuse still
		// destroys the neighbour.
		expect(world.getBlock(261, 40, 260)).toBe(stone);
		expect(world.getBlock(260, 40, 260)).toBe(dirt);
	});

	it('registers a replaced-in lamp and lights the chunk in its colour', () => {
		// updateLightsForBlockChange reads the colour through lights.getColor and
		// packs it into chunk.lights, so a lamp registered *after* the light
		// update would be lit white. Compare a red lamp against a white one.
		const lit = (color: string) => {
			const lights = new LightRegistry(new THREE.Scene());
			const { loop, world } = makeLoop({ lights });
			world.setBlock(260, 40, 260, stone);
			const chunk = world.ensureChunk(16, 16);
			chunk.lights.fill(0);
			expect(loop.replaceBlock(hit(260, 40, 260), lamp, color)).toBe(true);
			expect(lights.getColor(260, 40, 260)).toBe(color);
			return chunk.lights[indexOf(4, 40, 4)];
		};
		const red = lit('#ff0000');
		const white = lit('#ffffff');
		expect(red).not.toBe(0);
		expect(white).not.toBe(0);
		expect(red).not.toBe(white);
	});

	it('unregisters a lamp replaced by stone', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world } = makeLoop({ lights });
		world.setBlock(260, 40, 260, lamp);
		lights.add(260, 40, 260, '#ff8800');
		expect(loop.replaceBlock(hit(260, 40, 260), stone, '#ffffff')).toBe(true);
		expect(lights.getColor(260, 40, 260)).toBeNull();
	});

	it('cancels in-progress mining on the replaced cell', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world, player, tick } = makeLoop({ lights });
		// Player at (260, 40, 260), eye y = 41.6, yaw 0 looks toward -z.
		player.flying = true; // no gravity, so the eye stays put
		world.setBlock(260, 41, 257, stone);
		loop.setLeftMouseDown(true);
		tick(0.05); // starts mining
		tick(0.05); // accumulates
		expect(loop.miningProgress()).toBeGreaterThan(0);

		expect(loop.replaceBlock(hit(260, 41, 257), lamp, '#ff8800')).toBe(true);
		expect(loop.miningProgress()).toBe(0);

		// Mouse still held: mining restarts on the lamp and eventually breaks it
		// (lamp hardness 0.3). A stale mining record would finish with stone's id
		// and skip lights.remove, orphaning the light.
		for (let i = 0; i < 40 && world.getBlock(260, 41, 257) !== AIR; i++) tick(0.05);
		expect(world.getBlock(260, 41, 257)).toBe(AIR);
		expect(lights.getColor(260, 41, 257)).toBeNull();
	});
});

describe('GameLoop face highlight', () => {
	function makeHighlight() {
		const scene = new THREE.Scene();
		const h = new FaceHighlight(scene);
		const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
		return { h, group };
	}

	it('shows the aimed face within reach and hides it beyond reach or when paused', () => {
		const { h, group } = makeHighlight();
		const { loop, world, player, tick } = makeLoop({ highlight: h });
		player.flying = true;
		// yaw 0 looks toward -z from eye (260, 41.6, 260); reach is 6.
		world.setBlock(260, 41, 257, stone);
		tick(0.05);
		expect(group.visible).toBe(true);
		expect(group.position.z).toBeCloseTo(258 + HIGHLIGHT_EPS, 6); // pz face of the block at z=257

		loop.paused = true;
		tick(0.05);
		expect(group.visible).toBe(false);
		loop.paused = false;
		// Re-show before the out-of-reach step, so the final assertion can only
		// pass if the tick actually hides the group again.
		tick(0.05);
		expect(group.visible).toBe(true);

		world.setBlock(260, 41, 257, AIR);
		// Reach is inclusive (raycastVoxel loops while t <= 6): a block whose near
		// face is 6.0 away is still hit. z=251 puts the face at 9.0, clearly out.
		world.setBlock(260, 41, 251, stone);
		tick(0.05);
		expect(group.visible).toBe(false);
	});
});

describe('GameLoop edit lane', () => {
	it('§6.4 sunlitHash compare: an interior edit dirties 4 chunks (1 edit + 3 SE shadowOnly) and re-meshes exactly 1 over two ticks (mutant: skip the compare → 4)', () => {
		const { loop, world, tick, mounts } = makeLoop();
		// interior-flat fixture: 3×3 chunks of flat stone at y 20, player above chunk (16,16)
		for (let cx = 15; cx <= 17; cx++) for (let cz = 15; cz <= 17; cz++) {
			const c = world.ensureChunk(cx, cz);
			c.blocks.fill(AIR);
			for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) c.blocks[indexOf(x, 20, z)] = stone;
			c.lights.fill(0);
			c.liquidFrontier.clear();
		}
		for (let cx = 15; cx <= 17; cx++) for (let cz = 15; cz <= 17; cz++) fillChunkLights(world, world.getChunk(cx, cz)!);
		// stream the whole MESH_RADIUS ring in (the still budget mounts several chunks per tick)
		// Settled = the queue stays empty and nothing mounts for 5 ticks in a row: with paced generation, late
		// neighbour arrivals can re-queue shadowOnly re-meshes after the queue first empties.
		let quiet = 0;
		for (let k = 0; k < 600 && quiet < 5; k++) {
			const m = mounts();
			tick(1 / 60);
			quiet = loop.stats.streamQueue === 0 && mounts() === m ? quiet + 1 : 0;
		}
		expect(quiet).toBe(5);
		const before = mounts();
		// interior voxel (264, 21, 264): lx = lz = 8 → markChunkDirtyAround marks exactly one chunk
		world.setBlock(264, 21, 264, stone);
		loop.markChunkDirtyAround(264, 264);
		loop.applyLightUpdate(264, 21, 264);
		tick(1 / 60); // edit lane: the edited chunk re-meshes (1)
		tick(1 / 60); // stream lane: the 3 SE shadowOnly chunks are shadowed; a single block on a flat plain changes no neighbour's sunlit → 0 re-meshes
		expect(mounts() - before).toBe(1);
		expect(loop.stats.lastEditMs).toBeGreaterThan(0);
		// work-only time of the edit lane (the bench gate): positive, and never more than the click-to-mount latency
		expect(loop.stats.lastEditWorkMs).toBeGreaterThan(0);
		expect(loop.stats.lastEditWorkMs).toBeLessThanOrEqual(loop.stats.lastEditMs);
	}, 30_000);
});

describe('worker streaming through the loop (spec §3.D / §6.3)', () => {
	it('neighbour seams: the worker path meshes the 9 spawn chunks byte-identically to the synchronous path (mutant: skip the axis-neighbour shadow pass in mountStream → 0/9 identical)', { timeout: 60_000 }, async () => {
		const seed = 3, s = spawnV3(seed), picks = picksAround(seed);
		const sync = makeLoop({ seed }); // jobs null → mountSync for every chunk
		const viaWorker = makeLoop({ seed, jobs: new ChunkJobs(inlineWorkerFactory(), table, 2) });
		for (const h of [sync, viaWorker]) {
			h.player.position = [s.x + 0.5, s.h + 2, s.z + 0.5];
			await drain(h);
		}
		expect(picks.every((i) => sync.meshes().has(i) && viaWorker.meshes().has(i))).toBe(true);
		let identical = 0;
		for (const i of picks) if (fnvBytes(sync.meshes().get(i)!.opaque.colors) === fnvBytes(viaWorker.meshes().get(i)!.opaque.colors)) identical++;
		expect(identical).toBe(9); // gate 2 measured 81/81 chunks differing when the pass is missing (all-zero neighbour sunlit → dark seams)
	});

	it('a reply dropped for a rev bump re-dirties the chunk and the next reply is applied (mutant: drop without re-dirty → stale geometry forever)', { timeout: 60_000 }, async () => {
		const seed = 3, s = spawnV3(seed);
		const h = makeLoop({ seed, jobs: new ChunkJobs(inlineWorkerFactory(), table, 2) });
		h.player.position = [s.x + 0.5, s.h + 2, s.z + 0.5];
		await drain(h);
		const cx = Math.floor(s.x / 16), cz = Math.floor(s.z / 16);
		const c = h.world.getChunk(cx, cz)!;
		const before = h.mounts();
		h.loop.markChunkDirty(cx, cz); // stream lane → mountStream posts a job
		h.tick(1 / 60); // posted, in flight
		expect(h.loop.stats.workerInFlight).toBe(1);
		c.rev++; // invalidate while in flight → the reply must be dropped and the chunk re-dirtied
		await drain(h); // onDropped re-adds it; the next job's reply is applied
		expect(h.mounts()).toBeGreaterThan(before);
		expect(h.loop.stats.streamQueue).toBe(0);
		expect(h.loop.stats.workerInFlight).toBe(0);
	});
});

describe('stale stream entries (perf gate-1 follow-up)', () => {
	it('chunks queued near an old position are never generated once the player has left their ring', () => {
		const { world, player, tick } = makeLoop();
		tick(1 / 60); tick(1 / 60); // queue the ring around (260, 260); only a few mount
		// leave: 15 chunks east, far outside MESH_RADIUS of the old ring
		player.position = [31 * 16 + 8, 40, 260];
		const orig = world.ensureChunk.bind(world);
		const far: string[] = [];
		world.ensureChunk = (cx: number, cz: number) => {
			const created = !world.getChunk(cx, cz);
			const c = orig(cx, cz);
			const pcx = Math.floor(player.position[0] / 16), pcz = Math.floor(player.position[2] / 16);
			// Legitimate creation reaches DATA_RADIUS (a ring-5 mount ensures its 3×3 at 6; re-shadowing a ring-6
			// chunk ensures ITS 3×3 at 7). Beyond DATA_RADIUS the evictor drops the chunk again: pure waste.
			// Before the fix, stale queue entries created 447 chunks at distance 7..17 here.
			if (created && Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) > DATA_RADIUS_T) far.push(`${cx},${cz}`);
			return c;
		};
		for (let k = 0; k < 40; k++) tick(1 / 60);
		expect(far).toEqual([]);
	}, 30_000);
});

describe('paced neighbour generation (perf: initial-load gate)', () => {
	it('a streaming mount generates its missing 3×3 across frames within the budget, never all at once', () => {
		const { world, tick } = makeLoop();
		let clock = 1000;
		const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
		const orig = world.ensureChunk.bind(world);
		let created = 0;
		world.ensureChunk = (cx: number, cz: number) => {
			if (!world.getChunk(cx, cz)) { created++; clock += 7; } // each new chunk costs 7 ms of main thread
			return orig(cx, cz);
		};
		try {
			const perTick: number[] = [];
			for (let k = 0; k < 6; k++) { const b = created; tick(1 / 60); clock += 16; perTick.push(created - b); }
			// Initial-load budget 20 ms, and a chunk is started only with ≥ 10 ms left: at 7 ms per chunk that is
			// 2 per frame (starts at 0 and 7; at 14 only 6 ms remain). Without the reserve a third starts at 14 and
			// overshoots to 21; before pacing the first streaming mount generated its whole 3×3 in one frame.
			// (tick 0 also generates the chunk under the crosshair via the aim raycast, outside the stream budget)
			for (const n of perTick.slice(1)) expect(n).toBeLessThanOrEqual(2);
			expect(perTick[0]).toBeLessThanOrEqual(3);
			expect(perTick.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(8); // it still makes progress
		} finally {
			spy.mockRestore();
		}
	}, 30_000);
});
