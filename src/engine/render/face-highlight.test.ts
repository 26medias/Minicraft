import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { faceTransform, HIGHLIGHT_EPS, FaceHighlight } from './face-highlight';
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
