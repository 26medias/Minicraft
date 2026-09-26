import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JournalEntry } from 'minicraft-bot';
import { RELATION_AXES, type State } from './types.js';
import type { Patch } from './store.js';

export const SCHEMA_VERSION = 1;
const HALVE_AFTER_MS = 30 * 60_000;
const SAVE_EVERY_MS = 5_000;

export interface BrainFile {
	schemaVersion: number; worldUuid: string; bot: string; lastAlive: number;
	relations: State['relations']; inventory: State['inventory']; builds: State['builds']; digs: State['digs'];
	owned: State['owned']; explored: string[];
}

export function brainFilePath(stateRoot: string, target: string, worldUuid: string, bot: string): string {
	return `${stateRoot}/brain/${target}/${worldUuid}/${bot}.json`;
}

/** Migrations from older schemas (spec §4.6). Index n migrates version n → n + 1. None yet. */
const MIGRATIONS: Array<(f: Record<string, unknown>) => Record<string, unknown>> = [];

function bad(path: string, wallNow: number, why: string): { file: null; note: string } {
	renameSync(path, `${path}.bad-${wallNow}`);
	return { file: null, note: `bad (${why}): moved to .bad-${wallNow}` };
}

export function loadBrainFile(path: string, expect: { worldUuid: string; bot: string }, wallNow: number): { file: BrainFile | null; note: string } {
	if (!existsSync(path)) return { file: null, note: 'none' };
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return bad(path, wallNow, 'unreadable');
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad(path, wallNow, 'not an object');
	if (raw.worldUuid !== expect.worldUuid || raw.bot !== expect.bot) return bad(path, wallNow, 'another world or bot');
	let v = Number(raw.schemaVersion);
	if (!Number.isInteger(v) || v > SCHEMA_VERSION) return bad(path, wallNow, `schema ${raw.schemaVersion}`);
	while (v < SCHEMA_VERSION) {
		const m = MIGRATIONS[v];
		if (!m) return bad(path, wallNow, `no migration from ${v}`);
		raw = m(raw);
		v++;
	}
	const shapeOk = ['relations', 'inventory', 'owned'].every((k) => raw[k] !== null && typeof raw[k] === 'object')
		&& ['builds', 'digs', 'explored'].every((k) => Array.isArray(raw[k])) && typeof raw.lastAlive === 'number';
	if (!shapeOk) return bad(path, wallNow, 'missing fields');
	return { file: raw as unknown as BrainFile, note: 'loaded' };
}

export function loadedPatch(file: BrainFile, wallNow: number): Patch {
	const halve = wallNow - file.lastAlive > HALVE_AFTER_MS;
	const relations = structuredClone(file.relations);
	if (halve) for (const r of Object.values(relations)) for (const ax of RELATION_AXES) r.axes[ax].value *= 0.5;
	if (halve) for (const r of Object.values(relations)) r.metSessions += 1;
	return [
		{ path: ['relations'], value: relations },
		{ path: ['inventory'], value: file.inventory },
		{ path: ['builds'], value: file.builds },
		{ path: ['digs'], value: file.digs },
		{ path: ['owned'], value: file.owned },
		{ path: ['explored'], value: Object.fromEntries(file.explored.map((k) => [k, true])) },
	];
}

export class BrainSaver {
	private lastWrite = -Infinity;
	constructor(private readonly path: string, private readonly meta: { worldUuid: string; bot: string }, private readonly wall: () => number) {}
	/** Kept for callers' clarity: tick() writes at most every 5 s regardless, which also refreshes lastAlive. */
	markDirty(): void {}
	tick(state: Readonly<State>): void {
		if (this.wall() - this.lastWrite >= SAVE_EVERY_MS) this.write(state);
	}
	flush(state: Readonly<State>): void {
		this.write(state);
	}
	private write(state: Readonly<State>): void {
		const f: BrainFile = {
			schemaVersion: SCHEMA_VERSION, ...this.meta, lastAlive: this.wall(),
			relations: state.relations, inventory: state.inventory, builds: state.builds, digs: state.digs,
			owned: state.owned, explored: Object.keys(state.explored).sort(),
		};
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(f));
		renameSync(tmp, this.path);
		this.lastWrite = this.wall();
	}
}

export function reconcileRevert(state: Readonly<State>, reverted: JournalEntry[], nameOf: (id: number) => string | null): Patch {
	const inv = { ...state.inventory };
	const out: Patch = [];
	const cells = new Set<string>();
	for (const e of reverted) {
		const k = `${e.x},${e.y},${e.z}`;
		cells.add(k);
		if (k in state.owned) out.push({ path: ['owned', k], value: undefined });
		const placed = nameOf(e.newId), mined = nameOf(e.oldId);
		if (e.newId !== 0 && placed) inv[placed] = (inv[placed] ?? 0) + 1;       // the placement is undone: the block comes back
		if (e.newId === 0 && e.oldId !== 0 && mined) inv[mined] = Math.max(0, (inv[mined] ?? 0) - 1); // the mined block is back in the world
	}
	for (const [name, n] of Object.entries(inv)) if (n !== state.inventory[name]) out.push({ path: ['inventory', name], value: n });
	const touch = (c: { x: number; y: number; z: number }) => cells.has(`${c.x},${c.y},${c.z}`);
	out.push({ path: ['builds'], value: state.builds.map((b) => (b.cells.some((c) => touch(c.cell)) ? { ...b, status: 'reverted' } : b)) });
	out.push({ path: ['digs'], value: state.digs.map((d) => (d.cells.some((k) => cells.has(k)) ? { ...d, status: 'reverted' } : d)) });
	return out;
}
