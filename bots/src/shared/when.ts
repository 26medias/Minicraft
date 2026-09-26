/**
 * `--when always|players` (every bot): with `players`, the bot is active only while at least one non-bot player is
 * online. When none is, it pauses — stays connected, ends its current move and build step safely, makes no model call
 * and no edit, only idles — and resumes when a player joins. Both switches wait out a 5 s debounce (a kid rejoining
 * after a dropped connection doesn't flap the bot). Logs `paused` / `resumed`.
 */
export type WhenMode = 'always' | 'players';
export const WHEN_MODES: readonly WhenMode[] = ['always', 'players'];
export const WHEN_DEBOUNCE_MS = 5000;

export interface PresenceGateOpts {
	mode: WhenMode;
	players: () => ReadonlyArray<{ bot: boolean }>;
	clock: () => number;
	log: (e: Record<string, unknown>) => void;
	debounceMs?: number;
}

export class PresenceGate {
	private on: boolean;
	private flipSince: number | null = null;

	constructor(private readonly o: PresenceGateOpts) {
		this.on = o.mode === 'always' || this.present();
		if (!this.on) o.log({ k: 'paused', why: 'no player online' });
	}

	private present(): boolean {
		return this.o.players().some((p) => !p.bot);
	}

	/** True while the bot must stay paused. Call it often: it is also what notices a player joining or leaving. */
	paused(): boolean {
		if (this.o.mode === 'always') return false;
		const want = this.present();
		if (want === this.on) {
			this.flipSince = null;
			return !this.on;
		}
		const now = this.o.clock();
		this.flipSince ??= now;
		if (now - this.flipSince >= (this.o.debounceMs ?? WHEN_DEBOUNCE_MS)) {
			this.on = want;
			this.flipSince = null;
			this.o.log(want ? { k: 'resumed', why: 'a player is online' } : { k: 'paused', why: 'no player online' });
		}
		return !this.on;
	}
}

/** One idle beat while paused: a look around from where the bot stands, then a short wait. No move, no edit. */
export async function idlePaused(body: { pose(): { x: number; y: number; z: number }; lookAt(x: number, y: number, z: number): void }, sleep: (ms: number) => Promise<void>, rng: () => number): Promise<void> {
	const p = body.pose();
	const a = rng() * Math.PI * 2;
	body.lookAt(p.x + Math.cos(a) * 8, p.y + 1.6, p.z + Math.sin(a) * 8);
	await sleep(3000);
}
