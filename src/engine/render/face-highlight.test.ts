import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { faceTransform, HIGHLIGHT_EPS, FaceHighlight, HIGHLIGHT_AREA, HIGHLIGHT_WHITE } from './face-highlight';
import type { Face } from '../../data/blocks.data';

const NORMALS: Record<Face, [number, number, number]> = {
	px: [1, 0, 0],
	nx: [-1, 0, 0],
	py: [0, 1, 0],
	ny: [0, -1, 0],
	pz: [0, 0, 1],
	nz: [0, 0, -1],
};

describe('faceTransform', () => {
	for (const face of Object.keys(NORMALS) as Face[]) {
		it(`orients the quad outward on ${face}`, () => {
			const { offset, euler } = faceTransform(face);
			const n = new THREE.Vector3(...NORMALS[face]);
			const rotated = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...euler));
			expect(rotated.distanceTo(n)).toBeLessThan(1e-9);
			const fromCentre = new THREE.Vector3(offset[0] - 0.5, offset[1] - 0.5, offset[2] - 0.5);
			expect(fromCentre.length()).toBeCloseTo(0.5 + HIGHLIGHT_EPS, 9);
			expect(fromCentre.normalize().distanceTo(n)).toBeLessThan(1e-9);
		});
	}
});

describe('FaceHighlight', () => {
	it('is hidden until shown, and placed on the face when shown', () => {
		const scene = new THREE.Scene();
		const h = new FaceHighlight(scene);
		const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
		expect(group.visible).toBe(false);
		h.show(10, 20, 30, 'py');
		expect(group.visible).toBe(true);
		expect(group.position.toArray()).toEqual([10.5, 21 + HIGHLIGHT_EPS, 30.5]);
		h.hide();
		expect(group.visible).toBe(false);
		expect(scene.children.filter((c) => c instanceof THREE.Group)).toHaveLength(1);
	});
});
describe('FaceHighlight.setCells: a faint glow on exactly the blocks that will break (playtest: the wireframe box was unreadable in the dark)', () => {
	function parts() {
		const scene = new THREE.Scene();
		const h = new FaceHighlight(scene);
		const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
		const glow = scene.children.find((c) => c.name === 'area-glow') as THREE.InstancedMesh;
		const border = (group.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
		return { scene, h, glow, border };
	}
	const cells = [{ x: 10, y: 20, z: 30 }, { x: 10, y: 21, z: 30 }, { x: 9, y: 20, z: 30 }];

	it('multi-block: orange border and one glow instance per cell, centred on it (catches a glow over the whole area shape, air included)', () => {
		const { h, glow, border } = parts();
		h.show(10, 20, 30, 'px');
		h.setCells(cells, true);
		expect(border.color.getHex()).toBe(HIGHLIGHT_AREA);
		expect(glow.visible).toBe(true);
		expect(glow.count).toBe(3);
		const m = new THREE.Matrix4(), p = new THREE.Vector3();
		for (let i = 0; i < cells.length; i++) {
			glow.getMatrixAt(i, m);
			p.setFromMatrixPosition(m);
			expect(p.toArray()).toEqual([cells[i].x + 0.5, cells[i].y + 0.5, cells[i].z + 0.5]);
		}
	});

	it('the glow is a self-lit translucent tint, depth-tested (catches a lit material that goes black in caves, additive blending that washes out to white on snow, and one drawn through walls)', () => {
		const { glow } = parts();
		const mat = glow.material as THREE.MeshBasicMaterial;
		expect(mat).toBeInstanceOf(THREE.MeshBasicMaterial);
		expect(mat.blending).toBe(THREE.NormalBlending);
		expect(mat.transparent).toBe(true);
		expect(mat.depthTest).toBe(true);
		expect(mat.depthWrite).toBe(false);
		expect(mat.fog).toBe(false);
		expect(glow.frustumCulled).toBe(false); // instance positions are not in the geometry's bounds
	});

	it('holds Emerald\'s full 5×5×5 (catches a buffer too small for the top tier)', () => {
		const { h, glow } = parts();
		const all = [];
		for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) for (let z = 0; z < 5; z++) all.push({ x, y, z });
		h.show(2, 2, 4, 'pz');
		h.setCells(all, true);
		expect(glow.count).toBe(125);
	});

	it('holds a whole Tunnel TNT preview, 3 × 3 × 24 = 216 cells (toys spec §3.4; catches the far end of the tunnel cut off at 125)', () => {
		const { h, glow } = parts();
		const all = [];
		for (let l = 0; l < 24; l++) for (let y = 0; y < 3; y++) for (let w = 0; w < 3; w++) all.push({ x: l, y, z: w });
		h.show(0, 0, 1, 'pz');
		h.setCells(all, true);
		expect(glow.count).toBe(216);
	});

	it('single-cell tier: today\'s white face outline and no glow (catches a glow drawn for the hand, which changes every existing world\'s look)', () => {
		const { h, glow, border } = parts();
		h.show(10, 20, 30, 'px');
		h.setCells(cells, true);
		h.setCells([], false);
		expect(glow.visible).toBe(false);
		expect(border.color.getHex()).toBe(HIGHLIGHT_WHITE);
	});

	it('hide() hides the glow too, and no wireframe box is left in the scene (catches a glow left floating when the aim leaves reach)', () => {
		const { scene, h, glow } = parts();
		h.show(10, 20, 30, 'px');
		h.setCells(cells, true);
		h.hide();
		expect(glow.visible).toBe(false);
		expect(scene.children.find((c) => c.name === 'area-box')).toBeUndefined();
	});
});
