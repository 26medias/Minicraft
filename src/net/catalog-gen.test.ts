import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BLOCKS } from '../data/blocks.data';

/**
 * The server rejects ops with ids above its generated CatalogMax (spec §5, G12). A block added
 * without `npm run gen-server-catalog` would make the server kick every edit that places it, so
 * the committed Go constant must match the catalog.
 */
describe('server/internal/proto/catalog_gen.go', () => {
	it('CatalogMax equals the highest block id in BLOCKS (run `npm run gen-server-catalog`)', () => {
		const src = readFileSync('server/internal/proto/catalog_gen.go', 'utf8');
		const m = /^const CatalogMax = (\d+)$/m.exec(src);
		expect(m, 'catalog_gen.go has no `const CatalogMax = N` line').not.toBeNull();
		const maxId = BLOCKS.reduce((a, b) => Math.max(a, b.id), 0);
		expect(Number(m![1])).toBe(maxId);
	});
});
