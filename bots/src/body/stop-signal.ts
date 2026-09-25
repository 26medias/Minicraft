/**
 * The stop signal (spec §6, amended by §12a): when a kid turns a cell that currently holds the bot's
 * block (the cell's latest journal entry's `newId`) into anything else, that kid — by NAME — gets a
 * stop until now + `stopMs`. There is no radius: the stop follows the kid wherever he goes. During a
 * stop the bot offers no `help_build` for that kid (candidates.ts); follow and watch continue.
 */
import type { JournalEntry } from 'minicraft-bot';
import type { EditEvent } from '../types.js';

export class StopSignal {
	private readonly until = new Map<string, number>();

	constructor(private readonly stopMs: number) {}

	/**
	 * Feeds one edit. Returns the kid's name when this edit started (or renewed) a stop, else `null`.
	 * `journal` is the bot's own journal, oldest first.
	 */
	onEdit(edit: EditEvent, journal: readonly JournalEntry[], now: number): string | null {
		if (edit.byBot || edit.byName === null) return null;
		for (const cell of edit.cells) {
			if (cell.oldId === null) continue;
			const entry = latestEntry(journal, cell.x, cell.y, cell.z);
			if (!entry) continue;
			if (cell.oldId === entry.newId && cell.newId !== entry.newId) {
				this.until.set(edit.byName, now + this.stopMs);
				return edit.byName;
			}
		}
		return null;
	}

	activeFor(kidName: string, now: number): boolean {
		return (this.until.get(kidName) ?? -Infinity) > now;
	}

	anyActive(now: number): boolean {
		for (const t of this.until.values()) if (t > now) return true;
		return false;
	}

	/** Every kid with an active stop, and the ms left (for the status line: "paused near Noah 9m"). */
	active(now: number): { name: string; remainingMs: number }[] {
		const out: { name: string; remainingMs: number }[] = [];
		for (const [name, t] of this.until) if (t > now) out.push({ name, remainingMs: t - now });
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}
}

/** The cell's most recent journal entry (the journal is oldest first), or `undefined`. */
function latestEntry(journal: readonly JournalEntry[], x: number, y: number, z: number): JournalEntry | undefined {
	for (let i = journal.length - 1; i >= 0; i--) {
		const e = journal[i];
		if (e.x === x && e.y === y && e.z === z) return e;
	}
	return undefined;
}
