// Multiplayer plan task C4: MpClient — liveness (spec §3.1), close codes (§5) and the 4003 counter (§7.5).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MpClient, type MpState, type Clock } from './mp-client';
import { PROTO, type Hello, type Welcome } from './protocol';

class FakeWS {
	static instances: FakeWS[] = [];
	readyState = 0;
	binaryType = 'blob';
	sent: string[] = [];
	closedWith: number | null = null;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	constructor(public url: string) { FakeWS.instances.push(this); }
	send(data: string): void { this.sent.push(data); }
	close(code = 1005): void {
		if (this.readyState === 3) return;
		this.closedWith = code;
		this.readyState = 3;
		this.onclose?.({ code, reason: '' });
	}
	// test drivers
	open(): void { this.readyState = 1; this.onopen?.({}); }
	recv(data: unknown): void { this.onmessage?.({ data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data) }); }
	serverClose(code: number): void { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
	sentTypes(): string[] { return this.sent.map((s) => JSON.parse(s).t); }
}

class FakeClock implements Clock {
	t = 1_000_000;
	private timers = new Map<number, { fn: () => void; ms: number; next: number }>();
	private id = 0;
	setInterval = (fn: () => void, ms: number): number => {
		this.timers.set(++this.id, { fn, ms, next: this.t + ms });
		return this.id;
	};
	clearInterval = (id: number): void => { this.timers.delete(id); };
	now = (): number => this.t;
	advance(ms: number): void {
		const end = this.t + ms;
		for (;;) {
			let due: { fn: () => void; ms: number; next: number } | null = null;
			for (const tm of this.timers.values()) if (tm.next <= end && (!due || tm.next < due.next)) due = tm;
			if (!due) break;
			this.t = due.next;
			due.next += due.ms;
			due.fn();
		}
		this.t = end;
	}
	get active(): number { return this.timers.size; }
}

class MemStorage {
	m = new Map<string, string>();
	getItem(k: string): string | null { return this.m.get(k) ?? null; }
	setItem(k: string, v: string): void { this.m.set(k, v); }
	removeItem(k: string): void { this.m.delete(k); }
}

const hello: Hello = { t: 'hello', world: 'w1', name: 'Noah', skin: 'milo', bid: 'b1', proto: PROTO, gen: 3, resume: false };
const welcome = { t: 'welcome', you: 1, world: { uuid: 'w1', name: 'W', seed: 1, gen: 3, height: 128, mustMine: false }, spawn: { mode: 'first', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, extras: {}, players: [], seq: 0, catalogMax: 100 } as Welcome;

function make(storage = new MemStorage()) {
	const clock = new FakeClock();
	const states: Array<[MpState, number | undefined]> = [];
	const got: unknown[] = [];
	const welcomes: Welcome[] = [];
	const snaps: ArrayBuffer[] = [];
	const client = new MpClient('https://mc.example:8443', 'to ken', hello, {
		onWelcome: (w) => welcomes.push(w),
		onSnapshot: (b) => snaps.push(b),
		onMessage: (m) => got.push(m),
		onState: (s, code) => states.push([s, code]),
	}, clock, storage);
	const ws = FakeWS.instances[FakeWS.instances.length - 1];
	return { client, clock, ws, states, got, welcomes, snaps, storage };
}

beforeEach(() => {
	FakeWS.instances = [];
	vi.stubGlobal('WebSocket', FakeWS);
	// No rAF in this suite: liveness must be driven by setInterval alone (spec §5, a hidden tab stays alive).
	vi.stubGlobal('requestAnimationFrame', () => { throw new Error('rAF must not be used'); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('MpClient transport', () => {
	it('connects to /ws with the token, binary as arraybuffer, and sends hello on open', () => {
		const { ws, states } = make();
		expect(ws.url).toBe('wss://mc.example:8443/ws?token=to%20ken');
		expect(ws.binaryType).toBe('arraybuffer');
		expect(states).toEqual([['connecting', undefined]]);
		ws.open();
		expect(JSON.parse(ws.sent[0])).toEqual(hello);
		expect(states.at(-1)).toEqual(['open', undefined]);
	});

	it('routes welcome, the binary snapshot and other messages', () => {
		const { ws, welcomes, snaps, got } = make();
		ws.open();
		ws.recv(welcome);
		const buf = new ArrayBuffer(8);
		ws.recv(buf);
		ws.recv({ t: 'tick', poses: [] });
		ws.recv({ t: 'ping' });
		expect(welcomes).toHaveLength(1);
		expect(snaps).toEqual([buf]);
		expect(got).toEqual([{ t: 'tick', poses: [] }]);
	});

	it('send() serialises and is dropped when the socket is not open', () => {
		const { client, ws } = make();
		expect(client.send({ t: 'ping' })).toBe(false);
		ws.open();
		expect(client.send({ t: 'pos', x: 1, y: 2, z: 3, yaw: 0, pitch: 0 })).toBe(true);
		expect(ws.sentTypes()).toEqual(['hello', 'pos']);
	});
});

describe('MpClient liveness (spec §3.1)', () => {
	it('sends a ping every 2 s from setInterval alone, when nothing else was sent', () => {
		const { ws, clock } = make();
		ws.open();
		ws.recv(welcome);
		for (let i = 0; i < 5; i++) { clock.advance(1000); ws.recv({ t: 'ping' }); }
		const pings = ws.sentTypes().filter((t) => t === 'ping').length;
		expect(pings).toBeGreaterThanOrEqual(2);
		expect(pings).toBeLessThanOrEqual(3);
	});

	it('does not ping while other messages keep going out', () => {
		const { client, ws, clock } = make();
		ws.open();
		for (let i = 0; i < 10; i++) { clock.advance(500); client.send({ t: 'pos', x: i, y: 0, z: 0, yaw: 0, pitch: 0 }); ws.recv({ t: 'ping' }); }
		expect(ws.sentTypes().filter((t) => t === 'ping')).toEqual([]);
	});

	it('no message for 6 s → the socket is closed and the state is lost', () => {
		const { ws, clock, states } = make();
		ws.open();
		ws.recv(welcome);
		clock.advance(5000);
		expect(states.at(-1)![0]).toBe('open');
		clock.advance(1000);
		expect(states.at(-1)![0]).toBe('lost');
		expect(ws.closedWith).not.toBeNull();
		expect(states.filter(([s]) => s === 'lost')).toHaveLength(1);
		expect(clock.active).toBe(0);
	});

	it('any message renews the 6 s deadline', () => {
		const { ws, clock, states } = make();
		ws.open();
		for (let i = 0; i < 8; i++) { clock.advance(4000); ws.recv({ t: 'ping' }); }
		expect(states.map(([s]) => s)).not.toContain('lost');
	});

	it('a socket that never opens is lost after 6 s', () => {
		const { clock, states } = make();
		clock.advance(6000);
		expect(states.at(-1)![0]).toBe('lost');
	});
});

describe('MpClient close codes (spec §5)', () => {
	for (const code of [4001, 4004, 4005, 4006, 4007, 4008, 4009]) {
		it(`close ${code} → fatal`, () => {
			const { ws, states, clock } = make();
			ws.open();
			ws.serverClose(code);
			expect(states.at(-1)).toEqual(['fatal', code]);
			expect(clock.active).toBe(0);
		});
	}

	for (const code of [1000, 1001, 1006, 4002]) {
		it(`close ${code} → lost`, () => {
			const { ws, states } = make();
			ws.open();
			ws.serverClose(code);
			expect(states.at(-1)).toEqual(['lost', code]);
		});
	}

	// The server sends 4003 only for a rejected `edit`, and a client edits only after its `welcome`:
	// every real 4003 follows a welcome. The counter must therefore survive the welcome of the reload.
	it('4003 once → lost; a second 4003 after the reload\'s welcome, with no accepted edit between → fatal with 4004', () => {
		const storage = new MemStorage();
		const a = make(storage);
		a.ws.open();
		a.ws.recv(welcome);
		a.ws.serverClose(4003);
		expect(a.states.at(-1)).toEqual(['lost', 4003]);
		// The reconnect is a page reload: a new client, the same sessionStorage.
		const b = make(storage);
		b.ws.open();
		b.ws.recv(welcome);
		b.ws.serverClose(4003);
		expect(b.states.at(-1)).toEqual(['fatal', 4004]);
	});

	it('an accepted own edit (its echo) resets the 4003 counter', () => {
		const storage = new MemStorage();
		const a = make(storage);
		a.ws.open();
		a.ws.recv(welcome);
		a.ws.serverClose(4003);
		const b = make(storage);
		b.ws.open();
		b.ws.recv(welcome);
		b.ws.recv({ t: 'edit', seq: 1, by: welcome.you, cid: 1, ops: [[0, 70, 0, 1, 0, 0]] });
		b.ws.serverClose(4003);
		expect(b.states.at(-1)).toEqual(['lost', 4003]);
	});

	it('a foreign edit does not reset the 4003 counter', () => {
		const storage = new MemStorage();
		const a = make(storage);
		a.ws.open();
		a.ws.recv(welcome);
		a.ws.serverClose(4003);
		const b = make(storage);
		b.ws.open();
		b.ws.recv(welcome);
		b.ws.recv({ t: 'edit', seq: 1, by: welcome.you + 1, ops: [[0, 70, 0, 1, 0, 0]] });
		b.ws.serverClose(4003);
		expect(b.states.at(-1)).toEqual(['fatal', 4004]);
	});

	it('close() by the client reports no lost state and stops the timers', () => {
		const { client, ws, states, clock } = make();
		ws.open();
		client.close();
		expect(ws.closedWith).toBe(1000);
		expect(states.map(([s]) => s)).not.toContain('lost');
		expect(clock.active).toBe(0);
	});

	it('the state is reported once: the close after a watchdog loss is ignored', () => {
		const { ws, clock, states } = make();
		ws.open();
		clock.advance(6000);
		ws.serverClose(4009);
		expect(states.filter(([s]) => s === 'lost' || s === 'fatal')).toHaveLength(1);
	});
});
