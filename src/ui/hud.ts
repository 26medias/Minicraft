import type { BlockId } from '../data/blocks.data';
import { BLOCKS } from '../data/blocks.data';

export class Hud {
	private root: HTMLElement;
	private hotbarEl: HTMLDivElement;
	private slotEls: HTMLDivElement[] = [];

	constructor(container: HTMLElement) {
		this.root = container;

		const crosshair = document.createElement('div');
		crosshair.id = 'hud-crosshair';
		this.root.appendChild(crosshair);

		this.hotbarEl = document.createElement('div');
		this.hotbarEl.id = 'hud-hotbar';
		this.root.appendChild(this.hotbarEl);
	}

	setHotbar(ids: BlockId[], selected: number) {
		while (this.slotEls.length < ids.length) {
			const el = document.createElement('div');
			el.className = 'hotbar-slot';
			this.hotbarEl.appendChild(el);
			this.slotEls.push(el);
		}
		while (this.slotEls.length > ids.length) {
			const el = this.slotEls.pop()!;
			el.remove();
		}
		for (let i = 0; i < ids.length; i++) {
			const def = BLOCKS[ids[i]];
			this.slotEls[i].textContent = def ? def.label : '';
			this.slotEls[i].classList.toggle('selected', i === selected);
		}
	}
}
