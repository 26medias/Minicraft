import * as THREE from 'three';
import type { World } from '../engine/world/world';
import { moveWithCollisions } from '../engine/physics/collision';
import type { BlockId } from '../data/blocks.data';

const WALK_SPEED = 5;      // blocks/sec
const JUMP_SPEED = 8;      // blocks/sec, initial upward velocity
const GRAVITY = 24;        // blocks/sec^2
const SIZE: [number, number, number] = [0.6, 1.8, 0.6];
const EYE_HEIGHT = 1.6;
const MAX_STEP = 0.4;      // max displacement per physics sub-step (blocks)
const FLY_TIER_MIN = 1;
const FLY_TIER_MAX = 5;
const FLY_TIER_DEFAULT = 2;

export type Keys = {
	forward: boolean;
	back: boolean;
	left: boolean;
	right: boolean;
	jump: boolean;
	flyUp: boolean;
	flyDown: boolean;
};

export class Player {
	position: [number, number, number];
	vy = 0;
	grounded = false;
	hotbar: BlockId[] = [];
	selected = 0;
	flying = false;
	flySpeedTier = FLY_TIER_DEFAULT;

	constructor(spawn: [number, number, number]) {
		this.position = spawn;
	}

	eyePosition(): [number, number, number] {
		return [this.position[0], this.position[1] + EYE_HEIGHT, this.position[2]];
	}

	toggleFly() {
		this.flying = !this.flying;
		this.vy = 0;
	}

	adjustFlySpeed(delta: number) {
		if (!this.flying) return;
		this.flySpeedTier = Math.max(
			FLY_TIER_MIN,
			Math.min(FLY_TIER_MAX, this.flySpeedTier + delta),
		);
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
		const speed = this.flying ? WALK_SPEED * this.flySpeedTier : WALK_SPEED;
		const vx = ix * speed * dt;
		const vz = iz * speed * dt;

		let vyStep: number;
		if (this.flying) {
			let vy = 0;
			if (keys.flyUp) vy += speed;
			if (keys.flyDown) vy -= speed;
			this.vy = vy;
			vyStep = vy * dt;
		} else {
			this.vy -= GRAVITY * dt;
			if (keys.jump && this.grounded) this.vy = JUMP_SPEED;
			vyStep = this.vy * dt;
		}

		const disp = Math.max(Math.abs(vx), Math.abs(vyStep), Math.abs(vz));
		const steps = Math.max(1, Math.ceil(disp / MAX_STEP));
		const sx = vx / steps, sy = vyStep / steps, sz = vz / steps;
		let grounded = false;
		for (let i = 0; i < steps; i++) {
			const r = moveWithCollisions(world, this.position, SIZE, [sx, sy, sz]);
			this.position = r.position;
			grounded = grounded || r.grounded;
			if (r.vy === 0) this.vy = 0;
			if (r.vx === 0 && r.vz === 0 && r.vy === 0) break;
		}
		this.grounded = grounded;
	}
}
