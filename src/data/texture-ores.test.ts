// src/data/texture-ores.test.ts
import { describe, it, expect } from 'vitest';
import { requiredTextureNames } from './texture-sources';
import { deltaE, meanRgb } from './texture-import';
import { readTile } from './texture-test-util';

const host = (n: string) => (n.startsWith('deepslate_') ? 'deepslate' : n.startsWith('nether_') ? 'netherrack' : 'stone');
const threshold = (n: string) => (n === 'deepslate_coal_ore' ? 12 : 25);

describe('ores stay findable (spec §5.3)', () => {
	it('every *_ore has ≥ 12 pixels far from its shipped host stone', async () => {
		for (const n of requiredTextureNames().filter((x) => x.endsWith('_ore'))) {
			const h = meanRgb(await readTile(host(n)));
			const t = await readTile(n);
			let far = 0;
			for (let i = 0; i < t.length; i += 4) if (deltaE([t[i], t[i + 1], t[i + 2]], h) > threshold(n)) far++;
			expect(far, `${n} vs ${host(n)}`).toBeGreaterThanOrEqual(12);
		}
	});
	it('the instrument can go red: plain deepslate is not findable as an ore', async () => {
		const h = meanRgb(await readTile('deepslate')); const t = await readTile('deepslate');
		let far = 0;
		for (let i = 0; i < t.length; i += 4) if (deltaE([t[i], t[i + 1], t[i + 2]], h) > 12) far++;
		expect(far).toBeLessThan(12);
	});
});
