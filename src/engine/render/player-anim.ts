/**
 * Remote-player animation (spec §7): pure, no three. Everything derives from the interpolated pose;
 * no network data beyond it. Joints are vanilla-convention angles (see player-rig applyJoints).
 * Add an animation = append one AnimLayer to LAYERS (+ whatever sets its state).
 */
export type Joints = { headX: number; rArmX: number; rArmZ: number; lArmX: number; lArmZ: number; rLegX: number; lLegX: number };
export const ZERO_JOINTS: Readonly<Joints> = { headX: 0, rArmX: 0, rArmZ: 0, lArmX: 0, lArmZ: 0, rLegX: 0, lLegX: 0 };

export const SWING_MS = 300;
export const MINING_SWING_EVERY_MS = 200;
/** A pose jump longer than this (blocks) is a teleport/respawn/first pose: it does not walk. */
export const TELEPORT_BLOCKS = 1;

/** `idleOffset` (s) desynchronises the idle sway between avatars, like vanilla's per-entity age. */
export type AnimState = { walkPhase: number; walkAmount: number; swingAt: number | null; lastX: number | null; lastZ: number | null; lastT: number | null; idleOffset: number };
export type AnimInput = { now: number; x: number; z: number; pitch: number; mining: boolean };
export type AnimLayer = (s: AnimState, inp: AnimInput, j: Joints) => void;

export function newAnimState(idleOffset = 0): AnimState {
	return { walkPhase: 0, walkAmount: 0, swingAt: null, lastX: null, lastZ: null, lastT: null, idleOffset };
}

export function triggerSwing(s: AnimState, now: number): void {
	s.swingAt = now;
}

/** Advances walk and swing state from a new pose. */
export function step(s: AnimState, inp: AnimInput): void {
	if (s.swingAt !== null && inp.now - s.swingAt >= SWING_MS) s.swingAt = null;
	if (inp.mining && (s.swingAt === null || inp.now - s.swingAt >= MINING_SWING_EVERY_MS)) s.swingAt = inp.now;
	const { lastX, lastZ, lastT } = s;
	s.lastX = inp.x; s.lastZ = inp.z;
	if (lastT === null || lastX === null || lastZ === null) { s.lastT = inp.now; return; }
	const dt = (inp.now - lastT) / 1000;
	if (dt <= 0) return; // keep lastT: the next step measures from it
	s.lastT = inp.now;
	const dist = Math.hypot(inp.x - lastX, inp.z - lastZ);
	if (dist > TELEPORT_BLOCKS) return;
	const target = Math.min(1, 0.2 * (dist / dt));
	s.walkAmount += (target - s.walkAmount) * (1 - Math.pow(0.6, 20 * dt));
	s.walkPhase += 20 * s.walkAmount * dt;
}

const idle: AnimLayer = (s, inp, j) => {
	const t = inp.now / 1000 + s.idleOffset;
	const z = Math.cos(1.8 * t) * 0.05 + 0.05;
	const x = Math.sin(1.34 * t) * 0.05;
	j.rArmZ += z; j.lArmZ -= z;
	j.rArmX += x; j.lArmX -= x;
};

const walk: AnimLayer = (s, _inp, j) => {
	const ph = s.walkPhase * 0.6662, a = s.walkAmount;
	j.rArmX += Math.cos(ph + Math.PI) * a;
	j.lArmX += Math.cos(ph) * a;
	j.rLegX += Math.cos(ph) * 1.4 * a;
	j.lLegX += Math.cos(ph + Math.PI) * 1.4 * a;
};

const swing: AnimLayer = (s, inp, j) => {
	if (s.swingAt === null) return;
	const p = (inp.now - s.swingAt) / SWING_MS;
	if (p < 0 || p >= 1) return;
	const f1 = Math.sin(Math.PI * (1 - Math.pow(1 - p, 4)));
	const headXv = -inp.pitch;
	j.rArmX -= f1 * 1.2 + Math.sin(p * Math.PI) * (0.7 - headXv) * 0.75;
	j.rArmZ += -0.4 * Math.sin(p * Math.PI);
};

export const LAYERS: AnimLayer[] = [idle, walk, swing];

export function joints(s: AnimState, inp: AnimInput): Joints {
	const j: Joints = { ...ZERO_JOINTS, headX: -inp.pitch };
	for (const layer of LAYERS) layer(s, inp, j);
	return j;
}
