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

	/** No break time: the freeze lasts until a new session (spec §8.3); MENU is the way back. */
	freeze(lockedText?: string): void {
		this.hideWarning();
		this.freezeEl.innerHTML = '';
		const title = document.createElement('div');
		title.className = 'playtime-title';
		title.textContent = "TIME'S UP";
		this.freezeEl.appendChild(title);

		const line = document.createElement('div');
		line.className = 'playtime-line';
		line.textContent = lockedText ?? 'ASK A GROWN-UP';
		const menuBtn = document.createElement('button');
		menuBtn.className = 'playtime-button';
		menuBtn.textContent = 'MENU';
		// A frozen tab left open overnight has no other way back to the Play button.
		menuBtn.onclick = () => location.reload();
		this.freezeEl.appendChild(line);
		this.freezeEl.appendChild(menuBtn);
		this.freezeEl.classList.remove('hidden');
	}

	unfreeze(): void {
		this.freezeEl.classList.add('hidden');
		this.freezeEl.innerHTML = '';
	}
}
