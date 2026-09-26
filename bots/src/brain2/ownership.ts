import type { WorldView } from '../port.js';
import type { EditEvent } from '../types.js';
import type { Patch, PatchOp } from './store.js';

export type CellClass = 'natural' | 'bot' | 'kid';
export const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const ck = (cx: number, cz: number): string => `${cx},${cz}`;
const chunkOf = (x: number, z: number): [number, number] => [Math.floor(x / 16), Math.floor(z / 16)];

/** Who owns a cell (spec §4.5): decided by the current block and the last writer, never by coordinates alone. */
export class Ownership {
	private verified = new Set<string>();
	private dropped = new Set<string>();         // owned keys found stale; kept until the store deletes them
	private pending: Patch = [];
	private kidIndex = new Map<string, Set<string>>();
	/** Cells a kid (a non-bot author) edited since this process started watching: a shared bot entry no longer counts. */
	private kidTouched = new Set<string>();

	/**
	 * `shared`: the other bots' latest placed id per cell (the shared bot-cell registry); a cell whose current block
	 * equals it counts as `bot`, unless a kid edited it since.
	 */
	constructor(
		private readonly world: WorldView, private readonly owned: () => Readonly<Record<string, number>>,
		private readonly shared?: () => Readonly<Record<string, number>>,
	) {}

	classify(x: number, y: number, z: number): CellClass {
		const [cx, cz] = chunkOf(x, z);
		if (!this.verified.has(ck(cx, cz))) this.pending.push(...this.verifyChunk(cx, cz));
		const k = key(x, y, z);
		const mine = this.owned()[k];
		if (mine !== undefined && !this.dropped.has(k) && this.world.getBlock(x, y, z) === mine) return 'bot';
		if (this.shared && !this.kidTouched.has(k)) {
			const s = this.shared()[k];
			if (s !== undefined && this.world.getBlock(x, y, z) === s) return 'bot';
		}
		return this.world.isEdited(x, y, z) ? 'kid' : 'natural';
	}

	ownWrite(x: number, y: number, z: number, newId: number): PatchOp {
		const k = key(x, y, z);
		this.dropped.delete(k);
		const [cx, cz] = chunkOf(x, z);
		this.kidIndex.get(ck(cx, cz))?.delete(k);
		return { path: ['owned', k], value: newId };
	}

	onEdit(e: EditEvent, you: number): Patch {
		if (e.by === you) return [];
		const out: Patch = [];
		for (const c of e.cells) {
			const k = key(c.x, c.y, c.z);
			if (e.byBot) this.kidTouched.delete(k);
			else this.kidTouched.add(k);
			if (this.owned()[k] !== undefined) {
				this.dropped.add(k);
				out.push({ path: ['owned', k], value: undefined });
			}
			const [cx, cz] = chunkOf(c.x, c.z);
			this.kidIndex.get(ck(cx, cz))?.add(k);
		}
		return out;
	}

	reset(): void {
		this.verified.clear();
		this.kidIndex.clear();
	}

	verifyChunk(cx: number, cz: number): Patch {
		this.verified.add(ck(cx, cz));
		const out: Patch = [];
		for (const [k, idv] of Object.entries(this.owned())) {
			const [x, y, z] = k.split(',').map(Number);
			const [kx, kz] = chunkOf(x, z);
			if (kx !== cx || kz !== cz) continue;
			if (this.world.getBlock(x, y, z) !== idv) {
				this.dropped.add(k);
				out.push({ path: ['owned', k], value: undefined });
			}
		}
		return out;
	}

	drainPending(): Patch {
		const p = this.pending;
		this.pending = [];
		return p;
	}

	private kidSet(cx: number, cz: number): Set<string> {
		const id = ck(cx, cz);
		let s = this.kidIndex.get(id);
		if (!s) {
			s = new Set();
			for (const [x, y, z] of this.world.editedCellsInChunk(cx, cz)) if (this.classify(x, y, z) === 'kid') s.add(key(x, y, z));
			this.kidIndex.set(id, s);
		}
		return s;
	}

	kidCellWithin(x: number, z: number, r: number): boolean {
		const [c0x, c0z] = chunkOf(x - r, z - r);
		const [c1x, c1z] = chunkOf(x + r, z + r);
		for (let cx = c0x; cx <= c1x; cx++) {
			for (let cz = c0z; cz <= c1z; cz++) {
				for (const k of this.kidSet(cx, cz)) {
					const [kx, ky, kz] = k.split(',').map(Number);
					if (Math.hypot(kx - x, kz - z) <= r && this.classify(kx, ky, kz) === 'kid') return true;
				}
			}
		}
		return false;
	}

	kidNeighbour(x: number, y: number, z: number, radius: 1 | 2, airOnly = false): boolean {
		for (let dx = -radius; dx <= radius; dx++)
			for (let dy = -radius; dy <= radius; dy++)
				for (let dz = -radius; dz <= radius; dz++) {
					if (dx === 0 && dy === 0 && dz === 0) continue;
					const nx = x + dx, ny = y + dy, nz = z + dz;
					if (this.classify(nx, ny, nz) !== 'kid') continue;
					if (airOnly && this.world.getBlock(nx, ny, nz) !== 0) continue;
					return true;
				}
		return false;
	}
}
