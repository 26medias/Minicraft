import * as THREE from 'three';
import type { Chunk } from '../world/chunk';
import type { ChunkMeshResult } from '../world/mesher';
import type { LoadedAtlas } from './atlas';

// Sun offset from player, preserving the original (1, 1.5, 0.5) direction but scaled
// so the shadow-camera near/far plane straddles the visible world above and below.
const SUN_OFFSET: [number, number, number] = [53, 80, 27];

export class Renderer {
	readonly scene: THREE.Scene;
	readonly camera: THREE.PerspectiveCamera;
	readonly gl: THREE.WebGLRenderer;
	private chunkGroup: THREE.Group;
	private chunkMeshes = new Map<string, THREE.Mesh>();
	private liquidMeshes = new Map<string, THREE.Mesh>();
	readonly material: THREE.Material;
	readonly liquidMaterial: THREE.Material;
	private sun: THREE.DirectionalLight;
	private tickFn: ((dt: number) => void) | null = null;
	private last = performance.now();

	constructor(container: HTMLElement, atlas: LoadedAtlas) {
		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x87ceeb); // sky blue
		this.scene.fog = new THREE.Fog(0x87ceeb, 60, 200);

		this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 500);
		this.camera.position.set(8, 70, 8);

		this.gl = new THREE.WebGLRenderer({
			antialias: false,
			powerPreference: 'high-performance',
		});
		this.gl.setPixelRatio(window.devicePixelRatio);
		this.gl.outputColorSpace = THREE.SRGBColorSpace;
		this.gl.shadowMap.enabled = true;
		// PCFShadowMap (not PCFSoftShadowMap): voxel geometry is all sharp concave
		// corners, and the soft-filter kernel leaks light at every wall-floor seam.
		// Hard-edged PCF produces pixel-precise shadow boundaries that match the
		// blocky aesthetic.
		this.gl.shadowMap.type = THREE.PCFShadowMap;
		container.appendChild(this.gl.domElement);

		const amb = new THREE.AmbientLight(0xffffff, 0.2);
		const sun = new THREE.DirectionalLight(0xffffff, 1.0);
		sun.position.set(...SUN_OFFSET);
		sun.castShadow = true;
		sun.shadow.mapSize.set(4096, 4096);
		sun.shadow.camera.near = 0.5;
		sun.shadow.camera.far = 200;
		sun.shadow.camera.left = -48;
		sun.shadow.camera.right = 48;
		sun.shadow.camera.top = 48;
		sun.shadow.camera.bottom = -48;
		// Voxel geometry is all axis-aligned, so a tiny depth bias is enough to
		// suppress self-shadow acne. Any normalBias > 0 offsets the shadow sample
		// along the receiver's own normal and starts leaking light at floor-wall
		// joints, so keep it at 0.
		sun.shadow.bias = -0.0005;
		sun.shadow.normalBias = 0;
		this.sun = sun;
		this.scene.add(amb, sun, sun.target);

		this.chunkGroup = new THREE.Group();
		this.scene.add(this.chunkGroup);

		this.material = new THREE.MeshLambertMaterial({
			map: atlas.texture,
			alphaTest: 0.5,
			transparent: false,
			side: THREE.FrontSide,
		});

		this.liquidMaterial = new THREE.MeshLambertMaterial({
			map: atlas.texture,
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			alphaTest: 0.01,
		});

		this.resize();
		window.addEventListener('resize', () => this.resize());
		requestAnimationFrame(this.frame);
	}

	onTick(fn: (dt: number) => void) {
		this.tickFn = fn;
	}

	mountChunkMesh(chunk: Chunk, meshResult: ChunkMeshResult): void {
		const k = `${chunk.cx},${chunk.cz}`;

		// Opaque
		const existingOpaque = this.chunkMeshes.get(k);
		if (existingOpaque) {
			this.chunkGroup.remove(existingOpaque);
			(existingOpaque.geometry as THREE.BufferGeometry).dispose();
			this.chunkMeshes.delete(k);
		}
		if (meshResult.opaque.indices.length > 0) {
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(meshResult.opaque.positions, 3));
			g.setAttribute('normal', new THREE.BufferAttribute(meshResult.opaque.normals, 3));
			g.setAttribute('uv', new THREE.BufferAttribute(meshResult.opaque.uvs, 2));
			g.setAttribute('color', new THREE.BufferAttribute(meshResult.opaque.colors, 3));
			g.setIndex(new THREE.BufferAttribute(meshResult.opaque.indices, 1));
			g.computeBoundingSphere();
			const m = new THREE.Mesh(g, this.material);
			m.position.set(chunk.cx * 16, 0, chunk.cz * 16);
			m.castShadow = true;
			m.receiveShadow = true;
			this.chunkGroup.add(m);
			this.chunkMeshes.set(k, m);
		}

		// Liquid
		const existingLiquid = this.liquidMeshes.get(k);
		if (existingLiquid) {
			this.chunkGroup.remove(existingLiquid);
			(existingLiquid.geometry as THREE.BufferGeometry).dispose();
			this.liquidMeshes.delete(k);
		}
		if (meshResult.liquid && meshResult.liquid.indices.length > 0) {
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(meshResult.liquid.positions, 3));
			g.setAttribute('normal', new THREE.BufferAttribute(meshResult.liquid.normals, 3));
			g.setAttribute('uv', new THREE.BufferAttribute(meshResult.liquid.uvs, 2));
			g.setAttribute('color', new THREE.BufferAttribute(meshResult.liquid.colors, 3));
			g.setIndex(new THREE.BufferAttribute(meshResult.liquid.indices, 1));
			g.computeBoundingSphere();
			const m = new THREE.Mesh(g, this.liquidMaterial);
			m.position.set(chunk.cx * 16, 0, chunk.cz * 16);
			this.chunkGroup.add(m);
			this.liquidMeshes.set(k, m);
		}
	}

	/** Keep the sun's shadow frustum centred on the player each tick. */
	setSunTarget(x: number, y: number, z: number): void {
		this.sun.position.set(x + SUN_OFFSET[0], y + SUN_OFFSET[1], z + SUN_OFFSET[2]);
		this.sun.target.position.set(x, y, z);
		this.sun.target.updateMatrixWorld();
	}

	private resize() {
		const w = window.innerWidth,
			h = window.innerHeight;
		this.gl.setSize(w, h);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	private frame = () => {
		const now = performance.now();
		const dt = Math.min(0.1, (now - this.last) / 1000);
		this.last = now;
		this.tickFn?.(dt);
		this.gl.render(this.scene, this.camera);
		requestAnimationFrame(this.frame);
	};
}
