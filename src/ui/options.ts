import { ACTIONS, ACTION_LABEL, DEFAULT_KEYBINDINGS, type Options } from '../data/keybindings.data';
import { loadOptions, saveOptions } from '../persistence/options';

export class OptionsMenu {
	private root: HTMLDivElement;
	private onClose: (() => void) | null = null;
	private current: Options;

	constructor(container: HTMLElement) {
		this.root = document.createElement('div');
		this.root.id = 'menu-root';
		this.root.classList.add('hidden');
		container.appendChild(this.root);
		this.current = loadOptions();
	}

	show(onClose: () => void) {
		this.onClose = onClose;
		this.current = loadOptions();
		this.root.classList.remove('hidden');
		this.render();
	}

	private render() {
		this.root.innerHTML = '';
		const card = document.createElement('div');
		card.className = 'menu-card';
		card.innerHTML = `<h1>Options</h1>`;

		const kidRow = document.createElement('div');
		kidRow.style.margin = '12px 0';
		const kidLabel = document.createElement('label');
		const kidCheck = document.createElement('input');
		kidCheck.type = 'checkbox';
		kidCheck.checked = this.current.kidMode;
		kidCheck.onchange = () => {
			this.current.kidMode = kidCheck.checked;
		};
		kidLabel.appendChild(kidCheck);
		kidLabel.appendChild(document.createTextNode(' Kid mode (basic blocks only)'));
		kidRow.appendChild(kidLabel);
		card.appendChild(kidRow);

		const kb = document.createElement('div');
		kb.innerHTML = '<h2 style="font-size: 16px; margin: 16px 0 4px;">Keybindings</h2>';
		for (const action of ACTIONS) {
			const row = document.createElement('div');
			row.style.display = 'flex';
			row.style.justifyContent = 'space-between';
			row.style.padding = '4px 0';
			const label = document.createElement('span');
			label.textContent = ACTION_LABEL[action];
			const btn = document.createElement('button');
			btn.style.width = '120px';
			btn.textContent = this.current.keybindings[action];
			btn.onclick = () => {
				btn.textContent = 'Press a key…';
				const capture = (e: KeyboardEvent) => {
					e.preventDefault();
					this.current.keybindings[action] = e.code;
					btn.textContent = e.code;
					window.removeEventListener('keydown', capture, true);
				};
				window.addEventListener('keydown', capture, true);
			};
			row.appendChild(label);
			row.appendChild(btn);
			kb.appendChild(row);
		}
		card.appendChild(kb);

		const actions = document.createElement('div');
		actions.style.marginTop = '16px';
		const reset = document.createElement('button');
		reset.textContent = 'Reset Keybindings';
		reset.onclick = () => {
			this.current.keybindings = { ...DEFAULT_KEYBINDINGS };
			this.render();
		};
		const save = document.createElement('button');
		save.textContent = 'Save & Back';
		save.onclick = () => {
			saveOptions(this.current);
			this.root.classList.add('hidden');
			this.onClose?.();
		};
		actions.appendChild(reset);
		actions.appendChild(save);
		card.appendChild(actions);

		this.root.appendChild(card);
	}
}
