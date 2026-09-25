import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKIN_IDS } from '../src/skins.js';

/**
 * bots/src/skins.ts hard-codes the game's skin catalog ids because bots/ may not import the game's
 * src/ (see test/boundary.test.ts). This test reads src/data/skins.data.ts as TEXT via node:fs
 * (never an `import`, so the boundary test stays happy) and asserts the ids haven't drifted.
 */

const testFileDir = dirname(fileURLToPath(import.meta.url));
const skinsDataPath = resolve(testFileDir, '..', '..', 'src', 'data', 'skins.data.ts');

function idsFromSkinsData(): string[] {
	const source = readFileSync(skinsDataPath, 'utf8');
	return [...source.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('SKIN_IDS matches src/data/skins.data.ts', () => {
	it('is exactly the game catalog\'s ids, in order', () => {
		expect([...SKIN_IDS]).toEqual(idsFromSkinsData());
	});
});
