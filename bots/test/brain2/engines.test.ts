import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnswerCache } from '../../src/brain2/engines/cache.js';
import { Health } from '../../src/brain2/engines/health.js';
import { Laya } from '../../src/brain2/engines/laya.js';
import { Llm } from '../../src/brain2/engines/llm.js';
import { ManualClock } from '../../src/brain2/clock.js';
import type { Choice } from '../../src/brain/brain.js';

/** Task 18: the engines (spec §3.2) and the answer cache (criterion 3), all on a fake `fetch`. */

interface Call { url: string; method: string; body: unknown }
type Responder = (url: string, body: unknown) => { status?: number; json: unknown };

function fakeFetch(respond: Responder): { fetchImpl: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url, method: init?.method ?? 'GET', body });
		const r = respond(url, body);
		return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

const MODEL = 'llama3.2:3b';
const clock = new ManualClock(0).now;
const healthy = (): Health => {
	const h = new Health({ layaUrl: null, llm: null, clock });
	h.laya = true;
	h.llm = true;
	return h;
};
const SCHEMA = { type: 'object', properties: { mood: { type: 'string', enum: ['down', 'stay', 'up'] } }, required: ['mood'] };
const signal = () => new AbortController().signal;
const layaAnswer = { answers: { next: { type: 'choice', choice: 'up', probabilities: { down: 0.1, stay: 0.2, up: 0.7 } } } };
const Q: Choice = { type: 'choice', instructions: 'Does my mood go down, stay, or go up?', options: { down: 'it goes down', stay: 'it stays the same', up: 'it goes up' } };

describe('Llm (spec §3.2)', () => {
	// Red if temperature, seed or keep_alive is missing (the re-gate got 6 different answers out of 6 at 0.2).
	it('POSTs the pinned body to /api/chat and parses message.content', async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ json: { message: { role: 'assistant', content: '{"mood":"up"}' } } }));
		const llm = new Llm({ url: 'http://127.0.0.1:11434', model: MODEL, health: healthy(), fetchImpl });
		const out = await llm.json<{ mood: string }>('Just now: I finished my house.', SCHEMA, signal());
		expect(out).toEqual({ value: { mood: 'up' }, raw: '{"mood":"up"}' });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('http://127.0.0.1:11434/api/chat');
		expect(calls[0].method).toBe('POST');
		expect(calls[0].body).toEqual({
			model: MODEL,
			messages: [{ role: 'user', content: 'Just now: I finished my house.' }],
			format: SCHEMA,
			stream: false,
			keep_alive: -1,
			options: { temperature: 0, seed: 42 },
		});
	});

	it("throws 'llm: not JSON' on non-JSON content", async () => {
		const { fetchImpl } = fakeFetch(() => ({ json: { message: { role: 'assistant', content: 'I think it goes up' } } }));
		const llm = new Llm({ url: 'http://x', model: MODEL, health: healthy(), fetchImpl });
		await expect(llm.json('p', SCHEMA, signal())).rejects.toThrow('llm: not JSON');
	});

	it('throws on an HTTP error, and healthy() reads the health flag', async () => {
		const { fetchImpl } = fakeFetch(() => ({ status: 500, json: { error: 'boom' } }));
		const h = healthy();
		const llm = new Llm({ url: 'http://x', model: MODEL, health: h, fetchImpl });
		await expect(llm.json('p', SCHEMA, signal())).rejects.toThrow(/500/);
		expect(llm.healthy()).toBe(true);
		h.llm = false;
		expect(llm.healthy()).toBe(false);
	});
});

describe('Health (spec §3.2)', () => {
	const ps = (entry: object | null) => ({ models: entry ? [entry] : [] });
	const mk = (respond: Responder) => {
		const f = fakeFetch(respond);
		return { h: new Health({ layaUrl: 'http://laya', llm: { url: 'http://ollama', model: MODEL }, fetchImpl: f.fetchImpl, clock }), calls: f.calls };
	};

	// Red if a partly-offloaded model (size_vram < size, too slow) counts as healthy.
	it('size_vram < size gives llm false, with lastError set', async () => {
		const { h } = mk((url) => (url.endsWith('/api/ps') ? { json: ps({ name: MODEL, model: MODEL, size: 3_600, size_vram: 1_400 }) } : { json: { status: 'ok' } }));
		await h.poll();
		expect(h.llm).toBe(false);
		expect(h.laya).toBe(true);
		expect(h.lastError).toMatch(/size_vram/);
	});

	it('size_vram == size gives llm true', async () => {
		const { h } = mk((url) => (url.endsWith('/api/ps') ? { json: ps({ name: MODEL, model: MODEL, size: 3_600, size_vram: 3_600 }) } : { json: { status: 'ok' } }));
		await h.poll();
		expect(h.llm).toBe(true);
	});

	// Red if "not loaded" is treated as a failure with no load, or the load is sent again on every poll while one is in flight.
	it('a missing model gives one load call (keep_alive -1) and false until a poll confirms it', async () => {
		let loaded = false;
		const { h, calls } = mk((url) => {
			if (url.endsWith('/api/ps')) return { json: ps(loaded ? { name: MODEL, model: MODEL, size: 3_600, size_vram: 3_600 } : null) };
			if (url.endsWith('/api/generate')) return { json: { done: true } };
			return { json: { status: 'ok' } };
		});
		await h.poll();
		expect(h.llm).toBe(false);
		const loads = calls.filter((c) => c.url.endsWith('/api/generate'));
		expect(loads).toHaveLength(1);
		expect(loads[0].body).toEqual({ model: MODEL, prompt: '', keep_alive: -1 });
		loaded = true;
		await h.poll();
		expect(h.llm).toBe(true);
		expect(calls.filter((c) => c.url.endsWith('/api/generate'))).toHaveLength(1);
	});

	it("Laya's /health failing gives laya false; an unreachable Ollama gives llm false", async () => {
		const { h } = mk((url) => (url.endsWith('/health') ? { status: 503, json: {} } : { status: 500, json: {} }));
		await h.poll();
		expect(h.laya).toBe(false);
		expect(h.llm).toBe(false);
	});
});

describe('Laya (spec §3.2)', () => {
	it('warmUp sends exactly one call; ask delegates to the systemone adapter; healthy() reads the flag', async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ json: layaAnswer }));
		const h = healthy();
		const laya = new Laya({ url: 'http://laya', timeoutMs: 400, health: h, fetchImpl });
		await laya.warmUp();
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('http://laya/v1/systemone');
		const a = await laya.ask('Just now: I finished my house.', Q, signal());
		expect(a.best).toBe('up');
		expect(a.confidence).toBeCloseTo(0.7);
		expect(calls).toHaveLength(2);
		expect((calls[1].body as { questions: { next: { criteria: unknown } } }).questions.next.criteria).toEqual(Q.options);
		h.laya = false;
		expect(laya.healthy()).toBe(false);
	});

	it('warmUp swallows a failure (Laya down at startup is not fatal)', async () => {
		const { fetchImpl } = fakeFetch(() => ({ status: 503, json: {} }));
		await expect(new Laya({ url: 'http://laya', timeoutMs: 400, health: healthy(), fetchImpl }).warmUp()).resolves.toBeUndefined();
	});
});

describe('AnswerCache (criterion 3)', () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	// Red if the key ignores the prompt or the schema/criteria, or a hit still calls the live engine.
	it('replay-or-live: the first call goes live and records, the identical second is a hit with no fetch; it survives save/load', async () => {
		dir = mkdtempSync(join(tmpdir(), 'answer-cache-'));
		const path = join(dir, 'cache.json');
		const { fetchImpl, calls } = fakeFetch((url) => (url.endsWith('/api/chat') ? { json: { message: { content: '{"mood":"up"}' } } } : { json: layaAnswer }));
		const engines = { laya: new Laya({ url: 'http://laya', timeoutMs: 400, health: healthy(), fetchImpl }), llm: new Llm({ url: 'http://ollama', model: MODEL, health: healthy(), fetchImpl }) };
		const cache = new AnswerCache(path);
		const e = cache.wrap(engines, 'replay-or-live');
		expect(await e.llm!.json('prompt A', SCHEMA, signal())).toEqual({ value: { mood: 'up' }, raw: '{"mood":"up"}' });
		expect(calls).toHaveLength(1);
		expect(cache.stats()).toEqual({ hits: 0, misses: 1 });
		expect(await e.llm!.json('prompt A', SCHEMA, signal())).toEqual({ value: { mood: 'up' }, raw: '{"mood":"up"}' });
		expect(calls).toHaveLength(1);
		expect(cache.stats()).toEqual({ hits: 1, misses: 1 });
		// A different schema is a different key.
		await e.llm!.json('prompt A', { ...SCHEMA, required: [] }, signal());
		expect(calls).toHaveLength(2);
		// Laya: keyed on state, instructions and criteria.
		await e.laya!.ask('state', Q, signal());
		await e.laya!.ask('state', Q, signal());
		await e.laya!.ask('state', { ...Q, options: { yes: 'yes', no: 'no' } }, signal());
		expect(calls).toHaveLength(4);
		expect(cache.stats()).toEqual({ hits: 2, misses: 4 });
		cache.save();

		const again = new AnswerCache(path);
		const e2 = again.wrap(engines, 'replay-or-live');
		expect((await e2.laya!.ask('state', Q, signal())).best).toBe('up');
		expect(await e2.llm!.json('prompt A', SCHEMA, signal())).toEqual({ value: { mood: 'up' }, raw: '{"mood":"up"}' });
		expect(calls).toHaveLength(4);
		expect(again.stats()).toEqual({ hits: 2, misses: 0 });
	});

	it('live: always calls the engine, and records what it answered', async () => {
		dir = mkdtempSync(join(tmpdir(), 'answer-cache-'));
		const { fetchImpl, calls } = fakeFetch(() => ({ json: { message: { content: '{"mood":"stay"}' } } }));
		const cache = new AnswerCache(join(dir, 'c.json'));
		const e = cache.wrap({ laya: null, llm: new Llm({ url: 'http://ollama', model: MODEL, health: healthy(), fetchImpl }) }, 'live');
		expect(e.laya).toBeNull();
		await e.llm!.json('p', SCHEMA, signal());
		await e.llm!.json('p', SCHEMA, signal());
		expect(calls).toHaveLength(2);
		expect(cache.stats()).toEqual({ hits: 0, misses: 2 });
	});
});
