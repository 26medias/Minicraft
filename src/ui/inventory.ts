import { AIR, GROUP_ORDER, type BlockDef, type BlockId } from '../data/blocks.data';
import type { Inventory as Counts, PlayerTools } from '../data/crafting.data';
import type { LoadedAtlas } from '../engine/render/atlas';
import { blockTileView, type HotbarBadge } from './craft-model';

/** What the I screen shows counts from; pushed by main.ts on every change. */
export type InventoryState = { inv: Counts; tools: PlayerTools; mustMine: boolean };

const TILE_PX = 48;

/**
 * Full-screen block picker. Click a tile → onPick(id) for the selected slot;
 * the strip at the bottom mirrors the HUD hotbar. Built once; scroll position
 * survives open/close so "back to the pink ones" is fast.
 */
export class Inventory {
	private root: HTMLDivElement;
	private grid: HTMLDivElement;
	private nameEl: HTMLDivElement;
	private strip: HTMLDivElement;
	private slotEls: HTMLDivElement[] = [];
	private labels = new Map<BlockId, string>();
	private tiles: Array<{ def: BlockDef; el: HTMLButtonElement; badge: HTMLSpanElement }> = [];
	private groupHeads: Array<{ el: HTMLDivElement; members: HTMLButtonElement[] }> = [];
	private slotBadges: HTMLSpanElement[] = [];
	private state: InventoryState = { inv: {}, tools: { owned: [0], equipped: 0 }, mustMine: false };
	onPick: ((id: BlockId) => void) | null = null;
	onSelectSlot: ((slot: number) => void) | null = null;
	onClose: (() => void) | null = null;

	constructor(container: HTMLElement, private atlas: LoadedAtlas, blocks: BlockDef[]) {
		this.root = document.createElement('div');
		this.root.id = 'inventory-root';
		this.root.classList.add('hidden');

		const card = document.createElement('div');
		card.className = 'inventory-card';

		for (const b of blocks) this.labels.set(b.id, b.label);
		this.grid = document.createElement('div');
		this.grid.className = 'inventory-grid';
		for (const group of GROUP_ORDER) {
			const rows = blocks.filter((b) => b.group === group && b.id !== AIR && !b.retired);
			// BASICS keeps hand order (grass, dirt, stone…); generated groups sort by
			// label so a regeneration that appends ids does not land new blocks at the end.
			if (group !== 'basics') rows.sort((a, b) => a.label.localeCompare(b.label));
			if (rows.length === 0) continue;
			const h = document.createElement('div');
			h.className = 'inventory-group';
			h.textContent = group.toUpperCase();
			this.grid.appendChild(h);
			const members: HTMLButtonElement[] = [];
			for (const b of rows) {
				const tile = document.createElement('button');
				tile.className = 'inventory-tile';
				tile.title = b.label;
				tile.dataset.block = b.name;
				tile.tabIndex = -1; // a focused tile would re-fire on Space (his jump reflex)
				this.paintTile(tile, b.id);
				const badge = document.createElement('span');
				badge.className = 'count-badge';
				tile.appendChild(badge);
				tile.addEventListener('mouseenter', () => { this.nameEl.textContent = b.label; });
				tile.addEventListener('click', (e) => {
					e.stopPropagation();
					tile.blur();
					this.onPick?.(b.id);
				});
				this.grid.appendChild(tile);
				this.tiles.push({ def: b, el: tile, badge });
				members.push(tile);
			}
			this.groupHeads.push({ el: h, members });
		}
		card.appendChild(this.grid);

		this.nameEl = document.createElement('div');
		this.nameEl.className = 'inventory-name';
		this.nameEl.textContent = ' ';
		card.appendChild(this.nameEl);

		this.strip = document.createElement('div');
		this.strip.className = 'inventory-strip';
		card.appendChild(this.strip);

		this.root.appendChild(card);
		this.root.addEventListener('click', (e) => e.stopPropagation());
		window.addEventListener('keydown', (e) => {
			if (!this.isOpen || e.code !== 'Escape') return;
			e.preventDefault();
			this.onClose?.();
		});
		container.appendChild(this.root);
	}

	private paintTile(el: HTMLElement, id: BlockId) {
		const rect = id === AIR ? null : this.atlas.tileRect(id, 'nz');
		if (!rect) {
			el.style.backgroundImage = '';
			return;
		}
		const scale = TILE_PX / this.atlas.tileSize;
		el.style.backgroundImage = `url(${this.atlas.pngUrl})`;
		el.style.backgroundSize = `${this.atlas.size * scale}px ${this.atlas.size * scale}px`;
		el.style.backgroundPosition = `-${rect.u * scale}px -${rect.v * scale}px`;
	}

	get isOpen(): boolean {
		return !this.root.classList.contains('hidden');
	}

	open(): void {
		this.root.classList.remove('hidden');
		this.renderBlocks();
	}

	/** New counts/tools/mode. Re-renders only while open; open() renders anyway. */
	setState(state: InventoryState): void {
		this.state = state;
		if (this.isOpen) this.renderBlocks();
	}

	/** Crafted-only blocks hidden at 0, count badges, must-mine dimming (spec §9). */
	private renderBlocks(): void {
		const { inv, mustMine } = this.state;
		for (const t of this.tiles) {
			const v = blockTileView(t.def, inv, mustMine);
			t.el.classList.toggle('hidden', !v.visible);
			t.el.classList.toggle('dimmed', v.dimmed);
			t.badge.textContent = v.badge ?? '';
		}
		for (const g of this.groupHeads) g.el.classList.toggle('hidden', g.members.every((m) => m.classList.contains('hidden')));
	}

	close(): void {
		this.root.classList.add('hidden');
	}

	/** Mirrors Hud.setHotbar; `flashSlot` pulses that slot (every pick, even a repeat). */
	setHotbar(ids: BlockId[], selected: number, flashSlot?: number, badges?: Array<HotbarBadge | null>): void {
		while (this.slotEls.length < ids.length) {
			const i = this.slotEls.length;
			const el = document.createElement('div');
			el.className = 'hotbar-slot';
			el.addEventListener('click', (e) => {
				e.stopPropagation();
				this.onSelectSlot?.(i);
			});
			const badge = document.createElement('span');
			badge.className = 'count-badge';
			el.appendChild(badge);
			this.strip.appendChild(el);
			this.slotEls.push(el);
			this.slotBadges.push(badge);
		}
		for (let i = 0; i < ids.length; i++) {
			const el = this.slotEls[i];
			el.classList.toggle('selected', i === selected);
			el.title = ids[i] === AIR ? '' : (this.labels.get(ids[i]) ?? '');
			this.paintTile(el, ids[i]);
			const b = badges?.[i] ?? null;
			this.slotBadges[i].textContent = b ? b.text : '';
			el.classList.toggle('grey', b?.grey === true);
			if (i === flashSlot) {
				el.classList.remove('flash');
				void el.offsetWidth; // restart the animation
				el.classList.add('flash');
			}
		}
	}
}
