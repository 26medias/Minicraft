import * as THREE from 'three';
import { tntKey } from '../../game/tnt';

const OVERLAY_SCALE = 1.05;      // slightly larger than a voxel so it peeks out on every face
const PULSE_HZ = 6;              // angular frequency for the sin pulse
const OPACITY_MIN = 0.2;
const OPACITY_SWING = 0.3;

export class PrimedOverlay {
	private meshes = new Map<string, THREE.Mesh>();
	private material: THREE.MeshBasicMaterial;
	private geometry: THREE.BoxGeometry;
	private elapsed = 0;
	private probe: THREE.Mesh | null = null;
	private probeTicks = 0;

	constructor(private scene: THREE.Scene) {
		this.material = new THREE.MeshBasicMaterial({
			color: 0xff3322,
			transparent: true,
			depthWrite: false,
			opacity: OPACITY_MIN + OPACITY_SWING,
		});
		this.geometry = new THREE.BoxGeometry(OVERLAY_SCALE, OVERLAY_SCALE, OVERLAY_SCALE);
	}

	/**
	 * Draw the overlay material once now, instead of on the frame the first TNT is lit (measured:
	 * a 48–56 ms first-draw frame at ignition; gl.compile alone did not remove it).
	 */
	warm(ticks = 30): void {
		const probe = new THREE.Mesh(this.geometry, this.material);
		probe.position.set(0, -1000, 0);
		probe.frustumCulled = false;
		this.scene.add(probe);
		this.probe = probe;
		this.probeTicks = ticks;
	}

	add(x: number, y: number, z: number): void {
		const k = tntKey(x, y, z);
		if (this.meshes.has(k)) return;
		const mesh = new THREE.Mesh(this.geometry, this.material);
		mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
		this.scene.add(mesh);
		this.meshes.set(k, mesh);
	}

	remove(x: number, y: number, z: number): void {
		const k = tntKey(x, y, z);
		const mesh = this.meshes.get(k);
		if (!mesh) return;
		this.scene.remove(mesh);
		this.meshes.delete(k);
	}

	tick(dt: number): void {
		if (this.probe && --this.probeTicks <= 0) {
			this.scene.remove(this.probe);
			this.probe = null;
		}
		this.elapsed += dt;
		const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * PULSE_HZ);
		this.material.opacity = OPACITY_MIN + OPACITY_SWING * pulse;
	}
}
