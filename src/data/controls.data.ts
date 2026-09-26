import type { Action } from './keybindings.data';

/**
 * The pause menu's Controls view (pause menu spec §3.5), in display order. Kid words, not the Options
 * screen's labels. A row shows fixed text, the live keys of its actions, or (slots) the hotbar keys.
 */
export type ControlRow =
	| { does: string; fixed: string }
	| { does: string; actions: Action[]; sep: string }
	| { does: string; slots: true };

export const CONTROL_ROWS: ControlRow[] = [
	{ does: 'Walk', actions: ['forward', 'left', 'back', 'right'], sep: ' ' },
	{ does: 'Jump', actions: ['jump'], sep: ' ' },
	{ does: 'Mine', fixed: 'Hold left click' },
	{ does: 'Build', fixed: 'Right click' },
	{ does: 'Swap a block', fixed: 'Shift + right click' },
	{ does: 'Choose a block', slots: true },
	{ does: 'Inventory', actions: ['inventory'], sep: ' ' },
	{ does: 'Change pickaxe', actions: ['cyclePickaxe'], sep: ' ' },
	{ does: 'Fly', actions: ['toggleFly'], sep: ' ' },
	{ does: 'Fly faster / slower', actions: ['flySpeedUp', 'flySpeedDown'], sep: ' / ' },
	{ does: 'Light TNT', actions: ['ignite'], sep: ' ' },
	{ does: 'Lamp color', actions: ['pickLightColor'], sep: ' ' },
	// Shift only stops the bounce pads here; "Sneak" would promise Minecraft's edge protection.
	{ does: 'Stop bouncing', fixed: 'Hold Shift' },
	{ does: 'Menu', fixed: 'Esc' },
];

export const SLOT_ACTIONS: Action[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9'];
