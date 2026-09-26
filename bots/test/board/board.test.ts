import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOARD_CLAIM_MS, boardPath, claimNext, complete, fireworkTurn, list, post, readBoard, renew, sight, type Board } from '../../src/board/board.js';

const BOTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const freshPath = () => boardPath(mkdtempSync(join(tmpdir(), 'board-')), 'local', 'w1');
const need = (i: number) => ({ type: 'flat-needed' as const, center: { x: i * 20, y: 70, z: 0 }, size: 16, requester: 'Robo' });

describe('board', () => {
	it('post → claimNext → complete; a keyed post is added once', () => {
		const path = freshPath();
		expect(post(path, need(0), 1).added).toBe(true);
		const k = { type: 'kid-marker' as const, center: { x: 1, y: 2, z: 3 }, requester: 'Noah', key: 'red@1,2,3', marker: 'flatten' as const };
		const a = post(path, k, 2);
		const b = post(path, k, 3);
		expect(a.added).toBe(true);
		expect(b.added).toBe(false);
		expect(b.post.id).toBe(a.post.id);
		const c = claimNext(path, 'flat-needed', 'Dozer', 10)!;
		expect(c.status).toBe('claimed');
		expect(claimNext(path, 'flat-needed', 'Other', 11)).toBeNull();
		// A restart resumes its own claim.
		expect(claimNext(path, 'flat-needed', 'Dozer', 12)!.id).toBe(c.id);
		expect(complete(path, c.id, 'Other', 13)).toBe(false);
		expect(complete(path, c.id, 'Dozer', 13)).toBe(true);
		expect(list(path, { status: 'done' }).map((p) => p.id)).toEqual([c.id]);
		expect(claimNext(path, 'flat-needed', 'Other', 14)).toBeNull();
	});

	it('a claim not renewed for 15 min expires; a renewed one does not; giving up reopens', () => {
		const path = freshPath();
		post(path, need(0), 0);
		const c = claimNext(path, 'flat-needed', 'Dozer', 1000)!;
		expect(BOARD_CLAIM_MS).toBe(15 * 60_000);
		expect(claimNext(path, 'flat-needed', 'Other', 1000 + BOARD_CLAIM_MS)).toBeNull();
		expect(renew(path, c.id, 'Dozer', 1000 + BOARD_CLAIM_MS)).toBe(true);
		expect(claimNext(path, 'flat-needed', 'Other', 1000 + BOARD_CLAIM_MS + 1)).toBeNull();
		const taken = claimNext(path, 'flat-needed', 'Other', 1000 + 2 * BOARD_CLAIM_MS + 1)!;
		expect(taken.claimedBy).toBe('Other');
		expect(renew(path, c.id, 'Dozer', 1000 + 2 * BOARD_CLAIM_MS + 2)).toBe(false);
		expect(complete(path, c.id, 'Other', 0, { status: 'open' })).toBe(true);
		expect(readBoard(path).posts[0].status).toBe('open');
	});

	it('claimNext honours the filter (a flattened post reserved for its requester)', () => {
		const path = freshPath();
		post(path, { type: 'flattened', region: { x0: 0, z0: 0, x1: 15, z1: 15, y: 70 }, requester: 'Bob' }, 0);
		const mineOrOld = (bot: string, now: number) => (p: { requester: string; t: number }) => p.requester === bot || now - p.t > 60_000;
		expect(claimNext(path, 'flattened', 'Alice', 10, mineOrOld('Alice', 10))).toBeNull();
		expect(claimNext(path, 'flattened', 'Bob', 10, mineOrOld('Bob', 10))!.claimedBy).toBe('Bob');
	});

	it('kid marker firework: only the nearest sighting fires, once', () => {
		const path = freshPath();
		const { post: p } = post(path, { type: 'kid-marker', center: { x: 0, y: 70, z: 0 }, requester: 'Noah', key: 'm1', marker: 'house' }, 0);
		sight(path, p.id, 'Far', 30);
		sight(path, p.id, 'Near', 8);
		expect(fireworkTurn(path, p.id, 'Far')).toBe(false);
		expect(fireworkTurn(path, p.id, 'Near')).toBe(true);
		expect(fireworkTurn(path, p.id, 'Near')).toBe(false);
	});

	it('eight processes racing on one board: every post claimed exactly once', async () => {
		const n = 200;
		const path = freshPath();
		const b: Board = { v: 1, posts: Array.from({ length: n }, (_, i) => ({ ...need(i), id: `p${i}`, status: 'open' as const, t: 0 })) };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(b));
		const runs = Array.from({ length: 8 }, (_, i) => new Promise<string[]>((res, rej) => {
			const p = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/board-claim-child.ts', path, `bot${i}`], { cwd: BOTS });
			let out = '';
			let err = '';
			p.stdout.on('data', (d) => (out += d));
			p.stderr.on('data', (d) => (err += d));
			p.on('close', (code) => (code === 0 ? res(JSON.parse(out) as string[]) : rej(new Error(`child ${i}: ${code} ${err}`))));
		}));
		const t0 = Date.now();
		while (Date.now() - t0 < 40_000 && !Array.from({ length: 8 }, (_, i) => existsSync(`${path}.ready-bot${i}`)).every(Boolean)) await new Promise((r) => setTimeout(r, 50));
		writeFileSync(`${path}.go`, '');
		const got = await Promise.all(runs);
		const all = got.flat();
		expect(all.filter((x) => x.startsWith('LOST'))).toEqual([]);
		expect(all.length).toBe(n);
		expect(new Set(all).size).toBe(n);
		expect(got.filter((g) => g.length > 0).length).toBeGreaterThan(1);
		const final = JSON.parse(readFileSync(path, 'utf8')) as Board;
		expect(final.posts.every((q) => q.status === 'done')).toBe(true);
	}, 60_000);
});
