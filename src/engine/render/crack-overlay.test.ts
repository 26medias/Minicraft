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

	describe('setGroup / clearGroup (area mining: one owner cracks many cells)', () => {
		function cellAt(scene: THREE.Scene, x: number, y: number, z: number): THREE.Mesh | undefined {
			return scene.children.find((c) => c.position.x === x + 0.5 && c.position.y === y + 0.5 && c.position.z === z + 0.5) as THREE.Mesh | undefined;
		}

		it('sets one mesh per cell, at the right positions', () => {
			const scene = new THREE.Scene();
			const o = new CrackOverlay(scene, stubLoad);
			const cells = [];
			for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) cells.push({ x, y: 10, z });
			o.setGroup('local', cells, 2);
			expect(scene.children).toHaveLength(9);
			expect(o.keys().filter((k) => k.startsWith('local#'))).toHaveLength(9);
			for (const c of cells) expect(cellAt(scene, c.x, c.y, c.z)).toBeDefined();
		});

		it('a later, smaller setGroup leaves exactly the new count (no leftover meshes)', () => {
			const scene = new THREE.Scene();
			const o = new CrackOverlay(scene, stubLoad);
			const nine = [];
			for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) nine.push({ x, y: 10, z });
			o.setGroup('local', nine, 1);
			expect(scene.children).toHaveLength(9);

			const three = nine.slice(0, 3);
			o.setGroup('local', three, 1);
			expect(scene.children).toHaveLength(3);
			expect(o.keys().filter((k) => k.startsWith('local#'))).toHaveLength(3);
		});

		it('clearGroup removes every mesh of the group', () => {
			const scene = new THREE.Scene();
			const o = new CrackOverlay(scene, stubLoad);
			o.setGroup('local', [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], 0);
			o.set('p:2', 5, 5, 5, 3);
			o.clearGroup('local');
			expect(o.keys()).toEqual(['p:2']);
			expect(scene.children).toHaveLength(1);
		});

		it('retain(keep with the bare group key) keeps every local#i and drops a bare key not in keep', () => {
			const scene = new THREE.Scene();
			const o = new CrackOverlay(scene, stubLoad);
			o.setGroup('local', [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], 0);
			o.set('p:7', 9, 9, 9, 1);
			o.retain(new Set(['local']));
			expect(o.keys().sort()).toEqual(['local#0', 'local#1', 'local#2']);
		});

		it('retain(keep without the group) drops the whole local group', () => {
			const scene = new THREE.Scene();
			const o = new CrackOverlay(scene, stubLoad);
			o.setGroup('local', [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], 0);
			o.set('p:7', 9, 9, 9, 1);
			o.retain(new Set(['p:7']));
			expect(o.keys()).toEqual(['p:7']);
		});
	});
});
