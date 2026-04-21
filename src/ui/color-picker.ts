import { LIGHT_PALETTE_COLUMNS } from '../data/light-palette.data';

export class ColorPicker {
	private root: HTMLDivElement;
	private card: HTMLDivElement;
	onPick: (color: string) => void = () => {};

	constructor(container: HTMLElement, palette: readonly string[]) {
		this.root = document.createElement('div');
		this.root.id = 'color-picker-root';
		this.root.classList.add('hidden');

		this.card = document.createElement('div');
		this.card.className = 'color-picker-card';
		this.card.style.gridTemplateColumns = `repeat(${LIGHT_PALETTE_COLUMNS}, 48px)`;

		for (const color of palette) {
			const tile = document.createElement('button');
			tile.className = 'color-picker-tile';
			tile.style.background = color;
			tile.title = color;
			tile.addEventListener('click', (e) => {
				e.stopPropagation();
				this.onPick(color);
				this.hide();
			});
			this.card.appendChild(tile);
		}

		this.root.appendChild(this.card);
		// Clicking the backdrop cancels.
		this.root.addEventListener('click', () => this.hide());

		window.addEventListener('keydown', (e) => {
			if (!this.isOpen) return;
			if (e.code === 'Escape') {
				e.preventDefault();
				this.hide();
			}
		});

		container.appendChild(this.root);
	}

	get isOpen(): boolean {
		return !this.root.classList.contains('hidden');
	}

	show(): void {
		this.root.classList.remove('hidden');
		if (document.pointerLockElement) document.exitPointerLock();
	}

	hide(): void {
		this.root.classList.add('hidden');
	}
}
