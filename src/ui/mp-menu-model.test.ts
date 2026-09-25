import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { preselect, validName, nameError, NAME_ERROR, nameTakenText, sortRows } from './mp-menu-model';
import { loadMpPrefs, saveMpPrefs, MP_KEY } from '../persistence/mp-prefs';
import { MpApi, type MpWorldRow } from '../net/mp-api';

const row = (uuid: string, online: string[] = [], createdAt = 0): MpWorldRow => ({
	uuid, name: `World ${uuid}`, mustMine: false, createdAt,
	online: online.map((name) => ({ name, skin: 'milo' })),
});

/** An in-memory localStorage; `throwOnSet` simulates a full or private-mode store. */
function memStorage(throwOnSet = false) {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => { if (throwOnSet) throw new Error('quota'); m.set(k, v); },
		removeItem: (k: string) => { m.delete(k); },
		clear: () => m.clear(),
		key: (i: number) => [...m.keys()][i] ?? null,
		get length() { return m.size; },
	};
}

describe('preselect (T13, multiplayer part)', () => {
	it('remembered world empty, another world has 1 player → the other world', () => {
		expect(preselect([row('a'), row('b', ['Léo'])], 'a')).toBe('b');
	});

	it('remembered world has a player → remembered, even when another world is busier', () => {
		expect(preselect([row('a', ['Noah']), row('b', ['Léo', 'Zoé'])], 'a')).toBe('a');
	});

	it('remembered world empty → the busiest of the occupied worlds, not the first occupied', () => {
		expect(preselect([row('a'), row('b', ['Léo']), row('c', ['Léo', 'Zoé'])], 'a')).toBe('c');
	});

	it('nobody online, remembered world still exists → remembered', () => {
		expect(preselect([row('a'), row('b'), row('c')], 'b')).toBe('b');
	});

	it('remembered world deleted → the first row', () => {
		expect(preselect([row('a'), row('b')], 'gone')).toBe('a');
	});

	it('nothing remembered and nobody online → the first row; an empty list → null', () => {
		expect(preselect([row('a'), row('b')], null)).toBe('a');
		expect(preselect([], 'a')).toBeNull();
	});
});

describe('sortRows', () => {
	it('busiest first, then newest', () => {
		const rows = [row('old', [], 1), row('busy', ['A', 'B'], 0), row('new', [], 5), row('one', ['A'], 9)];
		expect(sortRows(rows).map((r) => r.uuid)).toEqual(['busy', 'one', 'new', 'old']);
	});
});

describe('validName (same rule as the server)', () => {
	it('accepts letters with accents', () => {
		expect(validName('Noé')).toBe('Noé');
	});

	it('trims', () => {
		expect(validName(' Léo ')).toBe('Léo');
	});

	it('refuses empty, symbols, and 17 characters', () => {
		expect(validName('')).toBeNull();
		expect(validName('   ')).toBeNull();
		expect(validName('a<b')).toBeNull();
		expect(validName('a'.repeat(17))).toBeNull();
		expect(validName('a'.repeat(16))).toBe('a'.repeat(16));
	});

	it('NFC-normalises like the server, so a decomposed é passes', () => {
		expect(validName('Noé')).toBe('Noé');
	});
});

describe('nameError', () => {
	it('explains a refused name', () => {
		expect(nameError('Noah!')).toBe('Only letters, numbers and spaces');
		expect(NAME_ERROR).toBe('Only letters, numbers and spaces');
	});

	it('is null for a good name', () => {
		expect(nameError('Noah')).toBeNull();
	});

	it('asks for a name when it is empty', () => {
		expect(nameError('  ')).toBe('Type your name');
	});
});

describe('nameTakenText', () => {
	it('names the other player', () => {
		expect(nameTakenText('Noah')).toBe('Someone called Noah is already playing. Pick another name.');
	});
});

describe('mp-prefs', () => {
	beforeEach(() => { vi.stubGlobal('localStorage', memStorage()); });
	afterEach(() => { vi.unstubAllGlobals(); });

	it('bid is created once and stable across calls', () => {
		const a = loadMpPrefs();
		const b = loadMpPrefs();
		expect(a.bid).toMatch(/^[0-9a-f-]{36}$/);
		expect(b.bid).toBe(a.bid);
		expect(JSON.parse(localStorage.getItem(MP_KEY)!).bid).toBe(a.bid);
	});

	it('restores name, skin and world; a bad skin falls back to null', () => {
		const { bid } = loadMpPrefs();
		saveMpPrefs({ name: 'Noah', skin: 'jj', worldId: 'w9', bid });
		expect(loadMpPrefs()).toEqual({ name: 'Noah', skin: 'jj', worldId: 'w9', bid });
		localStorage.setItem(MP_KEY, JSON.stringify({ name: 'Noah', skin: 'plaid', worldId: 3, bid }));
		expect(loadMpPrefs()).toEqual({ name: 'Noah', skin: null, worldId: null, bid });
	});

	it('a corrupt record still yields a usable bid', () => {
		localStorage.setItem(MP_KEY, '{nope');
		const p = loadMpPrefs();
		expect(p.name).toBeNull();
		expect(p.bid).toMatch(/^[0-9a-f-]{36}$/);
		expect(loadMpPrefs().bid).toBe(p.bid);
	});

	it('a throwing store does not throw', () => {
		vi.stubGlobal('localStorage', memStorage(true));
		expect(() => saveMpPrefs({ name: 'Noah', skin: 'milo', worldId: null, bid: 'x' })).not.toThrow();
		expect(loadMpPrefs().bid).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe('MpApi', () => {
	afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

	it('listWorlds against a fetch that never resolves rejects within 4 s', async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
			signal = init.signal ?? undefined;
			// Ignores the abort on purpose: the timeout must not rely on fetch honouring it.
			return new Promise(() => {});
		});
		const api = new MpApi('http://127.0.0.1:1', 'tok');
		let settled: 'pending' | 'rejected' | 'resolved' = 'pending';
		api.listWorlds().then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
		await vi.advanceTimersByTimeAsync(3_900);
		expect(settled).toBe('pending');
		await vi.advanceTimersByTimeAsync(200);
		expect(settled).toBe('rejected');
		expect(signal?.aborted).toBe(true);
	});

	it('sends the bearer token and parses the rows', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify([row('a', ['Noah'])]), { status: 200 });
		});
		const rows = await new MpApi('http://h:8080/', 'tok').listWorlds();
		expect(rows[0].uuid).toBe('a');
		expect(calls[0].url).toBe('http://h:8080/worlds');
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
	});

	it('listWorlds rejects on a non-2xx and on a body that is not a list', async () => {
		vi.stubGlobal('fetch', async () => new Response('no', { status: 401 }));
		await expect(new MpApi('http://h', 't').listWorlds()).rejects.toThrow();
		vi.stubGlobal('fetch', async () => new Response('{"a":1}', { status: 200 }));
		await expect(new MpApi('http://h', 't').listWorlds()).rejects.toThrow();
	});

	it('createWorld posts name, seed, mustMine and the generator version', async () => {
		let body: unknown = null;
		let method = '';
		vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
			method = init.method ?? '';
			body = JSON.parse(init.body as string);
			return new Response(JSON.stringify(row('n')), { status: 200 });
		});
		const r = await new MpApi('http://h', 't').createWorld('Castle', 42, true);
		expect(method).toBe('POST');
		expect(body).toEqual({ name: 'Castle', seed: 42, mustMine: true, gen: 3 });
		expect(r.uuid).toBe('n');
	});

	it('deleteWorld: 204 → ok, 409 → occupied, anything else throws', async () => {
		let status = 204;
		let url = '';
		vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
			url = u;
			expect(init.method).toBe('DELETE');
			return new Response(null, { status });
		});
		const api = new MpApi('http://h', 't');
		expect(await api.deleteWorld('a b')).toBe('ok');
		expect(url).toBe('http://h/worlds/a%20b');
		status = 409;
		expect(await api.deleteWorld('a')).toBe('occupied');
		status = 500;
		await expect(api.deleteWorld('a')).rejects.toThrow();
	});
});
