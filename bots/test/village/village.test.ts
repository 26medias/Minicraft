import { describe, expect, it } from 'vitest';
import { blockNames } from 'minicraft-bot';
import { THEMES, themeBlocks, type Layout } from '../../src/village/themes.data.js';
import { boxOf, gapBetween, layoutLots, lotSpecs, MAX_GAP, MIN_GAP } from '../../src/village/plan.js';

const known = new Set(blockNames());

describe('village lot layout', () => {
	it('theme blocks are real catalog names', () => {
		for (const t of THEMES) for (const b of themeBlocks(t)) expect(known.has(b), `${t.name}: ${b}`).toBe(true);
	});

	it('every layout keeps lots 4–6 blocks apart (nearest neighbour), never closer than 4', () => {
		for (const layout of ['row', 'circle', 'square'] as Layout[]) {
			for (const theme of THEMES) {
				for (const n of [3, 4, 5]) {
					const specs = lotSpecs(n, theme);
					const boxes = layoutLots(layout, specs, { x: 100, z: 200 }).map((o, i) => boxOf(o, specs[i]));
					const tag = `${layout} ${theme.name} n=${n}`;
					expect(boxes.length, tag).toBe(n);
					for (let i = 0; i < n; i++) {
						const gaps = boxes.map((b, j) => (j === i ? Infinity : gapBetween(boxes[i], b)));
						expect(Math.min(...gaps), `${tag} lot ${i} closest`).toBeGreaterThanOrEqual(MIN_GAP);
						expect(Math.min(...gaps), `${tag} lot ${i} nearest`).toBeLessThanOrEqual(MAX_GAP);
					}
				}
			}
		}
	});
});
