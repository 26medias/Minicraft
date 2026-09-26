import { describe, expect, it } from 'vitest';
import { blockNames } from 'minicraft-bot';
import { clampParams, IDEAS, makeDesign, MAX_CELLS, MAX_H, MAX_W, presetParams, THEMES, type Idea } from '../../src/architect/designs.js';

const known = new Set(blockNames());
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

describe('architect generators', () => {
	for (const idea of IDEAS) {
		for (const size of idea.sizes) {
			for (const style of idea.styles) {
				it(`${idea.name} ${size.key} ${style.key}: bounded, real blocks, every cell placed after a supporting neighbour`, () => {
					for (const theme of THEMES) {
						const r = makeDesign(idea, theme, size.key, style.key, presetParams(idea, size, style), known);
						expect(r.errors, `${theme.name}`).toEqual([]);
						const d = r.design!;
						expect(d.w).toBeLessThanOrEqual(MAX_W);
						expect(d.d).toBeLessThanOrEqual(MAX_W);
						expect(d.h).toBeLessThanOrEqual(MAX_H);
						expect(d.cells.length).toBeLessThanOrEqual(MAX_CELLS);
						expect(d.cells.length, 'worth building').toBeGreaterThanOrEqual(30);
						// Replay the placement order: each cell is on the ground (y 0) or touches an already placed cell.
						const placed = new Set<string>();
						for (const c of d.cells) {
							const { x, y, z } = c.cell;
							const ok = y === 0 || FACES.some(([dx, dy, dz]) => placed.has(`${x + dx},${y + dy},${z + dz}`));
							expect(ok, `${theme.name} ${x},${y},${z} placed unsupported`).toBe(true);
							placed.add(`${x},${y},${z}`);
							expect(known.has(c.block), c.block).toBe(true);
						}
						expect(placed.size, 'no duplicate cells').toBe(d.cells.length);
					}
				});
			}
		}
		it(`${idea.name}: the three sizes grow`, () => {
			const n = idea.sizes.map((s) => makeDesign(idea, THEMES[0], s.key, idea.styles[0].key, presetParams(idea, s, idea.styles[0]), known).design!.cells.length);
			expect(n[0]).toBeLessThan(n[2]);
		});
		it(`${idea.name}: every value in the parameter ranges still validates (the --llm-params space)`, () => {
			const keys = Object.keys(idea.params);
			const base = presetParams(idea, idea.sizes[0], idea.styles[0]);
			for (const corner of [0, 1]) {
				for (const k of keys) {
					const p = { ...base, [k]: corner ? idea.params[k].max : idea.params[k].min };
					const r = makeDesign(idea, THEMES[1], 'x', 'y', p, known);
					expect(r.errors, `${k}=${p[k]}`).toEqual([]);
				}
				const all = Object.fromEntries(keys.map((k) => [k, corner ? idea.params[k].max : idea.params[k].min]));
				expect(makeDesign(idea, THEMES[1], 'x', 'y', { ...base, ...all }, known).errors, `all ${corner ? 'max' : 'min'}`).toEqual([]);
			}
		});
	}

	it('the validator goes red: a floating cell, an unknown block, an oversize design', () => {
		const bad = (gen: Idea['gen'], colors?: Idea['colors']): string[] => makeDesign({ ...IDEAS[0], gen, colors }, THEMES[0], 's', 't', {}, known).errors;
		expect(bad(() => [{ x: 0, y: 0, z: 0, role: 'main' }, { x: 0, y: 2, z: 0, role: 'main' }]).join()).toMatch(/floating/);
		expect(bad(() => [{ x: 0, y: 0, z: 0, role: 'main' }], () => ({ main: 'not_a_block' })).join()).toMatch(/unknown block/);
		expect(bad(() => Array.from({ length: 21 }, (_, y) => ({ x: 0, y, z: 0, role: 'main' as const }))).join()).toMatch(/height/);
		expect(bad(() => Array.from({ length: 13 }, (_, x) => ({ x, y: 0, z: 0, role: 'main' as const }))).join()).toMatch(/footprint/);
	});

	it('clampParams keeps proposals inside the ranges', () => {
		const idea = IDEAS.find((i) => i.name === 'lighthouse')!;
		const base = presetParams(idea, idea.sizes[0], idea.styles[0]);
		expect(clampParams(idea, { radius: 99, height: -4, stripe: '2', junk: 5 }, base)).toEqual({ ...base, radius: 3, height: 6, stripe: 2 });
	});
});
