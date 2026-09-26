import type { PersistenceAdapter, WorldSummary } from '../persistence/adapter';
import { newWorldId } from '../persistence/uuid';
import { clearSession, loadSession } from '../persistence/playtime';
import { isStale } from '../game/playtime';
import { loadMenuState, saveMenuState, type MenuState } from '../persistence/menu-state';
import {
	newWorldFields, singleModel,
	type CreatedWorld, type MenuAction, type SingleRow,
} from './menu-model';
import { DurationControl } from './duration-control';
import { clearPin, clearPlan, loadPin, loadPlan, newPlanId, savePin, savePlan } from '../persistence/plan';
import {
	formatWhen, nextStartAt, planSentence, planSummary, playStatus,
	type Plan, type PlayStatus, type StatusInput,
} from '../game/plan';
import { isLegacyId, seedFromLegacyId } from '../persistence/uuid';
import { mpApiFromEnv, type MpApi, type MpWorldRow } from '../net/mp-api';
import { loadMpPrefs, saveMpPrefs, type MpPrefs } from '../persistence/mp-prefs';
import { SKINS, skinColor, skinOf, type SkinId } from '../data/skins.data';
import { nameError, nameTakenText, preselect, sortRows, validName, NAME_ERROR } from './mp-menu-model';
import { paintPreview } from './skin-preview';
import logoUrl from '../assets/menu/logo.webp';

export type { MenuAction } from './menu-model';

const BADGE_TEXT: Record<SingleRow['badge'], string> = { cloud: 'Cloud', device: 'This device', new: 'New' };

export const MP_SLEEPING_TEXT = 'The multiplayer server is sleeping. Ask a parent to wake it up.';
/** How often screen 2 refreshes the world list, and how often the sleeping screen retries (spec §8.2). */
const MP_REFRESH_MS = 5_000;
/** sessionStorage keys set by main.ts before a reload (Task I1): a close code's reason, and the world to select. */
export const MP_ERROR_KEY = 'mp:error';
export const MP_PRESELECT_KEY = 'mp:preselect';

/** Reads and deletes a one-shot sessionStorage entry. */
function takeSession(key: string): string | null {
	try {
		const v = sessionStorage.getItem(key);
		if (v !== null) sessionStorage.removeItem(key);
		return v;
	} catch {
		return null;
	}
}

function peekSession(key: string): boolean {
	try {
		return sessionStorage.getItem(key) !== null;
	} catch {
		return false;
	}
}

/**
 * The main menu (spec §8): a home screen with Single Player, Multiplayer and
 * Parents, a line saying where the kid stands under the parent's rules, and
 * Options. Each screen replaces the card's content; Back
 * returns home.
 */
/**
 * The kid's status plaque. The part before " · " is the headline and what follows sits smaller
 * underneath ("All done for today" / "play again tomorrow"); the separator stays in the text so it
 * still reads as one sentence. `play-go` when he can play, `play-wait` when he can't.
 */
function paintPlayLine(el: HTMLElement, st: PlayStatus): void {
	el.replaceChildren();
	el.classList.toggle('hidden', st.line === null);
	el.classList.toggle('play-go', st.canPlay);
	el.classList.toggle('play-wait', !st.canPlay);
	if (st.line === null) return;
	const [head, ...rest] = st.line.split(' · ');
	const part = (className: string, text: string) => {
		const s = document.createElement('span');
		s.className = className;
		s.textContent = text;
		el.appendChild(s);
	};
	part('play-line-head', head);
	if (rest.length > 0) {
		part('play-line-sep', ' · ');
		part('play-line-sub', rest.join(' · '));
	}
}

/** The plan's locked world among the listed rows; a legacy id matches the world adopted from it by seed. */
function findWorld(rows: SingleRow[], id: string): SingleRow | null {
	const exact = rows.find((r) => r.id === id);
	if (exact) return exact;
	if (!isLegacyId(id)) return null;
	const seed = seedFromLegacyId(id);
	return rows.find((r) => r.seed === seed && r.badge === 'device') ?? null;
}

export class MainMenu {
	private root: HTMLDivElement;
	private onAction: ((a: MenuAction) => void) | null = null;
	private refresh: ReturnType<typeof setInterval> | null = null;
	/** Bumped per render so an older, slower world-list fetch cannot paint over a newer screen. */
	private renderGen = 0;
	/** Shown once under the title on the next renderHome, then cleared so the refresh does not repeat it. */
	private notice: string | null = null;
	/** A world made by Create: listed and selected, but saved only once played. */
	private created: CreatedWorld | null = null;
	/** The multiplayer screen's pending refresh or retry (a chained timeout, so two fetches never overlap). */
	private mpTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * `mp` is the multiplayer server's API, null when `VITE_MINICRAFT_MP_URL` is
	 * unset: then the home Multiplayer button is hidden (spec §3).
	 */
	constructor(
		container: HTMLElement,
		private adapter: PersistenceAdapter,
		private mp: MpApi | null = mpApiFromEnv(),
	) {
		this.root = document.createElement('div');
		this.root.id = 'menu-root';
		container.appendChild(this.root);
	}

	show(onAction: (a: MenuAction) => void, notice?: string) {
		this.onAction = onAction;
		this.notice = notice ?? null;
		this.root.classList.remove('hidden');
		// After a multiplayer reload that failed (a 4009, a 4008, a rejoin that timed out), main.ts
		// leaves a reason or a world in sessionStorage: go straight to the Multiplayer screens.
		const mpPending = peekSession(MP_ERROR_KEY) || peekSession(MP_PRESELECT_KEY);
		if (loadPlan().kind !== 'none') this.renderLocked();
		else if (this.mp && mpPending) this.renderMulti();
		else void this.renderHome();
	}

	/** Opens the Multiplayer screens directly (the autojoin failure path, Task I1). */
	showMultiplayer(onAction: (a: MenuAction) => void): void {
		this.onAction = onAction;
		this.notice = null;
		this.root.classList.remove('hidden');
		if (loadPlan().kind !== 'none') this.renderLocked();
		else if (this.mp) this.renderMulti();
		else void this.renderHome();
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
		const card = this.newCard("Noah's Worlds");
		const line = document.createElement('div'); line.className = 'menu-loading'; line.textContent = text; card.appendChild(line);
	}

	private stopRefresh(): void {
		if (this.refresh !== null) clearInterval(this.refresh);
		this.refresh = null;
		if (this.mpTimer !== null) clearTimeout(this.mpTimer);
		this.mpTimer = null;
	}

	/** Clears the screen and returns a fresh card with its title. */
	private newCard(title: string, screen = 'home'): HTMLDivElement {
		this.stopRefresh();
		this.root.innerHTML = '';
		const logo = document.createElement('img');
		logo.className = 'menu-logo';
		logo.src = logoUrl;
		logo.alt = "Noah's Worlds";
		this.root.appendChild(logo);
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

	/** Back to home; under a plan home is out of reach, so it is the parent's button instead. */
	private backButton(card: HTMLElement): void {
		if (loadPlan().kind !== 'none') {
			this.button(card, 'Parents', 'plan-parents', () => this.renderPlanParents(), 'menu-back');
			return;
		}
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

	private statusInput(): StatusInput {
		const now = Date.now();
		return { plan: loadPlan(now), session: loadSession(), now };
	}

	/** Where the kid stands under the parent's plan, read fresh from storage. */
	private status(): PlayStatus {
		return playStatus(this.statusInput());
	}

	/**
	 * The kid's play-time block on Single Player and Multiplayer: the duration
	 * control when the kid picks, else the status plaque ("25 minutes left"),
	 * repainted every second so Play lights up at the start time without a
	 * reload. Returns the duration getter (null under a plan: main.ts ignores it).
	 */
	private playTime(parent: HTMLElement, st: PlayStatus, onTick?: (st: PlayStatus) => void): () => number | null {
		if (!st.kidPicks) {
			const line = document.createElement('div');
			line.className = 'play-line';
			line.id = 'play-line';
			paintPlayLine(line, st);
			parent.appendChild(line);
			if (onTick) {
				if (this.refresh !== null) clearInterval(this.refresh);
				this.refresh = setInterval(() => {
					const now = this.status();
					paintPlayLine(line, now);
					onTick(now);
				}, 1_000);
			}
			return () => null;
		}
		let duration = loadMenuState(null).duration;
		const dh = document.createElement('div');
		dh.className = 'menu-section';
		dh.textContent = 'Play time';
		parent.appendChild(dh);
		// The duration is shared by Single Player and Multiplayer and remembered in minicraft:v1:menu (spec §8).
		new DurationControl(parent, duration, null, (v) => { duration = v; saveMenuState({ ...loadMenuState(null), duration: v }); });
		return () => duration;
	}

	// --- Home ---------------------------------------------------------------

	private async renderHome() {
		this.renderGen++;
		const card = this.newCard("Noah's Worlds");
		const notice = this.notice;
		// One-shot: the 30 s card refresh and any later render must not repeat it.
		this.notice = null;

		if (notice) {
			const n = document.createElement('div');
			n.className = 'menu-warning';
			n.textContent = notice;
			card.appendChild(n);
		}
		const line = document.createElement('div');
		line.className = 'play-line';
		line.id = 'play-line';
		const paintLine = () => paintPlayLine(line, this.status());
		paintLine();
		card.appendChild(line);
		const home = document.createElement('div');
		home.className = 'home-buttons';
		this.button(home, 'Single Player', 'home-single', () => void this.renderSingle(), 'home-button');
		if (this.mp) this.button(home, 'Multiplayer', 'home-multi', () => this.renderMulti(), 'home-button');
		// Parents is styled as a quieter stone block (menu.css), not grass.
		this.button(home, 'Parents', 'home-parents', () => this.renderParents(), 'home-button');
		card.appendChild(home);
		this.button(card, 'Options', 'home-options', () => this.onAction?.({ type: 'options' }), 'menu-small');
		// "Play at 7:00 AM" turns into "45 minutes left today" without a reload.
		this.refresh = setInterval(paintLine, 30_000);
	}

	/** The PIN prompt: calls `onOk` once the right PIN is entered. */
	private pinGate(parent: HTMLElement, labelText: string, onOk: () => void): void {
		const gate = document.createElement('div');
		gate.className = 'pin-gate';
		const label = document.createElement('label');
		label.className = 'pin-gate-label';
		label.htmlFor = 'pin-input';
		label.textContent = labelText;
		const input = document.createElement('input');
		input.type = 'password';
		input.inputMode = 'numeric';
		input.maxLength = 4;
		input.autocomplete = 'off';
		input.id = 'pin-input';
		input.className = 'pin-code';
		input.placeholder = '••••';
		const go = document.createElement('button');
		go.id = 'pin-go';
		go.textContent = 'Open';
		const err = document.createElement('div');
		err.className = 'menu-error';
		err.id = 'pin-error';
		go.onclick = () => {
			if (input.value === loadPin()) {
				gate.remove();
				onOk();
			} else {
				err.textContent = 'Wrong PIN';
				input.value = '';
				input.focus();
			}
		};
		input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
		// The way out is there when it is needed, and out of the way otherwise.
		const forgot = document.createElement('details');
		forgot.className = 'pin-forgot';
		const summary = document.createElement('summary');
		summary.textContent = 'Forgot the PIN?';
		const how = document.createElement('div');
		how.className = 'menu-hint';
		how.textContent = "On this computer press F12, open Console, type localStorage.removeItem('minicraft:v1:pin') and press Enter. Only the PIN is removed.";
		forgot.append(summary, how);
		gate.append(label, input, err, go, forgot);
		parent.appendChild(gate);
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

		const state: MenuState = loadMenuState(null);
		const loaded = loadPlan();
		const plan = loaded.kind === 'set' && loaded.plan.mode === 'solo' ? loaded.plan : null;
		const locked = loaded.kind !== 'none';
		const all = singleModel({ worlds, created: locked ? null : this.created, state, max: null });
		// Under a plan: only the plan's world when it is locked; no New World, no Delete.
		const lockedRow = plan?.worldId ? findWorld(all.worlds, plan.worldId) : null;
		const m = plan?.worldId ? { ...all, worlds: lockedRow ? [lockedRow] : [], selectedId: lockedRow?.id ?? null } : all;
		let selectedId = m.selectedId;
		let st = this.status();
		const remember = () => saveMenuState({ ...loadMenuState(null), selectedId });

		if (!locked) this.button(card, 'New World', 'single-new', () => this.renderNew());
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
			play.disabled = selectedId === null || !st.canPlay;
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
			if (!locked) row.appendChild(this.deleteButton(w, row));
			list.appendChild(row);
		}
		if (m.worlds.length === 0) {
			const empty = document.createElement('div');
			empty.className = plan?.worldId ? 'menu-warning' : 'menu-hint';
			empty.id = 'single-empty';
			empty.textContent = plan?.worldId ? "Your world isn't here · ask a parent" : locked ? 'No worlds yet · ask a parent' : 'No worlds yet. Press New World.';
			card.appendChild(empty);
		}

		const duration = this.playTime(card, st, (now) => { st = now; paintSelection(); });

		play.id = 'single-play';
		play.className = 'play-big';
		play.textContent = '▶ Play';
		play.onclick = () => {
			const row = m.worlds.find((r) => r.id === selectedId);
			if (!row || !this.status().canPlay) return;
			remember();
			if (row.badge === 'new' && this.created && this.created.id === row.id) {
				const c = this.created;
				this.created = null;
				this.onAction?.({ type: 'new', id: c.id, seed: c.seed, name: c.name, mustMine: c.mustMine, duration: duration() });
			} else {
				this.onAction?.({ type: 'continue', id: row.id, seed: row.seed, name: row.name, duration: duration() });
			}
		};
		card.appendChild(play);
		paintSelection();
		if (!locked) {
			const selected = () => m.worlds.find((r) => r.id === selectedId && r.badge !== 'new') ?? null;
			this.button(card, 'Schedule', 'single-schedule', () => {
				const w = selected();
				this.renderScheduleGate('solo', w ? { id: w.id, name: w.name } : null, null);
			}, 'menu-small');
		}
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
			<div class="new-field">
				<label>Name<br/><input type="text" id="w-name" value="My World" /></label>
			</div>
			<div class="new-field">
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
			saveMenuState({ ...loadMenuState(null), selectedId: this.created.id });
			void this.renderSingle();
		});
		this.button(card, 'Back', 'menu-back', () => void this.renderSingle(), 'menu-back');
	}

	// --- Multiplayer (spec §8.2) --------------------------------------------

	/**
	 * Entry to the Multiplayer screens: screen 1 (name and skin) unless a name
	 * is remembered, else screen 2. A one-shot reason left by main.ts before a
	 * reload (4009, 4008) sends the kid back to screen 1 with the message; a
	 * world left by a failed rejoin is selected on screen 2.
	 */
	private renderMulti(): void {
		if (!this.mp) { void this.renderHome(); return; }
		const prefs = loadMpPrefs();
		const reason = takeSession(MP_ERROR_KEY);
		const pre = takeSession(MP_PRESELECT_KEY);
		let force: string | null = null;
		if (pre !== null) {
			try {
				const v: unknown = JSON.parse(pre);
				const w = typeof v === 'object' && v !== null ? (v as { world?: unknown }).world : null;
				if (typeof w === 'string' && w !== '') force = w;
			} catch {
				// A broken entry only loses the preselect.
			}
		}
		if (reason === 'name_taken') { this.renderMultiName(prefs, nameTakenText(prefs.name ?? 'you')); return; }
		if (reason === 'bad_name') { this.renderMultiName(prefs, NAME_ERROR); return; }
		if (prefs.name === null || validName(prefs.name) === null || prefs.skin === null) { this.renderMultiName(prefs, null); return; }
		const notice = reason === 'unknown_world' ? 'That world is gone. Pick another one.'
			: reason === 'bad_token' ? "The game couldn't get into the multiplayer server. Ask a parent."
				: null;
		this.renderMultiWorlds(force, notice);
	}

	/** Screen 1: the name field and the 6 character buttons, then Next. */
	private renderMultiName(prefs: MpPrefs, message: string | null): void {
		this.renderGen++;
		const card = this.newCard('Multiplayer', 'multi-name');
		let skin: SkinId = prefs.skin ?? SKINS[0].id;

		const label = document.createElement('label');
		label.textContent = 'Your name';
		label.appendChild(document.createElement('br'));
		const input = document.createElement('input');
		input.type = 'text';
		input.id = 'mp-name';
		input.maxLength = 24;
		input.autocomplete = 'off';
		input.value = prefs.name ?? '';
		label.appendChild(input);
		card.appendChild(label);
		const error = document.createElement('div');
		error.className = 'menu-error';
		error.id = 'mp-name-error';
		error.textContent = message ?? '';
		card.appendChild(error);

		const sh = document.createElement('div');
		sh.className = 'menu-section';
		sh.textContent = 'Pick your character';
		card.appendChild(sh);
		const swatches = document.createElement('div');
		swatches.className = 'skin-swatches';
		swatches.id = 'mp-skins';
		const paint = () => {
			for (const el of Array.from(swatches.children) as HTMLElement[]) el.classList.toggle('selected', el.dataset.skin === skin);
		};
		for (const s of SKINS) {
			const b = document.createElement('button');
			b.className = 'skin-swatch';
			b.id = `mp-skin-${s.id}`;
			b.dataset.skin = s.id;
			b.setAttribute('aria-label', s.name);
			const c = document.createElement('canvas');
			c.className = 'skin-front';
			paintPreview(c, s.id, 'front');
			const n = document.createElement('span');
			n.className = 'skin-name';
			n.textContent = s.name;
			b.append(c, n);
			b.onclick = () => { skin = s.id; paint(); };
			swatches.appendChild(b);
		}
		card.appendChild(swatches);
		paint();

		// The reason shows as the kid types; Next stays enabled but refuses a bad name (gate-2 P3).
		input.oninput = () => { error.textContent = input.value === '' ? '' : (nameError(input.value) ?? ''); };
		const next = () => {
			const err = nameError(input.value);
			const name = validName(input.value);
			if (err !== null || name === null) { error.textContent = err ?? NAME_ERROR; input.focus(); return; }
			saveMpPrefs({ ...loadMpPrefs(), name, skin });
			this.renderMultiWorlds(null, null);
		};
		input.onkeydown = (e) => { if (e.key === 'Enter') next(); };
		this.button(card, 'Next', 'mp-next', next, 'play-big');
		this.backButton(card);
		input.focus();
	}

	/**
	 * Screen 2: "Playing as [preview] Noah (Character) [change]", the world list (refreshed every
	 * 5 s, busiest first), New World, the duration and Play. When the list
	 * can't be fetched the server is sleeping: the text, a Retry button, and a
	 * retry every 5 s on its own. `force` is a world to select (just created,
	 * or the world a failed rejoin was for).
	 */
	private renderMultiWorlds(force: string | null, notice: string | null): void {
		const gen = ++this.renderGen;
		const card = this.newCard('Multiplayer', 'multi');
		const api = this.mp!;
		const prefs = loadMpPrefs();
		const name = prefs.name ?? '';
		const skin: SkinId = prefs.skin ?? SKINS[0].id;

		const who = document.createElement('div');
		who.className = 'mp-playing-as';
		who.id = 'mp-playing';
		const dot = document.createElement('canvas');
		dot.className = 'mp-mini';
		paintPreview(dot, skin, 'front');
		const whoText = document.createElement('span');
		whoText.textContent = `Playing as ${name} (${skinOf(skin).name})`;
		const change = document.createElement('button');
		change.id = 'mp-change';
		change.className = 'mp-change';
		change.textContent = 'change';
		change.onclick = () => this.renderMultiName(loadMpPrefs(), null);
		who.append(dot, whoText, change);
		card.appendChild(who);

		if (notice) {
			const n = document.createElement('div');
			n.className = 'menu-warning';
			n.textContent = notice;
			card.appendChild(n);
		}

		const status = document.createElement('div');
		status.className = 'menu-loading';
		status.id = 'mp-status';
		status.textContent = 'Looking for the multiplayer server…';
		card.appendChild(status);
		const sleeping = document.createElement('div');
		sleeping.className = 'mp-sleeping hidden';
		sleeping.id = 'mp-sleeping';
		const sleepText = document.createElement('div');
		sleepText.className = 'menu-warning';
		sleepText.textContent = MP_SLEEPING_TEXT;
		sleeping.appendChild(sleepText);
		card.appendChild(sleeping);

		const worldsBox = document.createElement('div');
		worldsBox.className = 'hidden';
		card.appendChild(worldsBox);
		const loadedPlan = loadPlan();
		const locked = loadedPlan.kind !== 'none';
		const lockedId = loadedPlan.kind === 'set' && loadedPlan.plan.mode === 'mp' ? loadedPlan.plan.worldId : null;
		if (!locked) this.button(worldsBox, 'New World', 'mp-new', () => this.renderMultiNew());
		const list = document.createElement('div');
		list.className = 'world-list';
		list.id = 'mp-worlds';
		worldsBox.appendChild(list);
		const empty = document.createElement('div');
		empty.className = 'menu-hint';
		empty.textContent = 'No worlds yet. Press New World.';
		worldsBox.appendChild(empty);

		let st = this.status();
		const duration = this.playTime(worldsBox, st, (now) => { st = now; play.disabled = selectedId === null || !st.canPlay; });

		let rows: MpWorldRow[] = [];
		let selectedId: string | null = null;
		let listed = false;
		const play = document.createElement('button');
		play.id = 'mp-play';
		play.className = 'play-big';
		play.textContent = '▶ Play';
		play.onclick = () => {
			if (selectedId === null || !rows.some((r) => r.uuid === selectedId) || !this.status().canPlay) return;
			const p = loadMpPrefs();
			saveMpPrefs({ ...p, worldId: selectedId });
			this.onAction?.({ type: 'mp', world: selectedId, name, skin, duration: duration() });
		};
		worldsBox.appendChild(play);

		const paint = () => {
			list.innerHTML = '';
			for (const r of rows) {
				const row = document.createElement('div');
				row.className = 'world-row';
				row.dataset.id = r.uuid;
				row.classList.toggle('selected', r.uuid === selectedId);
				const label = document.createElement('span');
				label.className = 'world-name';
				label.textContent = r.name;
				const badge = document.createElement('span');
				badge.className = 'world-badge';
				badge.textContent = r.mustMine ? 'Mining' : 'Sandbox';
				const people = document.createElement('span');
				people.className = 'mp-online';
				for (const o of r.online) {
					const d = document.createElement('span');
					d.className = 'mp-dot';
					d.style.background = skinColor(o.skin);
					const n = document.createElement('span');
					n.className = 'mp-online-name';
					n.textContent = o.name;
					people.append(d, n);
				}
				row.append(label, people, badge);
				row.onclick = () => {
					selectedId = r.uuid;
					saveMpPrefs({ ...loadMpPrefs(), worldId: r.uuid });
					paint();
				};
				list.appendChild(row);
			}
			empty.classList.toggle('hidden', rows.length > 0);
			if (lockedId !== null) {
				empty.textContent = "Your world isn't here · ask a parent";
				empty.className = rows.length > 0 ? 'hidden' : 'menu-warning';
			}
			play.disabled = selectedId === null || !st.canPlay;
		};

		const showSleeping = () => {
			status.classList.add('hidden');
			worldsBox.classList.add('hidden');
			sleeping.classList.remove('hidden');
			play.disabled = true;
		};

		const load = async () => {
			if (this.mpTimer !== null) clearTimeout(this.mpTimer);
			this.mpTimer = null;
			let fresh: MpWorldRow[] | null = null;
			try {
				fresh = await api.listWorlds();
			} catch {
				fresh = null;
			}
			if (gen !== this.renderGen) return;
			if (fresh === null) {
				showSleeping();
			} else {
				// Under a plan with a locked world, only that world (matched on its uuid).
				rows = sortRows(fresh).filter((r) => lockedId === null || r.uuid === lockedId);
				// First list (or the selection vanished): pick per spec §8.2. After that the kid's click sticks.
				if (!listed || selectedId === null || !rows.some((r) => r.uuid === selectedId)) {
					const wanted = force !== null && rows.some((r) => r.uuid === force) ? force : null;
					selectedId = wanted ?? preselect(rows, loadMpPrefs().worldId);
					force = null;
				}
				listed = true;
				status.classList.add('hidden');
				sleeping.classList.add('hidden');
				worldsBox.classList.remove('hidden');
				paint();
			}
			// Refresh every 5 s; while sleeping this is the automatic retry.
			this.mpTimer = setTimeout(() => void load(), MP_REFRESH_MS);
		};
		this.button(sleeping, 'Retry', 'mp-retry', () => {
			sleeping.classList.add('hidden');
			status.classList.remove('hidden');
			void load();
		});

		if (!locked) {
			this.button(worldsBox, 'Schedule', 'mp-schedule', () => {
				const w = rows.find((r) => r.uuid === selectedId);
				this.renderScheduleGate('mp', w ? { id: w.uuid, name: w.name } : null, null);
			}, 'menu-small');
		}
		this.backButton(card);
		void load();
	}

	/** New World for multiplayer: name, seed (random), Mining/Sandbox. Create posts, then selects it. */
	private renderMultiNew(): void {
		this.renderGen++;
		const card = this.newCard('New World', 'mp-new');
		const form = document.createElement('div');
		form.innerHTML = `
			<div class="new-field">
				<label>Name<br/><input type="text" id="mp-w-name" value="Our World" /></label>
			</div>
			<div class="new-field">
				<label>Seed<br/><input type="number" id="mp-w-seed" value="${Math.floor(Math.random() * 1_000_000)}" /></label>
			</div>
			<label class="menu-check"><input type="checkbox" id="mp-w-must-mine" /> Must mine blocks to build</label>
		`;
		card.appendChild(form);
		const error = document.createElement('div');
		error.className = 'menu-error';
		error.id = 'mp-new-error';
		const create = this.button(card, 'Create', 'mp-w-create', async () => {
			const f = newWorldFields({
				nameRaw: (card.querySelector('#mp-w-name') as HTMLInputElement).value,
				seedRaw: (card.querySelector('#mp-w-seed') as HTMLInputElement).value,
				mustMine: (card.querySelector('#mp-w-must-mine') as HTMLInputElement).checked,
			});
			create.disabled = true;
			error.textContent = '';
			const gen = this.renderGen;
			try {
				const w = await this.mp!.createWorld(f.name, f.seed, f.mustMine);
				if (gen !== this.renderGen) return;
				saveMpPrefs({ ...loadMpPrefs(), worldId: w.uuid });
				this.renderMultiWorlds(w.uuid, null);
			} catch {
				if (gen !== this.renderGen) return;
				create.disabled = false;
				error.textContent = "Couldn't make the world. Try again.";
			}
		});
		card.appendChild(error);
		this.button(card, 'Back', 'menu-back', () => this.renderMultiWorlds(null, null), 'menu-back');
	}

	// --- Parents ------------------------------------------------------------

	// --- Scheduled plan -------------------------------------------------------

	/**
	 * The menu under a plan: the plan's screen and nothing else. Solo: Single
	 * Player (filtered, Play lit only in time). Multiplayer: in its playing time,
	 * the usual name/skin then worlds screens; before and after it, only the
	 * plaque (no name or skin: nothing to do early). Broken: the plaque.
	 */
	private renderLocked(): void {
		const loaded = loadPlan();
		if (loaded.kind === 'none') { void this.renderHome(); return; }
		if (loaded.kind === 'set' && loaded.plan.mode === 'solo') { void this.renderSingle(); return; }
		const st = this.status();
		if (loaded.kind === 'set' && st.canPlay && this.mp) { this.renderMulti(); return; }
		this.renderGen++;
		const card = this.newCard(loaded.kind === 'set' ? 'Multiplayer' : "Noah's Worlds", 'locked');
		if (loaded.kind === 'set' && loaded.plan.worldName) {
			const w = document.createElement('div');
			w.className = 'plan-world';
			w.textContent = loaded.plan.worldName;
			card.appendChild(w);
		}
		const line = document.createElement('div');
		line.className = 'play-line';
		line.id = 'play-line';
		paintPlayLine(line, st);
		card.appendChild(line);
		this.button(card, 'Parents', 'plan-parents', () => this.renderPlanParents(), 'menu-back');
		// At the start time the multiplayer flow opens by itself.
		this.refresh = setInterval(() => {
			const now = this.status();
			if (now.canPlay) { this.renderLocked(); return; }
			paintPlayLine(line, now);
		}, 1_000);
	}

	/** Schedule is for parents: a PIN first (set one, typed twice, if there is none), then the dialog. */
	private renderScheduleGate(mode: 'solo' | 'mp', world: { id: string; name: string } | null, existing: Plan | null): void {
		this.renderGen++;
		const card = this.newCard('Schedule', 'schedule');
		const body = document.createElement('div');
		card.appendChild(body);
		const back = () => (mode === 'solo' ? void this.renderSingle() : this.renderMulti());
		this.button(card, 'Cancel', 'sched-cancel', back, 'menu-back');
		if (loadPin() !== null) {
			this.pinGate(body, 'Type the parent PIN', () => this.renderSchedule(mode, world, existing));
			return;
		}
		const hint = document.createElement('div');
		hint.className = 'menu-hint';
		hint.textContent = 'First, a 4-digit parent PIN, so only parents can change the schedule.';
		body.appendChild(hint);
		this.pinForm(body, () => this.renderSchedule(mode, world, existing));
	}

	/** A New PIN / Type it again form; `onSaved` once a PIN is stored. */
	private pinForm(parent: HTMLElement, onSaved: () => void): void {
		const form = document.createElement('div');
		form.className = 'pin-form';
		const field = (id: string, text: string) => {
			const label = document.createElement('label');
			label.className = 'pin-field';
			label.textContent = text;
			const i = document.createElement('input');
			i.type = 'password';
			i.inputMode = 'numeric';
			i.maxLength = 4;
			i.autocomplete = 'off';
			i.id = id;
			i.placeholder = '••••';
			label.appendChild(i);
			form.appendChild(label);
			return i;
		};
		const pin1 = field('pin-set-input', 'New PIN');
		const pin2 = field('pin-set-again', 'Type it again');
		const msg = document.createElement('div');
		msg.className = 'menu-msg';
		msg.id = 'pin-msg';
		msg.setAttribute('role', 'status');
		const save = document.createElement('button');
		save.id = 'pin-save';
		save.textContent = 'Save PIN';
		const bad = (text: string) => { msg.textContent = text; msg.className = 'menu-msg bad'; };
		save.onclick = () => {
			if (!/^\d{4}$/.test(pin1.value)) { bad('The PIN must be 4 digits.'); return; }
			if (pin1.value !== pin2.value) { bad("The two PINs don't match."); return; }
			if (!savePin(pin1.value)) { bad("Couldn't save. Try again."); return; }
			onSaved();
		};
		form.appendChild(save);
		parent.append(form, msg);
		pin1.focus();
	}

	/**
	 * The Schedule dialog: which world, when, how long. OK reads the plan back
	 * and locks the menu onto it at once, so the parent sees what the kid sees.
	 * `existing`: Change (keeps the plan's id, so played time is kept).
	 */
	private renderSchedule(mode: 'solo' | 'mp', world: { id: string; name: string } | null, existing: Plan | null): void {
		this.renderGen++;
		const card = this.newCard(existing ? 'Change the schedule' : 'Schedule', 'schedule');
		const pad = (n: number) => String(n).padStart(2, '0');
		const lockable = world ?? (existing?.worldId ? { id: existing.worldId, name: existing.worldName ?? 'this world' } : null);
		let onlyWorld = existing ? existing.worldId !== null : lockable !== null;
		let startsNow = false;
		const startDefault = existing ? new Date(existing.startAt) : null;
		let limitMin: number = existing?.limitMin ?? 45;

		const section = (title: string) => {
			const h = document.createElement('div');
			h.className = 'menu-section';
			h.textContent = title;
			card.appendChild(h);
		};
		const choice = (parent: HTMLElement, name: string, id: string, text: string, checked: boolean, onPick: () => void) => {
			const label = document.createElement('label');
			label.className = 'menu-check sched-choice';
			const r = document.createElement('input');
			r.type = 'radio';
			r.name = name;
			r.id = id;
			r.checked = checked;
			r.onchange = () => { onPick(); paint(); };
			label.append(r, ` ${text}`);
			parent.appendChild(label);
			return r;
		};

		section('World');
		if (lockable) choice(card, 'sched-world', 'sched-only', `Only ${lockable.name}`, onlyWorld, () => { onlyWorld = true; });
		choice(card, 'sched-world', 'sched-any', 'Let him choose', !onlyWorld || !lockable, () => { onlyWorld = false; });
		if (!lockable) {
			const h = document.createElement('div');
			h.className = 'menu-hint';
			h.textContent = 'To lock one world, select it in the list first.';
			card.appendChild(h);
		}

		section('Starts');
		choice(card, 'sched-start', 'sched-now', 'Now', false, () => { startsNow = true; });
		const atRow = document.createElement('div');
		atRow.className = 'sched-at';
		const atRadio = choice(atRow, 'sched-start', 'sched-at', 'At', true, () => { startsNow = false; });
		const time = document.createElement('input');
		time.type = 'time';
		time.id = 'sched-time';
		time.value = startDefault ? `${pad(startDefault.getHours())}:${pad(startDefault.getMinutes())}` : '07:00';
		time.oninput = () => { startsNow = false; atRadio.checked = true; paint(); };
		atRow.appendChild(time);
		card.appendChild(atRow);
		const when = document.createElement('div');
		when.className = 'menu-hint';
		when.id = 'sched-when';
		card.appendChild(when);

		section('Play for');
		new DurationControl(card, limitMin, 120, (v) => { limitMin = v ?? 120; paint(); });

		const msg = document.createElement('div');
		msg.className = 'menu-msg';
		msg.id = 'sched-msg';
		const draft = (): Plan | null => {
			const now = Date.now();
			const startAt = startsNow ? now : nextStartAt(time.value, now);
			if (startAt === null) return null;
			const w = onlyWorld && lockable ? lockable : null;
			return {
				id: existing?.id ?? newPlanId(),
				mode,
				worldId: w?.id ?? null,
				worldName: w?.name ?? null,
				startAt,
				limitMin,
				extraMin: existing?.extraMin ?? 0,
				createdAt: existing?.createdAt ?? now,
			};
		};
		const ok = this.button(card, 'OK', 'sched-ok', () => {
			const p = draft();
			if (!p) { msg.textContent = 'Pick a start time.'; msg.className = 'menu-msg bad'; return; }
			if (!savePlan(p)) { msg.textContent = "Couldn't save. Try again."; msg.className = 'menu-msg bad'; return; }
			this.renderLocked();
		});
		card.appendChild(msg);
		const paint = () => {
			const now = Date.now();
			const at = nextStartAt(time.value, now);
			when.textContent = startsNow ? 'Starts right away.' : at === null ? 'Pick a time.' : `That is ${formatWhen(at, now)}.`;
			const p = draft();
			ok.textContent = p ? `Lock: ${planSentence(p, now)}` : 'OK';
		};
		paint();
		this.button(card, 'Cancel', 'sched-cancel', () => {
			if (existing) this.renderPlanParents(true);
			else if (mode === 'solo') void this.renderSingle();
			else this.renderMulti();
		}, 'menu-back');
	}

	/** Parents on the locked screen: how the plan stands, +15 min, Change, End schedule. */
	private renderPlanParents(unlocked = false, flash?: string): void {
		this.renderGen++;
		const card = this.newCard('Parents', 'parents');
		const body = document.createElement('div');
		card.appendChild(body);
		this.button(card, 'Back', 'menu-back', () => this.renderLocked(), 'menu-back');
		const open = () => {
			body.innerHTML = '';
			const loaded = loadPlan();
			const summary = document.createElement('div');
			summary.className = 'parents-today';
			summary.id = 'plan-summary';
			summary.textContent = planSummary(loaded, loadSession(), Date.now());
			body.appendChild(summary);
			const msg = document.createElement('div');
			msg.className = flash ? 'menu-msg ok' : 'menu-msg';
			msg.id = 'plan-msg';
			msg.setAttribute('role', 'status');
			msg.textContent = flash ?? '';
			const row = document.createElement('div');
			row.className = 'parents-actions';
			body.appendChild(row);
			if (loaded.kind === 'set') {
				const p = loaded.plan;
				this.button(row, '+15 min', 'plan-plus', () => {
					if (!savePlan({ ...p, extraMin: p.extraMin + 15 })) { msg.textContent = "Couldn't save. Try again."; msg.className = 'menu-msg bad'; return; }
					this.renderPlanParents(true, '✓ Added 15 minutes.');
				});
				this.button(row, 'Change', 'plan-change', () => {
					this.renderSchedule(p.mode, p.worldId ? { id: p.worldId, name: p.worldName ?? 'this world' } : null, p);
				});
			}
			this.button(row, 'End schedule', 'plan-end', () => {
				if (!clearPlan()) { msg.textContent = "Couldn't save. Try again."; msg.className = 'menu-msg bad'; return; }
				// The plan's session goes with it: free play starts clean.
				clearSession();
				this.notice = 'Schedule ended · free play';
				void this.renderHome();
			});
			body.appendChild(msg);
			const hint = document.createElement('div');
			hint.className = 'menu-hint';
			hint.textContent = 'End schedule unlocks everything. A new schedule is made from Single Player or Multiplayer.';
			body.appendChild(hint);
		};
		// Under a plan a PIN always exists (Schedule sets one first); fail open only if it was lost.
		if (unlocked || loadPin() === null) open();
		else this.pinGate(body, 'Type the parent PIN', open);
	}

	// --- Parents (no plan) ---------------------------------------------------

	private renderParents(): void {
		this.renderGen++;
		const card = this.newCard('Parents', 'parents');
		const body = document.createElement('div');
		card.appendChild(body);
		this.backButton(card);
		if (loadPin() === null) this.renderParentsBody(body);
		else this.pinGate(body, 'Type the parent PIN', () => this.renderParentsBody(body));
	}

	/** Free play's timer (with a Reset), the parent PIN, the multiplayer worlds. Schedules live in Single Player and Multiplayer. */
	private renderParentsBody(body: HTMLElement, flash?: { id: string; text: string }): void {
		body.innerHTML = '';
		const pin = loadPin();
		const rerender = (f?: { id: string; text: string }) => this.renderParentsBody(body, f);
		const panel = (title: string) => {
			const p = document.createElement('section');
			p.className = 'parents-panel';
			const head = document.createElement('div');
			head.className = 'parents-panel-head';
			const h = document.createElement('h2');
			h.textContent = title;
			head.appendChild(h);
			p.appendChild(head);
			body.appendChild(p);
			return p;
		};
		const message = (parent: HTMLElement, id: string) => {
			const m = document.createElement('div');
			m.className = 'menu-msg';
			m.id = id;
			m.setAttribute('role', 'status');
			if (flash?.id === id) { m.textContent = flash.text; m.classList.add('ok'); }
			parent.appendChild(m);
			return m;
		};

		// 1. Play time: how to schedule, and free play's own timer.
		const play = panel('Play time');
		const how = document.createElement('div');
		how.className = 'parents-today';
		how.id = 'parents-how';
		how.textContent = 'To plan a play session, open Single Player or Multiplayer and press Schedule.';
		play.appendChild(how);
		const s = loadSession();
		const live = s && s.planId === undefined && !isStale(s, Date.now()) ? s : null;
		const playMsg = message(play, 'play-msg');
		if (live) {
			const left = Math.max(0, Math.ceil((live.limitMs - live.playedMs) / 60_000));
			const state = document.createElement('div');
			state.className = 'menu-hint';
			state.id = 'free-state';
			state.textContent = live.frozenAt !== null ? "Free play: time's up." : `Free play: ${left} min left on his timer.`;
			play.insertBefore(state, playMsg);
			const row = document.createElement('div');
			row.className = 'parents-actions';
			play.insertBefore(row, playMsg);
			this.button(row, 'Reset play time', 'reset-play', () => {
				clearSession();
				rerender({ id: 'play-msg', text: "✓ His timer is reset. He can pick a new one." });
			});
		}

		// 2. Parent PIN.
		const pinPanel = panel('Parent PIN');
		if (pin === null) {
			const hint = document.createElement('div');
			hint.className = 'menu-hint';
			hint.textContent = 'Set a 4-digit PIN so only parents can open this screen and change schedules.';
			pinPanel.appendChild(hint);
			this.pinForm(pinPanel, () => rerender({ id: 'pin-msg2', text: '✓ PIN saved. It is asked for every time Parents or Schedule is opened.' }));
		} else {
			const state = document.createElement('div');
			state.className = 'menu-hint';
			state.textContent = 'A PIN is set. It is asked for every time Parents or Schedule is opened.';
			pinPanel.appendChild(state);
			const row = document.createElement('div');
			row.className = 'parents-actions';
			pinPanel.appendChild(row);
			this.button(row, 'Change PIN', 'pin-change', () => {
				row.remove();
				this.pinForm(pinPanel, () => rerender({ id: 'pin-msg2', text: '✓ PIN saved.' }));
			});
			const remove = this.button(row, 'Remove PIN', 'pin-reset', () => {
				if (!clearPin()) { pinMsg.textContent = "Couldn't save. Try again."; pinMsg.className = 'menu-msg bad'; return; }
				rerender({ id: 'pin-msg2', text: '✓ PIN removed. Anyone can open Parents now.' });
			});
			remove.classList.add('danger');
		}
		const pinMsg = message(pinPanel, 'pin-msg2');

		// 3. Multiplayer worlds: shown only when the server is reachable (spec §8.3).
		const mp = document.createElement('div');
		mp.id = 'parents-mp-worlds';
		body.appendChild(mp);
		void this.fillParentsMp(mp);
	}

	/** The multiplayer world list with Delete; left empty when there is no server or it can't be reached. */
	private async fillParentsMp(box: HTMLElement): Promise<void> {
		if (!this.mp) return;
		let rows: MpWorldRow[];
		try {
			rows = sortRows(await this.mp.listWorlds());
		} catch {
			return;
		}
		// The body was re-rendered (any Parents button) or the screen left while this was in flight.
		if (!box.isConnected) return;
		box.innerHTML = '';
		const head = document.createElement('div');
		head.className = 'parents-panel-head';
		const h = document.createElement('h2');
		h.textContent = 'Multiplayer worlds';
		head.appendChild(h);
		box.appendChild(head);
		if (rows.length === 0) {
			const none = document.createElement('div');
			none.className = 'menu-hint';
			none.textContent = 'No multiplayer worlds';
			box.appendChild(none);
		}
		for (const r of rows) {
			const row = document.createElement('div');
			row.className = 'world-row';
			row.dataset.id = r.uuid;
			const label = document.createElement('span');
			label.className = 'world-name';
			label.textContent = r.online.length > 0 ? `${r.name} (${r.online.map((o) => o.name).join(', ')})` : r.name;
			const del = document.createElement('button');
			del.className = 'delete';
			del.textContent = 'Delete';
			const msg = document.createElement('div');
			msg.className = 'menu-warning hidden';
			del.onclick = async () => {
				if (!confirm(`Delete "${r.name}" for everyone?`)) return;
				del.disabled = true;
				try {
					const res = await this.mp!.deleteWorld(r.uuid);
					if (res === 'occupied') {
						del.disabled = false;
						msg.textContent = 'Someone is playing in it right now.';
						msg.classList.remove('hidden');
						return;
					}
					await this.fillParentsMp(box);
				} catch {
					del.disabled = false;
					msg.textContent = `Could not delete "${r.name}". It is still there.`;
					msg.classList.remove('hidden');
				}
			};
			row.append(label, del);
			box.append(row, msg);
		}
	}
}
