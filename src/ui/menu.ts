import type { PersistenceAdapter, WorldSummary } from '../persistence/adapter';
import { newWorldId } from '../persistence/uuid';
import { loadOptions } from '../persistence/options';
import { PLAY_BREAK_CHOICES_MIN, PLAY_LIMIT_CHOICES_MIN } from '../data/playtime.data';
import { applyPlaytimeSetting, clearSession, loadSession, saveSession } from '../persistence/playtime';
import { phaseOf } from '../game/playtime';
import { menuModel, planSave, type CardModel, type Staged } from './menu-model';
import {
	clearPin, clearSchedule, loadPin, loadSchedule, savePin, saveSchedule,
} from '../persistence/schedule';
import { formatStartTime, resolveWorld, sessionInForce } from '../game/schedule';

export type MenuAction =
	| { type: 'new'; id: string; seed: number; name: string; mustMine: boolean }
	| { type: 'continue'; id: string; seed: number; name: string }
	| { type: 'options' };

export class MainMenu {
	private root: HTMLDivElement;
	private onAction: ((a: MenuAction) => void) | null = null;
	private refresh: ReturnType<typeof setInterval> | null = null;
	private grownUpsOpen = false;
	/** Staged Grown-ups edits; written only by Save. */
	private staged: Staged | null = null;
	/** Bumped per renderHome so an older, slower world-list fetch cannot paint over a newer render. */
	private renderGen = 0;
	/** Shown once under the title on the next renderHome, then cleared so the refresh does not repeat it. */
	private notice: string | null = null;

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
		this.grownUpsOpen = false;
		this.staged = null;
		this.notice = notice ?? null;
		this.root.classList.remove('hidden');
		void this.renderHome();
	}

	hide() {
		this.stopRefresh();
		this.root.classList.add('hidden');
	}

	/** One-line status card shown while main.ts does synchronous work (spawn search). `hide()` removes it. */
	showBuilding(text: string): void {
		this.stopRefresh();
		this.root.classList.remove('hidden');
		this.root.innerHTML = '';
		const card = document.createElement('div');
		card.className = 'menu-card';
		card.innerHTML = `<h1>Minicraft</h1>`;
		const line = document.createElement('div'); line.className = 'menu-loading'; line.textContent = text; card.appendChild(line);
		this.root.appendChild(card);
	}

	private stopRefresh(): void {
		if (this.refresh !== null) clearInterval(this.refresh);
		this.refresh = null;
	}

	private model(worlds: WorldSummary[] | null, offline: boolean) {
		return menuModel({ schedule: loadSchedule(), session: loadSession(), worlds, offline, now: Date.now(), notice: this.notice });
	}

	private async renderHome() {
		this.stopRefresh();
		const gen = ++this.renderGen;
		this.root.innerHTML = '';
		const card = document.createElement('div');
		card.className = 'menu-card';
		card.innerHTML = `<h1>Minicraft</h1><div class="menu-loading">Loading worlds…</div>`;
		this.root.appendChild(card);

		let worlds: WorldSummary[] = [];
		let offline = false;
		try {
			worlds = await this.adapter.listWorlds();
			// Reaching the cloud can fail without listWorlds() throwing: the local
			// list still comes back. Without this the menu shows an empty card and
			// no explanation, which reads as "my worlds are gone".
			offline = (this.adapter as { cloudListFailed?: boolean }).cloudListFailed === true;
		} catch {
			offline = true;
		}
		if (gen !== this.renderGen) return;

		card.innerHTML = `<h1>Minicraft</h1>`;
		const model = this.model(worlds, offline);
		// One-shot: the 30 s card refresh and any later renderHome must not repeat it.
		this.notice = null;
		if (model.notice) {
			const n = document.createElement('div');
			n.className = 'menu-warning';
			n.textContent = model.notice;
			card.appendChild(n);
		}
		if (model.mode === 'card') {
			this.renderCard(card, model, worlds, offline);
		} else {
			const btnNew = document.createElement('button');
			btnNew.textContent = 'New World';
			btnNew.onclick = () => this.renderNew();
			card.appendChild(btnNew);

			if (offline) {
				const warn = document.createElement('div');
				warn.className = 'menu-warning';
				warn.textContent =
					"Can't reach cloud saves right now — your worlds are safe, they just can't be listed. Worlds on this device still work.";
				card.appendChild(warn);
			}

			const cloud = worlds.filter((w) => w.origin === 'cloud');
			const local = worlds.filter((w) => w.origin !== 'cloud');

			this.renderSection(card, 'Worlds', cloud);
			this.renderSection(card, 'On this device', local);
		}
		this.renderGrownUps(card, worlds);

		const btnOptions = document.createElement('button');
		btnOptions.textContent = 'Options';
		btnOptions.onclick = () => this.onAction?.({ type: 'options' });
		card.appendChild(btnOptions);
	}

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
				this.onAction?.({ type: 'continue', id: current.world.id, seed: current.world.seed, name: current.world.name });
			}
		};
		card.append(title, line, play);
		// Only the line and the button change; a full re-render would wipe a PIN
		// being typed in the Grown-ups section below.
		this.stopRefresh();
		this.refresh = setInterval(() => {
			const m = this.model(worlds, offline);
			if (m.mode !== 'card') return;
			current = m;
			line.textContent = m.line;
			play.disabled = !m.playEnabled;
		}, 30_000);
	}

	private renderSection(card: HTMLElement, title: string, worlds: WorldSummary[]) {
		if (worlds.length === 0) return;

		const h = document.createElement('div');
		h.className = 'menu-section';
		h.textContent = title;
		card.appendChild(h);

		for (const w of worlds) {
			const row = document.createElement('div');
			row.className = 'world-row';

			const label = document.createElement('span');
			label.textContent = w.degraded
				? `${w.name} (needs recovery)`
				: `${w.name} (seed ${w.seed})`;
			label.onclick = () => this.onAction?.({ type: 'continue', id: w.id, seed: w.seed, name: w.name });
			row.appendChild(label);

			const del = document.createElement('button');
			del.className = 'delete';
			del.textContent = 'Delete';
			del.onclick = async (e) => {
				e.stopPropagation();
				const where = w.origin === 'cloud' ? 'the cloud' : 'this device';
				if (!confirm(`Delete "${w.name}" from ${where}?`)) return;
				del.disabled = true;
				try {
					await this.adapter.deleteWorld(w.id);
					await this.renderHome();
				} catch {
					// Without this the row would vanish as though the delete worked.
					del.disabled = false;
					const err = document.createElement('div');
					err.className = 'menu-warning';
					err.textContent = `Could not delete "${w.name}". It is still there.`;
					row.appendChild(err);
				}
			};
			row.appendChild(del);
			card.appendChild(row);
		}
	}

	private renderGrownUps(card: HTMLElement, worlds: WorldSummary[]): void {
		const section = document.createElement('div');
		section.className = 'playtime-section';
		const body = document.createElement('div');
		section.appendChild(body);
		card.appendChild(section);

		if (this.grownUpsOpen) {
			const h = document.createElement('div');
			h.className = 'menu-section';
			h.textContent = 'Grown-ups';
			section.insertBefore(h, body);
			this.renderGrownUpsBody(body, worlds);
			return;
		}
		const pin = loadPin();
		const open = document.createElement('button');
		open.id = 'grownups-open';
		open.textContent = 'Grown-ups';
		open.onclick = () => {
			open.remove();
			if (pin === null) {
				this.grownUpsOpen = true;
				this.renderGrownUpsBody(body, worlds);
				return;
			}
			const row = document.createElement('div');
			row.className = 'pin-row';
			const label = document.createElement('label');
			label.textContent = 'Grown-ups PIN ';
			const input = document.createElement('input');
			input.type = 'password';
			input.inputMode = 'numeric';
			input.maxLength = 4;
			input.autocomplete = 'off';
			input.id = 'pin-input';
			const go = document.createElement('button');
			go.textContent = 'Open';
			const err = document.createElement('div');
			err.className = 'menu-error';
			err.id = 'pin-error';
			go.onclick = () => {
				if (input.value === loadPin()) {
					this.grownUpsOpen = true;
					row.remove();
					this.renderGrownUpsBody(body, worlds);
				} else {
					err.textContent = 'Wrong PIN';
					input.value = '';
					input.focus();
				}
			};
			input.onkeydown = (e) => { if (e.key === 'Enter') go.onclick!(e as unknown as MouseEvent); };
			label.appendChild(input);
			row.append(label, go, err);
			body.appendChild(row);
			input.focus();
		};
		body.appendChild(open);
	}

	/**
	 * Staged form: the PIN row is last so the parent lands on the schedule, and
	 * only the World change re-renders the form because only it changes the
	 * form's shape; the break and time rows are toggled with `hidden`.
	 */
	private renderGrownUpsBody(body: HTMLElement, worlds: WorldSummary[]): void {
		body.innerHTML = '';
		const pin = loadPin();
		const loaded = loadSchedule();
		const opts = loadOptions();
		const armed = loaded.kind === 'armed' ? loaded.schedule : null;
		if (this.staged === null) {
			const pad = (n: number) => String(n).padStart(2, '0');
			const startMin = armed?.startMin ?? 420;
			this.staged = {
				// A legacy world is re-listed under its adopted uuid after first play.
				worldId: armed ? (resolveWorld(armed, worlds)?.id ?? armed.worldId) : '',
				limitMin: armed ? armed.limitMin : opts.playLimitMin,
				breakMin: opts.playBreakMin,
				startRaw: `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`,
			};
		}
		const st = this.staged;
		const rerender = () => this.renderGrownUpsBody(body, worlds);
		const error = document.createElement('div');
		error.className = 'menu-error';
		error.id = 'grownups-error';
		const fail = (msg: string) => { error.textContent = msg; };

		// Rows that are shown or hidden by the world/limit choice are built first so
		// the change handlers below can reference them.
		const brk = document.createElement('select');
		brk.id = 'playtime-break';
		const untilUnlock = document.createElement('option');
		untilUnlock.value = '';
		untilUnlock.textContent = 'Until a grown-up unlocks';
		brk.appendChild(untilUnlock);
		for (const m of PLAY_BREAK_CHOICES_MIN) {
			const o = document.createElement('option');
			o.value = String(m);
			o.textContent = `${m} minutes`;
			brk.appendChild(o);
		}
		brk.value = st.breakMin === null ? '' : String(st.breakMin);
		brk.onchange = () => { st.breakMin = brk.value === '' ? null : Number(brk.value); };
		const breakRow = this.labelled('Then break for', brk);

		const time = document.createElement('input');
		time.type = 'time';
		time.id = 'sched-start';
		time.value = st.startRaw;
		time.onchange = () => { st.startRaw = time.value; };
		const timeRow = this.labelled('Not before', time);

		// 1. World
		const worldSel = document.createElement('select');
		worldSel.id = 'sched-world';
		const none = document.createElement('option');
		none.value = '';
		none.textContent = 'No schedule';
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
		worldSel.onchange = () => {
			st.worldId = worldSel.value;
			if (st.worldId !== '' && st.limitMin === null) st.limitMin = 45;
			rerender();
		};
		body.appendChild(this.labelled('Lock to world', worldSel));
		if (pin === null) {
			const hint = document.createElement('div');
			hint.className = 'menu-hint';
			hint.textContent = 'Set a PIN (below) to lock to a world';
			body.appendChild(hint);
		}

		// 2. Play for
		const limit = document.createElement('select');
		limit.id = 'playtime-limit';
		if (st.worldId === '') {
			const off = document.createElement('option');
			off.value = '';
			off.textContent = 'Off';
			limit.appendChild(off);
		}
		for (const m of PLAY_LIMIT_CHOICES_MIN) {
			const o = document.createElement('option');
			o.value = String(m);
			o.textContent = `${m} minutes`;
			limit.appendChild(o);
		}
		limit.value = st.limitMin === null ? '' : String(st.limitMin);
		limit.onchange = () => {
			st.limitMin = limit.value === '' ? null : Number(limit.value);
			breakRow.hidden = !(st.worldId === '' && st.limitMin !== null);
		};
		body.appendChild(this.labelled('Play for', limit));

		// 3. Then break for (no-schedule mode only); 4. Not before (schedule only)
		breakRow.hidden = !(st.worldId === '' && st.limitMin !== null);
		body.appendChild(breakRow);
		timeRow.hidden = st.worldId === '';
		body.appendChild(timeRow);

		// 5. Save / Turn off — writes in fail-closed order: the schedule first,
		// the session only once the schedule write is proven.
		const save = document.createElement('button');
		save.id = 'sched-save';
		save.textContent = 'Save';
		save.onclick = () => {
			st.startRaw = time.value;
			const plan = planSave(st, worlds, Date.now());
			if (plan.kind === 'error') { fail(plan.message); return; }
			if (plan.kind === 'none') {
				if (!clearSchedule()) { fail("Couldn't save — try again"); return; }
				applyPlaytimeSetting({ playLimitMin: plan.limitMin, playBreakMin: plan.breakMin });
			} else {
				if (!saveSchedule(plan.schedule)) { fail("Couldn't save — try again"); return; }
				if (plan.session) saveSession(plan.session); else clearSession();
			}
			this.staged = null;
			void this.renderHome();
		};
		body.appendChild(save);
		if (loaded.kind !== 'none') {
			const off = document.createElement('button');
			off.id = 'sched-off';
			off.textContent = 'Turn off';
			off.onclick = () => {
				if (!clearSchedule()) { fail("Couldn't save — try again"); return; }
				clearSession();
				this.staged = null;
				void this.renderHome();
			};
			body.appendChild(off);
		}

		// 6. Status row + Unlock / Start fresh
		const now = Date.now();
		const session = loadSession();
		if (session && sessionInForce(session, armed, now)) {
			const phase = phaseOf(session, now);
			const status = document.createElement('div');
			status.className = 'playtime-status';
			const text = document.createElement('span');
			const btn = document.createElement('button');
			btn.id = 'playtime-unlock';
			let show = true;
			if (phase === 'playing') {
				const left = Math.max(1, Math.ceil((session.limitMs - session.playedMs) / 60_000));
				text.textContent = `${left} minute${left === 1 ? '' : 's'} left`;
				btn.textContent = 'Start fresh';
			} else if (armed) {
				// Any non-playing in-force session under a schedule is "done for today".
				text.textContent = `Locked until ${formatStartTime(armed.startMin, now)} tomorrow`;
				btn.textContent = 'Unlock · play today';
			} else if (phase === 'over') {
				show = false;
			} else if (session.breakMs === null) {
				text.textContent = 'Locked — ask a grown-up';
				btn.textContent = 'Unlock';
			} else {
				const left = Math.max(1, Math.ceil((session.frozenAt! + session.breakMs - now) / 60_000));
				text.textContent = `Break, ${left} minute${left === 1 ? '' : 's'} left`;
				btn.textContent = 'Unlock';
			}
			if (show) {
				btn.onclick = () => { clearSession(); void this.renderHome(); };
				status.append(text, btn);
				body.appendChild(status);
			}
		}

		// 7. PIN row, last: the parent came for the schedule. With a PIN set, the
		// input is hidden behind "Change PIN" so it does not read as "PIN not saved".
		const pinRow = document.createElement('div');
		pinRow.className = 'pin-row';
		const pinLabel = document.createElement('div');
		pinLabel.className = 'menu-hint';
		pinLabel.textContent = pin === null ? 'Set a PIN so only grown-ups can change this' : 'PIN is set';
		pinRow.appendChild(pinLabel);
		const pinInput = document.createElement('input');
		pinInput.type = 'password';
		pinInput.inputMode = 'numeric';
		pinInput.maxLength = 4;
		pinInput.autocomplete = 'off';
		pinInput.id = 'pin-set-input';
		const setPin = document.createElement('button');
		setPin.textContent = pin === null ? 'Set PIN' : 'Save new PIN';
		setPin.onclick = () => {
			if (!/^\d{4}$/.test(pinInput.value)) { fail('PIN must be 4 digits'); return; }
			if (!savePin(pinInput.value)) { fail("Couldn't save — try again"); return; }
			rerender();
		};
		if (pin === null) {
			pinRow.append(pinInput, setPin);
		} else {
			const change = document.createElement('button');
			change.id = 'pin-change';
			change.textContent = 'Change PIN';
			change.onclick = () => {
				change.replaceWith(pinInput, setPin);
				pinInput.focus();
			};
			const remove = document.createElement('button');
			remove.textContent = 'Remove PIN';
			remove.onclick = () => { if (!clearPin()) { fail("Couldn't save — try again"); return; } rerender(); };
			pinRow.append(change, remove);
		}
		body.appendChild(pinRow);
		body.appendChild(error);
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

	private renderNew() {
		this.stopRefresh();
		this.root.innerHTML = '';
		const card = document.createElement('div');
		card.className = 'menu-card';
		card.innerHTML = `
			<h1>New World</h1>
			<div style="margin: 12px 0;">
				<label>Name<br/><input type="text" id="w-name" value="My World" /></label>
			</div>
			<div style="margin: 12px 0;">
				<label>Seed<br/><input type="number" id="w-seed" value="${Math.floor(Math.random() * 1_000_000)}" /></label>
			</div>
		`;
		const back = document.createElement('button');
		back.textContent = 'Back';
		back.onclick = () => void this.renderHome();

		const create = document.createElement('button');
		create.textContent = 'Create';
		create.onclick = () => {
			const name =
				(card.querySelector('#w-name') as HTMLInputElement).value.trim() || 'My World';
			const seed = Number((card.querySelector('#w-seed') as HTMLInputElement).value) || 0;
			// "Must mine blocks to build" gets its checkbox with the New World screen
			// change (crafting spec §3); until then every new world is unlimited.
			this.onAction?.({ type: 'new', id: newWorldId(), seed, name, mustMine: false });
		};
		card.appendChild(create);
		card.appendChild(back);
		this.root.appendChild(card);
	}
}
