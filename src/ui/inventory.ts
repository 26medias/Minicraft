import { AIR, GROUP_ORDER, type BlockDef, type BlockId } from '../data/blocks.data';
import type { Inventory as Counts, PlayerTools } from '../data/crafting.data';
import type { CraftTab, Recipe } from '../data/recipes.data';
import type { LoadedAtlas, TileRect } from '../engine/render/atlas';
import {
	CRAFT_TABS, NO_DOTS, blockTileView, craftCards, craftTabViews, inventoryRows, matchesSearch, pickaxeRow, searchKey, readyRecipeIds, stepDots, tabRecipes,
	type CraftCardView, type CraftDots, type HotbarBadge, type InventoryTab, type Picture,
} from './craft-model';

const TILE_PX = 48;

/** What the I screen shows counts and cards from; pushed by main.ts on every change. */
export type InventoryState = { inv: Counts; tools: PlayerTools; mustMine: boolean };

/**
 * Full-screen I screen with two tabs (spec §9). Blocks: the pickaxe row (click to
 * equip) over today's block grid, with count badges, must-mine dimming and
 * crafted-only blocks hidden at 0. Craft: three icon tabs (toys spec §5), each
 * showing its recipes' cards, with a green dot for "something new is craftable".
 * The strip at the bottom mirrors the HUD hotbar. Built once per game; the tabs,
 * the craft tab and the grid's scroll position survive open/close for the session.
 */
export class Inventory {
	private root: HTMLDivElement;
	private tabButtons = new Map<InventoryTab, HTMLButtonElement>();
	private blocksPanel: HTMLDivElement;
	private craftPanel: HTMLDivElement;
	private craftGrid: HTMLDivElement;
	private craftTabButtons = new Map<CraftTab, HTMLButtonElement>();
	private craftTab: CraftTab = 'pickaxes';
	private dots: CraftDots = NO_DOTS;
	private pickRow: HTMLDivElement;
	private grid: HTMLDivElement;
	private tiles: Array<{ def: BlockDef; el: HTMLButtonElement; badge: HTMLSpanElement }> = [];
	private groupHeads: Array<{ el: HTMLDivElement; members: HTMLButtonElement[] }> = [];
	private search: HTMLInputElement;
	private nameEl: HTMLDivElement;
	private strip: HTMLDivElement;
	private slotEls: HTMLDivElement[] = [];
	private slotBadges: HTMLSpanElement[] = [];
	private labels = new Map<BlockId, string>();
	private tab: InventoryTab = 'blocks';
	private state: InventoryState = { inv: {}, tools: { owned: [0], equipped: 0 }, mustMine: false };
	private cardEls = new Map<string, HTMLDivElement>();
	onPick: ((id: BlockId) => void) | null = null;
	onSelectSlot: ((slot: number) => void) | null = null;
	onClose: (() => void) | null = null;
	/** Returns true when the craft happened (main.ts re-checks canCraft). */
	onCraft: ((recipeId: string) => boolean) | null = null;
	onEquip: ((tier: number) => void) | null = null;

	constructor(container: HTMLElement, private atlas: LoadedAtlas, blocks: BlockDef[], private recipes: readonly Recipe[]) {
		this.root = document.createElement('div');
		this.root.id = 'inventory-root';
		this.root.classList.add('hidden');

		const card = document.createElement('div');
		card.className = 'inventory-card';

		const tabs = document.createElement('div');
		tabs.className = 'inventory-tabs';
		for (const [tab, text] of [['blocks', 'Blocks'], ['craft', 'Craft']] as const) {
			const b = document.createElement('button');
			b.className = 'inventory-tab';
			b.dataset.tab = tab;
			b.textContent = text;
			b.tabIndex = -1;
			b.addEventListener('click', (e) => {
				e.stopPropagation();
				b.blur();
				this.setTab(tab);
			});
			tabs.appendChild(b);
			this.tabButtons.set(tab, b);
		}
		card.appendChild(tabs);

		this.blocksPanel = document.createElement('div');
		this.blocksPanel.className = 'inventory-panel';
		this.pickRow = document.createElement('div');
		this.pickRow.className = 'pickaxe-row';
		this.blocksPanel.appendChild(this.pickRow);

		// Search box: filters the tiles by name. Keys typed here never reach the game (number keys, I, Tab, Shift).
		this.search = document.createElement('input');
		this.search.type = 'text';
		this.search.className = 'inventory-search';
		this.search.placeholder = '🔍 Search blocks';
		this.search.autocomplete = 'off';
		this.search.spellcheck = false;
		this.search.addEventListener('input', () => this.applySearch());
		this.search.addEventListener('keyup', (e) => e.stopPropagation());
		this.search.addEventListener('keydown', (e) => {
			e.stopPropagation();
			const action = searchKey(e.code, this.search.value);
			if (action === 'type') return;
			e.preventDefault();
			if (action === 'clear') {
				this.search.value = '';
				this.applySearch();
			} else {
				this.search.blur();
				this.onClose?.();
			}
		});
		this.blocksPanel.appendChild(this.search);

		for (const b of blocks) this.labels.set(b.id, b.label);
		this.grid = document.createElement('div');
		this.grid.className = 'inventory-grid';
		for (const group of GROUP_ORDER) {
			const rows = inventoryRows(blocks, group); // every ore in the ORE row, variants beside their plain ore
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
				this.paintBlock(tile, b.id, TILE_PX);
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
		this.blocksPanel.appendChild(this.grid);
		card.appendChild(this.blocksPanel);

		this.craftPanel = document.createElement('div');
		this.craftPanel.className = 'inventory-panel craft-panel';
		const craftTabs = document.createElement('div');
		craftTabs.className = 'craft-tabs';
		for (const t of CRAFT_TABS) {
			const b = document.createElement('button');
			b.className = 'craft-tab';
			b.dataset.craftTab = t.tab;
			b.title = t.title;
			b.tabIndex = -1;
			const pic = document.createElement('div');
			pic.className = 'craft-pic';
			this.paintPicture(pic, t.picture, 40);
			const dot = document.createElement('span');
			dot.className = 'craft-dot';
			b.append(pic, dot);
			b.addEventListener('click', (e) => {
				e.stopPropagation();
				b.blur();
				this.setCraftTab(t.tab);
			});
			craftTabs.appendChild(b);
			this.craftTabButtons.set(t.tab, b);
		}
		this.craftGrid = document.createElement('div');
		this.craftGrid.className = 'craft-grid';
		this.craftPanel.append(craftTabs, this.craftGrid);
		card.appendChild(this.craftPanel);

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
		this.setTab('blocks');
	}

	private paintRect(el: HTMLElement, rect: TileRect | null, px: number) {
		if (!rect) {
			el.style.backgroundImage = '';
			return;
		}
		const scale = px / this.atlas.tileSize;
		el.style.backgroundImage = `url(${this.atlas.pngUrl})`;
		el.style.backgroundSize = `${this.atlas.size * scale}px ${this.atlas.size * scale}px`;
		el.style.backgroundPosition = `-${rect.u * scale}px -${rect.v * scale}px`;
	}

	private paintBlock(el: HTMLElement, id: BlockId, px: number) {
		this.paintRect(el, id === AIR ? null : this.atlas.tileRect(id, 'nz'), px);
	}

	private paintPicture(el: HTMLElement, p: Picture, px: number) {
		if (p.kind === 'block') this.paintBlock(el, p.id, px);
		else this.paintRect(el, this.atlas.tileRectByName(p.name), px);
	}

	get isOpen(): boolean {
		return !this.root.classList.contains('hidden');
	}

	get activeTab(): InventoryTab {
		return this.tab;
	}

	/** The icon tab the Craft panel shows (remembered for the session). */
	get activeCraftTab(): CraftTab {
		return this.craftTab;
	}

	open(): void {
		this.root.classList.remove('hidden');
		this.refreshDots();
		this.render();
	}

	close(): void {
		this.root.classList.add('hidden');
	}

	setTab(tab: InventoryTab): void {
		this.tab = tab;
		for (const [t, b] of this.tabButtons) b.classList.toggle('active', t === tab);
		this.blocksPanel.classList.toggle('hidden', tab !== 'blocks');
		this.craftPanel.classList.toggle('hidden', tab !== 'craft');
		this.refreshDots();
		this.render();
	}

	setCraftTab(tab: CraftTab): void {
		this.craftTab = tab;
		this.refreshDots();
		this.render();
	}

	/** New counts/tools/mode. Steps the dot rule always (it must see every change); re-renders only while open. */
	setState(state: InventoryState): void {
		this.state = state;
		this.refreshDots();
		if (this.isOpen) this.render();
	}

	/** One step of the dot rule (toys spec §5): the craft tab counts as viewed only while it is on screen. */
	private refreshDots(): void {
		const viewing = this.isOpen && this.tab === 'craft' ? this.craftTab : null;
		this.dots = stepDots(this.dots, this.recipes, readyRecipeIds(this.recipes, this.state.inv, this.state.tools), viewing);
	}

	/** A short sparkle on a card, after a successful craft (spec §9). */
	sparkle(recipeId: string): void {
		const el = this.cardEls.get(recipeId);
		if (!el) return;
		el.classList.remove('sparkle');
		void el.offsetWidth; // restart the animation
		el.classList.add('sparkle');
	}

	private render(): void {
		if (this.tab === 'blocks') this.renderBlocks();
		else this.renderCraft();
	}

	private renderBlocks(): void {
		const { inv, tools, mustMine } = this.state;
		this.pickRow.replaceChildren();
		for (const p of pickaxeRow(tools)) {
			const b = document.createElement('button');
			b.className = 'pickaxe-button';
			b.classList.toggle('equipped', p.equipped);
			b.dataset.tier = String(p.tier);
			b.title = p.label;
			b.tabIndex = -1;
			this.paintRect(b, this.atlas.tileRectByName(p.icon), 40);
			b.addEventListener('click', (e) => {
				e.stopPropagation();
				b.blur();
				this.onEquip?.(p.tier);
			});
			this.pickRow.appendChild(b);
		}
		for (const t of this.tiles) {
			const v = blockTileView(t.def, inv, mustMine);
			t.el.classList.toggle('hidden', !v.visible);
			t.el.classList.toggle('dimmed', v.dimmed);
			t.badge.textContent = v.badge ?? '';
		}
		this.applySearch();
	}

	/** Hide tiles whose name does not match the search box, and group headings left with no visible tile. */
	private applySearch(): void {
		const q = this.search.value;
		for (const t of this.tiles) t.el.classList.toggle('search-hidden', !matchesSearch(t.def.label, q));
		const shown = (m: HTMLElement) => !m.classList.contains('hidden') && !m.classList.contains('search-hidden');
		for (const g of this.groupHeads) g.el.classList.toggle('hidden', !g.members.some(shown));
	}

	private renderCraft(): void {
		const { inv, tools } = this.state;
		for (const v of craftTabViews(this.recipes, this.dots, this.craftTab)) {
			const b = this.craftTabButtons.get(v.tab)!;
			b.classList.toggle('active', v.active);
			b.classList.toggle('dot', v.dot);
		}
		this.craftGrid.replaceChildren();
		this.cardEls.clear();
		for (const c of craftCards(tabRecipes(this.recipes, this.craftTab), inv, tools)) {
			const el = this.buildCard(c);
			this.cardEls.set(c.recipeId, el);
			this.craftGrid.appendChild(el);
		}
	}

	private buildCard(c: CraftCardView): HTMLDivElement {
		const card = document.createElement('div');
		card.className = `craft-card ${c.state}`;
		card.dataset.recipe = c.recipeId;
		card.dataset.output = c.outputKey;

		const head = document.createElement('div');
		head.className = 'craft-head';
		const pic = document.createElement('div');
		pic.className = 'craft-pic';
		this.paintPicture(pic, c.picture, 40);
		const title = document.createElement('div');
		title.className = 'craft-title';
		title.textContent = c.countLabel ? `${c.title} ${c.countLabel}` : c.title;
		head.append(pic, title);
		card.appendChild(head);

		for (const i of c.ingredients) {
			const row = document.createElement('div');
			row.className = 'craft-ing';
			row.classList.toggle('short', i.short);
			row.title = i.title;
			const icon = document.createElement('div');
			icon.className = 'craft-ing-icon';
			this.paintPicture(icon, i.picture, 24);
			const text = document.createElement('div');
			text.className = 'craft-ing-text';
			text.textContent = `${i.have} / ${i.need}`;
			const bar = document.createElement('div');
			bar.className = 'craft-bar';
			const fill = document.createElement('div');
			fill.className = 'craft-bar-fill';
			fill.style.width = `${Math.round(i.fill * 100)}%`;
			bar.appendChild(fill);
			row.append(icon, text, bar);
			card.appendChild(row);
		}

		if (c.state === 'owned') {
			const done = document.createElement('div');
			done.className = 'craft-owned';
			done.textContent = '✔';
			card.appendChild(done);
		} else {
			const btn = document.createElement('button');
			btn.className = 'craft-button';
			btn.disabled = c.state !== 'ready';
			btn.tabIndex = -1;
			const bpic = document.createElement('div');
			bpic.className = 'craft-pic';
			this.paintPicture(bpic, c.picture, 32);
			btn.appendChild(bpic);
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				btn.blur();
				if (btn.disabled) return;
				if (this.onCraft?.(c.recipeId)) this.sparkle(c.recipeId);
			});
			card.appendChild(btn);
		}
		return card;
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
			this.paintBlock(el, ids[i], TILE_PX);
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
