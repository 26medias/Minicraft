import * as THREE from 'three';
import { SUN_DIR_RAW } from '../world/shadows';

/** Beyond every loaded chunk, so terrain in front hides it by depth; inside the camera's 500 far plane. */
export const SUN_DISTANCE = 300;
/** Quad size: the disc is ~22% of it (about 4° across, bigger than the real sun, which reads better in a game); the rest is glow. */
const SUN_SIZE = 90;
const TEX = 128;
/** Disc radius, as a fraction of the half-size. */
const DISC = 0.22;

const smoothstep = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/**
 * A round sun: a white-hot disc with a soft edge, inside a warm glow that fades to nothing before the
 * quad's edge (drawn additively, the glow brightens the sky around it). Built in code: no asset.
 */
function sunTexture(): THREE.DataTexture {
	const data = new Uint8Array(TEX * TEX * 4);
	const half = TEX / 2;
	for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
		const r = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half; // 0 at the centre, 1 at the quad's edge midpoints
		const disc = 1 - smoothstep(DISC - 0.02, DISC + 0.01, r);
		const out = Math.max(0, r - DISC);
		const glow = (0.55 * Math.exp(-out / 0.07) + 0.3 * Math.exp(-out / 0.25)) * (1 - smoothstep(0.75, 0.97, r));
		const a = Math.min(1, disc + (1 - disc) * glow);
		// White-hot disc, warm yellow glow.
		const i = (y * TEX + x) * 4;
		data[i] = 255;
		data[i + 1] = Math.round(disc * 250 + (1 - disc) * 232);
		data[i + 2] = Math.round(disc * 238 + (1 - disc) * 170);
		data[i + 3] = Math.round(a * 255);
	}
	const tex = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
	tex.magFilter = THREE.LinearFilter;
	tex.minFilter = THREE.LinearFilter;
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;
}

/**
 * A fixed sun in the sky, where the baked shadows (shadows.ts SUN_DIR_RAW) say it is, so shadows
 * point away from it. Decoration only: it does not move yet (day/night is to be revisited). It is
 * transparent and additive, beyond all loaded terrain with depth testing on, so hills in front cover it.
 */
export class Sun {
	readonly mesh: THREE.Mesh;
	private dir = new THREE.Vector3(...SUN_DIR_RAW).normalize();

	constructor(scene: THREE.Scene) {
		const material = new THREE.MeshBasicMaterial({
			map: sunTexture(),
			fog: false,
			transparent: true,
			blending: THREE.AdditiveBlending,
			depthTest: true,
			depthWrite: false,
		});
		this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SUN_SIZE, SUN_SIZE), material);
		this.mesh.frustumCulled = false;
		scene.add(this.mesh);
	}

	/** Keep the sun at a fixed direction from the camera, facing it. Call once per frame before rendering. */
	update(camera: THREE.Camera): void {
		this.mesh.position.copy(camera.position).addScaledVector(this.dir, SUN_DISTANCE);
		this.mesh.quaternion.copy(camera.quaternion);
	}
}
