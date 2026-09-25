import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CrackOverlay } from './crack-overlay';

const stubLoad = () => new THREE.Texture();

describe('CrackOverlay', () => {
	it('one mesh per key, moved and re-staged in place; clear and retain remove them', () => {
		const scene = new THREE.Scene();
		const o = new CrackOverlay(scene, stubLoad);
		o.set('local', 1, 2, 3, 0);
		o.set('local', 4, 5, 6, 7);
		o.set('p:2', 0, 0, 0, 3);
		expect(scene.children).toHaveLength(2);
		const local = scene.children.find((c) => c.position.x === 4.5) as THREE.Mesh;
		expect(local.position.toArray()).toEqual([4.5, 5.5, 6.5]);
		expect((local.material as THREE.MeshBasicMaterial).depthWrite).toBe(false);

		o.retain(new Set(['local']));
		expect(o.keys()).toEqual(['local']);
		o.clear('local');
		expect(scene.children).toHaveLength(0);
	});

	it('all ten crack textures are found on disk', () => {
		const urls: string[] = [];
		new CrackOverlay(new THREE.Scene(), (url) => { urls.push(url); return new THREE.Texture(); });
		// In order 0..9: a missing destroy_stage_N.png would leave a gap (and a null map).
		expect(urls).toHaveLength(10);
		urls.forEach((u, i) => expect(u).toContain(`destroy_stage_${i}.png`));
	});
});
