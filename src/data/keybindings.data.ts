export type Action =
	| 'forward'
	| 'back'
	| 'left'
	| 'right'
	| 'jump'
	| 'slot1'
	| 'slot2'
	| 'slot3'
	| 'slot4'
	| 'slot5'
	| 'slot6'
	| 'slot7'
	| 'slot8'
	| 'slot9'
	| 'toggleFly'
	| 'flySpeedUp'
	| 'flySpeedDown'
	| 'ignite'
	| 'pickLightColor'
	| 'inventory';

export const ACTIONS: Action[] = [
	'forward',
	'back',
	'left',
	'right',
	'jump',
	'slot1',
	'slot2',
	'slot3',
	'slot4',
	'slot5',
	'slot6',
	'slot7',
	'slot8',
	'slot9',
	'toggleFly',
	'flySpeedUp',
	'flySpeedDown',
	'ignite',
	'pickLightColor',
	'inventory',
];

export const ACTION_LABEL: Record<Action, string> = {
	forward: 'Move Forward',
	back: 'Move Back',
	left: 'Strafe Left',
	right: 'Strafe Right',
	jump: 'Jump',
	slot1: 'Hotbar 1',
	slot2: 'Hotbar 2',
	slot3: 'Hotbar 3',
	slot4: 'Hotbar 4',
	slot5: 'Hotbar 5',
	slot6: 'Hotbar 6',
	slot7: 'Hotbar 7',
	slot8: 'Hotbar 8',
	slot9: 'Hotbar 9',
	toggleFly: 'Toggle Fly',
	flySpeedUp: 'Fly Faster',
	flySpeedDown: 'Fly Slower',
	ignite: 'Ignite TNT',
	pickLightColor: 'Pick Light Color',
	inventory: 'Open Inventory',
};

export const DEFAULT_KEYBINDINGS: Record<Action, string> = {
	forward: 'KeyW',
	back: 'KeyS',
	left: 'KeyA',
	right: 'KeyD',
	jump: 'Space',
	slot1: 'Digit1',
	slot2: 'Digit2',
	slot3: 'Digit3',
	slot4: 'Digit4',
	slot5: 'Digit5',
	slot6: 'Digit6',
	slot7: 'Digit7',
	slot8: 'Digit8',
	slot9: 'Digit9',
	toggleFly: 'KeyF',
	flySpeedUp: 'Equal',
	flySpeedDown: 'Minus',
	ignite: 'KeyE',
	pickLightColor: 'KeyC',
	inventory: 'KeyI',
};

export type Options = {
	keybindings: Record<Action, string>;
	currentLightColor: string;
	/** Minutes of play per session; null = Off. */
	playLimitMin: number | null;
	/** Minutes of break after the limit; null = until a grown-up unlocks. */
	playBreakMin: number | null;
};
