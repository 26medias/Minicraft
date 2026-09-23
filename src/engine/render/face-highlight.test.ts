import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { faceTransform, HIGHLIGHT_EPS, FaceHighlight, HIGHLIGHT_AREA, HIGHLIGHT_WHITE, AREA_BOX_PAD, AREA_EDGE } from './face-highlight';
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
describe('FaceHighlight.setArea (spec §5)', () => {
	function parts() {
		const scene = new THREE.Scene();
		const h = new FaceHighlight(scene);
		const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
		const box = scene.children.find((c) => c.name === 'area-box')!;
		const border = (group.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
		return { h, group, box, border };
	}

	it('multi-block: orange border and one box over the whole area, air included (catches a white or face-only warning)', () => {
		const { h, box, border } = parts();
		h.show(10, 20, 30, 'px');
		h.setArea([8, 19, 29], [10, 21, 31], true);
		expect(box.visible).toBe(true);
		expect(border.color.getHex()).toBe(HIGHLIGHT_AREA);
		// 12 edge beams whose outer bounds wrap cells 8..10 × 19..21 × 29..31.
		expect(box.children).toHaveLength(12);
		const b = new THREE.Box3().setFromObject(box);
		const out = AREA_BOX_PAD + AREA_EDGE / 2;
		for (const [got, want] of [[b.min.x, 8 - out], [b.min.y, 19 - out], [b.min.z, 29 - out], [b.max.x, 11 + out], [b.max.y, 22 + out], [b.max.z, 32 + out]]) {
			expect(got).toBeCloseTo(want, 6);
		}
	});

	it('the area edges are thick beams, not 1-pixel lines (catches LineSegments: WebGL ignores linewidth, and gate 2 found a 1 px orange line disappears on snow)', () => {
		const { h, box } = parts();
		h.show(10, 20, 30, 'px');
		h.setArea([8, 19, 29], [10, 21, 31], true);
		expect(box.children).toHaveLength(12);
		for (const beam of box.children as THREE.Mesh[]) {
			expect(beam).toBeInstanceOf(THREE.Mesh);
			expect(Math.min(beam.scale.x, beam.scale.y, beam.scale.z)).toBeCloseTo(AREA_EDGE, 6);
		}
	});

	it('single-cell tier: today\'s white face outline and no box (catches a box drawn for the hand, which changes every existing world\'s look)', () => {
		const { h, box, border } = parts();
		h.show(10, 20, 30, 'px');
		h.setArea([8, 19, 29], [10, 21, 31], true);
		h.setArea([10, 20, 30], [10, 20, 30], false);
		expect(box.visible).toBe(false);
		expect(border.color.getHex()).toBe(HIGHLIGHT_WHITE);
	});

	it('hide() hides the box too (catches an orange box left floating when the aim leaves reach)', () => {
		const { h, box } = parts();
		h.show(10, 20, 30, 'px');
		h.setArea([8, 19, 29], [10, 21, 31], true);
		h.hide();
		expect(box.visible).toBe(false);
	});
});
