import type { ControlLine } from './controls-model';

/**
 * The Esc menu over the running game (pause menu spec §3.3–§3.5): one .menu-card, like the main
 * menu, on a dimmed backdrop. DOM only — main.ts owns pausing, the pointer lock and quitting.
 * A click on the backdrop does nothing; Return to Game is the one way back.
 */
export class PauseMenu {
	private root: HTMLDivElement;
	private title = '';
	private view: 'card' | 'controls' = 'card';
	private quitting = false;
	onResume: (() => void) | null = null;
	onQuit: (() => void) | null = null;

	constructor(container: HTMLElement, private rows: () => ControlLine[]) {
		this.root = document.createElement('div');
		this.root.id = 'pause-root';
		this.root.classList.add('hidden');
		container.appendChild(this.root);
	}

	get isOpen(): boolean {
		return !this.root.classList.contains('hidden');
	}

	get controlsShown(): boolean {
		return this.isOpen && this.view === 'controls';
	}

	open(title: string): void {
		this.title = title;
		this.view = 'card';
		this.render();
		this.root.classList.remove('hidden');
		this.root.querySelector<HTMLButtonElement>('#pause-resume')?.focus();
	}

	close(): void {
		this.root.classList.add('hidden');
		this.view = 'card';
		this.root.innerHTML = '';
	}

	showCard(): void {
		this.view = 'card';
		this.render();
		// Back to Return to Game, so Space/Enter on the card always mean "back to the game".
		this.root.querySelector<HTMLButtonElement>('#pause-resume')?.focus();
	}

	showControls(): void {
		this.view = 'controls';
		this.render();
		this.root.querySelector<HTMLButtonElement>('#pause-back')?.focus();
	}

	setQuitting(): void {
		this.quitting = true;
		this.view = 'card';
		this.render();
	}

	private button(parent: HTMLElement, id: string, text: string, onClick: () => void, className?: string): void {
		const b = document.createElement('button');
		b.id = id;
		b.textContent = text;
		if (className) b.className = className;
		b.disabled = this.quitting;
		b.onclick = onClick;
		parent.appendChild(b);
	}

	private render(): void {
		this.root.innerHTML = '';
		const card = document.createElement('div');
		card.className = 'menu-card';
		const h = document.createElement('h1');
		h.id = 'pause-title';
		card.appendChild(h);
		if (this.view === 'controls') {
			h.textContent = 'Controls';
			for (const r of this.rows()) {
				const line = document.createElement('div');
				line.className = 'controls-row';
				const does = document.createElement('span');
				does.className = 'controls-does';
				does.textContent = r.does;
				const keys = document.createElement('span');
				keys.className = 'controls-keys';
				keys.textContent = r.keys;
				line.append(does, keys);
				card.appendChild(line);
			}
			this.button(card, 'pause-back', 'Back', () => this.showCard(), 'menu-back');
		} else {
			h.textContent = this.title;
			this.button(card, 'pause-resume', 'Return to Game', () => this.onResume?.(), 'home-button');
			this.button(card, 'pause-controls', 'Controls', () => this.showControls());
			this.button(card, 'pause-quit', this.quitting ? 'Saving…' : 'Quit to Menu', () => this.onQuit?.(), 'pause-quit');
			if (!this.quitting) {
				const credits = document.createElement('a');
				credits.id = 'pause-credits';
				credits.className = 'menu-credits';
				credits.href = 'CREDITS.txt'; // relative: next to index.html at any subpath (vite base './')
				credits.target = '_blank';
				credits.rel = 'noopener';
				credits.textContent = 'Texture credits';
				card.appendChild(credits);
			}
		}
		this.root.appendChild(card);
	}
}
