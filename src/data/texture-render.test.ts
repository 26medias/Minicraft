// src/data/texture-render.test.ts
import { describe, it, expect } from 'vitest';
import { ImportRefusal, renderAll } from './texture-render';
import { TILE } from './texture-import';
import type { TextureSource } from './texture-sources';

const solid = (r: number, g: number, b: number, a = 255) => {
	const t = new Uint8Array(TILE * TILE * 4);
	for (let i = 0; i < t.length; i += 4) t.set([r, g, b, a], i);
	return t;
};
const holes = (frac: number) => {
	const t = solid(200, 100, 50);
	for (let i = 0; i < Math.round(TILE * TILE * frac); i++) t[i * 4 + 3] = 0;
	return t;
};

describe('renderAll (spec §4.2, §5)', () => {
	const files: Record<string, Uint8Array> = { 'stone.png': solid(120, 120, 120), 'ore.png': holes(0.3), 'slime.png': solid(90, 200, 90, 140) };
	const read = (_p: string, f: string) => { const t = files[f]; if (!t) throw new Error(`missing ${f}`); return t; };

	it('refuses an overlay-style source on an opaque block unless it is an over row', () => {
		const rows: Record<string, TextureSource> = { stone: { pack: 'ppce', file: 'stone.png' }, copper_ore: { pack: 'bauniclonia', file: 'ore.png' } };
		expect(() => renderAll(rows, read)).toThrow(ImportRefusal);
		expect(() => renderAll(rows, read)).toThrow(/copper_ore/);
	});
	it('accepts the same source as an over row and composites it on the base', () => {
		const rows: Record<string, TextureSource> = { stone: { pack: 'ppce', file: 'stone.png' }, copper_ore: { over: 'stone', pack: 'bauniclonia', file: 'ore.png' } };
		const out = renderAll(rows, read).get('copper_ore')!;
		expect([...out.slice(0, 4)]).toEqual([120, 120, 120, 255]);   // a hole shows stone, not a smear
		expect([...out.slice(-4)]).toEqual([200, 100, 50, 255]);
	});
	it('lets uniformly semi-transparent art through and forces it opaque (slime alpha 140)', () => {
		const out = renderAll({ slime_block: { pack: 'ppce', file: 'slime.png' } }, read).get('slime_block')!;
		for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
	});
	it('flat fills the tile with one colour and alpha, no texture (glass, user decision 2026-09-26)', () => {
		const t = renderAll({ blue_stained_glass: { flat: [60, 68, 170], alpha: 140 } }, read).get('blue_stained_glass')!;
		for (let i = 0; i < t.length; i += 4) expect([...t.slice(i, i + 4)]).toEqual([60, 68, 170, 140]);
	});
	it('same copies the target bytes exactly', () => {
		const m = renderAll({ stone: { pack: 'ppce', file: 'stone.png' }, cobblestone: { same: 'stone' } }, read);
		expect(m.get('cobblestone')).toEqual(m.get('stone'));
	});
	it('derive tints a pack file to its target luminance', () => {
		const m = renderAll({ stone: { derive: 'tint', pack: 'ppce', file: 'stone.png', tint: [255, 0, 0], targetLum: 100 } }, read);
		const t = m.get('stone')!;
		expect(t[1]).toBe(0); expect(t[0]).toBeGreaterThan(0);
	});
	it('renders nothing when any row fails: the error happens before the caller writes', () => {
		// Review Focus 3: renderAll is all-or-nothing, so import-textures writes only after it returns.
		const rows: Record<string, TextureSource> = { stone: { pack: 'ppce', file: 'stone.png' }, cobblestone: { pack: 'ppce', file: 'missing.png' } };
		expect(() => renderAll(rows, read)).toThrow(/missing/);
	});
});
