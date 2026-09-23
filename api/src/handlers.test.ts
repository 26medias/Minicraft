import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, type BucketLike } from './handlers';
import { FakeBucket } from './fakeStorage';
import { validWire, validWireV3, chunkBlocks, manyChunks, FIXTURE_ID } from './testFixtures';
import type { WorldSaveWireV3 } from './schema';

const NEW = { 'If-None-Match': '*' };

describe('worlds API', () => {
	let bucket: FakeBucket;
	let app: ReturnType<typeof createApp>;

	beforeEach(() => {
		bucket = new FakeBucket();
		app = createApp(bucket as unknown as BucketLike);
	});

	function put(w = validWire(), headers: Record<string, string> = NEW) {
		return request(app).put(`/worlds/${w.id}`).set(headers).send(w);
	}

	it('round-trips a world', async () => {
		const w = validWire();
		await put(w).expect(200);
		const got = await request(app).get(`/worlds/${w.id}`).expect(200);
		expect(got.body).toMatchObject(w);
	});

	it('returns the generation in the PUT response body and header', async () => {
		const r = await put().expect(200);
		expect(r.body.generation).toBeTruthy();
		expect(r.headers['x-generation']).toBe(String(r.body.generation));
		expect(r.body.updatedAt).toBe(validWire().updatedAt);
	});

	it('lists worlds from metadata without downloading bodies', async () => {
		const w = validWire();
		await put(w).expect(200);
		bucket.failOnDownload = true;
		const list = await request(app).get('/worlds').expect(200);
		expect(list.body).toHaveLength(1);
		expect(list.body[0]).toMatchObject({ id: w.id, name: w.name, seed: w.seed });
	});

	it('rejects a non-uuid id before touching storage', async () => {
		// Not '/worlds/../../etc/passwd': supertest normalizes that away before it
		// leaves the client, so the route never matches and any server returns 404.
		for (const bad of [
			'/worlds/not-a-uuid',
			'/worlds/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd',
			`/worlds/${'a'.repeat(500)}`,
		]) {
			await request(app).get(bad).expect(400);
		}
		expect(bucket.calls).toBe(0);
	});

	it('sets CORS headers on error responses too', async () => {
		const bad = await request(app).get('/worlds/not-a-uuid').expect(400);
		expect(bad.headers['access-control-allow-origin']).toBeTruthy();
		const missing = await request(app)
			.get('/worlds/33333333-3333-4333-8333-333333333333')
			.expect(404);
		expect(missing.headers['access-control-allow-origin']).toBeTruthy();
	});

	it('answers CORS preflight', async () => {
		const r = await request(app).options('/worlds').expect(204);
		expect(r.headers['access-control-allow-origin']).toBeTruthy();
		expect(r.headers['access-control-allow-methods']).toContain('PUT');
	});

	it('rejects a body whose id disagrees with the path', async () => {
		const w = validWire();
		await request(app)
			.put('/worlds/44444444-4444-4444-8444-444444444444')
			.set(NEW)
			.send(w)
			.expect(400);
	});

	it('rejects a PUT with no precondition', async () => {
		const w = validWire();
		await request(app).put(`/worlds/${w.id}`).send(w).expect(428);
	});

	it('rejects an over-cap content-length before parsing the body', async () => {
		const w = validWire();
		const r = await request(app)
			.put(`/worlds/${w.id}`)
			.set({ ...NEW, 'Content-Length': String(33 * 1024 * 1024) })
			.send(w);
		expect(r.status).toBe(413);
	});

	it('leaves the stored object unchanged when a chunk is corrupt', async () => {
		const w = validWire();
		await put(w).expect(200);
		const gen = (await request(app).get(`/worlds/${w.id}`)).headers['x-generation'];

		const bad = { ...w, chunks: [{ ...w.chunks[0], blocks: 'not-valid-base64!!!' }] };
		await request(app).put(`/worlds/${w.id}`).set({ 'If-Match': gen }).send(bad).expect(400);

		const got = await request(app).get(`/worlds/${w.id}`).expect(200);
		expect(got.body).toMatchObject(w);
	});

	it('rejects an out-of-range fluidMeta index', async () => {
		const w = validWire();
		const bad = { ...w, chunks: [{ ...w.chunks[0], fluidMeta: 'garbage' }] };
		await request(app).put(`/worlds/${w.id}`).set(NEW).send(bad).expect(400);
	});

	it('rejects duplicate chunk coordinates', async () => {
		const w = validWire();
		const bad = { ...w, chunks: [w.chunks[0], { ...w.chunks[0] }] };
		await request(app).put(`/worlds/${w.id}`).set(NEW).send(bad).expect(400);
	});

	it('rejects a suspicious shrink', async () => {
		const w = validWire({ chunks: manyChunks(10) });
		await put(w).expect(200);
		const gen = (await request(app).get(`/worlds/${w.id}`)).headers['x-generation'];
		await request(app)
			.put(`/worlds/${w.id}`)
			.set({ 'If-Match': gen })
			.send({ ...w, chunks: manyChunks(2) })
			.expect(400);
	});

	it('allows a legitimate small change to a large world', async () => {
		const w = validWire({ chunks: manyChunks(10) });
		await put(w).expect(200);
		const gen = (await request(app).get(`/worlds/${w.id}`)).headers['x-generation'];
		await request(app)
			.put(`/worlds/${w.id}`)
			.set({ 'If-Match': gen })
			.send({ ...w, chunks: manyChunks(9) })
			.expect(200);
	});

	it('returns 409 on a generation mismatch', async () => {
		const w = validWire();
		await put(w).expect(200);
		await request(app).put(`/worlds/${w.id}`).set({ 'If-Match': '999' }).send(w).expect(409);
	});

	it('returns 409 when a new-world PUT hits an existing id', async () => {
		const w = validWire();
		await put(w).expect(200);
		await put(w).expect(409);
	});

	it('never skips a world whose metadata is unreadable', async () => {
		bucket.putRaw('worlds/22222222-2222-4222-8222-222222222222.json', '{}', {});
		const list = await request(app).get('/worlds').expect(200);
		expect(list.body).toHaveLength(1);
		expect(list.body[0].degraded).toBe(true);
		expect(list.body[0].id).toBe('22222222-2222-4222-8222-222222222222');
	});

	it('ignores objects that are not worlds/{uuid}.json', async () => {
		bucket.putRaw('worlds/notes.txt', 'hi', {});
		const list = await request(app).get('/worlds').expect(200);
		expect(list.body).toHaveLength(0);
	});

	it('404s a missing world', async () => {
		await request(app).get(`/worlds/${FIXTURE_ID}`).expect(404);
		await request(app).delete(`/worlds/${FIXTURE_ID}`).expect(404);
	});

	it('deletes a world', async () => {
		const w = validWire();
		await put(w).expect(200);
		await request(app).delete(`/worlds/${w.id}`).expect(204);
		await request(app).get(`/worlds/${w.id}`).expect(404);
	});

	it('accepts a world with an emoji name and a negative seed', async () => {
		const w = validWire({ name: 'Château 🏰 Noah', seed: -4242 });
		await put(w).expect(200);
		const got = await request(app).get(`/worlds/${w.id}`).expect(200);
		expect(got.body.name).toBe('Château 🏰 Noah');
		expect(got.body.seed).toBe(-4242);
	});

	it('health check responds', async () => {
		await request(app).get('/health').expect(200, { ok: true, codec: 3 });
	});
});

describe('worlds API v3', () => {
	let bucket: FakeBucket;
	let app: ReturnType<typeof createApp>;
	beforeEach(() => {
		bucket = new FakeBucket();
		app = createApp(bucket as unknown as BucketLike);
	});
	const put3 = (w = validWireV3(), headers: Record<string, string> = NEW) =>
		request(app).put(`/v3/worlds/${w.id}`).set(headers).send(w);

	it('round-trips a 256 world under worlds3/ and lists it with its height', async () => {
		const w = validWireV3();
		await put3(w).expect(200);
		expect([...bucket.entries.keys()]).toEqual([`worlds3/${w.id}.json`]);
		const got = await request(app).get(`/v3/worlds/${w.id}`).expect(200);
		expect(got.body).toMatchObject({ version: 3, height: 256, genVersion: 2 });
		const list = await request(app).get('/v3/worlds').expect(200);
		expect(list.body[0]).toMatchObject({ id: w.id, height: 256, genVersion: 2 });
	});

	it('rejects a 65536-length chunk claimed as height 64, and a 16384 chunk claimed as 256', async () => {
		await put3(validWireV3({ height: 64 }))
			.expect(400)
			.then((r) => expect(r.body.code).toBe('BAD_CHUNK'));
		await put3(validWireV3({ chunks: [{ cx: 0, cz: 0, blocks: chunkBlocks(3, 16384) }] }))
			.expect(400)
			.then((r) => expect(r.body.code).toBe('BAD_CHUNK'));
	});

	it('rejects a v3 body missing height (strict schema)', async () => {
		const w = validWireV3() as Record<string, unknown>;
		delete w.height;
		await request(app).put(`/v3/worlds/${validWireV3().id}`).set(NEW).send(w).expect(400);
	});

	it('rejects unknown keys instead of stripping them', async () => {
		await put3({ ...validWireV3(), bogus: 1 } as unknown as WorldSaveWireV3).expect(400);
	});

	it('stores height and genVersion in object metadata (the list reads only metadata)', async () => {
		const w = validWireV3();
		await put3(w).expect(200);
		bucket.failOnDownload = true;
		const list = await request(app).get('/v3/worlds').expect(200);
		expect(list.body[0]).toMatchObject({ height: 256, genVersion: 2 });
	});

	it('old /worlds list does not see worlds3/ objects and /v3 list does not see worlds/', async () => {
		await put3(validWireV3()).expect(200);
		await request(app).put(`/worlds/${FIXTURE_ID}`).set(NEW).send(validWire()).expect(200);
		expect((await request(app).get('/worlds').expect(200)).body).toHaveLength(1);
		expect((await request(app).get('/v3/worlds').expect(200)).body).toHaveLength(1);
	});

	it('applies the shrink guard on /v3', async () => {
		const w = validWireV3({
			chunks: Array.from({ length: 10 }, (_, i) => ({ cx: i, cz: 0, blocks: chunkBlocks(3, 65536) })),
		});
		const first = await put3(w).expect(200);
		await put3({ ...w, chunks: w.chunks.slice(0, 2) }, { 'If-Match': first.body.generation })
			.expect(400)
			.then((r) => expect(r.body.code).toBe('SUSPICIOUS_SHRINK'));
	});
});
describe('crafting fields through the API (crafting spec §10)', () => {
	let bucket: FakeBucket;
	let app: ReturnType<typeof createApp>;
	beforeEach(() => {
		bucket = new FakeBucket();
		app = createApp(bucket as unknown as BucketLike);
	});

	const EXTRAS = {
		inventory: { stone: 12, dirt: 0, deepslate_emerald_ore: 1 },
		tools: { owned: [0, 1, 3], equipped: 3 },
	};

	for (const route of [
		{ name: 'v2', prefix: '/worlds', make: () => validWire() as Record<string, unknown> },
		{ name: 'v3', prefix: '/v3/worlds', make: () => validWireV3() as unknown as Record<string, unknown> },
	]) {
		it(`round-trips inventory, tools and mustMine on ${route.name} with exact equality`, async () => {
			// Catches: a schema that strips the fields (v2 today: 200 and the counts are
			// gone) or refuses them (v3 today: 400 on the unknown mustMine key).
			const base = route.make();
			const w = { ...base, mustMine: true, player: { ...(base.player as object), ...EXTRAS } };
			await request(app).put(`${route.prefix}/${FIXTURE_ID}`).set(NEW).send(w).expect(200);
			const got = await request(app).get(`${route.prefix}/${FIXTURE_ID}`).expect(200);
			expect(got.body.player.inventory).toEqual(EXTRAS.inventory);
			expect(got.body.player.tools).toEqual(EXTRAS.tools);
			expect(got.body.mustMine).toBe(true);
		});

		it(`stores a pre-crafting ${route.name} body as it came, without inventing the fields`, async () => {
			// Catches: the API filling defaults into an old client's save. A stored `{}`
			// is indistinguishable from "used up everything" and the guard could not help.
			await request(app).put(`${route.prefix}/${FIXTURE_ID}`).set(NEW).send(route.make()).expect(200);
			const got = await request(app).get(`${route.prefix}/${FIXTURE_ID}`).expect(200);
			expect('inventory' in got.body.player).toBe(false);
			expect('tools' in got.body.player).toBe(false);
			expect('mustMine' in got.body).toBe(false);
		});
	}
});
