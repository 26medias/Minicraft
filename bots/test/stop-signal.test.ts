import { describe, expect, it } from 'vitest';
import type { JournalEntry } from 'minicraft-bot';
import { StopSignal } from '../src/body/stop-signal.js';
import type { EditEvent } from '../src/types.js';
import { AIR, id } from './fake-port.js';

/**
 * Task 3 stop signal (spec §6, §12a): a kid turning a cell that currently holds the bot's block (the
 * cell's latest journal entry's `newId`) into anything → a stop for that kid, BY NAME, until
 * now + stopMs, wherever he goes. No radius.
 */

const STOP_MS = 600_000;
const T0 = 1_000_000;
const PLANKS = id('oak_planks');
const STONE = id('stone');

const journal: JournalEntry[] = [
	{ x: 10, y: 70, z: 10, oldId: AIR, newId: PLANKS, t: 1 },
	// The bot later replaced (11, 70, 10) twice: the latest entry (stone) is what counts.
	{ x: 11, y: 70, z: 10, oldId: AIR, newId: PLANKS, t: 2 },
	{ x: 11, y: 70, z: 10, oldId: PLANKS, newId: STONE, t: 3 },
];

function edit(by: string | null, cells: EditEvent['cells'], over: Partial<EditEvent> = {}): EditEvent {
	return { by: 1, byName: by, byBot: false, opCount: cells.length, cells, ...over };
}

describe('StopSignal', () => {
	it('a kid breaking a bot block → a stop for that kid by name, until now + stopMs', () => {
		const s = new StopSignal(STOP_MS);
		expect(s.onEdit(edit('Noah', [{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: AIR }]), journal, T0)).toBe('Noah');
		expect(s.activeFor('Noah', T0)).toBe(true);
		expect(s.activeFor('Noah', T0 + STOP_MS - 1)).toBe(true);
		expect(s.anyActive(T0 + 1000)).toBe(true);
		expect(s.active(T0 + 1000)).toEqual([{ name: 'Noah', remainingMs: STOP_MS - 1000 }]);
	});

	it('turning the bot block into ANOTHER block also counts', () => {
		const s = new StopSignal(STOP_MS);
		expect(s.onEdit(edit('Noah', [{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: STONE }]), journal, T0)).toBe('Noah');
	});

	it('only the latest journal entry counts: the cell holds stone now, not planks', () => {
		const s = new StopSignal(STOP_MS);
		// (11, 70, 10) held the bot's planks once, but the bot replaced them with stone: a planks → air change
		// there isn't the bot's current block.
		expect(s.onEdit(edit('Noah', [{ x: 11, y: 70, z: 10, oldId: PLANKS, newId: AIR }]), journal, T0)).toBeNull();
		expect(s.onEdit(edit('Noah', [{ x: 11, y: 70, z: 10, oldId: STONE, newId: AIR }]), journal, T0)).toBe('Noah');
	});

	it('it is by NAME and follows the kid anywhere (a reconnect, a new id, far away)', () => {
		const s = new StopSignal(STOP_MS);
		s.onEdit(edit('Noah', [{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: AIR }], { by: 1 }), journal, T0);
		// The stop has no position: it is simply active for "Noah", whatever his id or position.
		expect(s.activeFor('Noah', T0 + 300_000)).toBe(true);
	});

	it('expires at now + stopMs', () => {
		const s = new StopSignal(STOP_MS);
		s.onEdit(edit('Noah', [{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: AIR }]), journal, T0);
		expect(s.activeFor('Noah', T0 + STOP_MS)).toBe(false);
		expect(s.anyActive(T0 + STOP_MS)).toBe(false);
		expect(s.active(T0 + STOP_MS)).toEqual([]);
	});

	it('another kid is unaffected', () => {
		const s = new StopSignal(STOP_MS);
		s.onEdit(edit('Noah', [{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: AIR }]), journal, T0);
		expect(s.activeFor('Julien', T0 + 1)).toBe(false);
	});

	it.each<[string, EditEvent]>([
		['an edit of a cell the bot never touched', edit('Noah', [{ x: 50, y: 70, z: 50, oldId: STONE, newId: AIR }])],
		['a placement next to a bot block', edit('Noah', [{ x: 10, y: 71, z: 10, oldId: AIR, newId: STONE }])],
		['an op that did not change the cell (old id unknown)', edit('Noah', [{ x: 10, y: 70, z: 10, oldId: null, newId: AIR }])],
		["the bot's own edit", edit(null, [{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: AIR }], { byBot: true, by: 99 })],
		["another bot's edit", edit('Robo2', [{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: AIR }], { byBot: true, by: 5 })],
	])('no stop: %s', (_label, e) => {
		const s = new StopSignal(STOP_MS);
		expect(s.onEdit(e, journal, T0)).toBeNull();
		expect(s.anyActive(T0)).toBe(false);
	});

	it('no stop when the cell still ends up holding the bot block (newId === the journal newId)', () => {
		const s = new StopSignal(STOP_MS);
		expect(s.onEdit(edit('Noah', [{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: PLANKS }]), journal, T0)).toBeNull();
		expect(s.anyActive(T0)).toBe(false);
	});

	it('a multi-op edit (e.g. TNT) that includes a bot block counts', () => {
		const s = new StopSignal(STOP_MS);
		const tnt = edit('Noah', [
			{ x: 50, y: 70, z: 50, oldId: STONE, newId: AIR },
			{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: AIR },
		]);
		expect(s.onEdit(tnt, journal, T0)).toBe('Noah');
	});

	it('a renewed break restarts the stop', () => {
		const s = new StopSignal(STOP_MS);
		s.onEdit(edit('Noah', [{ x: 10, y: 70, z: 10, oldId: PLANKS, newId: AIR }]), journal, T0);
		s.onEdit(edit('Noah', [{ x: 11, y: 70, z: 10, oldId: STONE, newId: AIR }]), journal, T0 + 100_000);
		expect(s.activeFor('Noah', T0 + STOP_MS + 50_000)).toBe(true);
	});
});
