/**
 * Two overlays for the play-time limit. The warning band sits in the upper
 * third with pointer-events none so the kid keeps playing through it. The
 * freeze overlay covers everything and swallows clicks so the canvas cannot
 * re-acquire pointer lock.
 */
export class PlaytimeOverlay {
	private warning: HTMLDivElement;
	private warningTimer: ReturnType<typeof setTimeout> | null = null;
	private freezeEl: HTMLDivElement;
	private countdown: HTMLDivElement | null = null;

	constructor(container: HTMLElement) {
		this.warning = document.createElement('div');
		this.warning.id = 'playtime-warning';
		container.appendChild(this.warning);

		this.freezeEl = document.createElement('div');
		this.freezeEl.id = 'playtime-freeze';
		this.freezeEl.classList.add('hidden');
		container.appendChild(this.freezeEl);
	}

	warn(text: string, ms: number): void {
		this.warning.textContent = text;
		this.warning.classList.add('visible');
		if (this.warningTimer) clearTimeout(this.warningTimer);
		this.warningTimer = setTimeout(() => {
			this.warning.classList.remove('visible');
			this.warningTimer = null;
		}, ms);
	}

	private hideWarning(): void {
		if (this.warningTimer) clearTimeout(this.warningTimer);
		this.warningTimer = null;
		this.warning.classList.remove('visible');
	}

	freeze(breakEndsAt: number | null): void {
		this.hideWarning();
		this.freezeEl.innerHTML = '';
		const title = document.createElement('div');
		title.className = 'playtime-title';
		title.textContent = "TIME'S UP";
		this.freezeEl.appendChild(title);

		const line = document.createElement('div');
		line.className = 'playtime-line';
		if (breakEndsAt === null) {
			line.textContent = 'ASK A GROWN-UP';
			this.countdown = null;
		} else {
			this.countdown = line;
		}
		this.freezeEl.appendChild(line);
		this.freezeEl.classList.remove('hidden');
	}

	/** No-op when the overlay has no countdown (no-break freeze) or `ms` is not finite. */
	setBreakRemaining(ms: number): void {
		if (!this.countdown || !Number.isFinite(ms)) return;
		const n = Math.max(1, Math.ceil(ms / 60_000));
		this.countdown.textContent = `PLAY AGAIN IN ${n} MINUTE${n === 1 ? '' : 'S'}`;
	}

	offerPlayAgain(onClick: () => void): void {
		if (!this.countdown) return;
		const btn = document.createElement('button');
		btn.className = 'playtime-button';
		btn.textContent = 'PLAY AGAIN';
		btn.onclick = onClick;
		this.countdown.replaceWith(btn);
		this.countdown = null;
	}

	unfreeze(): void {
		this.freezeEl.classList.add('hidden');
		this.freezeEl.innerHTML = '';
		this.countdown = null;
	}
}
