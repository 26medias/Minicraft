/**
 * 20 pastel colors for the in-game light picker, arranged as a 5-wide grid.
 * Kid-friendly — no pure primaries. Order is stable; UI renders in index order.
 */
export const LIGHT_PALETTE: readonly string[] = [
	// Row 1 — warm whites / yellows
	'#FFFFFF', '#FFF5E0', '#FFE8A8', '#FFD985', '#FFC870',
	// Row 2 — peach / coral
	'#FFB594', '#FFA585', '#FF9580', '#FF8A99', '#FF99B5',
	// Row 3 — pinks / purples
	'#FFB0D0', '#FCB8E0', '#E8B5F0', '#CFA8F0', '#B0A5F0',
	// Row 4 — blues / greens
	'#A5B8F0', '#9FD0F0', '#A8E5E0', '#A5E5C0', '#B5E59B',
];

export const LIGHT_PALETTE_COLUMNS = 5;
