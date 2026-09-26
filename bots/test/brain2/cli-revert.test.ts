import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotClient, BotClientOptions, JournalEntry } from 'minicraft-bot';
import { main, revertedEntries } from '../../src/cli.js';
import { brainFilePath, type BrainFile } from '../../src/brain2/persist.js';
import { id } from '../fake-port.js';

/**
 * Task 17b (spec §4.6): `revert` and `revert --builds` reconcile a v2 bot's brain file with what they undid.
 * The client is a fake with a scripted journal and world, and a revert that behaves as the SDK's (it empties the
 * journal of what it restored).
 */
const STONE = id('stone'), DIRT = id('dirt');
const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

function brainFile(): BrainFile {
	const cell = (x: number, y: number, z: number) => ({ cell: { x, y, z }, block: 'stone' });
	return {
		schemaVersion: 1, worldUuid: 'u-1', bot: 'Robo', lastAlive: 1_000,
		relations: {}, inventory: { stone: 5, dirt: 2 },
		builds: [
			{ id: 'b1', template: 'tower', variant: 'small', origin: { x: 1, y: 100, z: 1 }, cells: [cell(1, 100, 1), cell(2, 100, 1)], status: 'building' },
			{ id: 'b2', template: 'tower', variant: 'small', origin: { x: 5, y: 100, z: 5 }, cells: [cell(5, 100, 5)], status: 'done' },
		],
		digs: [{ id: 'd1', block: 'stone', entrance: { x: 7, y: 91, z: 7 }, target: { x: 7, y: 90, z: 7 }, stepsDone: 1, cells: ['7,90,7'], status: 'paused', spiral: { px: 6, pz: 7, y0: 92, phase: 0, lastStep: 1 } }],
		owned: { '1,100,1': STONE, '2,100,1': STONE, '3,100,1': STONE, '5,100,5': STONE },
		explored: [],
	};
}

function fakeClient(o: { journal: JournalEntry[]; world: Map<string, number> }) {
	const calls: string[] = [];
	let journal = o.journal.map((e) => ({ ...e }));
	const getBlock = (x: number, y: number, z: number) => o.world.get(cellKey(x, y, z)) ?? 0;
	const client = {
		listWorlds: async () => [{ uuid: 'u-1', name: 'Home', mustMine: false, createdAt: 0, online: [] }],
		connect: async () => ({}),
		journal: () => journal.map((e) => ({ ...e })),
		world: { getBlock, blockName: (v: number) => (v === STONE ? 'stone' : v === DIRT ? 'dirt' : v === 0 ? 'air' : null) },
		revert: async (since = -Infinity) => {
			calls.push(`revert ${since}`);
			let n = 0;
			const kept: JournalEntry[] = [];
			for (const e of [...journal].reverse()) {
				if (e.t < since) {
					kept.push(e);
					continue;
				}
				if (getBlock(e.x, e.y, e.z) !== e.newId) continue;
				o.world.set(cellKey(e.x, e.y, e.z), e.oldId);
				n++;
			}
			journal = kept.reverse();
			return n;
		},
		place: async (x: number, y: number, z: number, name: string) => {
			calls.push(`place ${cellKey(x, y, z)} ${name}`);
			o.world.set(cellKey(x, y, z), id(name));
			return true;
		},
		break: async (x: number, y: number, z: number) => {
			calls.push(`break ${cellKey(x, y, z)}`);
			o.world.set(cellKey(x, y, z), 0);
			return true;
		},
		close: () => void calls.push('close'),
	};
	return { client, calls };
}

describe('revert on a v2 bot reconciles the brain file (spec §4.6)', () => {
	let root: string;
	let path: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'bots-revert-'));
		path = brainFilePath(root, 'local', 'u-1', 'Robo');
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(brainFile()));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const scripted = () => {
		const journal: JournalEntry[] = [
			{ x: 1, y: 100, z: 1, oldId: 0, newId: STONE, t: 100 },
			{ x: 2, y: 100, z: 1, oldId: 0, newId: STONE, t: 200 },
			{ x: 7, y: 90, z: 7, oldId: STONE, newId: 0, t: 300 },
			{ x: 3, y: 100, z: 1, oldId: 0, newId: STONE, t: 400 },
			{ x: 5, y: 100, z: 5, oldId: 0, newId: STONE, t: 500 },     // a kid replaced it with dirt since: not restored
		];
		const world = new Map<string, number>([['1,100,1', STONE], ['2,100,1', STONE], ['3,100,1', STONE], ['5,100,5', DIRT]]);
		return fakeClient({ journal, world });
	};
	const run = async (argv: string[], client: ReturnType<typeof fakeClient>['client']) => {
		const printed: string[] = [];
		await main(argv, { makeClient: (_o: BotClientOptions) => client as unknown as BotClient, stateRoot: root, env: {}, readFile: () => null, print: (l) => void printed.push(l) });
		return printed;
	};
	const file = (): BrainFile => JSON.parse(readFileSync(path, 'utf8'));

	// Red if the journal is read after reverting (it is empty then: nothing is reconciled), or if an entry the
	// revert skipped (the kid's dirt at 5,100,5) is reconciled as if restored.
	it('revert: inventory and owned follow the undone edits, and the touched build and dig are reverted', async () => {
		const { client, calls } = scripted();
		await run(['revert', '--target', 'local', '--world', 'Home', '--name', 'Robo'], client);
		expect(calls).toEqual(['revert -Infinity', 'close']);
		const f = file();
		expect(f.inventory).toEqual({ stone: 5 + 3 - 1, dirt: 2 });  // 3 placements back in hand, the mined stone back in the world
		expect(f.owned).toEqual({ '5,100,5': STONE });                // the kid's cell: not the bot's revert to account for
		expect(f.builds.map((b) => b.status)).toEqual(['reverted', 'done']);
		expect(f.digs[0].status).toBe('reverted');
		expect(f.lastAlive).toBe(1_000);                                // a revert is not the bot being alive
	});

	// Red if --builds writes a cell that isn't `bot` any more (5,100,5 holds the kid's dirt), or plain-reverts too.
	it('revert --builds: only the builds\' `bot` cells are written back, and those builds are reverted', async () => {
		const { client, calls } = scripted();
		await run(['revert', '--builds', '--target', 'local', '--world', 'Home', '--name', 'Robo'], client);
		expect(calls).toEqual(['break 1,100,1', 'break 2,100,1', 'close']);
		const f = file();
		expect(f.inventory).toEqual({ stone: 7, dirt: 2 });
		expect(f.owned).toEqual({ '3,100,1': STONE, '5,100,5': STONE });
		expect(f.builds.map((b) => b.status)).toEqual(['reverted', 'done']);
		expect(f.digs[0].status).toBe('paused');
	});
});

describe('revertedEntries: what the SDK revert restored', () => {
	const e = (x: number, oldId: number, newId: number, t: number): JournalEntry => ({ x, y: 0, z: 0, oldId, newId, t });
	// Red if each entry is checked against the world before the revert only (the mined-then-refilled cell's older
	// entry would be skipped), or if a deferred cell's newer entries are dropped with it.
	it('follows a cell through its entries newest first, and stops at a deferred one', () => {
		const before = [e(1, STONE, 0, 1), e(1, 0, DIRT, 2), e(2, 0, STONE, 3), e(2, STONE, 0, 4), e(3, 0, STONE, 5)];
		const world = new Map([[1, DIRT], [2, 0], [3, 0]]);                // cell 3 was broken by a kid: not restored
		const after = [e(2, 0, STONE, 3)];                                    // the SDK deferred cell 2's older entry
		const got = revertedEntries(before, after, -Infinity, (x) => world.get(x) ?? 0);
		expect(got.map((x) => x.t)).toEqual([4, 2, 1]);
	});
});
