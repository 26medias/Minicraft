/** Spec §7.5: probe `GET /worlds` at these times after the connection was lost. */
export const RETRY_AT_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/** Spec §7.5: after this long without success, show Try again and Menu. */
export const GIVE_UP_MS = 30_000;

export type ReconnectDeps = {
	/** One `GET /worlds` (MpApi.listWorlds): resolves when the server answers. */
	probe: () => Promise<unknown>;
	/** The server answered: reload (the autojoin flag is still set). Called once. */
	onSuccess: () => void;
	/** 30 s without success: show Try again and Menu. Called once. */
	onGiveUp: () => void;
};

/**
 * The connection-lost retry schedule (spec §7.5). The reconnect itself is a page
 * reload; this only decides when the server is back.
 */
export class Reconnector {
	private timers: ReturnType<typeof setTimeout>[] = [];
	private done = false;

	constructor(private deps: ReconnectDeps) {}

	start(): void {
		for (const at of RETRY_AT_MS) this.timers.push(setTimeout(() => this.attempt(), at));
		this.timers.push(setTimeout(() => {
			if (this.done) return;
			this.deps.onGiveUp();
		}, GIVE_UP_MS));
	}

	stop(): void {
		this.done = true;
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
	}

	private attempt(): void {
		if (this.done) return;
		this.deps.probe().then(
			() => {
				if (this.done) return;
				this.stop();
				this.deps.onSuccess();
			},
			() => {
				// Still down: the next scheduled attempt (or the give-up) follows.
			},
		);
	}
}
