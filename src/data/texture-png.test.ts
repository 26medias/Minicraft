// src/data/texture-png.test.ts
import { describe, it, expect } from 'vitest';
import { encodePng } from './texture-png';

describe('encodePng (Review Focus 2)', () => {
	it('is byte-identical across runs, so a re-import is a no-op in git', async () => {
		const t = new Uint8Array(16 * 16 * 4).map((_, i) => (i * 37) % 256);
		expect(Buffer.compare(await encodePng(t), await encodePng(t))).toBe(0);
	});
});
