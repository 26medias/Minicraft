/**
 * The shared bot-cell registry: every bot (builder, decorator, village) appends the cells it places to
 * `<stateRoot>/shared/<target>/<world>/bot-cells.jsonl` ({x,y,z,id,bot,t}, append-only). A reader keeps the latest
 * entry per cell; Ownership counts a cell as `bot` (not kid) when its current block id equals that entry's id and no
 * kid (a non-bot edit, by the SDK's `byBot`) has touched it since this process started watching.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Vec3 } from '../types.js';

export interface SharedCell { x: number; y: number; z: number; id: number; bot: string; t: number }

export function sharedCellsPath(stateRoot: string, target: string, world: string): string {
	return join(stateRoot, 'shared', target, world, 'bot-cells.jsonl');
}

export class SharedCells {
	private latest: Record<string, number> = {};
	private offset = 0;
	private partial = '';
	private lastRead = -Infinity;

	/** `refreshMs`: re-read the file's new tail at most this often (classify is hot). */
	constructor(readonly path: string, private readonly bot: string, private readonly clock: () => number = () => Date.now(), private readonly refreshMs = 1000) {}

	/** Appends one placed cell (and records it locally at once). Never throws: a full disk must not stop the bot. */
	append(cell: Vec3, id: number): void {
		const e: SharedCell = { x: cell.x, y: cell.y, z: cell.z, id, bot: this.bot, t: this.clock() };
		this.latest[`${cell.x},${cell.y},${cell.z}`] = id;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			appendFileSync(this.path, `${JSON.stringify(e)}\n`);
		} catch {
			// ignore
		}
	}

	/** The latest id per cell key, across every bot (re-reads the new tail at most every refreshMs). */
	cells(): Readonly<Record<string, number>> {
		const now = this.clock();
		if (now - this.lastRead >= this.refreshMs) {
			this.lastRead = now;
			this.readTail();
		}
		return this.latest;
	}

	/** Reads what was appended since the last read (whole lines only). */
	readTail(): void {
		let fd: number;
		try {
			fd = openSync(this.path, 'r');
		} catch {
			return;
		}
		try {
			const size = fstatSync(fd).size;
			if (size < this.offset) {
				// truncated: start over
				this.offset = 0;
				this.partial = '';
				this.latest = {};
			}
			if (size === this.offset) return;
			const buf = Buffer.alloc(size - this.offset);
			readSync(fd, buf, 0, buf.length, this.offset);
			this.offset = size;
			const text = this.partial + buf.toString('utf8');
			const lines = text.split('\n');
			this.partial = lines.pop() ?? '';
			for (const l of lines) {
				if (!l) continue;
				try {
					const e = JSON.parse(l) as SharedCell;
					if (Number.isInteger(e.x) && Number.isInteger(e.y) && Number.isInteger(e.z) && Number.isInteger(e.id)) this.latest[`${e.x},${e.y},${e.z}`] = e.id;
				} catch {
					// a torn line: skip
				}
			}
		} finally {
			closeSync(fd);
		}
	}
}
