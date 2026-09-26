/**
 * Kid markers: a kid tags a place by stacking exactly 3 wool of one colour, one on top of the other.
 * - red_wool   → flatten here
 * - blue_wool  → build a house here
 * - green_wool → make a garden here
 * A bot that sees one (live, or in a scan when it starts) posts a 'kid-marker' on the board, once per marker (keyed by
 * colour and base cell), and the nearest watching bot sets off a firework above it so the kid knows it was heard.
 * The marker is the kid's: its cells are kid cells, which every bot's safety already keeps its hands off.
 */
import { blockId } from 'minicraft-bot';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { fireworkTurn, post, sight, type Post } from './board.js';

export type MarkerKind = 'flatten' | 'house' | 'garden';
export const MARKER_WOOL: Readonly<Record<string, MarkerKind>> = { red_wool: 'flatten', blue_wool: 'house', green_wool: 'garden' };
export const MARKER_HEIGHT = 3;
/** How long a watcher waits after its sighting before asking whether it is the nearest (other bots record theirs). */
export const FIREWORK_SETTLE_MS = 2000;

export interface Marker { kind: MarkerKind; block: string; base: Vec3; top: Vec3; key: string }

/**
 * The marker a cell belongs to, or null: the cell is marker wool, its column run of that wool is exactly
 * MARKER_HEIGHT long, and every cell of the run is a kid's (`isKid`).
 */
export function markerAt(world: Pick<WorldView, 'getBlock' | 'blockName'>, isKid: (x: number, y: number, z: number) => boolean, x: number, y: number, z: number): Marker | null {
	const id = world.getBlock(x, y, z);
	const name = world.blockName(id);
	const kind = name ? MARKER_WOOL[name] : undefined;
	if (!kind || !name) return null;
	let lo = y, hi = y;
	while (lo - 1 >= 0 && world.getBlock(x, lo - 1, z) === id && hi - lo < MARKER_HEIGHT + 1) lo--;
	while (world.getBlock(x, hi + 1, z) === id && hi - lo < MARKER_HEIGHT + 1) hi++;
	if (hi - lo + 1 !== MARKER_HEIGHT) return null;
	for (let yy = lo; yy <= hi; yy++) if (!isKid(x, yy, z)) return null;
	return { kind, block: name, base: { x, y: lo, z }, top: { x, y: hi, z }, key: `${name}@${x},${lo},${z}` };
}

export interface WatcherOpts {
	name: string; body: Body; world: WorldView; boardPath: string;
	isKid(x: number, y: number, z: number): boolean;
	log(e: Record<string, unknown>): void;
	clock?: () => number;
	/** Whether the bot may set off the firework now (the --when players pause). Default: always. */
	active?: () => boolean;
	/** Called with each new board post (a bot may act on it). */
	onPost?(p: Post): void;
}

/**
 * Watches kid edits for markers, posts each once and fires the nearest bot's firework. `scan(center, r)` looks at the
 * edited cells around a point (markers placed while the bot was away). Returns the stop function via `stop()`.
 */
export class MarkerWatcher {
	private readonly seen = new Set<string>();
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly unsub: () => void;
	private readonly clock: () => number;
	private readonly wool: ReadonlySet<number>;

	constructor(private readonly o: WatcherOpts) {
		this.clock = o.clock ?? (() => Date.now());
		this.wool = new Set(Object.keys(MARKER_WOOL).map((n) => blockId(n)).filter((v): v is number => v !== null));
		this.unsub = o.body.onEdit((e) => {
			if (e.byBot) return;
			for (const c of e.cells) if (this.wool.has(c.newId)) this.check(c.x, c.y, c.z, e.byName ?? 'kid');
		});
	}

	/** Checks the edited cells of the chunks within `r` of `center` for markers. */
	scan(center: { x: number; z: number }, r: number): number {
		let n = 0;
		for (let cx = Math.floor((center.x - r) / 16); cx <= Math.floor((center.x + r) / 16); cx++) {
			for (let cz = Math.floor((center.z - r) / 16); cz <= Math.floor((center.z + r) / 16); cz++) {
				for (const [x, y, z] of this.o.world.editedCellsInChunk(cx, cz)) if (this.wool.has(this.o.world.getBlock(x, y, z)) && this.check(x, y, z, 'kid')) n++;
			}
		}
		return n;
	}

	/** True when (x, y, z) is part of a marker this watcher had not handled yet. */
	check(x: number, y: number, z: number, by: string): boolean {
		const m = markerAt(this.o.world, this.o.isKid, x, y, z);
		if (!m || this.seen.has(m.key)) return false;
		this.seen.add(m.key);
		const now = this.clock();
		let p: Post;
		try {
			const r = post(this.o.boardPath, { type: 'kid-marker', center: { x: m.base.x, y: m.base.y, z: m.base.z }, requester: by, key: m.key, marker: m.kind, note: `${m.block} × ${MARKER_HEIGHT}` }, now);
			p = r.post;
			this.o.log({ k: 'kid-marker', t: now, marker: m.kind, at: m.base, by, post: p.id, added: r.added });
			if (r.added) this.o.onPost?.(p);
			const me = this.o.body.pose();
			sight(this.o.boardPath, p.id, this.o.name, Math.hypot(me.x - m.base.x, me.y - m.base.y, me.z - m.base.z));
		} catch (err) {
			this.o.log({ k: 'board-error', t: now, err: err instanceof Error ? err.message : String(err) });
			return true;
		}
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			try {
				if ((this.o.active?.() ?? true) && fireworkTurn(this.o.boardPath, p.id, this.o.name)) {
					this.o.body.fx({ kind: 'firework', x: m.top.x, y: m.top.y + 3, z: m.top.z });
					this.o.log({ k: 'marker-firework', t: this.clock(), at: m.top, post: p.id });
				}
			} catch (err) {
				this.o.log({ k: 'board-error', t: this.clock(), err: err instanceof Error ? err.message : String(err) });
			}
		}, FIREWORK_SETTLE_MS);
		this.timers.add(timer);
		return true;
	}

	stop(): void {
		this.unsub();
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
	}
}
