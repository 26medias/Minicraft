import * as THREE from 'three';
import type { Chunk } from '../world/chunk';
import type { ChunkMesh } from '../world/mesher';
import type { LoadedAtlas } from './atlas';

export class Renderer {
	readonly scene: THREE.Scene;
	readonly camera: THREE.PerspectiveCamera;
	readonly gl: THREE.WebGLRenderer;
	private chunkGroup: THREE.Group;
	readonly material: THREE.Material;
	private chunkMeshes = new Map<string, THREE.Mesh>();
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

		const amb = new THREE.AmbientLight(0xffffff, 0.15);
		const sun = new THREE.DirectionalLight(0xffffff, 1.0);
		sun.position.set(1, 1.5, 0.5);
		this.scene.add(amb, sun);

		this.chunkGroup = new THREE.Group();
		this.scene.add(this.chunkGroup);

		this.material = new THREE.MeshLambertMaterial({
			map: atlas.texture,
			alphaTest: 0.5,
			transparent: false,
			side: THREE.FrontSide,
		});

		this.resize();
		window.addEventListener('resize', () => this.resize());
		requestAnimationFrame(this.frame);
	}

	onTick(fn: (dt: number) => void) {
		this.tickFn = fn;
	}

	mountChunkMesh(chunk: Chunk, mesh: ChunkMesh): void {
		const k = `${chunk.cx},${chunk.cz}`;
		const existing = this.chunkMeshes.get(k);
		if (existing) {
			this.chunkGroup.remove(existing);
			(existing.geometry as THREE.BufferGeometry).dispose();
		}

		if (mesh.indices.length === 0) {
			this.chunkMeshes.delete(k);
			return;
		}

		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
		g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
		g.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
		g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
		g.computeBoundingSphere();

		const m = new THREE.Mesh(g, this.material);
		m.position.set(chunk.cx * 16, 0, chunk.cz * 16);
		this.chunkGroup.add(m);
		this.chunkMeshes.set(k, m);
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
