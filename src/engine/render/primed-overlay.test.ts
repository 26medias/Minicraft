import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PrimedOverlay } from './primed-overlay';

describe('PrimedOverlay.warm', () => {
	it('draws a probe once at startup and removes it after the warm ticks (catches a probe that is culled, so it never draws, or one that is never removed)', () => {
		const scene = new THREE.Scene();
		const o = new PrimedOverlay(scene);
		o.warm(3);
		expect(scene.children).toHaveLength(1);
		const probe = scene.children[0] as THREE.Mesh;
		expect(probe.frustumCulled).toBe(false);
		o.tick(0.016);
		o.tick(0.016);
		expect(scene.children).toHaveLength(1);
		o.tick(0.016);
		expect(scene.children).toHaveLength(0);
	});

	it('real primed TNT added during the warm-up is unaffected (catches tick() clearing every mesh)', () => {
		const scene = new THREE.Scene();
		const o = new PrimedOverlay(scene);
		o.warm(1);
		o.add(1, 2, 3);
		o.tick(0.016);
		expect(scene.children).toHaveLength(1);
		expect(scene.children[0].position.toArray()).toEqual([1.5, 2.5, 3.5]);
	});
});
