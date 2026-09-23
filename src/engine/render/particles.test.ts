// Toys spec §3.3: ParticleSystem.spawnFirework — a rocket 12 blocks up in 1 s, then a burst; at most 8 big bursts at once.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { FIREWORK_MAX_BURSTS, FIREWORK_RISE, FIREWORK_SPARKS_BIG, FIREWORK_SPARKS_SMALL, ParticleSystem } from './particles';
import type { LoadedAtlas } from './atlas';

function system() {
	const scene = new THREE.Scene();
	const atlas = { uvFor: () => [0, 0, 1, 1] } as unknown as LoadedAtlas;
	return { scene, ps: new ParticleSystem(scene, new THREE.MeshBasicMaterial(), atlas) };
}
const meanY = (scene: THREE.Scene) => scene.children.reduce((s, m) => s + m.position.y, 0) / scene.children.length;

describe('spawnFirework (toys spec §3.3)', () => {
	it('the pinned sizes: 12 blocks, 60 and 20 sparkles, 8 bursts', () => {
		expect([FIREWORK_RISE, FIREWORK_SPARKS_BIG, FIREWORK_SPARKS_SMALL, FIREWORK_MAX_BURSTS]).toEqual([12, 60, 20, 8]);
	});

	it('a rocket rises 12 blocks in 1 s, then bursts into 60 sparkles around the top (catches a burst at the launch cell, or no rocket)', () => {
		const { scene, ps } = system();
		ps.spawnFirework(10.5, 40.5, 10.5, true);
		expect(scene.children).toHaveLength(1);
		ps.tick(0.5);
		expect(scene.children).toHaveLength(1);
		expect(scene.children[0].position.y).toBeCloseTo(46.5, 5);
		ps.tick(0.5);
		expect(scene.children).toHaveLength(FIREWORK_SPARKS_BIG);
		expect(meanY(scene)).toBeGreaterThan(51.5);
		expect(meanY(scene)).toBeLessThan(53.5);
		expect(new Set(scene.children.map((m) => ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex())).size).toBeLessThanOrEqual(3);
	});

	it('at most 8 big bursts at once: 10 together give 8 × 60 + 2 × 20 sparkles; once they are gone a new one is big again (catches no cap, or a cap that never frees)', () => {
		const { scene, ps } = system();
		for (let i = 0; i < 10; i++) ps.spawnFirework(i, 40, 0, true);
		ps.tick(1);
		expect(scene.children).toHaveLength(8 * FIREWORK_SPARKS_BIG + 2 * FIREWORK_SPARKS_SMALL);
		for (let i = 0; i < 10; i++) ps.tick(0.5);
		expect(scene.children).toHaveLength(0);
		ps.spawnFirework(0, 40, 0, true);
		ps.tick(1);
		expect(scene.children).toHaveLength(FIREWORK_SPARKS_BIG);
	});

	it('big = false is always the small burst (catches the flag ignored)', () => {
		const { scene, ps } = system();
		ps.spawnFirework(0, 40, 0, false);
		ps.tick(1);
		expect(scene.children).toHaveLength(FIREWORK_SPARKS_SMALL);
	});
});
