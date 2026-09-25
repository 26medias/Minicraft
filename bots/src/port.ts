/**
 * The port (spec §6): the only surface the companion uses. Unit tests fake it (`test/fake-port.ts`)
 * instead of a socket — the SDK's private `BotWorld` constructor and its test-only `FakeWS` are not
 * reachable from `bots/` (spec §6 ruling). `realPort` is the thin adapter over a connected
 * `BotClient`; it is exercised against a real server in the e2e (Task 7), which is also where the
 * fake `WorldView`'s parity with the real SDK is checked (§12a).
 */
import { generateChunkBlocks, raycastVoxel } from 'minicraft-bot';
import type { BotClient, BotPlayer, FxMsg, JournalEntry, PoseInput, VoxelHit, WalkResult, WorldListing } from 'minicraft-bot';
import type { EditCell, EditEvent, Pose } from './types.js';

/** Another player as the port sees it: the SDK's `BotPlayer` (`hasPos: false` = no pose yet). */
export type PlayerView = BotPlayer;

export type Tuple3 = [number, number, number];

/** The bot's body: moving, looking, editing and hearing about edits. Mirrors `BotClient`. */
export interface Body {
	/** The bot's own player id in the current connection (it can change on a reconnect). */
	readonly you: number;
	pose(): Pose;
	players(): PlayerView[];
	walkTo(target: { x: number; z: number }): Promise<WalkResult>;
	flyTo(target: { x: number; y: number; z: number }): Promise<WalkResult>;
	move(pose: PoseInput): void;
	lookAt(x: number, y: number, z: number): void;
	place(x: number, y: number, z: number, name: string): Promise<boolean>;
	revert(sinceMs?: number): Promise<number>;
	journal(): JournalEntry[];
	/** Every server-ordered edit (anyone's, the bot's own echoes included). Returns the unsubscribe. */
	onEdit(cb: (edit: EditEvent) => void): () => void;
	onFx(cb: (fx: FxMsg) => void): () => void;
}

/** A read-only view of the world. Mirrors `BotWorld`, plus the generated terrain and `mustMine`. */
export interface WorldView {
	getBlock(x: number, y: number, z: number): number;
	blockName(id: number): string | null;
	isSolid(id: number): boolean;
	isLiquid(id: number): boolean;
	/** The feet y of the first standable cell at or below `nearY + 2`, or `null` (SDK README rule). */
	groundY(x: number, z: number, nearY: number): number | null;
	/** The first solid cell along a ray within `max`, as the game aims, or `null`. */
	raycast(origin: Tuple3, dir: Tuple3, max: number): VoxelHit | null;
	/** The block id at a cell as the world generator made it, before any edit. */
	generatedBlock(x: number, y: number, z: number): number;
	/** The world's `mustMine` flag, from its `listWorlds()` row. */
	readonly mustMine: boolean;
}

export interface Port {
	body: Body;
	world: WorldView;
}

const CHUNK = 16;

/**
 * A generated-terrain lookup over `generateChunkBlocks(seed, gen, cx, cz)`, one cached chunk at a
 * time (index `y·256 + z·16 + x`, local x/z). Outside the world (or the chunk's height) it is air (0).
 * Shared by `realPort` and the fake port so both read the generator the same way.
 */
export function generatedLookup(seed: number, gen: number): (x: number, y: number, z: number) => number {
	const cache = new Map<string, Uint16Array>();
	return (x, y, z) => {
		const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
		const cx = Math.floor(fx / CHUNK), cz = Math.floor(fz / CHUNK);
		const key = `${cx},${cz}`;
		let blocks = cache.get(key);
		if (!blocks) {
			blocks = generateChunkBlocks(seed, gen, cx, cz);
			cache.set(key, blocks);
		}
		const height = blocks.length / (CHUNK * CHUNK);
		if (fy < 0 || fy >= height) return 0;
		return blocks[fy * CHUNK * CHUNK + (fz - cz * CHUNK) * CHUNK + (fx - cx * CHUNK)];
	};
}

/**
 * The real adapter over a connected `BotClient`. `listing` is the `listWorlds()` row that `--world`
 * resolved: `mustMine` comes from it, since `connect()` doesn't return it (§12a).
 *
 * Edits: the SDK applies a server edit to the world (firing `onBlockChange` per changed cell, with
 * the cell's old id) and only then emits `edit` with the whole message. The adapter collects the
 * block changes of the edit being applied and hands both out together as one `EditEvent`, so the
 * stop signal sees each cell's old id and perception sees the op count.
 */
export function realPort(client: BotClient, listing: WorldListing): Port {
	const world = client.world;
	const generated = generatedLookup(world.seed, world.gen);
	const editListeners = new Set<(edit: EditEvent) => void>();
	let pending = new Map<string, number | null>();

	world.onBlockChange((x, y, z, oldId, _newId, by) => {
		// The bot's own local writes fire here too, outside any server edit: they are not part of the
		// next remote edit, and its echo (same author) never matters to perception or the stop signal.
		if (by === client.you) return;
		pending.set(`${x},${y},${z}`, oldId);
	});
	client.on('edit', (msg) => {
		const changed = pending;
		pending = new Map();
		const author = client.players().find((p) => p.id === msg.by);
		const isSelf = msg.by === client.you;
		const cells: EditCell[] = msg.ops.map(([x, y, z, id]) => ({ x, y, z, oldId: changed.get(`${x},${y},${z}`) ?? null, newId: id }));
		const event: EditEvent = {
			by: msg.by,
			byName: isSelf ? null : (author?.name ?? null),
			byBot: isSelf || (author?.bot ?? false),
			opCount: msg.ops.length,
			cells,
		};
		for (const cb of [...editListeners]) cb(event);
	});

	const body: Body = {
		get you() {
			return client.you;
		},
		pose: () => client.pose(),
		players: () => client.players(),
		walkTo: (t) => client.walkTo(t),
		flyTo: (t) => client.flyTo(t),
		move: (p) => client.move(p),
		lookAt: (x, y, z) => client.lookAt(x, y, z),
		place: (x, y, z, name) => client.place(x, y, z, name),
		revert: (sinceMs) => client.revert(sinceMs),
		journal: () => client.journal(),
		onEdit(cb) {
			editListeners.add(cb);
			return () => {
				editListeners.delete(cb);
			};
		},
		onFx: (cb) => client.on('fx', cb),
	};

	const view: WorldView = {
		getBlock: (x, y, z) => world.getBlock(x, y, z),
		blockName: (id) => world.blockName(id),
		isSolid: (id) => world.isSolid(id),
		isLiquid: (id) => world.isLiquid(id),
		groundY: (x, z, nearY) => world.groundY(x, z, nearY),
		raycast: (origin, dir, max) => raycastVoxel(world, origin, dir, max),
		generatedBlock: generated,
		mustMine: listing.mustMine,
	};

	return { body, world: view };
}
