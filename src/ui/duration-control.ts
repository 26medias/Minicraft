import { formatDuration, stepDuration } from '../game/session-policy';

/**
 * The shared play-duration control (spec §8): a big "30 min" or "No limit"
 * between − and + buttons, in 5-minute steps from 10 min up to the parent's
 * maximum `max` (null = No limit, where + goes past 2 h to "No limit").
 */
export class DurationControl {
	readonly el: HTMLDivElement;
	private valueEl: HTMLDivElement;
	private minus: HTMLButtonElement;
	private plus: HTMLButtonElement;

	constructor(
		parent: HTMLElement,
		private value: number | null,
		private max: number | null,
		private onChange: (v: number | null) => void,
	) {
		this.el = document.createElement('div');
		this.el.className = 'duration-control';
		this.minus = document.createElement('button');
		this.minus.className = 'duration-step';
		this.minus.id = 'duration-minus';
		this.minus.textContent = '−';
		this.minus.setAttribute('aria-label', 'Less time');
		this.valueEl = document.createElement('div');
		this.valueEl.className = 'duration-value';
		this.valueEl.id = 'duration-value';
		this.plus = document.createElement('button');
		this.plus.className = 'duration-step';
		this.plus.id = 'duration-plus';
		this.plus.textContent = '+';
		this.plus.setAttribute('aria-label', 'More time');
		this.minus.onclick = () => this.step(-1);
		this.plus.onclick = () => this.step(1);
		this.el.append(this.minus, this.valueEl, this.plus);
		parent.appendChild(this.el);
		this.paint();
	}

	get(): number | null {
		return this.value;
	}

	private step(dir: 1 | -1): void {
		const next = stepDuration(this.value, dir, this.max);
		if (next === this.value) return;
		this.value = next;
		this.paint();
		this.onChange(next);
	}

	private paint(): void {
		this.valueEl.textContent = formatDuration(this.value);
		// Greyed where a press would change nothing.
		this.minus.disabled = stepDuration(this.value, -1, this.max) === this.value;
		this.plus.disabled = stepDuration(this.value, 1, this.max) === this.value;
	}
}
