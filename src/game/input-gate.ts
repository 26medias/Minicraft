import type { Action } from '../data/keybindings.data';

export type GateState = { frozen: boolean; inventoryOpen: boolean; pickerOpen: boolean };

/**
 * Which key events main.ts acts on. Keyup is always processed so the held-key
 * flags stay truthful; keydown is gated by which overlay owns the screen.
 */
export function shouldHandleKey(down: boolean, action: Action, s: GateState): boolean {
	if (!down) return true;
	if (s.frozen) return false;
	if (s.inventoryOpen) return action === 'inventory' || action.startsWith('slot');
	if (s.pickerOpen && action === 'inventory') return false;
	return true;
}
