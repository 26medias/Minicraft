import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BLOCK_BY_NAME } from './blocks.data';
import { CRAFTED_ONLY } from './crafting.data';
import { RECIPES } from './recipes.data';
import { CRAFT_TABS } from '../ui/craft-model';

const doc = readFileSync('docs/crafting.md', 'utf8');

describe('docs/crafting.md stays in step with the data (toys spec §7 step 5)', () => {
	it('names every crafted block and every crafted-only block by its label', () => {
		// Catches a recipe row or a crafted-only block added without a line in the docs (the parent reads them to know what exists).
		const names = new Set([...RECIPES.flatMap((r) => (r.output.kind === 'block' ? [r.output.name] : [])), ...CRAFTED_ONLY]);
		for (const n of names) expect(doc, n).toContain(BLOCK_BY_NAME[n].label);
	});

	it('describes the three icon tabs, the green dot, sneak and the Flatten drop', () => {
		// Catches docs that still describe one ten-card Craft tab, and a toy rule the parent cannot find (Shift stops pads;
		// a Flattening TNT can drop him 12 blocks, harmless without fall damage).
		for (const t of CRAFT_TABS) expect(doc).toContain(t.title);
		expect(doc).toMatch(/green dot/i);
		expect(doc).toMatch(/Shift/);
		expect(doc).toMatch(/12 blocks/);
		expect(doc).not.toMatch(/Ten cards, all on screen/);
	});
});
