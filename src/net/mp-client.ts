/**
 * MpClient: the multiplayer socket (spec §3.1 liveness, §5 close codes, §7.5 connection loss).
 * - Sends `hello` on open, then routes `welcome`, the binary snapshot frame and every other message.
 * - Liveness runs on `setInterval` only, never rAF, so a hidden tab stays alive: a `ping` goes out
 *   when nothing was sent for 2 s, and 6 s without any message closes the socket as `lost`.
 * - Reconnecting is the caller's job (a page reload, spec §7.5); this class reports the state once.
 */
import { CLOSE, type ErrorMsg, type Hello, type ServerMsg, type Welcome } from './protocol';
import type { StorageLike } from './mp-sync';

export type MpState = 'connecting' | 'open' | 'lost' | 'fatal';

export type MpHandlers = {
	onWelcome: (w: Welcome) => void;
	/** The binary snapshot frame that follows `welcome` (decode with `decodeSnapshot`). */
	onSnapshot: (buf: ArrayBuffer) => void;
	/** Every other server message except `ping`. `error` is passed through; its close follows. */
	onMessage: (m: ServerMsg) => void;
	/**
	 * `lost` and `fatal` are terminal and reported once; `code` is the close code when there is one.
	 * `err` is the last `error` message received before this close, or undefined (the synthetic
	 * two-4003 → 4004 path never has one).
	 */
	onState: (state: MpState, code?: number, err?: ErrorMsg) => void;
};

export type Clock = {
	setInterval: (fn: () => void, ms: number) => unknown;
	clearInterval: (id: never) => void;
	now: () => number;
};

const PING_EVERY_MS = 2000;
const SILENCE_MS = 6000;
/** How often the liveness check runs. */
const CHECK_MS = 500;
/**
 * sessionStorage key: consecutive 4003 closes (spec §5: the second one shows the 4004 screen).
 * The server sends 4003 only for a rejected `edit`, and edits only follow a `welcome`, so a
 * `welcome` must NOT reset it (the loop would never break). It resets when the server accepts one
 * of this client's edits: an `edit` whose `by` is our `welcome.you`.
 */
export const RESYNC_KEY = 'mp:resync';

/** No reconnect: each needs a different screen (spec §5). */
const FATAL = new Set<number>([
	CLOSE.replaced,
	CLOSE.proto,
	CLOSE.genUnsupported,
	CLOSE.unknownWorld,
	CLOSE.badToken,
	CLOSE.badName,
	CLOSE.nameTaken,
]);

const defaultClock: Clock = {
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
	now: () => Date.now(),
};

export class MpClient {
	private ws: WebSocket;
	private timer: unknown = null;
	private lastRecv: number;
	private lastSent: number;
	private done = false;
	/** `welcome.you`, once known. */
	private you: number | null = null;
	/** The last `error` message received, for the fatal-close handler (spec §5). */
	private lastError: ErrorMsg | undefined = undefined;

	constructor(
		url: string,
		token: string,
		private hello: Hello,
		private handlers: MpHandlers,
		private clock: Clock = defaultClock,
		private storage: StorageLike = sessionStorage,
	) {
		this.lastRecv = this.lastSent = clock.now();
		const base = url.replace(/^http/, 'ws').replace(/\/+$/, '');
		this.ws = new WebSocket(base + '/ws?token=' + encodeURIComponent(token));
		this.ws.binaryType = 'arraybuffer';
		this.ws.onopen = () => this.onOpen();
		this.ws.onmessage = (ev) => this.onData(ev.data);
		this.ws.onclose = (ev) => this.onClose(ev.code);
		handlers.onState('connecting');
		this.timer = clock.setInterval(() => this.check(), CHECK_MS);
	}

	/** Sends one message. False (dropped) when the socket isn't open. */
	send(msg: object): boolean {
		if (this.done || this.ws.readyState !== 1) return false;
		this.ws.send(JSON.stringify(msg));
		this.lastSent = this.clock.now();
		return true;
	}

	/** A deliberate, normal close (freeze, Menu): no state is reported. */
	close(code = 1000): void {
		if (this.done) return;
		this.finish();
		this.ws.close(code);
	}

	private onOpen(): void {
		if (this.done) return;
		this.lastRecv = this.clock.now();
		this.send(this.hello);
		this.handlers.onState('open');
	}

	private onData(data: unknown): void {
		if (this.done) return;
		this.lastRecv = this.clock.now();
		if (data instanceof ArrayBuffer) {
			this.handlers.onSnapshot(data);
			return;
		}
		let m: ServerMsg;
		try {
			m = JSON.parse(String(data)) as ServerMsg;
		} catch {
			return;
		}
		if (m.t === 'ping') return;
		if (m.t === 'welcome') {
			this.you = m.you;
			this.handlers.onWelcome(m);
			return;
		}
		if (m.t === 'error') this.lastError = m;
		if (m.t === 'edit' && m.by === this.you) this.setResync(0);
		this.handlers.onMessage(m);
	}

	private onClose(code: number): void {
		if (this.done) return;
		this.finish();
		if (code === CLOSE.resync) {
			const n = this.getResync() + 1;
			this.setResync(n);
			if (n >= 2) {
				// Synthetic fatal (two 4003s in a row): no `error` message ever preceded this close.
				this.handlers.onState('fatal', CLOSE.proto);
				return;
			}
			this.handlers.onState('lost', code);
			return;
		}
		this.handlers.onState(FATAL.has(code) ? 'fatal' : 'lost', code, this.lastError);
	}

	private check(): void {
		if (this.done) return;
		const now = this.clock.now();
		if (now - this.lastRecv >= SILENCE_MS) {
			this.finish();
			this.ws.close();
			this.handlers.onState('lost');
			return;
		}
		if (now - this.lastSent >= PING_EVERY_MS) this.send({ t: 'ping' });
	}

	private finish(): void {
		this.done = true;
		if (this.timer !== null) this.clock.clearInterval(this.timer as never);
		this.timer = null;
	}

	private getResync(): number {
		try {
			return Number(this.storage.getItem(RESYNC_KEY)) || 0;
		} catch {
			return 0;
		}
	}

	private setResync(n: number): void {
		try {
			if (n === 0) this.storage.removeItem(RESYNC_KEY);
			else this.storage.setItem(RESYNC_KEY, String(n));
		} catch {
			// Storage unavailable: the counter can't survive the reload.
		}
	}
}
