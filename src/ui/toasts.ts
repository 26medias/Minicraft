/** How long a toast stays up. */
export const TOAST_MS = 6_000;
/** The cheat toast's dot (spec §8). */
export const CHEAT_TOAST_COLOR = '#f5c542';

export type ToastKind = 'mp' | 'cheat';

/**
 * The cap (spec §8): at most one cheat toast; a new one replaces it. Multiplayer toasts are
 * never evicted and never capped. Pure, so the rule is unit-tested without a DOM.
 */
export function nextToasts<T extends { kind: ToastKind }>(current: readonly T[], incoming: T): { keep: T[]; drop: T[] } {
	if (incoming.kind !== 'cheat') return { keep: [...current, incoming], drop: [] };
	return {
		keep: [...current.filter((x) => x.kind !== 'cheat'), incoming],
		drop: current.filter((x) => x.kind === 'cheat'),
	};
}

type Live = { kind: ToastKind; el: HTMLDivElement };

/**
 * The one top-right toast stack of the page, shared by solo and multiplayer (spec §8). The DOM
 * names stay the multiplayer ones: E5 and menu.ts rely on them. `.solo` moves the stack
 * below the #save-status pill.
 */
export class Toasts {
	private host: HTMLDivElement;
	private live: Live[] = [];

	constructor(app: HTMLElement) {
		this.host = document.createElement('div');
		this.host.id = 'mp-toasts';
		app.appendChild(this.host);
	}

	setSolo(solo: boolean): void {
		this.host.classList.toggle('solo', solo);
	}

	show(text: string, color?: string, kind: ToastKind = 'mp'): void {
		const el = document.createElement('div');
		el.className = 'mp-toast';
		if (color !== undefined) {
			const dot = document.createElement('span');
			dot.className = 'mp-dot';
			dot.style.background = color;
			el.appendChild(dot);
		}
		const span = document.createElement('span');
		span.className = 'mp-toast-text';
		span.textContent = text;
		el.appendChild(span);
		const entry: Live = { kind, el };
		const { keep, drop } = nextToasts(this.live, entry);
		for (const d of drop) d.el.remove();
		this.live = keep;
		this.host.appendChild(el);
		setTimeout(() => {
			el.remove();
			this.live = this.live.filter((x) => x !== entry);
		}, TOAST_MS);
	}
}
