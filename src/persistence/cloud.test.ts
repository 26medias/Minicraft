import { describe, it, expect, vi, afterEach } from 'vitest';
import { CloudAdapter } from './cloud';
import type { WorldSave } from './adapter';
import { BLOCKS_PER_CHUNK } from '../engine/world/coords';

const ID = '11111111-1111-4111-8111-111111111111';

function save(over: Partial<WorldSave> = {}): WorldSave {
	const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
	blocks[0] = 3;
	return {
		version: 2,
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
