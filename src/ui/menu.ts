import type { PersistenceAdapter, WorldSummary } from '../persistence/adapter';
import { newWorldId } from '../persistence/uuid';
import { loadOptions } from '../persistence/options';
import { DURATION_CHOICES_MIN } from '../data/playtime.data';
import { applyMaxDuration, clearSession, loadSession, saveSession } from '../persistence/playtime';
import { loadMenuState, saveMenuState, type MenuState } from '../persistence/menu-state';
import { formatDuration } from '../game/session-policy';
import { phaseOf } from '../game/playtime';
import {
	menuModel, newWorldFields, planSave, singleModel,
	type CardModel, type CreatedWorld, type MenuAction, type SingleRow, type Staged,
} from './menu-model';
import { DurationControl } from './duration-control';
import {
	clearPin, clearSchedule, loadPin, loadSchedule, savePin, saveSchedule,
} from '../persistence/schedule';
import { resolveWorld, sessionInForce } from '../game/schedule';

export type { MenuAction } from './menu-model';

const BADGE_TEXT: Record<SingleRow['badge'], string> = { cloud: 'Cloud', device: 'This device', new: 'New' };

/**
 * The main menu (spec §8): a home screen with Single Player, Multiplayer and
 * Parents, or, under a schedule, the scheduled card. Each screen replaces the
 * card's content; Back returns home.
 */
export class MainMenu {
	private root: HTMLDivElement;
	private onAction: ((a: MenuAction) => void) | null = null;
	private refresh: ReturnType<typeof setInterval> | null = null;
	/** Staged schedule edits in Parents; written only by Schedule. */
	private staged: Staged | null = null;
	/** Bumped per render so an older, slower world-list fetch cannot paint over a newer screen. */
	private renderGen = 0;
	/** Shown once under the title on the next renderHome, then cleared so the refresh does not repeat it. */
	private notice: string | null = null;
	/** A world made by Create: listed and selected, but saved only once played. */
	private created: CreatedWorld | null = null;

	constructor(
		container: HTMLElement,
		private adapter: PersistenceAdapter,
	) {
		this.root = document.createElement('div');
		this.root.id = 'menu-root';
		container.appendChild(this.root);
	}

	show(onAction: (a: MenuAction) => void, notice?: string) {
		this.onAction = onAction;
		this.staged = null;
		this.notice = notice ?? null;
		this.root.classList.remove('hidden');
		void this.renderHome();
	}

	hide() {
		this.stopRefresh();
		this.renderGen++;
		this.root.classList.add('hidden');
	}

	/** One-line status card shown while main.ts does synchronous work (spawn search). `hide()` removes it. */
	showBuilding(text: string): void {
		this.stopRefresh();
		this.renderGen++;
		this.root.classList.remove('hidden');
		const card = this.newCard('Minicraft');
		const line = document.createElement('div'); line.className = 'menu-loading'; line.textContent = text; card.appendChild(line);
	}

	private stopRefresh(): void {
		if (this.refresh !== null) clearInterval(this.refresh);
		this.refresh = null;
	}

	/** Clears the screen and returns a fresh card with its title. */
	private newCard(title: string, screen = 'home'): HTMLDivElement {
		this.stopRefresh();
		this.root.innerHTML = '';
		const card = document.createElement('div');
		card.className = 'menu-card';
		card.dataset.screen = screen;
		const h = document.createElement('h1');
		h.textContent = title;
		card.appendChild(h);
		this.root.appendChild(card);
		return card;
	}

	private button(parent: HTMLElement, text: string, id: string | null, onClick: () => void, className?: string): HTMLButtonElement {
		const b = document.createElement('button');
		b.textContent = text;
		if (id) b.id = id;
		if (className) b.className = className;
		b.onclick = onClick;
		parent.appendChild(b);
		return b;
	}

	private backButton(card: HTMLElement): void {
		this.button(card, 'Back', 'menu-back', () => void this.renderHome(), 'menu-back');
	}

	/** The world list, and whether the cloud could not be reached (the local list still comes back). */
	private async fetchWorlds(): Promise<{ worlds: WorldSummary[]; offline: boolean }> {
		try {
			const worlds = await this.adapter.listWorlds();
			// Without this the menu shows an empty list and no explanation, which
			// reads as "my worlds are gone".
			const offline = (this.adapter as { cloudListFailed?: boolean }).cloudListFailed === true;
			return { worlds, offline };
		} catch {
			return { worlds: [], offline: true };
		}
	}

	private cardModel(worlds: WorldSummary[] | null, offline: boolean) {
		return menuModel({ schedule: loadSchedule(), session: loadSession(), worlds, offline, now: Date.now(), notice: this.notice });
	}

	// --- Home ---------------------------------------------------------------

	private async renderHome() {
		const gen = ++this.renderGen;
		const card = this.newCard('Minicraft');
		const notice = this.notice;
		// One-shot: the 30 s card refresh and any later render must not repeat it.
		this.notice = null;

		let model = menuModel({ schedule: loadSchedule(), session: loadSession(), worlds: null, offline: false, now: Date.now(), notice });
		let worlds: WorldSummary[] = [];
		let offline = false;
		if (model.mode === 'card') {
			// The card needs the list to find the scheduled world.
			const loading = document.createElement('div');
			loading.className = 'menu-loading';
			loading.textContent = 'Loading worlds…';
			card.appendChild(loading);
			({ worlds, offline } = await this.fetchWorlds());
			if (gen !== this.renderGen) return;
			loading.remove();
			model = menuModel({ schedule: loadSchedule(), session: loadSession(), worlds, offline, now: Date.now(), notice });
		}
		if (model.notice) {
			const n = document.createElement('div');
			n.className = 'menu-warning';
			n.textContent = model.notice;
			card.appendChild(n);
		}
		if (model.mode === 'card') {
			this.renderCard(card, model, worlds, offline);
		} else {
			const home = document.createElement('div');
			home.className = 'home-buttons';
			this.button(home, 'Single Player', 'home-single', () => void this.renderSingle(), 'home-button');
			this.button(home, 'Multiplayer', 'home-multi', () => this.renderMulti(), 'home-button');
			this.button(home, 'Parents', 'home-parents', () => this.renderParents(), 'home-button');
			card.appendChild(home);
		}
		this.button(card, 'Options', 'home-options', () => this.onAction?.({ type: 'options' }), 'menu-small');
	}

	/** The scheduled card (spec §8): today's card plus a Parents button that cancels the schedule. */
	private renderCard(card: HTMLElement, first: CardModel, worlds: WorldSummary[], offline: boolean): void {
		let current = first;
		const title = document.createElement('div');
		title.className = 'card-world';
		title.textContent = current.title;
		const line = document.createElement('div');
		line.className = 'play-line';
		line.id = 'play-line';
		line.textContent = current.line;
		const play = document.createElement('button');
		play.id = 'play-button';
		play.textContent = '▶ Play';
		play.disabled = !current.playEnabled;
		play.onclick = () => {
			if (current.playEnabled && current.world) {
				// Under a schedule the schedule's own duration applies (main.ts); the kid's choice is not asked.
				this.onAction?.({ type: 'continue', id: current.world.id, seed: current.world.seed, name: current.world.name, duration: null });
			}
		};
		card.append(title, line, play);
		this.renderCardParents(card);
		// Only the line and the button change; a full re-render would wipe a PIN being typed.
		this.stopRefresh();
		this.refresh = setInterval(() => {
			const m = this.cardModel(worlds, offline);
			if (m.mode !== 'card') return;
			current = m;
			line.textContent = m.line;
			play.disabled = !m.playEnabled;
		}, 30_000);
	}

	/** Parents on the card: asks for the PIN when one is set, then cancels the schedule and goes home. */
	private renderCardParents(card: HTMLElement): void {
		const box = document.createElement('div');
		card.appendChild(box);
		const error = document.createElement('div');
		error.className = 'menu-error';
		error.id = 'card-parents-error';
		const cancel = () => {
			if (!clearSchedule()) { error.textContent = "Couldn't save — try again"; return; }
			void this.renderHome();
		};
		const open = this.button(box, 'Parents', 'card-parents', () => {
			if (loadPin() === null) { cancel(); return; }
			open.remove();
			this.pinGate(box, 'Parents PIN — cancels the schedule', cancel);
		});
		box.appendChild(error);
	}

	/** A PIN row: calls `onOk` once the right PIN is entered. */
	private pinGate(parent: HTMLElement, labelText: string, onOk: () => void): void {
		const row = document.createElement('div');
		row.className = 'pin-row';
		const label = document.createElement('label');
		label.textContent = `${labelText} `;
		const input = document.createElement('input');
		input.type = 'password';
		input.inputMode = 'numeric';
		input.maxLength = 4;
		input.autocomplete = 'off';
		input.id = 'pin-input';
		const go = document.createElement('button');
		go.id = 'pin-go';
		go.textContent = 'Open';
		const err = document.createElement('div');
		err.className = 'menu-error';
		err.id = 'pin-error';
		go.onclick = () => {
			if (input.value === loadPin()) {
				row.remove();
				onOk();
			} else {
				err.textContent = 'Wrong PIN';
				input.value = '';
				input.focus();
			}
		};
		input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
		label.appendChild(input);
		row.append(label, go, err);
		parent.appendChild(row);
		input.focus();
	}

	// --- Single Player ------------------------------------------------------

	private async renderSingle() {
		const gen = ++this.renderGen;
		const card = this.newCard('Single Player', 'single');
		const loading = document.createElement('div');
		loading.className = 'menu-loading';
		loading.textContent = 'Loading worlds…';
		card.appendChild(loading);
		const { worlds, offline } = await this.fetchWorlds();
		if (gen !== this.renderGen) return;
		loading.remove();

		const max = loadOptions().maxDurationMin;
		const state: MenuState = loadMenuState(max);
		const m = singleModel({ worlds, created: this.created, state, max });
		let selectedId = m.selectedId;
		let duration = m.duration;
		const remember = () => saveMenuState({ selectedId, duration });

		this.button(card, 'New World', 'single-new', () => this.renderNew());
		if (offline) {
			const warn = document.createElement('div');
			warn.className = 'menu-warning';
			warn.textContent =
				"Can't reach cloud saves right now — your worlds are safe, they just can't be listed. Worlds on this device still work.";
			card.appendChild(warn);
		}

		const list = document.createElement('div');
		list.className = 'world-list';
		list.id = 'single-worlds';
		card.appendChild(list);
		const play = document.createElement('button');
		const paintSelection = () => {
			for (const el of Array.from(list.children) as HTMLElement[]) {
				el.classList.toggle('selected', el.dataset.id === selectedId);
			}
			play.disabled = selectedId === null;
		};
		for (const w of m.worlds) {
			const row = document.createElement('div');
			row.className = 'world-row';
			row.dataset.id = w.id;
			const label = document.createElement('span');
			label.className = 'world-name';
			label.textContent = w.degraded ? `${w.name} (needs recovery)` : w.name;
			const badge = document.createElement('span');
			badge.className = `world-badge badge-${w.badge}`;
			badge.textContent = BADGE_TEXT[w.badge];
			row.append(label, badge);
			row.onclick = () => { selectedId = w.id; remember(); paintSelection(); };
			row.appendChild(this.deleteButton(w, row));
			list.appendChild(row);
		}
		if (m.worlds.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'menu-hint';
			empty.textContent = 'No worlds yet. Press New World.';
			card.appendChild(empty);
		}

		const dh = document.createElement('div');
		dh.className = 'menu-section';
		dh.textContent = 'Play time';
		card.appendChild(dh);
		new DurationControl(card, duration, max, (v) => { duration = v; remember(); });

		play.id = 'single-play';
		play.className = 'play-big';
		play.textContent = '▶ Play';
		play.onclick = () => {
			const row = m.worlds.find((r) => r.id === selectedId);
			if (!row) return;
			remember();
			if (row.badge === 'new' && this.created && this.created.id === row.id) {
				const c = this.created;
				this.created = null;
				this.onAction?.({ type: 'new', id: c.id, seed: c.seed, name: c.name, mustMine: c.mustMine, duration });
			} else {
				this.onAction?.({ type: 'continue', id: row.id, seed: row.seed, name: row.name, duration });
			}
		};
		card.appendChild(play);
		paintSelection();
		this.backButton(card);
	}

	private deleteButton(w: SingleRow, row: HTMLElement): HTMLButtonElement {
		const del = document.createElement('button');
		del.className = 'delete';
		del.textContent = 'Delete';
		del.onclick = async (e) => {
			e.stopPropagation();
			if (w.badge === 'new') {
				// Never saved: dropping it is enough.
				this.created = null;
				void this.renderSingle();
				return;
			}
			const where = w.badge === 'cloud' ? 'the cloud' : 'this device';
			if (!confirm(`Delete "${w.name}" from ${where}?`)) return;
			del.disabled = true;
			try {
				await this.adapter.deleteWorld(w.id);
				await this.renderSingle();
			} catch {
				// Without this the row would vanish as though the delete worked.
				del.disabled = false;
				const err = document.createElement('div');
				err.className = 'menu-warning';
				err.textContent = `Could not delete "${w.name}". It is still there.`;
				row.appendChild(err);
			}
		};
		return del;
	}

	private renderNew() {
		this.renderGen++;
		const card = this.newCard('New World', 'new');
		const form = document.createElement('div');
		form.innerHTML = `
			<div style="margin: 12px 0;">
				<label>Name<br/><input type="text" id="w-name" value="My World" /></label>
			</div>
			<div style="margin: 12px 0;">
				<label>Seed<br/><input type="number" id="w-seed" value="${Math.floor(Math.random() * 1_000_000)}" /></label>
			</div>
			<label class="menu-check"><input type="checkbox" id="w-must-mine" /> Must mine blocks to build</label>
		`;
		card.appendChild(form);
		this.button(card, 'Create', 'w-create', () => {
			const f = newWorldFields({
				nameRaw: (card.querySelector('#w-name') as HTMLInputElement).value,
				seedRaw: (card.querySelector('#w-seed') as HTMLInputElement).value,
				mustMine: (card.querySelector('#w-must-mine') as HTMLInputElement).checked,
			});
			// Create adds the world and selects it (spec §8.1); Play starts it.
			this.created = { id: newWorldId(), seed: f.seed, name: f.name, mustMine: f.mustMine };
			const max = loadOptions().maxDurationMin;
			saveMenuState({ ...loadMenuState(max), selectedId: this.created.id });
			void this.renderSingle();
		});
		this.button(card, 'Back', 'menu-back', () => void this.renderSingle(), 'menu-back');
	}

	// --- Multiplayer (Task P3 replaces this stub) ---------------------------

	private renderMulti(): void {
		this.renderGen++;
		const card = this.newCard('Multiplayer', 'multi');
		const soon = document.createElement('div');
		soon.className = 'menu-loading';
		soon.textContent = 'Coming soon';
		card.appendChild(soon);
		this.backButton(card);
	}

	// --- Parents ------------------------------------------------------------

	private renderParents(): void {
		const gen = ++this.renderGen;
		const card = this.newCard('Parents', 'parents');
		const body = document.createElement('div');
		card.appendChild(body);
		this.backButton(card);
		const open = async () => {
			const loading = document.createElement('div');
			loading.className = 'menu-loading';
			loading.textContent = 'Loading…';
			body.appendChild(loading);
			const { worlds } = await this.fetchWorlds();
			if (gen !== this.renderGen) return;
			this.staged = null;
			this.renderParentsBody(body, worlds);
		};
		if (loadPin() === null) void open();
		else this.pinGate(body, 'Parents PIN', () => void open());
	}

	/**
	 * Schedule, Maximum duration, Reset states and PIN, then the multiplayer
	 * worlds container that Task P3 fills. Each section writes on its own button;
	 * only a PIN change re-renders the body.
	 */
	private renderParentsBody(body: HTMLElement, worlds: WorldSummary[]): void {
		body.innerHTML = '';
		const pin = loadPin();
		const loaded = loadSchedule();
		const armed = loaded.kind === 'armed' ? loaded.schedule : null;
		if (this.staged === null) {
			const pad = (n: number) => String(n).padStart(2, '0');
			const startMin = armed?.startMin ?? 420;
			this.staged = {
				// A legacy world is re-listed under its adopted uuid after first play.
				worldId: armed ? (resolveWorld(armed, worlds)?.id ?? armed.worldId) : '',
				limitMin: armed ? armed.limitMin : 45,
				startRaw: `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`,
			};
		}
		const st = this.staged;
		const rerender = () => this.renderParentsBody(body, worlds);
		const error = document.createElement('div');
		error.className = 'menu-error';
		error.id = 'parents-error';
		const fail = (msg: string) => { error.textContent = msg; };
		const section = (text: string) => {
			const h = document.createElement('div');
			h.className = 'menu-section';
			h.textContent = text;
			body.appendChild(h);
		};

		// 1. Schedule: a solo world, a start time and a duration (not capped by the maximum).
		section('Schedule');
		const worldSel = document.createElement('select');
		worldSel.id = 'sched-world';
		const none = document.createElement('option');
		none.value = '';
		none.textContent = 'Pick a world';
		worldSel.appendChild(none);
		for (const w of worlds) {
			if (w.degraded) continue;
			const o = document.createElement('option');
			o.value = w.id;
			o.textContent = `${w.name} (${w.seed})`;
			worldSel.appendChild(o);
		}
		worldSel.value = worlds.some((w) => w.id === st.worldId) ? st.worldId : '';
		worldSel.disabled = pin === null;
		worldSel.onchange = () => { st.worldId = worldSel.value; };
		body.appendChild(this.labelled('World', worldSel));
		const time = document.createElement('input');
		time.type = 'time';
		time.id = 'sched-start';
		time.value = st.startRaw;
		time.disabled = pin === null;
		time.onchange = () => { st.startRaw = time.value; };
		body.appendChild(this.labelled('Not before', time));
		const schedDur = this.durationSelect('sched-duration', false, st.limitMin);
		schedDur.disabled = pin === null;
		schedDur.onchange = () => { st.limitMin = schedDur.value === '' ? null : Number(schedDur.value); };
		body.appendChild(this.labelled('Play for', schedDur));
		if (pin === null) {
			const hint = document.createElement('div');
			hint.className = 'menu-hint';
			hint.textContent = 'Set a PIN (below) to schedule';
			body.appendChild(hint);
		}
		const save = this.button(body, 'Schedule', 'sched-save', () => {
			st.startRaw = time.value;
			if (st.worldId === '') { fail('Pick a world'); return; }
			const plan = planSave(st, worlds, Date.now());
			if (plan.kind === 'error') { fail(plan.message); return; }
			if (plan.kind !== 'schedule') return;
			// Fail-closed order: the schedule first, the session only once the schedule write is proven.
			if (!saveSchedule(plan.schedule)) { fail("Couldn't save — try again"); return; }
			if (plan.session) saveSession(plan.session); else clearSession();
			this.staged = null;
			void this.renderHome();
		});
		save.disabled = pin === null;

		// 2. Maximum duration: caps the kid's duration control; saved on change.
		section('Maximum play time');
		const maxSel = this.durationSelect('max-duration', true, loadOptions().maxDurationMin);
		const maxSaved = document.createElement('span');
		maxSaved.className = 'menu-hint';
		maxSaved.id = 'max-saved';
		maxSel.onchange = () => {
			applyMaxDuration(maxSel.value === '' ? null : Number(maxSel.value));
			maxSaved.textContent = ' Saved';
		};
		const maxRow = this.labelled('Longest the kids can pick', maxSel);
		maxRow.appendChild(maxSaved);
		body.appendChild(maxRow);

		// 3. Reset states: the schedule and the play session.
		section('Reset');
		const status = document.createElement('div');
		status.className = 'menu-hint';
		status.id = 'playtime-status';
		const now = Date.now();
		const session = loadSession();
		if (session && sessionInForce(session, armed, now)) {
			if (phaseOf(session, now) === 'playing') {
				const left = Math.max(1, Math.ceil((session.limitMs - session.playedMs) / 60_000));
				status.textContent = `Play time: ${left} minute${left === 1 ? '' : 's'} left`;
			} else {
				status.textContent = 'Play time is up (locked)';
			}
		} else {
			status.textContent = 'No play time running';
		}
		body.appendChild(status);
		this.button(body, 'Reset states', 'reset-states', () => {
			if (!clearSchedule()) { fail("Couldn't save — try again"); return; }
			clearSession();
			status.textContent = 'Reset done';
		});

		// 4. PIN: Set / Change with a New PIN field and Save PIN; Reset PIN removes it.
		section('PIN');
		const pinRow = document.createElement('div');
		pinRow.className = 'pin-row';
		const pinLabel = document.createElement('div');
		pinLabel.className = 'menu-hint';
		pinLabel.textContent = pin === null ? 'Set a PIN so only parents can change this' : 'PIN is set';
		pinRow.appendChild(pinLabel);
		const pinInput = document.createElement('input');
		pinInput.type = 'password';
		pinInput.inputMode = 'numeric';
		pinInput.maxLength = 4;
		pinInput.autocomplete = 'off';
		pinInput.id = 'pin-set-input';
		pinInput.placeholder = 'New PIN';
		const savePinBtn = document.createElement('button');
		savePinBtn.id = 'pin-save';
		savePinBtn.textContent = 'Save PIN';
		savePinBtn.onclick = () => {
			if (!/^\d{4}$/.test(pinInput.value)) { fail('PIN must be 4 digits'); return; }
			if (!savePin(pinInput.value)) { fail("Couldn't save — try again"); return; }
			rerender();
		};
		if (pin === null) {
			pinRow.append(pinInput, savePinBtn);
		} else {
			const change = document.createElement('button');
			change.id = 'pin-change';
			change.textContent = 'Change PIN';
			change.onclick = () => {
				change.replaceWith(pinInput, savePinBtn);
				pinInput.focus();
			};
			const remove = document.createElement('button');
			remove.id = 'pin-reset';
			remove.textContent = 'Reset PIN';
			remove.onclick = () => { if (!clearPin()) { fail("Couldn't save — try again"); return; } rerender(); };
			pinRow.append(change, remove);
		}
		body.appendChild(pinRow);
		body.appendChild(error);

		// 5. Multiplayer worlds: Task P3 fills this when the server is reachable.
		const mp = document.createElement('div');
		mp.id = 'parents-mp-worlds';
		body.appendChild(mp);
	}

	/** A select over the 5-minute duration list, with "No limit" first when `withNoLimit`. */
	private durationSelect(id: string, withNoLimit: boolean, value: number | null): HTMLSelectElement {
		const sel = document.createElement('select');
		sel.id = id;
		if (withNoLimit) {
			const off = document.createElement('option');
			off.value = '';
			off.textContent = 'No limit';
			sel.appendChild(off);
		}
		for (const m of DURATION_CHOICES_MIN) {
			const o = document.createElement('option');
			o.value = String(m);
			o.textContent = formatDuration(m);
			sel.appendChild(o);
		}
		sel.value = value === null ? '' : String(value);
		return sel;
	}

	private labelled(text: string, control: HTMLElement): HTMLElement {
		const row = document.createElement('div');
		row.className = 'playtime-row';
		const label = document.createElement('label');
		label.textContent = text;
		label.appendChild(document.createElement('br'));
		label.appendChild(control);
		row.appendChild(label);
		return row;
	}
}
