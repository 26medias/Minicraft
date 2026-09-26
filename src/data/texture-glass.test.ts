import { describe, it, expect } from 'vitest';
import { requiredTextureNames } from './texture-sources';
import { readTile } from './texture-test-util';

describe('glass is a plain tinted transparent colour (user decision 2026-09-26)', () => {
	it('every *glass texture is one flat colour with partial alpha', async () => {
		const glass = requiredTextureNames().filter((n) => n === 'glass' || n.endsWith('_glass'));
		expect(glass.length).toBe(18); // glass, tinted_glass, 16 stained
		for (const n of glass) {
			const t = await readTile(n);
			for (let i = 4; i < t.length; i += 4) expect([...t.slice(i, i + 4)], n).toEqual([...t.slice(0, 4)]);
			expect(t[3] > 0 && t[3] < 255, `${n} alpha ${t[3]}`).toBe(true);
		}
	});
});
