import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Sun, SUN_DISTANCE } from './sun';
import { SUN_DIR_RAW } from '../world/shadows';
import { MESH_RADIUS } from '../world/radii';

describe('Sun', () => {
	it('sits where the shadows say the sun is: SUN_DIR_RAW from the camera, facing it, whatever the camera does', () => {
		const scene = new THREE.Scene();
		const sun = new Sun(scene);
		const cam = new THREE.PerspectiveCamera(75, 1, 0.1, 500);
		cam.position.set(100, 70, 200);
		cam.rotation.set(0.3, 1.2, 0);
		cam.updateMatrixWorld();
		sun.update(cam);
		const dir = new THREE.Vector3(...SUN_DIR_RAW).normalize();
		const want = cam.position.clone().addScaledVector(dir, SUN_DISTANCE);
		expect(sun.mesh.position.distanceTo(want)).toBeLessThan(1e-6);
		expect(sun.mesh.quaternion.angleTo(cam.quaternion)).toBeLessThan(1e-6);
	});

	it('is beyond every loaded chunk (so terrain in front hides it by depth) and inside the far plane', () => {
		// The farthest mesh-ring corner from the camera: MESH_RADIUS chunks out diagonally, plus a chunk.
		const farthestTerrain = (MESH_RADIUS + 1) * 16 * Math.SQRT2;
		expect(SUN_DISTANCE).toBeGreaterThan(farthestTerrain);
		expect(SUN_DISTANCE).toBeLessThan(500);
	});

	it('glows over the sky: transparent, additive, depth-tested, writes no depth, ignores fog', () => {
		const sun = new Sun(new THREE.Scene());
		const m = sun.mesh.material as THREE.MeshBasicMaterial;
		expect(m.fog).toBe(false);
		expect(m.transparent).toBe(true);
		expect(m.blending).toBe(THREE.AdditiveBlending);
		expect(m.depthTest).toBe(true);
		expect(m.depthWrite).toBe(false);
	});

	it('is round: a bright opaque core, a glow that fades out, nothing in the corners, the same in every direction', () => {
		const sun = new Sun(new THREE.Scene());
		const tex = (sun.mesh.material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
		const { data, width } = tex.image as { data: Uint8Array; width: number };
		const px = (x: number, y: number) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
		const c = width >> 1;
		const core = px(c, c);
		expect(core[3]).toBe(255);
		expect(Math.min(core[0], core[1], core[2])).toBeGreaterThan(235); // near white
		expect(px(0, 0)[3]).toBe(0);
		expect(px(width - 1, width - 1)[3]).toBe(0);
		// Round, not square: at the same distance from the centre, the axis and the diagonal match.
		const r = Math.round(width * 0.3);
		const d = Math.round(r / Math.SQRT2);
		expect(Math.abs(px(c + r, c)[3] - px(c + d, c + d)[3])).toBeLessThanOrEqual(8);
		// The glow falls off outward.
		expect(px(c + Math.round(width * 0.2), c)[3]).toBeGreaterThan(px(c + Math.round(width * 0.4), c)[3]);
	});
});
