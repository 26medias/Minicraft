/**
 * The shared board: `<stateRoot>/shared/<target>/<world>/board.json`, where bots (and, through wool markers, the kid)
 * post and pick up work about places: an area that needs flattening, an area flattened and ready to build on, a build
 * or decoration request, a kid's marker. A post is open → claimed (by one bot) → done. A claim not renewed for
 * CLAIM_MS (a crashed bot) expires and the post can be claimed again.
 *
 * Same file discipline as the foreman's plan.json (it reuses its lock): every read-modify-write under withPlanLock
 * (a mkdir'd lock directory beside the file), and atomic writes (a temp file, then rename).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAIM_MS, withPlanLock } from '../foreman/plan-file.js';

export const BOARD_CLAIM_MS = CLAIM_MS;

export type PostType = 'flat-needed' | 'flattened' | 'build-request' | 'decorate' | 'kid-marker';
export type PostStatus = 'open' | 'claimed' | 'done';
/** An inclusive horizontal box, with the floor's top y when known (a flattened area). */
export interface Region { x0: number; z0: number; x1: number; z1: number; y?: number }
export interface Post {
	id: string;
	type: PostType;
	region?: Region;
	center?: { x: number; y: number; z: number };
	/** The side of the square wanted (flat-needed, build-request), in blocks. */
	size?: number;
	/** Who asked (a bot name, or the kid's name for a marker). A 'flattened' post is reserved for it first. */
	requester: string;
	status: PostStatus;
	claimedBy?: string;
	claimTs?: number;
	note?: string;
	t: number;
	doneTs?: number;
	/** Dedupe key: a second post with the same key is not added (a kid marker is posted once). */
	key?: string;
	/** kid-marker: what the marker asks for. */
	marker?: 'flatten' | 'house' | 'garden';
	/** kid-marker: the bots that saw it and how far they were; the nearest one sets off the firework. */
	sightings?: Record<string, number>;
	fireworkBy?: string;
}
export interface Board { v: 1; posts: Post[] }
export type NewPost = Omit<Post, 'id' | 'status' | 't' | 'claimedBy' | 'claimTs' | 'doneTs'>;

export function boardPath(stateRoot: string, target: string, world: string): string {
	return join(stateRoot, 'shared', target, world, 'board.json');
}

export function readBoard(path: string): Board {
	try {
		const b = JSON.parse(readFileSync(path, 'utf8')) as Board;
		if (b && b.v === 1 && Array.isArray(b.posts)) return b;
	} catch {
		// missing or unreadable: empty
	}
	return { v: 1, posts: [] };
}

function writeBoard(path: string, b: Board): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, JSON.stringify(b));
	renameSync(tmp, path);
}

/** Read-modify-write under the lock; `fn` returns the result and whether to write. */
function update<T>(path: string, fn: (b: Board) => { out: T; write: boolean }): T {
	return withPlanLock(path, () => {
		const b = readBoard(path);
		const { out, write } = fn(b);
		if (write) writeBoard(path, b);
		return out;
	});
}

/** Whether a post can be claimed now: open, or claimed with a claim older than `claimMs`. */
export function claimablePost(p: Post, now: number, claimMs = BOARD_CLAIM_MS): boolean {
	return p.status === 'open' || (p.status === 'claimed' && now - (p.claimTs ?? 0) > claimMs);
}

/** Adds a post (open). With `key`, returns the existing post of that key instead of adding a second one. */
export function post(path: string, p: NewPost, now: number): { post: Post; added: boolean } {
	return update<{ post: Post; added: boolean }>(path, (b) => {
		const same = p.key ? b.posts.find((q) => q.key === p.key) : undefined;
		if (same) return { out: { post: same, added: false }, write: false };
		const np: Post = { ...p, id: `${p.type}-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, status: 'open', t: now };
		b.posts.push(np);
		return { out: { post: np, added: true }, write: true };
	});
}

/**
 * Claims a post of `type` for `bot`: the one of that type it already holds (a restart resumes it), else the first
 * claimable one `filter` accepts, else null.
 */
export function claimNext(path: string, type: PostType, bot: string, now: number, filter: (p: Post) => boolean = () => true, claimMs = BOARD_CLAIM_MS): Post | null {
	return update(path, (b) => {
		let p = b.posts.find((q) => q.type === type && q.status === 'claimed' && q.claimedBy === bot && filter(q)) ?? null;
		p ??= b.posts.find((q) => q.type === type && claimablePost(q, now, claimMs) && filter(q)) ?? null;
		if (!p) return { out: null, write: false };
		p.status = 'claimed';
		p.claimedBy = bot;
		p.claimTs = now;
		return { out: { ...p }, write: true };
	});
}

/** Renews `bot`'s claim on post `id`; false when it is no longer this bot's. */
export function renew(path: string, id: string, bot: string, now: number): boolean {
	return update(path, (b) => {
		const p = b.posts.find((q) => q.id === id);
		if (!p || p.status !== 'claimed' || p.claimedBy !== bot) return { out: false, write: false };
		p.claimTs = now;
		return { out: true, write: true };
	});
}

/** Ends `bot`'s claim on post `id`: done, or back to open (gave up). False when it is no longer this bot's. */
export function complete(path: string, id: string, bot: string, now: number, u: { status?: 'done' | 'open'; note?: string } = {}): boolean {
	return update(path, (b) => {
		const p = b.posts.find((q) => q.id === id);
		if (!p || p.status !== 'claimed' || p.claimedBy !== bot) return { out: false, write: false };
		if (u.note !== undefined) p.note = u.note;
		if ((u.status ?? 'done') === 'done') {
			p.status = 'done';
			p.doneTs = now;
		} else {
			p.status = 'open';
			delete p.claimedBy;
			delete p.claimTs;
		}
		return { out: true, write: true };
	});
}

/** The posts, optionally of one type / status. */
export function list(path: string, q: { type?: PostType; status?: PostStatus } = {}): Post[] {
	return readBoard(path).posts.filter((p) => (!q.type || p.type === q.type) && (!q.status || p.status === q.status));
}

/** Records that `bot` saw kid marker post `id` from `dist` blocks away. */
export function sight(path: string, id: string, bot: string, dist: number): void {
	update(path, (b) => {
		const p = b.posts.find((q) => q.id === id);
		if (!p) return { out: undefined, write: false };
		p.sightings = { ...(p.sightings ?? {}), [bot]: Math.round(dist * 10) / 10 };
		return { out: undefined, write: true };
	});
}

/**
 * A kid marker's firework (the nearest bot sets it off): true once, for the bot with the smallest sighting, when no
 * bot has fired yet. Call it a couple of seconds after `sight`, so every bot watching has had time to record its own.
 */
export function fireworkTurn(path: string, id: string, bot: string): boolean {
	return update(path, (b) => {
		const p = b.posts.find((q) => q.id === id);
		if (!p || p.fireworkBy || !p.sightings) return { out: false, write: false };
		const nearest = Object.entries(p.sightings).sort((a, c) => a[1] - c[1] || a[0].localeCompare(c[0]))[0]?.[0];
		if (nearest !== bot) return { out: false, write: false };
		p.fireworkBy = bot;
		return { out: true, write: true };
	});
}
