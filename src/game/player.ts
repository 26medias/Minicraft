import * as THREE from 'three';
import type { World } from '../engine/world/world';
import { moveWithCollisions } from '../engine/physics/collision';
import type { BlockId } from '../data/blocks.data';

const WALK_SPEED = 5;      // blocks/sec
const JUMP_SPEED = 8;      // blocks/sec, initial upward velocity
const GRAVITY = 24;        // blocks/sec^2
const SIZE: [number, number, number] = [0.6, 1.8, 0.6];
const EYE_HEIGHT = 1.6;

export type Keys = {
	forward: boolean;
	back: boolean;
	left: boolean;
	right: boolean;
	jump: boolean;
};

export class Player {
	position: [number, number, number];
	vy = 0;
	grounded = false;
	hotbar: BlockId[] = [];
	selected = 0;

	constructor(spawn: [number, number, number]) {
		this.position = spawn;
	}

	eyePosition(): [number, number, number] {
		return [this.position[0], this.position[1] + EYE_HEIGHT, this.position[2]];
	}

	update(
		dt: number,
		world: World,
		keys: Keys,
		forward: THREE.Vector3,
		right: THREE.Vector3,
	) {
		let ix = 0, iz = 0;
		if (keys.forward) { ix += forward.x; iz += forward.z; }
		if (keys.back) { ix -= forward.x; iz -= forward.z; }
		if (keys.left) { ix -= right.x; iz -= right.z; }
		if (keys.right) { ix += right.x; iz += right.z; }

		const mag = Math.hypot(ix, iz);
		if (mag > 0) {
			ix /= mag; iz /= mag;
		}
		const vx = ix * WALK_SPEED * dt;
		const vz = iz * WALK_SPEED * dt;

		this.vy -= GRAVITY * dt;
		if (keys.jump && this.grounded) this.vy = JUMP_SPEED;
		const vyStep = this.vy * dt;

		const r = moveWithCollisions(world, this.position, SIZE, [vx, vyStep, vz]);
		this.position = r.position;
		this.grounded = r.grounded;
		if (r.vy === 0) this.vy = 0;
	}
}
