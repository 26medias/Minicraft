/**
 * Build templates (spec §6, R10): layers bottom-up, rows are z, characters are x. `W` wall, `R` roof,
 * `F` floor, `A` accent, `D` door gap (air, never placed), `.` nothing. The statues are one block deep,
 * and their `medium` is the `small` scaled ×2 in x and y.
 */
export type Role = 'wall' | 'roof' | 'floor' | 'accent';
export interface Template { name: string; variant: 'small' | 'medium'; w: number; d: number; h: number; cells: Array<{ x: number; y: number; z: number; role: Role }>; doorGaps: Array<{ x: number; y: number; z: number }> }

const L = (...rows: string[]) => rows;
const RAW: Record<string, { small: string[][]; medium: string[][] }> = {
	house: {
		small: [
			L('FFFFF', 'FFFFF', 'FFFFF', 'FFFFF', 'FFFFF'),
			L('WWWWW', 'W...W', 'W...W', 'W...W', 'WWDWW'),
			L('WWWWW', 'W...W', 'A...A', 'W...W', 'WWDWW'),
			L('RRRRR', 'RRRRR', 'RRRRR', 'RRRRR', 'RRRRR'),
		],
		medium: [
			L('FFFFFFF', 'FFFFFFF', 'FFFFFFF', 'FFFFFFF', 'FFFFFFF', 'FFFFFFF', 'FFFFFFF'),
			L('WWWWWWW', 'W.....W', 'W.....W', 'W.....W', 'W.....W', 'W.....W', 'WWWDWWW'),
			L('WWWWWWW', 'W.....W', 'W.....W', 'A.....A', 'W.....W', 'W.....W', 'WWWDWWW'),
			L('WWWWWWW', 'W.....W', 'W.....W', 'W.....W', 'W.....W', 'W.....W', 'WWWWWWW'),
			L('RRRRRRR', 'RRRRRRR', 'RRRRRRR', 'RRRRRRR', 'RRRRRRR', 'RRRRRRR', 'RRRRRRR'),
		],
	},
	wall: {
		small: [L('WWWWWWW'), L('WWWWWWW'), L('WWWWWWW')],
		medium: [L('WWWWWWWWWWW'), L('WWWWWWWWWWW'), L('WWWWWWWWWWW'), L('A.A.A.A.A.A')],
	},
	tower: {
		small: [L('FFF', 'FFF', 'FFF'), L('WWW', 'W.W', 'WDW'), L('WWW', 'W.W', 'WDW'), L('WWW', 'W.W', 'WWW'), L('WWW', 'W.W', 'WWW'), L('WWW', 'A.A', 'WWW'), L('WWW', 'W.W', 'WWW'), L('ARA', 'RRR', 'ARA')],
		medium: [
			L('FFFFF', 'FFFFF', 'FFFFF', 'FFFFF', 'FFFFF'),
			L('WWWWW', 'W...W', 'W...W', 'W...W', 'WWDWW'),
			L('WWWWW', 'W...W', 'W...W', 'W...W', 'WWDWW'),
			L('WWWWW', 'W...W', 'W...W', 'W...W', 'WWWWW'),
			L('WWWWW', 'W...W', 'A...A', 'W...W', 'WWWWW'),
			L('WWWWW', 'W...W', 'W...W', 'W...W', 'WWWWW'),
			L('WWWWW', 'W...W', 'W...W', 'W...W', 'WWWWW'),
			L('WWWWW', 'W...W', 'A...A', 'W...W', 'WWWWW'),
			L('RRRRR', 'RRRRR', 'RRRRR', 'RRRRR', 'RRRRR'),
			L('A.A.A', '.....', 'A...A', '.....', 'A.A.A'),
		],
	},
	creeper: { small: [L('W.W'), L('WWW'), L('WWW'), L('WAW'), L('AWA')], medium: [] },
	person: { small: [L('W.W'), L('WWW'), L('AWA'), L('.W.'), L('.A.')], medium: [] },
	heart: { small: [L('..W..'), L('.WWW.'), L('WWWWW'), L('WWWWW'), L('.W.W.')], medium: [] },
};

/** A statue's medium: every layer twice (y ×2), every character twice (x ×2); depth stays 1. */
function scale2(layers: string[][]): string[][] {
	return layers.flatMap((rows) => {
		const wide = rows.map((r) => [...r].map((c) => c + c).join(''));
		return [wide, [...wide]];
	});
}

const ROLE: Record<string, Role> = { W: 'wall', R: 'roof', F: 'floor', A: 'accent' };

function parse(name: string, variant: 'small' | 'medium', layers: string[][]): Template {
	const cells: Template['cells'] = [];
	const doorGaps: Template['doorGaps'] = [];
	layers.forEach((rows, y) => rows.forEach((row, z) => [...row].forEach((ch, x) => {
		if (ch === 'D') doorGaps.push({ x, y, z });
		else if (ch !== '.') cells.push({ x, y, z, role: ROLE[ch] });
	})));
	return { name, variant, w: layers[0][0].length, d: layers[0].length, h: layers.length, cells, doorGaps };
}

export const TEMPLATES: Template[] = Object.entries(RAW).flatMap(([name, r]) => [
	parse(name, 'small', r.small),
	parse(name, 'medium', r.medium.length ? r.medium : scale2(r.small)),
]);

/** The template `name` × `variant`; throws on an unknown name. */
export function templateOf(name: string, variant: 'small' | 'medium'): Template {
	const t = TEMPLATES.find((x) => x.name === name && x.variant === variant);
	if (!t) throw new Error(`no template ${name} ${variant}`);
	return t;
}

/** The raw layers, for the templates test (rectangularity and the ×2 statues). */
export const RAW_LAYERS: Readonly<Record<string, { small: string[][]; medium: string[][] }>> = Object.fromEntries(
	Object.entries(RAW).map(([n, r]) => [n, { small: r.small, medium: r.medium.length ? r.medium : scale2(r.small) }]),
);
