import type { Action } from '../data/keybindings.data';
import { CONTROL_ROWS, SLOT_ACTIONS } from '../data/controls.data';
import { buildKeyToAction } from '../game/input-gate';

const NAMED: Record<string, string> = {
	Space: 'Space', Equal: '=', Minus: '-', ShiftLeft: 'Shift', ShiftRight: 'Shift', Escape: 'Esc',
	Backquote: '`', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',',
	Period: '.', Slash: '/', Backslash: '\\', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

/** A key code as the Controls view shows it: 'KeyW' → 'W', 'Equal' → '=', 'Numpad3' → 'Num 3'. */
export function keyText(code: string): string {
	const named = NAMED[code];
	if (named) return named;
	const m = /^(Key|Digit|Numpad)(.+)$/.exec(code);
	if (!m) return code;
	return m[1] === 'Numpad' ? `Num ${m[2]}` : m[2];
}

export type ControlLine = { does: string; keys: string };

/**
 * The rows the Controls view shows for these bindings (spec §3.5). A key is shown only on the action
 * it really triggers (buildKeyToAction: a code bound twice goes to the later action), an unbound key
 * is left out, and a row with no key left is dropped.
 */
export function controlRows(bindings: Record<Action, string>): ControlLine[] {
	const winner = buildKeyToAction(bindings);
	const live = (a: Action): string => {
		const code = bindings[a];
		return code !== '' && winner[code] === a ? code : '';
	};
	const out: ControlLine[] = [];
	for (const r of CONTROL_ROWS) {
		if ('fixed' in r) {
			out.push({ does: r.does, keys: r.fixed });
		} else if ('slots' in r) {
			const codes = SLOT_ACTIONS.map(live);
			const digits = codes.every((c, i) => c === `Digit${i + 1}`);
			const shown = digits ? '1 – 9' : codes.filter((c) => c !== '').map(keyText).join(' ');
			out.push({ does: r.does, keys: shown === '' ? 'Tab' : `${shown}, Tab` });
		} else {
			const codes = r.actions.map(live).filter((c) => c !== '');
			if (codes.length > 0) out.push({ does: r.does, keys: codes.map(keyText).join(r.sep) });
		}
	}
	return out;
}
