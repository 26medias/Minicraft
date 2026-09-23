import { ACTIONS, type Action } from '../data/keybindings.data';

export type GateState = { frozen: boolean; inventoryOpen: boolean; pickerOpen: boolean };

/**
 * Which key events main.ts acts on. Keyup is always processed so the held-key
 * flags stay truthful; keydown is gated by which overlay owns the screen.
 */
export function shouldHandleKey(down: boolean, action: Action, s: GateState): boolean {
	if (!down) return true;
	if (s.frozen) return false;
	if (s.inventoryOpen) return action === 'inventory' || action.startsWith('slot');
	// The colour picker is a modal too: neither the I screen nor a pickaxe switch may start behind it.
	if (s.pickerOpen && (action === 'inventory' || action === 'cyclePickaxe')) return false;
	return true;
}
/**
 * e.code → action for the keydown/keyup handlers. `''` is the unbound value (spec §11): it is
 * skipped, because a key the browser cannot identify reports e.code === '' and must do nothing.
 * Two actions on one code: the later one in ACTIONS wins, as main.ts's loop always did.
 */
export function buildKeyToAction(bindings: Record<Action, string>): Record<string, Action> {
	const out: Record<string, Action> = {};
	for (const action of ACTIONS) {
		const code = bindings[action];
		if (code) out[code] = action;
	}
	return out;
}
