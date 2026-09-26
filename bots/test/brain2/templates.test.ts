import { describe, expect, it } from 'vitest';
import { RAW_LAYERS, TEMPLATES, templateOf } from '../../src/brain2/behaviours/templates.data.js';

const STATUES = ['creeper', 'person', 'heart'];

describe('build templates (spec §6, R10)', () => {
	// Red if a row or layer is ragged (a typo in the data), or w/d/h don't describe the layers.
	it('every template\'s layers are rectangular and match w × d × h', () => {
		expect(TEMPLATES).toHaveLength(12);
		for (const t of TEMPLATES) {
			const layers = RAW_LAYERS[t.name][t.variant];
			expect(layers.length, `${t.name} ${t.variant}`).toBe(t.h);
			for (const rows of layers) {
				expect(rows.length, `${t.name} ${t.variant}`).toBe(t.d);
				for (const r of rows) expect(r.length, `${t.name} ${t.variant} ${r}`).toBe(t.w);
			}
			for (const c of [...t.cells, ...t.doorGaps]) {
				expect(c.x >= 0 && c.x < t.w && c.y >= 0 && c.y < t.h && c.z >= 0 && c.z < t.d).toBe(true);
			}
		}
	});

	// Red if scale2 scales the wrong axis, forgets a layer or a column, or statues are hand-written.
	it('the medium statues are exactly 2× the small ones', () => {
		for (const n of STATUES) {
			const s = templateOf(n, 'small'), m = templateOf(n, 'medium');
			expect([m.w, m.d, m.h]).toEqual([s.w * 2, 1, s.h * 2]);
			const key = (c: { x: number; y: number; z: number; role: string }) => `${c.x},${c.y},${c.z},${c.role}`;
			const want = s.cells.flatMap((c) => [0, 1].flatMap((i) => [0, 1].map((j) => key({ ...c, x: 2 * c.x + i, y: 2 * c.y + j }))));
			expect(m.cells.map(key).sort()).toEqual(want.sort());
		}
	});

	// Red if a house has no way in (a D missing or parsed as a cell).
	it('every house has at least one door gap at ground level + 1', () => {
		for (const v of ['small', 'medium'] as const) {
			const t = templateOf('house', v);
			expect(t.doorGaps.some((g) => g.y === 1)).toBe(true);
			for (const g of t.doorGaps) expect(t.cells.some((c) => c.x === g.x && c.y === g.y && c.z === g.z)).toBe(false);
		}
	});

	// Red if a character maps to an unknown role (undefined) or '.'/'D' become cells.
	it('roles are only wall, roof, floor or accent', () => {
		for (const t of TEMPLATES) for (const c of t.cells) expect(['wall', 'roof', 'floor', 'accent']).toContain(c.role);
	});
});
