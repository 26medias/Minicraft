/**
 * Remote-player pose interpolation (spec §7.3).
 *
 * A remote player is rendered INTERP_DELAY_MS in the past (two server tick
 * periods, to absorb jitter), linearly interpolated between the two `tick`
 * samples that bracket that render time. When two consecutive samples are more
 * than SNAP_DISTANCE blocks apart (a respawn, a teleport), the avatar holds the
 * older pose and then jumps, instead of sliding across the map.
 */

/** A player's pose. Position is the feet; yaw and pitch are in radians. */
export type Pose = { x: number; y: number; z: number; yaw: number; pitch: number };

export const INTERP_DELAY_MS = 200;
export const SNAP_DISTANCE = 8;

/** Samples older than the one bracketing the render time are dropped; this caps a stalled buffer. */
const MAX_SAMPLES = 32;

type Sample = { t: number; p: Pose };

function lerpAngle(a: number, b: number, f: number): number {
	let d = (b - a) % (2 * Math.PI);
	if (d > Math.PI) d -= 2 * Math.PI;
	else if (d < -Math.PI) d += 2 * Math.PI;
	return a + d * f;
}

export class PoseBuffer {
	private samples: Sample[] = [];

	/** Adds a sample received at time `t` (ms). Out-of-order samples are dropped. */
	push(t: number, p: Pose): void {
		const last = this.samples[this.samples.length - 1];
		if (last && t < last.t) return;
		if (last && t === last.t) {
			last.p = { ...p };
			return;
		}
		this.samples.push({ t, p: { ...p } });
		if (this.samples.length > MAX_SAMPLES) this.samples.shift();
	}

	/** The pose to draw at `now` (ms): the pose at `now − INTERP_DELAY_MS`; null before any sample. */
	sample(now: number): Pose | null {
		const s = this.samples;
		if (s.length === 0) return null;
		const rt = now - INTERP_DELAY_MS;
		// Drop samples that no longer bracket the render time (keep the one just before it).
		while (s.length >= 2 && s[1].t <= rt) s.shift();
		const a = s[0];
		if (rt <= a.t || s.length === 1) return { ...a.p };
		const b = s[1];
		const dx = b.p.x - a.p.x;
		const dy = b.p.y - a.p.y;
		const dz = b.p.z - a.p.z;
		if (dx * dx + dy * dy + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE) return { ...a.p };
		const f = (rt - a.t) / (b.t - a.t);
		return {
			x: a.p.x + dx * f,
			y: a.p.y + dy * f,
			z: a.p.z + dz * f,
			yaw: lerpAngle(a.p.yaw, b.p.yaw, f),
			pitch: a.p.pitch + (b.p.pitch - a.p.pitch) * f,
		};
	}

	/** Number of buffered samples (for tests). */
	size(): number {
		return this.samples.length;
	}
}
