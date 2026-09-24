import type { ServerMsg } from '../net/protocol';

/**
 * Between `welcome` and the moment startGame wires the session (the snapshot is decoded and the
 * world built in between), the link buffers server messages and remembers a lost or fatal
 * connection. `wire` replays that state, so a drop in that window still freezes the game and shows
 * Reconnecting instead of starting on a dead client (spec §7.5).
 */
export class MpLink {
	private route: ((m: ServerMsg) => void) | null = null;
	private readonly pending: ServerMsg[] = [];
	private dead: null | 'lost' | 'fatal' = null;
	private onLost: (() => void) | null = null;
	private onFatal: (() => void) | null = null;

	deliver(m: ServerMsg): void {
		if (this.route) this.route(m);
		else this.pending.push(m);
	}

	setRoute(route: (m: ServerMsg) => void): void {
		this.route = route;
		for (const m of this.pending.splice(0)) route(m);
	}

	lost(): void {
		if (this.dead) return;
		this.dead = 'lost';
		this.onLost?.();
	}

	fatal(): void {
		if (this.dead === 'fatal') return;
		this.dead = 'fatal';
		this.onFatal?.();
	}

	wire(onLost: () => void, onFatal: () => void): void {
		this.onLost = onLost;
		this.onFatal = onFatal;
		if (this.dead === 'fatal') onFatal();
		else if (this.dead === 'lost') onLost();
	}
}
