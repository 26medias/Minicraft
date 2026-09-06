import * as THREE from 'three';
import type { Chunk } from '../world/chunk';
import type { ChunkMesh, ChunkMeshResult } from '../world/mesher';
import type { LoadedAtlas } from './atlas';

export class Renderer {
	readonly scene: THREE.Scene;
	readonly camera: THREE.PerspectiveCamera;
	readonly gl: THREE.WebGLRenderer;
	private chunkGroup: THREE.Group;
	private chunkMeshes = new Map<string, THREE.Mesh>();
	private liquidMeshes = new Map<string, THREE.Mesh>();
	private translucentMeshes = new Map<string, THREE.Mesh>();
	readonly material: THREE.Material;
	readonly liquidMaterial: THREE.Material;
	readonly translucentMaterial: THREE.Material;
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
		container.appendChild(this.gl.domElement);

		this.chunkGroup = new THREE.Group();
		this.scene.add(this.chunkGroup);

		this.material = new THREE.MeshBasicMaterial({
			map: atlas.texture,
			alphaTest: 0.5,
			vertexColors: true,
			side: THREE.FrontSide,
		});

		this.liquidMaterial = new THREE.MeshBasicMaterial({
			map: atlas.texture,
			vertexColors: true,
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			alphaTest: 0.01,
		});

		// Full-cube translucent blocks (stained glass, ice). FrontSide + depthWrite so a
		// cube's inner faces are not drawn through its outer ones (the liquid material
		// is DoubleSide/no-depth-write and double-blends a closed cube).
		this.translucentMaterial = new THREE.MeshBasicMaterial({
			map: atlas.texture,
			vertexColors: true,
			transparent: true,
			depthWrite: true,
			side: THREE.FrontSide,
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
			const m = new THREE.Mesh(this.buildGeometry(meshResult.opaque), this.material);
			m.position.set(chunk.cx * 16, 0, chunk.cz * 16);
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
			const m = new THREE.Mesh(this.buildGeometry(meshResult.liquid), this.liquidMaterial);
			m.position.set(chunk.cx * 16, 0, chunk.cz * 16);
			// three sorts transparent meshes by chunk centroid, so without this a water
			// mesh from one chunk can draw before a glass mesh from another. Glass writes
			// depth, so drawing every glass mesh before every water mesh is correct.
			m.renderOrder = 1;
			this.chunkGroup.add(m);
			this.liquidMeshes.set(k, m);
		}

		// Translucent (stained glass, ice)
		const existingTranslucent = this.translucentMeshes.get(k);
		if (existingTranslucent) {
			this.chunkGroup.remove(existingTranslucent);
			(existingTranslucent.geometry as THREE.BufferGeometry).dispose();
			this.translucentMeshes.delete(k);
		}
		if (meshResult.translucent && meshResult.translucent.indices.length > 0) {
			const m = new THREE.Mesh(
				this.buildGeometry(meshResult.translucent),
				this.translucentMaterial,
			);
			m.position.set(chunk.cx * 16, 0, chunk.cz * 16);
			this.chunkGroup.add(m);
			this.translucentMeshes.set(k, m);
		}
	}

	private buildGeometry(mesh: ChunkMesh): THREE.BufferGeometry {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
		g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
		g.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
		g.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
		g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
		g.computeBoundingSphere();
		return g;
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
