import type { PersistenceAdapter, WorldSummary } from '../persistence/adapter';
import { newWorldId } from '../persistence/uuid';

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

		let worlds: WorldSummary[] = [];
		let offline = false;
		try {
			worlds = await this.adapter.listWorlds();
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
			warn.textContent = "Can't reach cloud saves. Worlds on this device still work.";
			card.appendChild(warn);
		}

		const cloud = worlds.filter((w) => w.origin === 'cloud');
		const local = worlds.filter((w) => w.origin !== 'cloud');

		this.renderSection(card, 'Worlds', cloud);
		this.renderSection(card, 'On this device', local);

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
