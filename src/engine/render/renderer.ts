import * as THREE from 'three';
import type { Chunk } from '../world/chunk';
import type { ChunkMeshResult } from '../world/mesher';
import type { LoadedAtlas } from './atlas';

export class Renderer {
	readonly scene: THREE.Scene;
	readonly camera: THREE.PerspectiveCamera;
	readonly gl: THREE.WebGLRenderer;
	private chunkGroup: THREE.Group;
	private chunkMeshes = new Map<string, THREE.Mesh>();
	private liquidMeshes = new Map<string, THREE.Mesh>();
	readonly material: THREE.Material;
	readonly liquidMaterial: THREE.Material;
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
