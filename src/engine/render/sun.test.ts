import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Sun, SUN_DISTANCE } from './sun';
import { SUN_DIR_RAW } from '../world/shadows';

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
		// Inside the camera's far plane, or it is clipped away.
		expect(SUN_DISTANCE).toBeLessThan(cam.far);
	});

	it('is drawn first, behind everything, and ignores fog (terrain in front still hides it)', () => {
		const sun = new Sun(new THREE.Scene());
		const m = sun.mesh.material as THREE.MeshBasicMaterial;
		expect(m.fog).toBe(false);
		expect(m.depthTest).toBe(false);
		expect(m.depthWrite).toBe(false);
		expect(m.transparent).toBe(false); // opaque list: drawn before terrain by renderOrder
		expect(sun.mesh.renderOrder).toBeLessThan(0);
	});

	it('is a Minecraft-style square: every pixel of its texture is opaque, with a pale core', () => {
		const sun = new Sun(new THREE.Scene());
		const tex = (sun.mesh.material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
		const { data, width } = tex.image as { data: Uint8Array; width: number };
		for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255);
		const px = (x: number, y: number) => data.slice((y * width + x) * 4, (y * width + x) * 4 + 3);
		const edge = px(0, 0), core = px(width >> 1, width >> 1);
		expect(core[2]).toBeGreaterThan(edge[2]); // the core is whiter (more blue) than the yellow rim
	});
});
