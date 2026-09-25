/** Shared test fixtures: welcome messages, snapshots, a fake WebSocket. */
import { encodeSnapshot } from '../../../src/net/snapshot';
import { type Op, type Welcome } from '../../../src/net/protocol';
import { NEWEST_GEN_VERSION } from '../../../src/engine/world/generation';

export const SEED = 12345;

export function welcome(over: Partial<Welcome> = {}, seed = SEED): Welcome {
	return {
		t: 'welcome',
		you: 1,
		world: { uuid: 'world-1', name: 'Test', seed, gen: NEWEST_GEN_VERSION, height: 256, mustMine: false },
		spawn: { mode: 'first', x: 100.5, y: 80, z: 100.5, yaw: 0.7, pitch: 0.1 },
		extras: {},
		players: [],
		seq: 0,
		catalogMax: 5000,
		...over,
	};
}

/** A snapshot frame holding these cells (x, y, z, id, fluid, color). */
export function snapshot(cells: Op[] = [], seq = 0): ArrayBuffer {
	const sorted = [...cells].sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
	return encodeSnapshot(seq, sorted.flat());
}

type Listener = ((ev: never) => void) | null;

/**
 * A fake WebSocket with the surface MpClient uses. Tests drive the server side: `open()`, `recv()`,
 * `recvBin()`, `serverClose()`. Every instance is recorded in `FakeWS.all`.
 */
export class FakeWS {
	static all: FakeWS[] = [];
	static get last(): FakeWS {
		return FakeWS.all[FakeWS.all.length - 1];
	}
	readyState = 0;
	binaryType = 'blob';
	onopen: Listener = null;
	onmessage: Listener = null;
	onclose: Listener = null;
	onerror: Listener = null;
	readonly sent: Array<Record<string, unknown>> = [];
	closedWith: number | null = null;

	constructor(readonly url: string) {
		FakeWS.all.push(this);
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}

	close(code = 1000): void {
		this.closedWith = code;
		this.readyState = 3;
	}

	open(): void {
		this.readyState = 1;
		(this.onopen as unknown as () => void)?.();
	}

	recv(msg: object): void {
		(this.onmessage as unknown as (ev: { data: unknown }) => void)?.({ data: JSON.stringify(msg) });
	}

	recvBin(buf: ArrayBuffer): void {
		(this.onmessage as unknown as (ev: { data: unknown }) => void)?.({ data: buf });
	}

	serverClose(code: number): void {
		this.readyState = 3;
		(this.onclose as unknown as (ev: { code: number }) => void)?.({ code });
	}

	/** Sent messages of type `t`. */
	of(t: string): Array<Record<string, unknown>> {
		return this.sent.filter((m) => m.t === t);
	}
}
