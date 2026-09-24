/**
 * MpSync (spec §7.1): the multiplayer stand-in for AutoSave. It collects this client's writes,
 * sends them once per frame as `edit` batches, applies the echo rule to incoming edits (spec §6),
 * and sends the player's extras (inventory, tools, hotbar) debounced.
 */
import type { World } from '../engine/world/world';
import type { LightRegistry } from '../engine/render/light-registry';
import { worldToChunk, indexOf } from '../engine/world/coords';
import { shouldApplyEcho } from './echo';
import { colorToInt, MAX_OPS_PER_EDIT, type EditOut, type ExtrasData, type Op } from './protocol';

const EXTRAS_DEBOUNCE_MS = 5000;
/** sessionStorage key: the latest extras, re-sent after the next `welcome` (a reconnect reload). */
export const EXTRAS_STASH_KEY = 'mp:extras';

/** The part of `Storage` MpSync uses (sessionStorage in the browser). */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type Stash = { tag: string; data: unknown };

export class MpSync {
	/**
	 * Cells written locally since the last flushFrame → [id, fluid] as written. The live chunk is
	 * read at flush when it is still loaded; the snapshot only covers a chunk evicted in between.
	 */
	private touched = new Map<string, [number, number]>();
	/** Cell → cid of this client's latest own write to it (spec §6). */
	private pending = new Map<string, number>();
	private cid = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * @param world the world whose `onLocalWrite` is set to {@link record} by the caller.
	 * @param lights lamp colours; read at flush time only.
	 * @param send sends one client message (MpClient.send).
	 * @param getExtras the player's current `{inventory, tools, hotbar, selected}`.
	 * @param storage sessionStorage: the extras stash lives there.
	 * @param apply receives the kept ops of each incoming edit (GameLoop.enqueueRemote).
	 * @param stashTag tags the stash (the world uuid and the player name, e.g. `${uuid}:${name}`), so
	 *   it is only ever re-sent by the same player into the world it came from.
	 */
	constructor(
		private world: World,
		private lights: Pick<LightRegistry, 'getColor'> | null,
		private send: (msg: object) => void,
		private getExtras: () => unknown,
		private storage: StorageLike,
		private apply: (ops: Op[]) => void = () => {},
		private stashTag = '',
	) {}

	/**
	 * Installed as `world.onLocalWrite`. Records the cell, plus its id and fluid as a fallback for a
	 * chunk evicted before the flush. The lamp colour is read at flush only (spec §7.1).
	 */
	record = (x: number, y: number, z: number): void => {
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.world.getChunk(cx, cz);
		const snap: [number, number] = c ? [c.get(lx, y, lz), c.fluidMeta.get(indexOf(lx, y, lz)) ?? 0] : [0, 0];
		this.touched.set(`${x},${y},${z}`, snap);
	};

	/**
	 * Called once per tick. Reads id, fluid and lamp colour of every touched cell now, and sends
	 * them in messages of at most MAX_OPS_PER_EDIT ops, each with its own cid.
	 */
	flushFrame(): void {
		if (this.touched.size === 0) return;
		let ops: Op[] = [];
		let keys: string[] = [];
		for (const [k, snap] of this.touched) {
			const [x, y, z] = k.split(',').map(Number);
			const { cx, cz, lx, lz } = worldToChunk(x, z);
			// Never world.getBlock here: it generates unloaded chunks. A chunk evicted since the
			// write sends the id and fluid recorded with it (spec §6: a dropped write is lost for good).
			const c = this.world.getChunk(cx, cz);
			const [id, fluid] = c ? [c.get(lx, y, lz), c.fluidMeta.get(indexOf(lx, y, lz)) ?? 0] : snap;
			const hex = this.lights?.getColor(x, y, z) ?? null;
			ops.push([x, y, z, id, fluid, hex ? colorToInt(hex) : 0]);
			keys.push(k);
			if (ops.length === MAX_OPS_PER_EDIT) {
				this.sendEdit(ops, keys);
				ops = [];
				keys = [];
			}
		}
		if (ops.length > 0) this.sendEdit(ops, keys);
		this.touched.clear();
	}

	private sendEdit(ops: Op[], keys: string[]): void {
		const cid = ++this.cid;
		for (const k of keys) this.pending.set(k, cid);
		this.send({ t: 'edit', cid, ops });
	}

	/** A server-sequenced edit. Own echoes go through the echo rule; everything kept goes to `apply`. */
	onEdit(msg: EditOut, you: number): void {
		const own = msg.by === you && msg.cid !== undefined;
		const kept = own
			? msg.ops.filter((op) => shouldApplyEcho(this.pending, `${op[0]},${op[1]},${op[2]}`, msg.cid!))
			: msg.ops;
		if (kept.length > 0) this.apply(kept);
	}

	/** AutoSave-shaped: extras changed. Sends them 5 s after the first mark; mirrors them to the stash now. */
	markDirty(): void {
		this.writeStash(this.getExtras());
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.sendExtras();
		}, EXTRAS_DEBOUNCE_MS);
	}

	/** AutoSave-shaped: send the extras now. */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.sendExtras();
	}

	/** Called after `welcome`: re-send the stash from before a reconnect reload, then delete it. */
	resendStashed(): void {
		const data = MpSync.readStash(this.storage, this.stashTag);
		try {
			this.storage.removeItem(EXTRAS_STASH_KEY);
		} catch {
			// Storage unavailable: nothing to clear.
		}
		if (data !== null) this.send({ t: 'extras', data });
	}

	/**
	 * The stashed extras for `tag`, or null. The caller building the player after a reconnect
	 * should prefer it over `welcome.extras`, which may predate it.
	 */
	static readStash(storage: StorageLike, tag: string): ExtrasData | null {
		try {
			const raw = storage.getItem(EXTRAS_STASH_KEY);
			if (raw === null) return null;
			const s = JSON.parse(raw) as Stash;
			return s && s.tag === tag && s.data !== undefined ? (s.data as ExtrasData) : null;
		} catch {
			return null;
		}
	}

	private sendExtras(): void {
		const data = this.getExtras();
		this.writeStash(data);
		this.send({ t: 'extras', data });
	}

	private writeStash(data: unknown): void {
		try {
			this.storage.setItem(EXTRAS_STASH_KEY, JSON.stringify({ tag: this.stashTag, data } satisfies Stash));
		} catch {
			// Quota or private mode: the stash is a best-effort safety net.
		}
	}
}
