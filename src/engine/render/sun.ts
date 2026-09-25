import * as THREE from 'three';
import { SUN_DIR_RAW } from '../world/shadows';

/** Far enough to look infinitely far (it moves with the camera), inside the camera's 500 far plane. */
export const SUN_DISTANCE = 300;
/** About 7° across: a little bigger than the real sun, like Minecraft's. */
const SUN_SIZE = 36;
const TEX = 16;

/** A 16×16 Minecraft-style square sun: yellow rim, pale core. Built in code, so there is no asset. */
function sunTexture(): THREE.DataTexture {
	const data = new Uint8Array(TEX * TEX * 4);
	for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
		const ring = Math.min(x, y, TEX - 1 - x, TEX - 1 - y);
		const [r, g, b] = ring >= 4 ? [255, 253, 230] : ring >= 2 ? [255, 240, 150] : [255, 222, 90];
		const i = (y * TEX + x) * 4;
		data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
	}
	const tex = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
	tex.magFilter = THREE.NearestFilter;
	tex.minFilter = THREE.NearestFilter;
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;
}

/**
 * A fixed sun in the sky, where the baked shadows (shadows.ts SUN_DIR_RAW) say it is, so shadows
 * point away from it. Decoration only: it never moves (no day/night, a non-goal). Drawn first among
 * opaque objects without depth, so the sky is behind it and any terrain in front covers it.
 */
export class Sun {
	readonly mesh: THREE.Mesh;
	private dir = new THREE.Vector3(...SUN_DIR_RAW).normalize();

	constructor(scene: THREE.Scene) {
		const material = new THREE.MeshBasicMaterial({ map: sunTexture(), fog: false, depthTest: false, depthWrite: false });
		this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SUN_SIZE, SUN_SIZE), material);
		this.mesh.renderOrder = -1000;
		this.mesh.frustumCulled = false;
		scene.add(this.mesh);
	}

	/** Keep the sun at a fixed direction from the camera, facing it. Call once per frame before rendering. */
	update(camera: THREE.Camera): void {
		this.mesh.position.copy(camera.position).addScaledVector(this.dir, SUN_DISTANCE);
		this.mesh.quaternion.copy(camera.quaternion);
	}
}
