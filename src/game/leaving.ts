/**
 * The multiplayer leaving countdown (spec §7.4). The leaver's client sends `leaving {secondsLeft}`
 * once per threshold crossed. Crossing is checked per update, which may jump 2 s at a time, so a
 * threshold fires when the remaining time is at or below it, never on an exact second (T9).
 */
export const LEAVING_THRESHOLDS_S = [120, 60, 30, 0] as const;

export class LeavingCountdown {
	private readonly fired = LEAVING_THRESHOLDS_S.map(() => false);
	private started = false;

	constructor(private readonly send: (secondsLeft: number) => void) {}

	update(remainingMs: number): void {
		const remaining = Math.max(0, remainingMs);
		if (!this.started) {
			this.started = true;
			// Joining with less than 120 s left: one immediate message with the real value, and every
			// threshold already passed is marked fired, as WARNING_THRESHOLDS does.
			if (remaining < LEAVING_THRESHOLDS_S[0] * 1000) {
				for (let i = 0; i < LEAVING_THRESHOLDS_S.length; i++) {
					if (LEAVING_THRESHOLDS_S[i] * 1000 >= remaining) this.fired[i] = true;
				}
				this.send(Math.ceil(remaining / 1000));
				return;
			}
		}
		let lowest: number | null = null;
		for (let i = 0; i < LEAVING_THRESHOLDS_S.length; i++) {
			if (this.fired[i] || remaining > LEAVING_THRESHOLDS_S[i] * 1000) continue;
			this.fired[i] = true;
			lowest = LEAVING_THRESHOLDS_S[i];
		}
		if (lowest !== null) this.send(lowest);
	}
}

/** The toast the other players see for a `leaving` message ("went home" only at 0). */
export function leavingText(name: string, secondsLeft: number): string {
	if (secondsLeft >= 90) return `${name} has to go in 2 minutes`;
	if (secondsLeft >= 45) return `${name} has to go in 1 minute`;
	if (secondsLeft > 0) return `${name} has to go in 30 seconds`;
	return `${name} went home`;
}
