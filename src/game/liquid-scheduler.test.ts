import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { BLOCK_BY_NAME, AIR } from '../data/blocks.data';
import { LiquidScheduler } from './liquid-scheduler';

const water = BLOCK_BY_NAME['water'].id;
const stone = BLOCK_BY_NAME['stone'].id;

function freshWorld(): World {
	const w = new World(1);
	// Force-create chunk (16, 16) covering coords ~(256..271). Clear it.
	const c = w.ensureChunk(16, 16);
	c.blocks.fill(AIR);
	c.lights.fill(0);
	c.liquidFrontier.clear();
	return w;
}

describe('LiquidScheduler — tick accumulator', () => {
	it('tick(0.4) does not fire', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.4);
		expect(w.getBlock(260, 30, 260)).toBe(water);
		expect(w.getBlock(260, 29, 260)).toBe(AIR);
	});

	it('tick(0.6) fires once', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(AIR);
		expect(w.getBlock(260, 29, 260)).toBe(water);
	});

	it('tick(1.2) fires once, not twice (no catch-up)', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(1.2);
		expect(w.getBlock(260, 29, 260)).toBe(water);
		expect(w.getBlock(260, 28, 260)).toBe(AIR);
	});
});

describe('LiquidScheduler — fall rule', () => {
	it('unsupported liquid block falls by 1 voxel per tick', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 29, 260)).toBe(water);
		expect(w.getBlock(260, 30, 260)).toBe(AIR);
	});

	it('liquid with solid below does not fall', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, stone);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(water);
	});

	it('liquid with same-type liquid below does not fall', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, water);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(water);
		expect(w.getBlock(260, 29, 260)).toBe(water);
	});
});
