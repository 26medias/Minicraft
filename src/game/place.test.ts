import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeLoop } from './test-loop';
import { tryPlace, applyRemoved } from './place';
import { AIR, BLOCK_BY_NAME } from '../data/blocks.data';
import { LightRegistry } from '../engine/render/light-registry';
import { TNT_PRIME_FUSE } from './tnt';
import type { VoxelHit } from '../engine/input/raycast';

const id = (n: string) => BLOCK_BY_NAME[n].id;
const stone = id('stone'), dirt = id('dirt'), cobble = id('cobblestone'), lamp = id('lamp'), coal = id('coal_ore'), tnt = id('tnt');
const sand = id('sand'), planks = id('oak_planks'), glass = id('glass'), oak = id('oak_log');

/** Player inside the cleared chunk (16,16), off block boundaries, flying so it stays put; yaw 0 looks −z. */
function fixture(opts: { lights?: LightRegistry } = {}) {
	const h = makeLoop({ lights: opts.lights ?? null });
	h.player.flying = true;
	h.player.position = [264.5, 40, 270.5];
	h.world.setBlock(264, 38, 268, dirt); // the block we build on
	return h;
}
/** Top face of the dirt: a plain place writes (264, 39, 268); a replace overwrites the dirt. */
const base: VoxelHit = { x: 264, y: 38, z: 268, face: 'py', distance: 3 };

describe('tryPlace (spec §2, §3)', () => {
	it('must-mine: refuses place and replace at count 0; mining one makes it placeable; placing takes the count back to 0 (catches a refusal that only guards the plain place)', () => {
		const { loop, world, player, tick } = fixture();
		player.hotbar = [stone, cobble, dirt, sand, AIR, planks, glass, lamp, oak];
		player.selected = 0;
		const place = (shift: boolean) => tryPlace({ loop, world, player, hit: base, shift, mustMine: true, lampColor: '#ffffff' });

		expect(place(false)).toEqual({ ok: false, reason: 'no-count' });
		expect(world.getBlock(264, 39, 268)).toBe(AIR);
		expect(place(true)).toEqual({ ok: false, reason: 'no-count' });
		expect(world.getBlock(264, 38, 268)).toBe(dirt);

		loop.onBlockBroken = (ev) => { applyRemoved(player, [ev.blockId], true); };
		world.setBlock(264, 41, 267, stone); // under the crosshair
		loop.setLeftMouseDown(true);
		for (let i = 0; i < 60 && world.getBlock(264, 41, 267) !== AIR; i++) tick(0.05);
		loop.setLeftMouseDown(false);
		expect(world.getBlock(264, 41, 267)).toBe(AIR);
		expect(player.inventory).toEqual({ stone: 1 });

		expect(place(false)).toEqual({ ok: true });
		expect(world.getBlock(264, 39, 268)).toBe(stone);
		expect(player.inventory).toEqual({ stone: 0 });
	}, 30_000);

	it('free placements never touch counts: stone in an unlimited world, cobblestone in a must-mine world (catches an unconditional −1 writing zero keys)', () => {
		const { loop, world, player } = fixture();
		player.hotbar = [stone, cobble, AIR, AIR, AIR, AIR, AIR, AIR, AIR];
		player.selected = 0;
		expect(tryPlace({ loop, world, player, hit: base, shift: false, mustMine: false, lampColor: '#ffffff' })).toEqual({ ok: true });
		expect(player.inventory).toEqual({});
		player.selected = 1;
		const up: VoxelHit = { x: 264, y: 39, z: 268, face: 'py', distance: 3 };
		expect(tryPlace({ loop, world, player, hit: up, shift: false, mustMine: true, lampColor: '#ffffff' })).toEqual({ ok: true });
		expect(world.getBlock(264, 40, 268)).toBe(cobble);
		expect(player.inventory).toEqual({});
	});

	it('replace: −1 placed under the rule, +1 replaced always (catches a replace path that skips the counts)', () => {
		const { loop, world, player } = fixture();
		player.hotbar = [stone, AIR, AIR, AIR, AIR, AIR, AIR, AIR, AIR];
		player.selected = 0;
		player.inventory = { stone: 1 };
		expect(tryPlace({ loop, world, player, hit: base, shift: true, mustMine: true, lampColor: '#ffffff' })).toEqual({ ok: true });
		expect(world.getBlock(264, 38, 268)).toBe(stone);
		expect(player.inventory).toEqual({ stone: 0, dirt: 1 });
	});

	it('a refused world write changes no count (catches −1 applied before the write is known to succeed)', () => {
		const { loop, world, player } = fixture();
		player.hotbar = [stone, AIR, AIR, AIR, AIR, AIR, AIR, AIR, AIR];
		player.selected = 0;
		player.inventory = { stone: 2 };
		world.setBlock(264, 39, 268, glass); // target cell occupied
		expect(tryPlace({ loop, world, player, hit: base, shift: false, mustMine: true, lampColor: '#ffffff' })).toEqual({ ok: false, reason: 'blocked' });
		expect(player.inventory).toEqual({ stone: 2 });
	});

	it('keeps the old handler\'s side effects: lamp colour registered, onWorldMutated fired once (catches the extraction dropping lights.add or markDirty)', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world, player } = fixture({ lights });
		let mutations = 0;
		loop.onWorldMutated = () => { mutations++; };
		player.hotbar = [lamp, AIR, AIR, AIR, AIR, AIR, AIR, AIR, AIR];
		player.selected = 0;
		expect(tryPlace({ loop, world, player, hit: base, shift: false, mustMine: false, lampColor: '#ff8800' })).toEqual({ ok: true });
		expect(world.getBlock(264, 39, 268)).toBe(lamp);
		expect(lights.getColor(264, 39, 268)).toBe('#ff8800');
		expect(mutations).toBe(1);
	});
});

describe('applyRemoved through a TNT blast (spec §3 auto-hotbar)', () => {
	it('a blast taking coal 0 → 5 counts 5 and puts coal on the first empty slot; the TNT itself is not counted (catches a trigger keyed to === 1)', () => {
		const { loop, world, player } = fixture();
		player.hotbar = [stone, cobble, dirt, sand, AIR, planks, glass, lamp, oak];
		player.selected = 0;
		loop.onBlocksRemoved = (removed) => { applyRemoved(player, removed.map((r) => r.blockId), true); };
		world.setBlock(264, 41, 262, tnt);
		for (const [x, y, z] of [[265, 41, 262], [263, 41, 262], [264, 42, 262], [264, 40, 262], [264, 41, 261]]) world.setBlock(x, y, z, coal);
		expect(loop.ignite({ x: 264, y: 41, z: 262, face: 'py', distance: 1 })).toBe(true);
		loop.simulate(TNT_PRIME_FUSE + 0.1);
		expect(world.getBlock(265, 41, 262)).toBe(AIR);
		expect(player.inventory.coal_ore).toBe(5);
		expect(player.inventory.tnt).toBeUndefined();
		expect(player.hotbar[4]).toBe(coal);
	});
});
