import * as THREE from 'three';
import { CRACK_STAGES } from '../../game/crack';

/** Slightly larger than a voxel so the cracks sit on every face without z-fighting. */
const CRACK_SCALE = 1.004;

// Mojang's destroy_stage_0..9 (src/assets/blocks), loaded as their own small textures: they are
// overlays, not block faces, so they stay out of the atlas.
const STAGE_URLS = import.meta.glob('../../assets/blocks/destroy_stage_*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

function stageUrl(i: number): string | undefined {
	for (const [path, url] of Object.entries(STAGE_URLS)) if (path.endsWith(`destroy_stage_${i}.png`)) return url;
	return undefined;
}

/**
 * The cracks drawn over blocks being mined (local player and friends). One mesh per key
 * ('local', 'p:<id>'), moved and re-textured in place; set() is called every frame.
 */
export class CrackOverlay {
	private geometry = new THREE.BoxGeometry(CRACK_SCALE, CRACK_SCALE, CRACK_SCALE);
	private materials: THREE.MeshBasicMaterial[] = [];
	private meshes = new Map<string, THREE.Mesh>();

	/** `load` is injectable because tests have no DOM for THREE.TextureLoader. */
	constructor(
		private scene: THREE.Scene,
		load: (url: string) => THREE.Texture = (url) => new THREE.TextureLoader().load(url),
	) {
		for (let i = 0; i < CRACK_STAGES; i++) {
			const url = stageUrl(i);
			const map = url ? load(url) : null;
			if (map) {
				map.magFilter = THREE.NearestFilter;
				map.minFilter = THREE.NearestFilter;
				map.colorSpace = THREE.SRGBColorSpace;
			}
			this.materials.push(new THREE.MeshBasicMaterial({
				map,
				transparent: true,
				depthWrite: false,
				polygonOffset: true,
				polygonOffsetFactor: -1,
				polygonOffsetUnits: -1,
			}));
		}
	}

	set(key: string, x: number, y: number, z: number, stage: number): void {
		const s = Math.min(CRACK_STAGES - 1, Math.max(0, stage | 0));
		let mesh = this.meshes.get(key);
		if (!mesh) {
			mesh = new THREE.Mesh(this.geometry, this.materials[s]);
			this.scene.add(mesh);
			this.meshes.set(key, mesh);
		}
		mesh.material = this.materials[s];
		mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
	}

	clear(key: string): void {
		const mesh = this.meshes.get(key);
		if (!mesh) return;
		this.scene.remove(mesh);
		this.meshes.delete(key);
	}

	/** Remove every key not in `keep` (the remote miners who stopped since last frame). */
	retain(keep: ReadonlySet<string>): void {
		for (const key of [...this.meshes.keys()]) if (!keep.has(key)) this.clear(key);
	}

	keys(): string[] {
		return [...this.meshes.keys()];
	}
}
