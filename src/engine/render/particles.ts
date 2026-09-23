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

/** Toys spec §3.3: the rocket rises FIREWORK_RISE blocks in FIREWORK_ROCKET_S, then bursts. */
export const FIREWORK_RISE = 12;
const FIREWORK_ROCKET_S = 1;
export const FIREWORK_SPARKS_BIG = 60;
export const FIREWORK_SPARKS_SMALL = 20;
/** At most this many bursts (rocket in flight or sparkles alive) are big at once; any extra one is small. */
export const FIREWORK_MAX_BURSTS = 8;
const SPARK_SIZE = 0.15;
const SPARK_SPEED_MIN = 3;
const SPARK_SPEED_MAX = 7;
const SPARK_GRAVITY = 4;
const SPARK_TTL_MIN = 1.2;
const SPARK_TTL_MAX = 2;
const FIREWORK_COLOURS = [0xff3b3b, 0xffd93b, 0x3bff6b, 0x3bc8ff, 0xc83bff, 0xff3bc8, 0xffffff];

type Burst = { rocket: THREE.Mesh | null; x: number; y: number; z: number; age: number; sparks: number; alive: number };

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
	/** Firework sparkles: their own gravity, a shared geometry (never disposed), and the burst they count against. */
	gravity?: number;
	shared?: true;
	burst?: Burst;
};

export class ParticleSystem {
	private particles: Particle[] = [];
	private bursts: Burst[] = [];
	private sparkGeometry: THREE.BoxGeometry | null = null;
	private sparkMaterials = new Map<number, THREE.MeshBasicMaterial>();

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

	/**
	 * Toys spec §3.3: a rocket from (x, y, z) rises FIREWORK_RISE blocks in 1 s, then bursts into sparkles in up to 3
	 * random bright colours. `big` asks for FIREWORK_SPARKS_BIG; while FIREWORK_MAX_BURSTS bursts are active, the burst is
	 * small (FIREWORK_SPARKS_SMALL) whatever `big` says.
	 */
	spawnFirework(x: number, y: number, z: number, big: boolean): void {
		const sparks = big && this.bursts.length < FIREWORK_MAX_BURSTS ? FIREWORK_SPARKS_BIG : FIREWORK_SPARKS_SMALL;
		const rocket = new THREE.Mesh(this.sparks(), this.sparkMaterial(0xffffff));
		rocket.position.set(x, y, z);
		this.scene.add(rocket);
		this.bursts.push({ rocket, x, y, z, age: 0, sparks, alive: 0 });
	}

	private sparks(): THREE.BoxGeometry {
		return (this.sparkGeometry ??= new THREE.BoxGeometry(SPARK_SIZE, SPARK_SIZE, SPARK_SIZE));
	}

	private sparkMaterial(colour: number): THREE.MeshBasicMaterial {
		let m = this.sparkMaterials.get(colour);
		if (!m) this.sparkMaterials.set(colour, (m = new THREE.MeshBasicMaterial({ color: colour })));
		return m;
	}

	private burst(b: Burst): void {
		const colours = [...FIREWORK_COLOURS].sort(() => Math.random() - 0.5).slice(0, 3);
		for (let i = 0; i < b.sparks; i++) {
			const mesh = new THREE.Mesh(this.sparks(), this.sparkMaterial(colours[i % 3]));
			mesh.position.set(b.x, b.y + FIREWORK_RISE, b.z);
			this.scene.add(mesh);
			// A random direction on the sphere, at a random speed.
			const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
			const speed = SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN);
			this.particles.push({
				mesh, vx: r * Math.cos(a) * speed, vy: u * speed, vz: r * Math.sin(a) * speed, rx: 0, ry: 0, rz: 0,
				age: 0, ttl: SPARK_TTL_MIN + Math.random() * (SPARK_TTL_MAX - SPARK_TTL_MIN), gravity: SPARK_GRAVITY, shared: true, burst: b,
			});
			b.alive++;
		}
	}

	tick(dt: number) {
		for (let i = this.particles.length - 1; i >= 0; i--) {
			const p = this.particles[i];
			p.age += dt;
			if (p.age >= p.ttl) {
				this.scene.remove(p.mesh);
				if (!p.shared) p.mesh.geometry.dispose();
				if (p.burst) p.burst.alive--;
				this.particles.splice(i, 1);
				continue;
			}
			p.vy -= (p.gravity ?? GRAVITY) * dt;
			p.mesh.position.x += p.vx * dt;
			p.mesh.position.y += p.vy * dt;
			p.mesh.position.z += p.vz * dt;
			p.mesh.rotation.x += p.rx * dt;
			p.mesh.rotation.y += p.ry * dt;
			p.mesh.rotation.z += p.rz * dt;
		}
		// Rockets after the particles, so a burst's sparkles first move on the next tick.
		for (const b of this.bursts) {
			if (!b.rocket) continue;
			b.age += dt;
			b.rocket.position.y = b.y + FIREWORK_RISE * Math.min(1, b.age / FIREWORK_ROCKET_S);
			if (b.age >= FIREWORK_ROCKET_S) {
				this.scene.remove(b.rocket);
				b.rocket = null;
				this.burst(b);
			}
		}
		this.bursts = this.bursts.filter((b) => b.rocket !== null || b.alive > 0);
	}
}
