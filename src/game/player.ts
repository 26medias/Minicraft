import * as THREE from 'three';
import type { World } from '../engine/world/world';
import { moveWithCollisions } from '../engine/physics/collision';
import type { BlockId } from '../data/blocks.data';
import { isLiquid } from '../data/blocks.data';
import type { Inventory, PlayerTools } from '../data/crafting.data';
import { GRAVITY, JUMP_SPEED, MIN_BOUNCE_VY, padResponse, padUnderFeet } from './pads';
import { EYE_HEIGHT, WALK_SPEED } from './player-constants';
import { findSafeSpawn, sanitizeSpawn, VOID_FLOOR_Y } from './safe-spawn';

// Spawn safety lives in a three-free module (shared with the bot SDK); re-exported so every importer is unchanged.
export { findSafeSpawn, sanitizeSpawn, skyCeilingY, VOID_FLOOR_Y } from './safe-spawn';

const SIZE: [number, number, number] = [0.6, 1.8, 0.6];
const MAX_STEP = 0.4; // max displacement per physics sub-step (blocks)
const FLY_TIER_MIN = 1;
const FLY_TIER_MAX = 5;
const FLY_TIER_DEFAULT = 2;

export type Keys = {
	forward: boolean;
	back: boolean;
	left: boolean;
	right: boolean;
	jump: boolean;
	/** Shift (toys spec §4): stops pads. Optional so every existing Keys literal stays valid; absent = not held. */
	sneak?: boolean;
};

export class Player {
	position: [number, number, number];
	vy = 0;
	grounded = false;
	hotbar: BlockId[] = [];
	selected = 0;
	/** Crafting counts by block name; replaced from the save by resolvePlayerExtras. */
	inventory: Inventory = {};
	/** Owned and equipped pickaxe tiers; 0 (the hand) is always owned. */
	tools: PlayerTools = { owned: [0], equipped: 0 };
	flying = false;
	flySpeedTier = FLY_TIER_DEFAULT;
	swimming = false;
	/**
	 * Toys spec §3.2: the column (x, z) of the Launch Pad that last threw him, or null when armed. It re-arms once
	 * his feet leave that column, so landing back on the pad does not throw him again. Not saved: a load starts armed.
	 */
	launchedFrom: [number, number] | null = null;
	readonly height: number;

	constructor(spawn: [number, number, number], height = 64) {
		this.height = height;
		this.position = sanitizeSpawn(spawn, height);
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

	update(dt: number, world: World, keys: Keys, forward: THREE.Vector3, right: THREE.Vector3) {
		// Tall worlds have unbreakable bedrock at y 0, so below it there is no way back up: put the player
		// on the surface of his column. Old 64-high worlds keep their void (he flies back up through his hole).
		if (world.height === 256 && this.position[1] < 0) {
			this.position = findSafeSpawn(world, [this.position[0], world.height - 1, this.position[2]]);
			this.vy = 0;
		}
		// Swim state (from Task 18) — keep this at the top so downstream logic sees it.
		const eye = this.eyePosition();
		const eyeBlock = world.getBlock(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]));
		this.swimming = isLiquid(eyeBlock);

		const feetBlock = world.getBlock(
			Math.floor(this.position[0]),
			Math.floor(this.position[1]),
			Math.floor(this.position[2]),
		);
		const feetInLiquid = isLiquid(feetBlock);
		// Launch Pad re-arm: his feet have left the column of the pad that threw him.
		const lf = this.launchedFrom;
		if (lf && (Math.floor(this.position[0]) !== lf[0] || Math.floor(this.position[2]) !== lf[1])) this.launchedFrom = null;

		let ix = 0,
			iy = 0,
			iz = 0;
		if (this.flying || this.swimming) {
			// Full 3D along cursor forward; strafe horizontal only (right.y is ~0 by construction).
			if (keys.forward) {
				ix += forward.x;
				iy += forward.y;
				iz += forward.z;
			}
			if (keys.back) {
				ix -= forward.x;
				iy -= forward.y;
				iz -= forward.z;
			}
			if (keys.left) {
				ix -= right.x;
				iz -= right.z;
			}
			if (keys.right) {
				ix += right.x;
				iz += right.z;
			}
		} else {
			// On-ground walking — unchanged horizontal projection of the look direction.
			if (keys.forward) {
				ix += forward.x;
				iz += forward.z;
			}
			if (keys.back) {
				ix -= forward.x;
				iz -= forward.z;
			}
			if (keys.left) {
				ix -= right.x;
				iz -= right.z;
			}
			if (keys.right) {
				ix += right.x;
				iz += right.z;
			}
		}

		const mag = Math.hypot(ix, iy, iz);
		if (mag > 0) {
			ix /= mag;
			iy /= mag;
			iz /= mag;
		}

		let speed: number;
		if (this.flying) speed = WALK_SPEED * this.flySpeedTier;
		else if (this.swimming) speed = WALK_SPEED * 0.6;
		else speed = WALK_SPEED;

		const vx = ix * speed * dt;
		const vz = iz * speed * dt;

		let vyStep: number;
		if (this.flying || this.swimming) {
			this.vy = iy * speed; // cursor-driven vertical; no gravity
			vyStep = this.vy * dt;
		} else {
			this.vy -= GRAVITY * dt;
			if (keys.jump && (this.grounded || feetInLiquid)) this.vy = JUMP_SPEED;
			// Launch Pad: after the jump line, so a held jump cannot overwrite the launch.
			if (this.grounded && this.launchedFrom === null && padUnderFeet(world, this.position) === 'launch') {
				const up = padResponse(0, 'launch', keys.jump, keys.sneak === true);
				if (up > 0) {
					this.vy = up;
					this.launchedFrom = [Math.floor(this.position[0]), Math.floor(this.position[2])];
				}
			}
			vyStep = this.vy * dt;
		}

		const disp = Math.max(Math.abs(vx), Math.abs(vyStep), Math.abs(vz));
		const steps = Math.max(1, Math.ceil(disp / MAX_STEP));
		const sx = vx / steps,
			sy = vyStep / steps,
			sz = vz / steps;
		// Toys spec §3.1: the speed he lands with, read before collision zeroes it.
		const landingVy = this.vy;
		let grounded = false;
		for (let i = 0; i < steps; i++) {
			const r = moveWithCollisions(world, this.position, SIZE, [sx, sy, sz]);
			this.position = r.position;
			grounded = grounded || r.grounded;
			if (r.vy === 0) this.vy = 0;
			if (r.vx === 0 && r.vz === 0 && r.vy === 0) break;
		}
		// Slime Pad: a real landing bounces. Not grounded, so next frame's jump line cannot overwrite the bounce
		// (gate 1 measured a 19.7 bounce cut to 8.0). A soft landing, or sneak, leaves him standing.
		if (!this.flying && !this.swimming && grounded && landingVy < -MIN_BOUNCE_VY && padUnderFeet(world, this.position) === 'slime') {
			const up = padResponse(landingVy, 'slime', keys.jump, keys.sneak === true);
			if (up > 0) {
				this.vy = up;
				grounded = false;
			}
		}

		// Keep the player inside the world. Leaving it horizontally means there is no
		// ground to land on, which is how an endless fall starts.
		const [cx, cy, cz] = sanitizeSpawn(this.position, world.height);
		if (cy !== this.position[1]) {
			// Landing on the void floor or bumping the ceiling cancels vertical speed,
			// so the player rests there rather than accumulating velocity.
			this.vy = 0;
			if (cy === VOID_FLOOR_Y) grounded = true;
		}
		this.position = [cx, cy, cz];

		this.grounded = grounded;
	}
}
