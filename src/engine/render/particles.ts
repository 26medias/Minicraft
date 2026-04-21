import * as THREE from 'three';
import type { BlockId } from '../../data/blocks.data';
import type { LoadedAtlas } from './atlas';

const GRAVITY = 15;
const BREAK_COUNT = 8;
const MIN_SIZE = 0.12;
const MAX_SIZE = 0.2;
const TTL_MIN = 0.5;
const TTL_MAX = 0.9;
const LATERAL_SPEED = 3;
const UP_SPEED_MIN = 1;
const UP_SPEED_MAX = 4;
const SPIN_SPEED = 6;

type Particle = {
	mesh: THREE.Mesh;
	vx: number;
	vy: number;
	vz: number;
	rx: number;
	ry: number;
	rz: number;
	age: number;
	ttl: number;
};

export class ParticleSystem {
	private particles: Particle[] = [];

	constructor(
		private scene: THREE.Scene,
		private material: THREE.Material,
		private atlas: LoadedAtlas,
	) {}

	spawnBreak(x: number, y: number, z: number, blockId: BlockId) {
		const [u0, v0, u1, v1] = this.atlas.uvFor(blockId, 'px');
		for (let i = 0; i < BREAK_COUNT; i++) {
			const size = MIN_SIZE + Math.random() * (MAX_SIZE - MIN_SIZE);
			const geo = new THREE.BoxGeometry(size, size, size);
			// Remap BoxGeometry's default [0,1]² UVs to the atlas region for this block.
			const uv = geo.getAttribute('uv');
			for (let j = 0; j < uv.count; j++) {
				uv.setXY(j, u0 + uv.getX(j) * (u1 - u0), v0 + uv.getY(j) * (v1 - v0));
			}
			uv.needsUpdate = true;

			const mesh = new THREE.Mesh(geo, this.material);
			mesh.position.set(
				x + 0.5 + (Math.random() - 0.5) * 0.4,
				y + 0.5 + (Math.random() - 0.5) * 0.4,
				z + 0.5 + (Math.random() - 0.5) * 0.4,
			);
			this.scene.add(mesh);
			this.particles.push({
				mesh,
				vx: (Math.random() - 0.5) * 2 * LATERAL_SPEED,
				vy: UP_SPEED_MIN + Math.random() * (UP_SPEED_MAX - UP_SPEED_MIN),
				vz: (Math.random() - 0.5) * 2 * LATERAL_SPEED,
				rx: (Math.random() - 0.5) * 2 * SPIN_SPEED,
				ry: (Math.random() - 0.5) * 2 * SPIN_SPEED,
				rz: (Math.random() - 0.5) * 2 * SPIN_SPEED,
				age: 0,
				ttl: TTL_MIN + Math.random() * (TTL_MAX - TTL_MIN),
			});
		}
	}

	tick(dt: number) {
		for (let i = this.particles.length - 1; i >= 0; i--) {
			const p = this.particles[i];
			p.age += dt;
			if (p.age >= p.ttl) {
				this.scene.remove(p.mesh);
				p.mesh.geometry.dispose();
				this.particles.splice(i, 1);
				continue;
			}
			p.vy -= GRAVITY * dt;
			p.mesh.position.x += p.vx * dt;
			p.mesh.position.y += p.vy * dt;
			p.mesh.position.z += p.vz * dt;
			p.mesh.rotation.x += p.rx * dt;
			p.mesh.rotation.y += p.ry * dt;
			p.mesh.rotation.z += p.rz * dt;
		}
	}
}
