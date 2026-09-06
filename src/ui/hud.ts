import type { BlockId } from '../data/blocks.data';
import { BLOCKS } from '../data/blocks.data';
import type { LoadedAtlas } from '../engine/render/atlas';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const SLOT_PX = 48;
const FLY_PIPS = 5;

export class Hud {
	private root: HTMLElement;
	private hotbarEl: HTMLDivElement;
	private slotEls: HTMLDivElement[] = [];
	private miningSvg: SVGSVGElement;
	private miningArc: SVGCircleElement;
	private atlas: LoadedAtlas;
	private flyEl: HTMLDivElement;
	private flyPips: HTMLDivElement[] = [];

	constructor(container: HTMLElement, atlas: LoadedAtlas) {
		this.root = container;
		this.atlas = atlas;

		const crosshair = document.createElement('div');
		crosshair.id = 'hud-crosshair';
		this.root.appendChild(crosshair);

		this.miningSvg = document.createElementNS(SVG_NS, 'svg');
		this.miningSvg.id = 'hud-mining';
		this.miningSvg.setAttribute('viewBox', '0 0 40 40');
		const track = document.createElementNS(SVG_NS, 'circle');
		track.setAttribute('cx', '20');
		track.setAttribute('cy', '20');
		track.setAttribute('r', String(RING_RADIUS));
		track.setAttribute('fill', 'none');
		track.setAttribute('stroke', 'rgba(0, 0, 0, 0.4)');
		track.setAttribute('stroke-width', '3');
		this.miningSvg.appendChild(track);
		this.miningArc = document.createElementNS(SVG_NS, 'circle');
		this.miningArc.setAttribute('cx', '20');
		this.miningArc.setAttribute('cy', '20');
		this.miningArc.setAttribute('r', String(RING_RADIUS));
		this.miningArc.setAttribute('fill', 'none');
		this.miningArc.setAttribute('stroke', 'white');
		this.miningArc.setAttribute('stroke-width', '3');
		this.miningArc.setAttribute('stroke-linecap', 'round');
		this.miningArc.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
		this.miningArc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
		this.miningArc.setAttribute('transform', 'rotate(-90 20 20)');
		this.miningSvg.appendChild(this.miningArc);
		this.root.appendChild(this.miningSvg);

		this.hotbarEl = document.createElement('div');
		this.hotbarEl.id = 'hud-hotbar';
		this.root.appendChild(this.hotbarEl);

		this.flyEl = document.createElement('div');
		this.flyEl.id = 'hud-fly-speed';
		for (let i = 0; i < FLY_PIPS; i++) {
			const pip = document.createElement('div');
			pip.className = 'fly-pip';
			this.flyEl.appendChild(pip);
			this.flyPips.push(pip);
		}
		this.root.appendChild(this.flyEl);
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
		const scale = SLOT_PX / this.atlas.tileSize;
		const bgSize = `${this.atlas.size * scale}px ${this.atlas.size * scale}px`;
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i];
			const def = BLOCKS[id];
			const slot = this.slotEls[i];
			slot.classList.toggle('selected', i === selected);
			slot.title = def ? def.label : '';

			const rect = this.atlas.tileRect(id, 'nz');
			if (rect) {
				slot.style.backgroundImage = `url(${this.atlas.pngUrl})`;
				slot.style.backgroundSize = bgSize;
				slot.style.backgroundPosition = `-${rect.u * scale}px -${rect.v * scale}px`;
			} else {
				slot.style.backgroundImage = '';
			}
		}
	}

	setMiningProgress(progress: number) {
		const clamped = Math.max(0, Math.min(1, progress));
		this.miningSvg.classList.toggle('active', clamped > 0);
		this.miningArc.setAttribute(
			'stroke-dashoffset',
			String(RING_CIRCUMFERENCE * (1 - clamped)),
		);
	}

	setFlySpeed(tier: number | null) {
		this.flyEl.classList.toggle('visible', tier !== null);
		const filled = tier ?? 0;
		for (let i = 0; i < this.flyPips.length; i++) {
			this.flyPips[i].classList.toggle('filled', i < filled);
		}
	}
}
