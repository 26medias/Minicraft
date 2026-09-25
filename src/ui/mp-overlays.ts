import type { FatalScreen } from '../game/mp-exit';

/** How long a toast stays up. */
const TOAST_MS = 6_000;

/**
 * The multiplayer UI pieces (plan I1, spec §5, §7.4, §7.5):
 * - the "Reconnecting…" dim overlay, with Try again and a Menu link after 30 s;
 * - the fatal screens (4001, 4004/4005);
 * - the toasts other players' countdowns raise, with the leaver's colour dot;
 * - the big 10…1 for the local player.
 * Nothing here exists in solo: main.ts creates it only in a multiplayer session.
 */
export class MpOverlays {
	private reconnectEl: HTMLDivElement | null = null;
	private fatalEl: HTMLDivElement | null = null;
	private toasts: HTMLDivElement;
	/** Created on the first visible number, so another player's screen never has one. */
	private countdownEl: HTMLDivElement | null = null;

	constructor(private app: HTMLElement) {
		this.toasts = document.createElement('div');
		this.toasts.id = 'mp-toasts';
		app.appendChild(this.toasts);
	}

	/** Spec §7.5: the screen dims under a big "Reconnecting…". */
	showReconnecting(): void {
		if (this.reconnectEl) return;
		const el = document.createElement('div');
		el.id = 'mp-reconnecting';
		el.className = 'mp-screen';
		const title = document.createElement('div');
		title.className = 'mp-screen-title';
		title.textContent = 'Reconnecting…';
		el.appendChild(title);
		this.app.appendChild(el);
		this.reconnectEl = el;
	}

	/** Spec §7.5, after 30 s: one big Try again (rejoins the same world) and a small Menu link. */
	showGiveUp(onTryAgain: () => void, onMenu: () => void): void {
		this.showReconnecting();
		const el = this.reconnectEl!;
		if (el.querySelector('#mp-try-again')) return;
		const again = document.createElement('button');
		again.id = 'mp-try-again';
		again.className = 'mp-screen-button';
		again.textContent = 'Try again';
		again.onclick = onTryAgain;
		const menu = document.createElement('a');
		menu.id = 'mp-menu-link';
		menu.className = 'mp-screen-link';
		menu.href = '#';
		menu.textContent = 'Menu';
		menu.onclick = (e) => {
			e.preventDefault();
			onMenu();
		};
		el.append(again, menu);
	}

	/**
	 * Spec §5 fatal screens. 4001: "You opened the game somewhere else." with one big Menu button.
	 * 4004/4005: "Minicraft was updated — click to reload". `onClick` reloads either way.
	 */
	showFatal(kind: FatalScreen, onClick: () => void): void {
		this.hideReconnecting();
		this.fatalEl?.remove();
		const el = document.createElement('div');
		el.id = 'mp-fatal';
		el.className = 'mp-screen';
		el.dataset.kind = kind;
		const title = document.createElement('div');
		title.className = 'mp-screen-title';
		const b = document.createElement('button');
		b.id = 'mp-fatal-button';
		b.className = 'mp-screen-button';
		b.onclick = onClick;
		if (kind === 'replaced') {
			title.textContent = 'You opened the game somewhere else.';
			b.textContent = 'Menu';
		} else {
			title.textContent = 'Minicraft was updated — click to reload';
			b.textContent = 'Reload';
			el.onclick = onClick;
		}
		el.append(title, b);
		this.app.appendChild(el);
		this.fatalEl = el;
	}

	/**
	 * Spec §5 outdated auto-reload: "Updating Minicraft…" for UPDATING_SCREEN_MS, no button — the
	 * caller schedules the reload itself.
	 */
	showUpdating(): void {
		this.hideReconnecting();
		this.fatalEl?.remove();
		const el = document.createElement('div');
		el.id = 'mp-updating';
		el.className = 'mp-screen';
		const title = document.createElement('div');
		title.className = 'mp-screen-title';
		title.textContent = 'Updating Minicraft…';
		el.appendChild(title);
		this.app.appendChild(el);
		this.fatalEl = el;
	}

	private hideReconnecting(): void {
		this.reconnectEl?.remove();
		this.reconnectEl = null;
	}

	/** A small toast with a colour dot ("Noah has to go in 2 minutes", "Noah went home"). */
	toast(text: string, color: string): void {
		const t = document.createElement('div');
		t.className = 'mp-toast';
		const dot = document.createElement('span');
		dot.className = 'mp-dot';
		dot.style.background = color;
		const span = document.createElement('span');
		span.className = 'mp-toast-text';
		span.textContent = text;
		t.append(dot, span);
		this.toasts.appendChild(t);
		setTimeout(() => t.remove(), TOAST_MS);
	}

	/** Spec §7.4: the leaver's big 10 … 1. `secondsLeft` outside 1..10 hides it. */
	countdown(secondsLeft: number): void {
		if (secondsLeft >= 1 && secondsLeft <= 10) {
			if (!this.countdownEl) {
				this.countdownEl = document.createElement('div');
				this.countdownEl.id = 'mp-countdown';
				this.app.appendChild(this.countdownEl);
			}
			this.countdownEl.textContent = String(secondsLeft);
		} else if (this.countdownEl) {
			this.countdownEl.remove();
			this.countdownEl = null;
		}
	}
}
