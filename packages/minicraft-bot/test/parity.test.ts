// Spec §9.1, plan Task 5 step 6: worldgen parity through the BUILT bundle (dist/index.js, loaded at run
// time; types come from source so nothing here imports dist statically). FNV-1a-32 over the Uint16 ids.
// Load-bearing: only the last two rows (seed 1 and seed 4) catch a float64 build of v3/generate.ts.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PKG_ROOT } from '../vite.config';

type Sdk = typeof import('../src/index');

const DIST = join(PKG_ROOT, 'dist/index.js');
const DTS = join(PKG_ROOT, 'dist/index.d.ts');

async function loadDist(): Promise<Sdk> {
	if (!existsSync(DIST)) throw new Error(`${DIST} is missing: run npm run build:bot`);
	return (await import(pathToFileURL(DIST).href)) as Sdk;
}

function fnv1a32(ids: ArrayLike<number>): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < ids.length; i++) {
		h ^= ids[i];
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h;
}

/** [seed, gen, cx, cz, hash]: the 6 reference hashes (generation.test.ts), then the 11 coverage hashes (spec §9.1). */
const ROWS: ReadonlyArray<readonly [number, number, number, number, number]> = [
	[2026, 1, 0, 0, 4166549171],
	[12345, 2, 3, 5, 3402466961],
	[12345, 3, 0, 0, 2020764513],
	[12345, 3, 16, 16, 800740276],
	[12345, 3, 31, 31, 2743801548],
	[12345, 3, 5, 27, 161955245],
	[12345, 3, 10, 2, 2228629264],
	[12345, 3, 12, 13, 282354078],
	[12345, 3, 1, 23, 1029461773],
	[12345, 3, 0, 16, 1969857804],
	[12345, 3, 1, 24, 4095451757],
	[12345, 3, 6, 22, 1052017669],
	[12345, 3, 6, 27, 3335755431],
	[12345, 3, 7, 15, 1876328107],
	[12345, 3, 9, 2, 2754869114],
	[1, 3, 25, 19, 158084171],
	[4, 3, 25, 14, 4284147560],
];

describe('worldgen parity through dist/index.js', () => {
	it('checks all 17 rows', () => {
		expect(ROWS).toHaveLength(17);
	});

	it.each(ROWS)('seed %i gen %i chunk (%i,%i) → %i', async (seed, gen, cx, cz, hash) => {
		const sdk = await loadDist();
		expect(fnv1a32(sdk.generateChunkBlocks(seed, gen, cx, cz))).toBe(hash);
	});

	it('the bundle carries the shared constants', async () => {
		const sdk = await loadDist();
		expect([sdk.CLIENT_VERSION, sdk.POS_EVERY_MS, sdk.WALK_SPEED, sdk.EYE_HEIGHT]).toEqual([1, 100, 5, 1.6]);
		expect(sdk.blockNames()).toContain('stone');
	});

	it('dist/index.d.ts is one file with no relative imports, no three, and no internals', () => {
		if (!existsSync(DTS)) throw new Error(`${DTS} is missing: run npm run build:bot`);
		const dts = readFileSync(DTS, 'utf8');
		expect(dts).not.toMatch(/three/);
		expect(dts).not.toMatch(/from\s+['"]\./);
		expect(dts).not.toMatch(/import\(['"]\./);
		expect(dts).not.toMatch(/\b(MpSync|LightRegistry|GameLoop|ChunkOverlay)\b/);
		expect(dts).toMatch(/export declare class BotClient/);
		expect(dts).toMatch(/export declare class BotWorld/);
	});
});
