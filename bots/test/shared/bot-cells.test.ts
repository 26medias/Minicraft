import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockId } from 'minicraft-bot';
import { StopSignal } from '../../src/body/stop-signal.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { checkPlace } from '../../src/builder/builder.js';
import { SharedCells, sharedCellsPath } from '../../src/shared/bot-cells.js';
import { FakeWorld } from '../fake-port.js';

/** A decorator ("Deco") placed a flower bed beside where a builder wants to build; the registry holds its cells. */
function setup() {
	const world = new FakeWorld();
	const x = 100, z = 100;
	const y = world.surfaceY(x, z) + 1;
	const path = sharedCellsPath(mkdtempSync(join(tmpdir(), 'shared-')), 'local', 'w1');
	const deco = new SharedCells(path, 'Deco');
	const bed = [0, 1, 2].map((i) => ({ x: x + 1, y, z: z + i }));
	for (const c of bed) {
		world.set(c.x, c.y, c.z, 'pink_wool'); // edited in the overlay, as any placement is
		deco.append(c, blockId('pink_wool')!);
	}
	const builderOwned: Record<string, number> = {};
	const shared = new SharedCells(path, 'Robo', () => 0, 0);
	const own = new Ownership(world, () => builderOwned, () => shared.cells());
	const base = { world, own, kids: [], stop: new StopSignal(600_000), now: 1e9, lastEditT: null, noEdits: false, halted: null };
	return { world, x, y, z, bed, path, own, base };
}

describe('shared bot cells', () => {
	it('appends {x,y,z,id,bot,t} lines', () => {
		const { path } = setup();
		const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatchObject({ bot: 'Deco', id: blockId('pink_wool') });
	});

	it("a builder next to another bot's cells does not treat them as kid cells", () => {
		const { x, y, z, bed, own, base } = setup();
		for (const c of bed) expect(own.classify(c.x, c.y, c.z)).toBe('bot');
		expect(own.kidCellWithin(x, z, 6)).toBe(false);
		expect(checkPlace({ x, y, z }, 'oak_planks', base)).toEqual({ ok: true });
		// Without the registry the same cells are kid cells (the check can go red).
		const bare = new Ownership(base.world, () => ({}));
		expect(bare.classify(bed[0].x, bed[0].y, bed[0].z)).toBe('kid');
		expect(checkPlace({ x, y, z }, 'oak_planks', { ...base, own: bare })).toMatchObject({ ok: false, reason: 'kid cell buffer' });
	});

	it('a kid overwriting such a cell makes it a kid cell (a different block, or the same block by a kid edit)', () => {
		const { world, x, y, z, bed, own, base } = setup();
		// A different block: the id no longer matches the registry.
		world.set(bed[0].x, bed[0].y, bed[0].z, 'dirt');
		expect(own.classify(bed[0].x, bed[0].y, bed[0].z)).toBe('kid');
		// The same block, but written by a kid (a non-bot edit).
		const c = bed[2];
		own.onEdit({ by: 7, byName: 'Noah', byBot: false, opCount: 1, cells: [{ ...c, oldId: null, newId: blockId('pink_wool')! }] }, 99);
		expect(own.classify(c.x, c.y, c.z)).toBe('kid');
		expect(checkPlace({ x, y, z }, 'oak_planks', base)).toMatchObject({ ok: false, reason: 'kid cell buffer' });
		// Another bot's edit of an untouched cell keeps it a bot cell.
		const b = bed[1];
		own.onEdit({ by: 8, byName: 'Deco', byBot: true, opCount: 1, cells: [{ ...b, oldId: null, newId: blockId('pink_wool')! }] }, 99);
		expect(own.classify(b.x, b.y, b.z)).toBe('bot');
	});
});
