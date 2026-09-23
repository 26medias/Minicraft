import { describe, it, expect } from 'vitest';
import { BLOCK_BY_NAME, type BlockId } from '../data/blocks.data';
import { CAP_VY, GRAVITY, JUMP_SPEED, LAUNCH_VY, MIN_BOUNCE_VY, blockUnderFeet, padResponse, padUnderFeet } from './pads';

const SLIME = BLOCK_BY_NAME['slime_pad'].id;
const LAUNCH = BLOCK_BY_NAME['launch_pad'].id;
const STONE = BLOCK_BY_NAME['stone'].id;
/** Rise of a launch speed v under GRAVITY (continuous). */
const rise = (v: number) => (v * v) / (2 * GRAVITY);

describe('padResponse (toys spec §3.1, §6)', () => {
	it('no key held: the bounce keeps 0.8 of the landing speed', () => {
		// Catches a perfect bounce (1.0: he never settles) and the sign left negative (he is pushed into the pad).
		expect(padResponse(-10, 'slime', false, false)).toBeCloseTo(8);
		expect(padResponse(-21.9, 'slime', false, false)).toBeCloseTo(17.52);
	});

	it('jump held grows every bounce by 2 up to CAP_VY, an 8-block rise, then stays there', () => {
		// Catches no cap (the kid is thrown out of the world), the +2 missing (bounces stay at a
		// plain jump forever), and max(-landingVy, JUMP_SPEED) dropped (a soft landing gives a tiny hop).
		expect(CAP_VY).toBeCloseTo(Math.sqrt(2 * GRAVITY * 8));
		expect(rise(CAP_VY)).toBeCloseTo(8);
		expect(padResponse(-4, 'slime', true, false)).toBeCloseTo(JUMP_SPEED + 2);
		let v = -JUMP_SPEED;
		const out: number[] = [];
		for (let i = 0; i < 12; i++) {
			const r = padResponse(v, 'slime', true, false);
			out.push(r);
			v = -r; // a lossless flight lands at the speed it left with
		}
		const firstCap = out.indexOf(CAP_VY);
		expect(firstCap).toBeGreaterThan(2);
		for (let i = 1; i < firstCap; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
		for (let i = firstCap; i < out.length; i++) expect(out[i]).toBe(CAP_VY);
		expect(padResponse(-40, 'slime', true, false)).toBe(CAP_VY);
	});

	it('sneak gives 0, and wins over jump, on both pads', () => {
		// Catches jump checked before sneak (holding both would still bounce) and a launch that ignores sneak.
		expect(padResponse(-20, 'slime', false, true)).toBe(0);
		expect(padResponse(-20, 'slime', true, true)).toBe(0);
		expect(padResponse(0, 'launch', false, true)).toBe(0);
		expect(padResponse(0, 'launch', true, true)).toBe(0);
	});

	it('a landing slower than MIN_BOUNCE_VY gives 0, even with jump held', () => {
		// Catches no threshold (standing on the pad jitters every frame and jump never works), and the
		// threshold applied after the jump branch (a resting kid holding jump is thrown up 10 blocks/s).
		expect(MIN_BOUNCE_VY).toBe(3);
		expect(padResponse(-2.9, 'slime', false, false)).toBe(0);
		expect(padResponse(-2.9, 'slime', true, false)).toBe(0);
		expect(padResponse(-MIN_BOUNCE_VY, 'slime', false, false)).toBe(0);
		expect(padResponse(-3.01, 'slime', false, false)).toBeGreaterThan(0);
	});

	it('launch gives LAUNCH_VY whatever the landing speed or jump, and LAUNCH_VY aims at 25 blocks', () => {
		// Catches a launch scaled by the landing (a step onto the pad would barely lift him).
		expect(padResponse(0, 'launch', false, false)).toBe(LAUNCH_VY);
		expect(padResponse(-20, 'launch', true, false)).toBe(LAUNCH_VY);
		expect(rise(LAUNCH_VY)).toBeCloseTo(25);
	});
});

describe('the block under his feet (toys spec §3.1)', () => {
	// A slime pad at (10, 5, 10), stone at (11, 5, 10), air elsewhere.
	const world = {
		getBlock(x: number, y: number, z: number): BlockId {
			if (y === 5 && z === 10 && x === 10) return SLIME;
			if (y === 5 && z === 10 && x === 11) return STONE;
			return 0;
		},
	};

	it('is the block under the centre of his feet, even when the 0.6-wide box straddles two blocks', () => {
		// Catches reading the box's max corner (x 10.9 + 0.3 → 11: stone, no bounce) and its min
		// corner (x 11.05 − 0.3 → 10: a bounce off a pad he is not standing on).
		expect(blockUnderFeet(world, [10.9, 6.0001, 10.5])).toBe(SLIME);
		expect(blockUnderFeet(world, [11.05, 6.0001, 10.5])).toBe(STONE);
		expect(padUnderFeet(world, [10.9, 6.0001, 10.5])).toBe('slime');
		expect(padUnderFeet(world, [11.05, 6.0001, 10.5])).toBeNull();
		expect(padUnderFeet({ getBlock: () => LAUNCH }, [3.5, 9.0001, 3.5])).toBe('launch');
	});

	it('is one block below the feet, not the cell the feet are in', () => {
		// Catches floor(y) without the −1: the feet cell is air when he stands on the pad.
		expect(blockUnderFeet(world, [10.5, 6.0001, 10.5])).toBe(SLIME);
		expect(blockUnderFeet(world, [10.5, 5.0001, 10.5])).toBe(0);
	});
});
