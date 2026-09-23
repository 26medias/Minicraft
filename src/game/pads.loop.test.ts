import { describe, it, expect } from 'vitest';
import { makeLoop } from './test-loop';
import { BLOCK_BY_NAME } from '../data/blocks.data';

const SLIME = BLOCK_BY_NAME['slime_pad'].id;
const STONE = BLOCK_BY_NAME['stone'].id;
const DT = 1 / 60;
// makeLoop() clears chunk (16,16) = x,z 256..271 of a 64-high v1 world: open air down to the void floor.
const P = { x: 260, y: 29, z: 260 };
/** The top face of the pad: where his feet rest on it. */
const TOP = P.y + 1;

/** A loop with a slime pad at P and his feet `drop` blocks above its top, centred over (cx, cz). */
function onPad(drop: number, cx = P.x + 0.5, cz = P.z + 0.5) {
	const h = makeLoop();
	h.world.setBlock(P.x, P.y, P.z, SLIME);
	h.player.position = [cx, TOP + drop, cz];
	h.player.vy = 0;
	return h;
}

type H = ReturnType<typeof makeLoop>;

/** Runs `frames` ticks; returns the height above TOP of each apex (vy going from > 0 to ≤ 0) and the highest point. */
function fly(h: H, frames: number) {
	const apexes: number[] = [];
	let prevVy = h.player.vy;
	let maxY = -Infinity;
	for (let i = 0; i < frames; i++) {
		h.tick(DT);
		const y = h.player.position[1];
		maxY = Math.max(maxY, y);
		if (prevVy > 0 && h.player.vy <= 0) apexes.push(y - TOP);
		prevVy = h.player.vy;
	}
	return { apexes, maxY: maxY - TOP };
}

/** Ticks until he first touches down (grounded, or a bounce already under way this frame). */
function untilLanding(h: H, max = 600) {
	let prevVy = h.player.vy;
	for (let i = 0; i < max; i++) {
		h.tick(DT);
		if (h.player.grounded || (prevVy < 0 && h.player.vy > 0)) return;
		prevVy = h.player.vy;
	}
	throw new Error('never landed');
}

// makeLoop() costs ~2 s and a tick ~3 ms here: the long flights need more than the 5 s default.
describe('Slime Pad in the loop (toys spec §3.1, §6)', { timeout: 30_000 }, () => {
	it('a 10-block drop bounces back up most of the way', () => {
		// Catches no hook at all, and landingVy read after the substep loop (collision has zeroed vy by then: no bounce).
		const h = onPad(10);
		const { apexes } = fly(h, 180);
		expect(apexes.length).toBeGreaterThan(0);
		expect(apexes[0]).toBeGreaterThan(5); // 0.8² × 10 = 6.4
		expect(apexes[0]).toBeLessThan(7);
	});

	it('jump held from a jump off the pad: every rise beats the last until one reaches 7.5, then stays flat at the cap', () => {
		// Catches the jump line overwriting the bounce (grounded left true: every rise is a plain jump's 1.40),
		// and a missing cap (rises keep growing past 8 blocks).
		const h = onPad(0);
		fly(h, 30); // settle on the pad: a landing this slow does not bounce
		expect(h.player.grounded).toBe(true);
		h.keys.jump = true;
		const { apexes } = fly(h, 60 * 20);
		const rises = apexes.slice(1); // apexes[0] is the plain jump off the pad
		expect(apexes[0]).toBeLessThan(1.45); // this integrator's plain jump: 1.40
		expect(rises[0]).toBeGreaterThan(1.45);
		const k = rises.findIndex((r) => r >= 7.5);
		expect(k).toBeGreaterThan(2);
		for (let i = 1; i <= k; i++) expect(rises[i]).toBeGreaterThan(rises[i - 1]);
		expect(rises.length).toBeGreaterThan(k + 3);
		for (let i = k + 1; i < rises.length; i++) expect(rises[i]).toBeCloseTo(rises[k], 3);
		expect(rises[k]).toBeLessThan(8.05);
	});

	it('sneak held: no bounce at all', () => {
		// Catches Player passing sneak: false (or reading a key that main.ts never fills).
		const h = onPad(10);
		h.keys.sneak = true;
		untilLanding(h);
		const { maxY } = fly(h, 120);
		expect(maxY).toBeLessThan(0.01);
		expect(h.player.grounded).toBe(true);
	});

	it('jump and sneak held: no bounce, only plain jumps', () => {
		// Catches jump winning over sneak (the landing would throw him 8 blocks up).
		const h = onPad(10);
		h.keys.jump = true;
		h.keys.sneak = true;
		untilLanding(h);
		const { maxY } = fly(h, 180);
		expect(maxY).toBeLessThan(1.45);
	});

	it('the bounces settle: he ends up standing on the pad, grounded every frame', () => {
		// Catches no MIN_BOUNCE_VY (he jitters on the pad forever) and a hook that clears grounded on every slime
		// contact, whatever the landing speed (he could never stand still on a pad, or jump off it).
		const h = onPad(10);
		fly(h, 60 * 10); // nine bounces, about 7 s
		for (let i = 0; i < 60; i++) {
			h.tick(DT);
			expect(h.player.grounded).toBe(true);
			expect(h.player.position[1] - TOP).toBeLessThan(0.01);
		}
	});

	it('the pad under the centre of his feet decides, not the edge of his box', () => {
		// Catches Player testing every block under the 0.6-wide box (straddling a pad he is not standing on bounces him),
		// and testing only its far corner (standing on the pad with one edge over stone gives no bounce).
		const off = onPad(10, P.x + 1.1, P.z + 0.5); // centre over stone at x+1, box edge over the pad
		off.world.setBlock(P.x + 1, P.y, P.z, STONE);
		untilLanding(off);
		expect(fly(off, 60).maxY).toBeLessThan(0.01);
		const on = onPad(10, P.x + 0.9, P.z + 0.5); // centre over the pad, box edge over stone
		on.world.setBlock(P.x + 1, P.y, P.z, STONE);
		untilLanding(on); // measure from the landing: the drop itself starts 10 up
		expect(fly(on, 180).maxY).toBeGreaterThan(5);
	});

	for (const room of [2, 3]) {
		it(`under a low ceiling (Review Focus 3, ${room} blocks of headroom): jump held never takes his head through it, and once he lets go he settles on the pad`, () => {
			// Catches a bounce that never decays (SLIME_KEEP 1.0: the ceiling hands him back the same speed forever) and
			// no MIN_BOUNCE_VY (the tiny ceiling-to-pad hops never end).
			const h = onPad(0);
			for (let x = P.x - 2; x <= P.x + 2; x++) for (let z = P.z - 2; z <= P.z + 2; z++) h.world.setBlock(x, TOP + room, z, STONE);
			const head = room - 1.8; // the most his feet can rise before his head meets the ceiling
			fly(h, 30);
			h.keys.jump = true;
			expect(fly(h, 60 * 3).maxY).toBeLessThanOrEqual(head + 0.001);
			h.keys.jump = false;
			fly(h, 60 * 3);
			for (let i = 0; i < 60; i++) {
				h.tick(DT);
				expect(h.player.grounded).toBe(true);
				expect(h.player.position[1] - TOP).toBeLessThan(0.01);
			}
		});
	}
});

const LAUNCH = BLOCK_BY_NAME['launch_pad'].id;
/** Stone floor along x 256..266 at y = P.y, the launch pad in it at (L.x, P.y, P.z); his feet on the pad. */
const L = { x: 262, y: P.y, z: P.z };

function onLaunchPad() {
	const h = makeLoop();
	for (let x = 256; x <= 266; x++) for (let z = P.z - 1; z <= P.z + 1; z++) h.world.setBlock(x, P.y, z, STONE);
	h.world.setBlock(L.x, L.y, L.z, LAUNCH);
	h.player.position = [L.x + 0.5, TOP, L.z + 0.5];
	h.player.vy = 0;
	return h;
}

/** Ticks until his feet are in column x (walking with the key already held), at most 5 s. */
function walkTo(h: H, x: number) {
	for (let i = 0; i < 300 && Math.floor(h.player.position[0]) !== x; i++) h.tick(DT);
	expect(Math.floor(h.player.position[0])).toBe(x);
}

describe('Launch Pad in the loop (toys spec §3.2, §6)', { timeout: 30_000 }, () => {
	it('the pad starts armed: standing on it throws him 25 ± 1.5 blocks straight up', () => {
		// Catches a pad that starts disarmed (the first step onto it does nothing) and a LAUNCH_VY off target.
		const h = onLaunchPad();
		const { maxY } = fly(h, 60 * 4);
		expect(maxY).toBeGreaterThan(23.5);
		expect(maxY).toBeLessThan(26.5);
		expect(Math.floor(h.player.position[0])).toBe(L.x); // straight up: he comes down on the same pad
	});

	it('jump held: still 25 ± 1.5 — the jump line cannot overwrite the launch', () => {
		// Catches the launch applied before the jump line (vy = 8 wins: a 1.4-block hop).
		const h = onLaunchPad();
		h.keys.jump = true;
		const { apexes } = fly(h, 60 * 4);
		expect(apexes[0]).toBeGreaterThan(23.5);
		expect(apexes[0]).toBeLessThan(26.5);
	});

	it('landing back on the pad does not relaunch him', () => {
		// Catches no re-arm state (he is thrown up forever) and re-arming when his feet leave the ground
		// (the landing re-fires, because in the air his feet are "off the pad").
		const h = onLaunchPad();
		fly(h, 60 * 5); // up, down, landed
		expect(h.player.grounded).toBe(true);
		expect(fly(h, 60 * 3).maxY).toBeLessThan(0.01);
	});

	it('stepping off and back on launches him again', () => {
		// Catches a single-use pad (never re-armed) and a re-arm that needs something other than leaving the cell.
		const h = onLaunchPad();
		fly(h, 60 * 5);
		h.keys.right = true;
		walkTo(h, L.x + 1);
		h.keys.right = false;
		fly(h, 10);
		h.keys.left = true;
		walkTo(h, L.x);
		h.keys.left = false;
		expect(fly(h, 60 * 4).maxY).toBeGreaterThan(23.5);
	});

	it('sneak blocks it without using it up: letting go of Shift on the pad launches him', () => {
		// Catches a launch that ignores sneak, and sneak treated as a launch (disarming the pad until he steps off).
		const h = onLaunchPad();
		h.keys.sneak = true;
		expect(fly(h, 120).maxY).toBeLessThan(0.01);
		h.keys.sneak = false;
		expect(fly(h, 60 * 4).maxY).toBeGreaterThan(23.5);
	});

	it('in a cave (Review Focus 4): he stops at the ceiling, lands back on the pad, and it does not fire again until he steps off', () => {
		// Catches a pad re-armed by the head bump (he would be thrown into the ceiling over and over), a pad re-armed
		// whenever his feet leave the ground, and no re-arm state at all.
		const h = onLaunchPad();
		const ROOM = 6; // stone ceiling 6 above the pad's top: his feet can rise 6 − 1.8 = 4.2
		for (let x = 256; x <= 266; x++) for (let z = P.z - 1; z <= P.z + 1; z++) h.world.setBlock(x, TOP + ROOM, z, STONE);
		const first = fly(h, 60 * 2);
		expect(first.maxY).toBeGreaterThan(3.5);
		expect(first.maxY).toBeLessThanOrEqual(ROOM - 1.8 + 0.001);
		expect(first.apexes).toHaveLength(1); // one throw, not a ceiling-to-pad loop
		expect(h.player.grounded).toBe(true);
		expect(Math.floor(h.player.position[0])).toBe(L.x); // back on the pad
		expect(fly(h, 60 * 3).maxY).toBeLessThan(0.01);
		h.keys.right = true;
		walkTo(h, L.x + 1);
		h.keys.right = false;
		fly(h, 10);
		h.keys.left = true;
		walkTo(h, L.x);
		h.keys.left = false;
		const again = fly(h, 60 * 2);
		expect(again.maxY).toBeGreaterThan(3.5);
		expect(again.maxY).toBeLessThanOrEqual(ROOM - 1.8 + 0.001);
	});
});
