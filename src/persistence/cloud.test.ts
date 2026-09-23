import { describe, it, expect, vi, afterEach } from 'vitest';
import { CloudAdapter } from './cloud';
import type { WorldSave } from './adapter';
import { SaveCorrupt } from './errors';
const BLOCKS_PER_CHUNK = 16 * 64 * 16;

const ID = '11111111-1111-4111-8111-111111111111';

function save(over: Partial<WorldSave> = {}): WorldSave {
	const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
	blocks[0] = 3;
	return {
		version: 2,
		height: 64,
		genVersion: 1,
		id: ID,
		seed: 1,
		name: 'Castle',
		createdAt: 1000,
		updatedAt: 2000,
		player: { x: 0, y: 60, z: 0, yaw: 0, pitch: 0, hotbar: [1], selected: 0 },
		chunks: [{ cx: 0, cz: 0, blocks }],
		...over,
	};
}

function res(status: number, body: unknown = {}, gen?: string) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (k: string) => (k === 'X-Generation' ? (gen ?? null) : null) },
		json: async () => body,
	};
}

function stubFetch(...responses: unknown[]) {
	const calls: { url: string; init?: RequestInit }[] = [];
	let i = 0;
	const fn = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const r = responses[Math.min(i, responses.length - 1)];
		i++;
		if (r instanceof Error) throw r;
		return r;
	});
	vi.stubGlobal('fetch', fn);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('CloudAdapter error mapping', () => {
	it('maps a thrown fetch to NETWORK', async () => {
		stubFetch(new TypeError('offline'));
		const a = new CloudAdapter('https://api.test');
		await expect(a.loadWorld(ID)).rejects.toMatchObject({ code: 'NETWORK' });
	});

	it('maps 413 to TOO_LARGE', async () => {
		stubFetch(res(413));
		const a = new CloudAdapter('https://api.test');
		await expect(a.saveWorld(save())).rejects.toMatchObject({ code: 'TOO_LARGE' });
	});

	it('maps 500 to SERVER', async () => {
		stubFetch(res(500));
		const a = new CloudAdapter('https://api.test');
		await expect(a.saveWorld(save())).rejects.toMatchObject({ code: 'SERVER' });
	});

	it('returns null rather than throwing for a missing world', async () => {
		stubFetch(res(404));
		const a = new CloudAdapter('https://api.test');
		expect(await a.loadWorld(ID)).toBeNull();
	});
});

describe('CloudAdapter generation handling', () => {
	it('sends If-None-Match:* for a world it has never loaded', async () => {
		const calls = stubFetch(res(200, { generation: '1' }));
		const a = new CloudAdapter('https://api.test');
		await a.saveWorld(save());
		const headers = calls[0].init!.headers as Record<string, string>;
		expect(headers['If-None-Match']).toBe('*');
		expect(headers['If-Match']).toBeUndefined();
	});

	it('sends the generation it loaded from on a subsequent save', async () => {
		const calls = stubFetch(
			res(200, { ...wire(), generation: '7' }, '7'),
			res(200, { generation: '8' }),
		);
		const a = new CloudAdapter('https://api.test');
		await a.loadWorld(ID);
		await a.saveWorld(save());
		const headers = calls[1].init!.headers as Record<string, string>;
		expect(headers['If-Match']).toBe('7');
	});

	it('uses If-None-Match:* for the first save of a world loaded offline', async () => {
		// The tablet played offline, so it never adopted a cloud generation. Sending
		// a freshly fetched one would match what another device wrote and clobber it.
		const calls = stubFetch(res(200, { generation: '9' }));
		const a = new CloudAdapter('https://api.test');
		a.markUnsynced(ID);
		await a.saveWorld(save());
		const headers = calls[0].init!.headers as Record<string, string>;
		expect(headers['If-None-Match']).toBe('*');
	});
});

describe('CloudAdapter conflict handling', () => {
	it('treats a 409 whose stored updatedAt matches our attempt as our own write', async () => {
		// A committed PUT whose response was lost looks identical to a real conflict.
		const calls = stubFetch(
			res(409),
			res(200, { ...wire(), updatedAt: 2000, generation: '77' }, '77'),
		);
		const a = new CloudAdapter('https://api.test');
		const out = await a.saveWorld(save({ updatedAt: 2000 }));
		expect(out.cloud).toBe('ok');
		expect(a.generationFor(ID)).toBe('77');
		expect(calls).toHaveLength(2);
	});

	it('reports CONFLICT when the stored updatedAt differs', async () => {
		stubFetch(res(409), res(200, { ...wire(), updatedAt: 99999, generation: '77' }, '77'));
		const a = new CloudAdapter('https://api.test');
		await expect(a.saveWorld(save({ updatedAt: 2000 }))).rejects.toMatchObject({
			code: 'CONFLICT',
		});
	});
});

describe('CloudAdapter round-trip', () => {
	it('encodes chunks on the way out and decodes them on the way back', async () => {
		const calls = stubFetch(res(200, { generation: '1' }));
		const a = new CloudAdapter('https://api.test');
		await a.saveWorld(save());
		const sent = JSON.parse(calls[0].init!.body as string);
		expect(typeof sent.chunks[0].blocks).toBe('string');

		vi.unstubAllGlobals();
		stubFetch(res(200, { ...wire(), chunks: sent.chunks }, '1'));
		const b = new CloudAdapter('https://api.test');
		const loaded = await b.loadWorld(ID);
		expect(loaded!.chunks[0].blocks).toBeInstanceOf(Uint16Array);
		expect(loaded!.chunks[0].blocks[0]).toBe(3);
	});

	it('reuses pre-encoded chunks instead of encoding again', async () => {
		const calls = stubFetch(res(200, { generation: '1' }));
		const a = new CloudAdapter('https://api.test');
		const pre = [{ cx: 5, cz: 6, blocks: 'PRE-ENCODED' }];
		await a.saveWorld(save(), pre);
		const sent = JSON.parse(calls[0].init!.body as string);
		expect(sent.chunks).toEqual(pre);
	});
});

function wire() {
	const s = save();
	return {
		version: 2,
		id: s.id,
		seed: s.seed,
		name: s.name,
		createdAt: s.createdAt,
		updatedAt: s.updatedAt,
		player: s.player,
		chunks: [],
	};
}

function tallSave(): WorldSave {
	return save({ version: 3, height: 256, genVersion: 2, chunks: [{ cx: 0, cz: 0, blocks: new Uint16Array(65536) }] });
}

describe('CloudAdapter v3 routing', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('loads a v3 world from /v3/worlds/:id', async () => {
		const a = new CloudAdapter('https://api');
		const wire = { ...tallSave(), chunks: a.encode(tallSave()) };
		const calls = stubFetch(res(200, wire, 'g1'));
		const loaded = await a.loadWorld(ID);
		expect(calls[0].url).toBe(`https://api/v3/worlds/${ID}`);
		expect(loaded).toMatchObject({ version: 3, height: 256, genVersion: 2 });
		expect(loaded!.chunks[0].blocks.length).toBe(65536);
	});

	it('falls through to /worlds/:id for a v2 world and normalises height 64', async () => {
		const a = new CloudAdapter('https://api');
		const wire = { ...save(), chunks: a.encode(save()) };
		const calls = stubFetch(res(404), res(200, wire, 'g2'));
		const loaded = await a.loadWorld(ID);
		expect(calls.map((c) => c.url)).toEqual([`https://api/v3/worlds/${ID}`, `https://api/worlds/${ID}`]);
		expect(loaded).toMatchObject({ version: 2, height: 64, genVersion: 1 });
	});

	it('returns null only when both namespaces 404', async () => {
		const a = new CloudAdapter('https://api');
		stubFetch(res(404), res(404));
		expect(await a.loadWorld(ID)).toBeNull();
	});

	it('refuses a v3 body without a valid height', async () => {
		const a = new CloudAdapter('https://api');
		const wire = { ...tallSave(), chunks: a.encode(tallSave()) } as Record<string, unknown>;
		delete wire.height;
		stubFetch(res(200, wire, 'g1'));
		await expect(a.loadWorld(ID)).rejects.toThrow(SaveCorrupt);
	});

	it('PUTs a tall world to /v3 with height and genVersion in the body', async () => {
		const a = new CloudAdapter('https://api');
		const calls = stubFetch(res(200, { generation: '5' }));
		await a.saveWorld(tallSave());
		expect(calls[0].url).toBe(`https://api/v3/worlds/${ID}`);
		expect(JSON.parse(calls[0].init!.body as string)).toMatchObject({ version: 3, height: 256, genVersion: 2 });
	});

	it('PUTs a v2 world to /worlds without the new fields', async () => {
		const a = new CloudAdapter('https://api');
		const calls = stubFetch(res(200, { generation: '5' }));
		await a.saveWorld(save());
		expect(calls[0].url).toBe(`https://api/worlds/${ID}`);
		const body = JSON.parse(calls[0].init!.body as string);
		expect('height' in body).toBe(false);
	});

	it('lists both namespaces', async () => {
		// stubFetch hands responses out POSITIONALLY: the implementation must issue the
		// /v3/worlds request FIRST (then /worlds), or the rows below swap and the
		// assertions fail in a confusing way.
		const a = new CloudAdapter('https://api');
		const calls = stubFetch(
			res(200, [{ id: ID, seed: 1, name: 'Tall', createdAt: 1, updatedAt: 3, height: 256, genVersion: 2 }]),
			res(200, [{ id: '22222222-2222-4222-8222-222222222222', seed: 2, name: 'Old', createdAt: 1, updatedAt: 2 }]),
		);
		const list = await a.listWorlds();
		expect(calls.map((c) => c.url).sort()).toEqual(['https://api/v3/worlds', 'https://api/worlds']);
		expect(list.find((w) => w.name === 'Tall')).toMatchObject({ version: 3, height: 256, origin: 'cloud' });
		expect(list.find((w) => w.name === 'Old')).toMatchObject({ version: 2, height: 64, origin: 'cloud' });
	});
});
describe('CloudAdapter — crafting fields (crafting spec §10)', () => {
	const EXTRAS = { inventory: { stone: 4, dirt: 0 }, tools: { owned: [0, 1], equipped: 1 } };

	it('sends inventory, tools and mustMine in the PUT body', async () => {
		// Catches: the fixed body field list dropping mustMine (today's code). With the
		// old-client guard on the server, an omitted field keeps the stored value, so a
		// client that "forgets" it could never switch a world back.
		const calls = stubFetch(res(200, { generation: '1' }));
		const a = new CloudAdapter('https://api.test');
		await a.saveWorld(save({ mustMine: true, player: { ...save().player, ...EXTRAS } }));
		const sent = JSON.parse(calls[0].init!.body as string);
		expect(sent.mustMine).toBe(true);
		expect(sent.player.inventory).toEqual(EXTRAS.inventory);
		expect(sent.player.tools).toEqual(EXTRAS.tools);
	});

	it('sends mustMine false rather than leaving it out', async () => {
		// Catches: `mustMine: save.mustMine` when the save has none: JSON drops the key
		// and the server guard would keep a stored `true`.
		const calls = stubFetch(res(200, { generation: '1' }));
		const a = new CloudAdapter('https://api.test');
		await a.saveWorld(save());
		expect(JSON.parse(calls[0].init!.body as string).mustMine).toBe(false);
	});

	it('decodes inventory, tools and mustMine from a loaded body', async () => {
		// Catches: decode() rebuilding the save from a fixed list without mustMine (today's code).
		const a = new CloudAdapter('https://api.test');
		stubFetch(res(404), res(200, { ...wire(), mustMine: true, player: { ...wire().player, ...EXTRAS } }, '3'));
		const loaded = await a.loadWorld(ID);
		expect(loaded!.mustMine).toBe(true);
		expect(loaded!.player.inventory).toEqual(EXTRAS.inventory);
		expect(loaded!.player.tools).toEqual(EXTRAS.tools);
	});
});
