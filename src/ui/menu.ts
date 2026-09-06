import type { PersistenceAdapter, WorldSummary } from '../persistence/adapter';
import { newWorldId } from '../persistence/uuid';
import { loadOptions } from '../persistence/options';
import { PLAY_BREAK_CHOICES_MIN, PLAY_LIMIT_CHOICES_MIN } from '../data/playtime.data';
import { applyPlaytimeSetting, clearSession, loadSession } from '../persistence/playtime';
import { isStale, phaseOf } from '../game/playtime';

export type MenuAction =
	| { type: 'new'; id: string; seed: number; name: string }
	| { type: 'continue'; id: string; seed: number }
	| { type: 'options' };

export class MainMenu {
	private root: HTMLDivElement;
	private onAction: ((a: MenuAction) => void) | null = null;

	constructor(
		container: HTMLElement,
		private adapter: PersistenceAdapter,
	) {
		this.root = document.createElement('div');
		this.root.id = 'menu-root';
		container.appendChild(this.root);
	}

	show(onAction: (a: MenuAction) => void) {
		this.onAction = onAction;
		this.root.classList.remove('hidden');
		void this.renderHome();
	}

	hide() {
		this.root.classList.add('hidden');
	}

	private async renderHome() {
		this.root.innerHTML = '';
		const card = document.createElement('div');
		card.className = 'menu-card';
		card.innerHTML = `<h1>Minicraft</h1><div class="menu-loading">Loading worlds…</div>`;
		this.root.appendChild(card);
		this.renderPlaytime(card);

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

		card.innerHTML = `<h1>Minicraft</h1>`;

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
		this.renderPlaytime(card);

		const btnOptions = document.createElement('button');
		btnOptions.textContent = 'Options';
		btnOptions.onclick = () => this.onAction?.({ type: 'options' });
		card.appendChild(btnOptions);
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
			label.onclick = () => this.onAction?.({ type: 'continue', id: w.id, seed: w.seed });
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

	/**
	 * Parent controls. Every change and both buttons clear the stored session,
	 * which is the unlock path: re-selecting a dropdown at its current value
	 * fires no change event, so the buttons must exist for that case.
	 */
	private renderPlaytime(card: HTMLElement) {
		const opts = loadOptions();
		const section = document.createElement('div');
		section.className = 'playtime-section';

		const h = document.createElement('div');
		h.className = 'menu-section';
		h.textContent = 'Play time';
		section.appendChild(h);

		const limitRow = document.createElement('div');
		limitRow.className = 'playtime-row';
		const limitLabel = document.createElement('label');
		limitLabel.textContent = 'Play for';
		const limit = document.createElement('select');
		limit.id = 'playtime-limit';
		const off = document.createElement('option');
		off.value = '';
		off.textContent = 'Off';
		limit.appendChild(off);
		for (const m of PLAY_LIMIT_CHOICES_MIN) {
			const o = document.createElement('option');
			o.value = String(m);
			o.textContent = `${m} minutes`;
			limit.appendChild(o);
		}
		limit.value = opts.playLimitMin === null ? '' : String(opts.playLimitMin);
		limit.onchange = () => {
			applyPlaytimeSetting({ playLimitMin: limit.value === '' ? null : Number(limit.value) });
			this.rerenderPlaytime(card, section);
		};
		limitLabel.appendChild(document.createElement('br'));
		limitLabel.appendChild(limit);
		limitRow.appendChild(limitLabel);
		section.appendChild(limitRow);

		if (opts.playLimitMin !== null) {
			const breakRow = document.createElement('div');
			breakRow.className = 'playtime-row';
			const breakLabel = document.createElement('label');
			breakLabel.textContent = 'Then break for';
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
			brk.value = opts.playBreakMin === null ? '' : String(opts.playBreakMin);
			brk.onchange = () => {
				applyPlaytimeSetting({ playBreakMin: brk.value === '' ? null : Number(brk.value) });
				this.rerenderPlaytime(card, section);
			};
			breakLabel.appendChild(document.createElement('br'));
			breakLabel.appendChild(brk);
			breakRow.appendChild(breakLabel);
			section.appendChild(breakRow);
		}

		const now = Date.now();
		const session = loadSession();
		if (session && !isStale(session, now)) {
			const phase = phaseOf(session, now);
			if (phase !== 'over') {
				const status = document.createElement('div');
				status.className = 'playtime-status';
				const text = document.createElement('span');
				const btn = document.createElement('button');
				if (phase === 'playing') {
					const left = Math.max(1, Math.ceil((session.limitMs - session.playedMs) / 60_000));
					text.textContent = `${left} minute${left === 1 ? '' : 's'} left`;
					btn.textContent = 'Start fresh';
				} else if (session.breakMs === null) {
					text.textContent = 'Locked — ask a grown-up';
					btn.textContent = 'Unlock';
				} else {
					const left = Math.max(
						1,
						Math.ceil((session.frozenAt! + session.breakMs - now) / 60_000),
					);
					text.textContent = `Break, ${left} minute${left === 1 ? '' : 's'} left`;
					btn.textContent = 'Unlock';
				}
				btn.onclick = () => {
					clearSession();
					this.rerenderPlaytime(card, section);
				};
				status.appendChild(text);
				status.appendChild(btn);
				section.appendChild(status);
			}
		}

		card.appendChild(section);
	}

	private rerenderPlaytime(card: HTMLElement, old: HTMLElement) {
		const marker = document.createElement('div');
		old.replaceWith(marker);
		this.renderPlaytime(card);
		// renderPlaytime appended at the end; move the fresh section to where the old one was.
		marker.replaceWith(card.lastElementChild!);
	}

	private renderNew() {
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
			this.onAction?.({ type: 'new', id: newWorldId(), seed, name });
		};
		card.appendChild(create);
		card.appendChild(back);
		this.root.appendChild(card);
	}
}
