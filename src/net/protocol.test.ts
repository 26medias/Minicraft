import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
	CLOSE,
	PROTO,
	colorToInt,
	intToColor,
	type EditMsg,
	type EditOut,
	type ErrorMsg,
	type ExtrasMsg,
	type FxMsg,
	type Hello,
	type Join,
	type Left,
	type LeavingMsg,
	type OnlinePlayer,
	type Op,
	type Ping,
	type PlayerInfo,
	type Pos,
	type Spawn,
	type Tick,
	type Welcome,
	type WorldInfo,
	type WorldListing,
} from './protocol';

const GO_TESTDATA = 'server/internal/proto/testdata';

function golden<T>(name: string): T {
	return JSON.parse(readFileSync(`${GO_TESTDATA}/${name}`, 'utf8')) as T;
}

/**
 * `fields<T>()(...keys)` compiles only when `keys` names every property of T (and only those):
 * the TS type and this runtime list cannot drift apart, so comparing the list with the Go golden
 * file's keys compares the TS type with the Go struct.
 */
function fields<T>() {
	return <const K extends readonly (keyof T & string)[]>(
		...keys: K & ([Exclude<keyof T, K[number]>] extends [never] ? unknown : { missing: Exclude<keyof T, K[number]> })
	): readonly string[] => keys;
}

function keysOf(v: unknown): string[] {
	return Object.keys(v as object).sort();
}

describe('T1: Go golden messages parse with the TS types, field for field', () => {
	// Every msg-*.json the Go side emits, with the TS type's full field list.
	const cases: Record<string, readonly string[]> = {
		'msg-hello.json': fields<Hello>()('t', 'world', 'name', 'skin', 'bid', 'proto', 'gen', 'resume'),
		'msg-pos.json': fields<Pos>()('t', 'x', 'y', 'z', 'yaw', 'pitch'),
		'msg-ping.json': fields<Ping>()('t'),
		'msg-edit.json': fields<EditMsg>()('t', 'cid', 'ops'),
		'msg-fx.json': fields<FxMsg>()('t', 'kind', 'x', 'y', 'z', 'tier', 'by'),
		'msg-extras.json': fields<ExtrasMsg>()('t', 'data'),
		'msg-leaving.json': fields<LeavingMsg>()('t', 'secondsLeft', 'by'),
		'msg-welcome.json': fields<Welcome>()('t', 'you', 'world', 'spawn', 'extras', 'players', 'seq', 'catalogMax'),
		'msg-edit-out.json': fields<EditOut>()('t', 'seq', 'by', 'cid', 'ops'),
		'msg-tick.json': fields<Tick>()('t', 'poses'),
		'msg-join.json': fields<Join>()('t', 'id', 'name', 'skin'),
		'msg-left.json': fields<Left>()('t', 'id'),
		'msg-error.json': fields<ErrorMsg>()('t', 'code', 'message'),
		'msg-worlds-row.json': fields<WorldListing>()('uuid', 'name', 'mustMine', 'createdAt', 'online'),
	};

	it('covers every golden message file Go wrote', () => {
		const onDisk = readdirSync(GO_TESTDATA).filter((f) => /^msg-.*\.json$/.test(f)).sort();
		expect(onDisk.length).toBeGreaterThan(0);
		expect(Object.keys(cases).sort()).toEqual(onDisk);
	});

	for (const [file, keys] of Object.entries(cases)) {
		it(`${file} has exactly the TS type's fields`, () => {
			expect(keysOf(golden(file))).toEqual([...keys].sort());
		});
	}

	it('nested welcome/world/spawn/player and worlds-row online fields match', () => {
		const w = golden<Welcome>('msg-welcome.json');
		expect(keysOf(w.world)).toEqual(
			[...fields<WorldInfo>()('uuid', 'name', 'seed', 'gen', 'height', 'mustMine')].sort(),
		);
		expect(keysOf(w.spawn)).toEqual(
			[...fields<Spawn>()('mode', 'x', 'y', 'z', 'yaw', 'pitch', 'target')].sort(),
		);
		expect(w.players.length).toBeGreaterThan(0);
		expect(keysOf(w.players[0])).toEqual(
			[...fields<PlayerInfo>()('id', 'name', 'skin', 'x', 'y', 'z', 'yaw', 'pitch')].sort(),
		);
		const row = golden<WorldListing>('msg-worlds-row.json');
		expect(keysOf(row.online[0])).toEqual([...fields<OnlinePlayer>()('name', 'skin')].sort());
	});

	it('values carry the types the TS side expects', () => {
		const w = golden<Welcome>('msg-welcome.json');
		expect(w.t).toBe('welcome');
		expect(typeof w.world.seed).toBe('number');
		expect(Number.isSafeInteger(w.world.seed)).toBe(true);
		expect(['first', 'return', 'near']).toContain(w.spawn.mode);
		expect(typeof w.catalogMax).toBe('number');
		const tick = golden<Tick>('msg-tick.json');
		expect(tick.poses[0]).toHaveLength(6);
		const edit = golden<EditOut>('msg-edit-out.json');
		expect(edit.t).toBe('edit');
		for (const op of edit.ops) expect(op).toHaveLength(6);
		const hello = golden<Hello>('msg-hello.json');
		expect(hello.proto).toBe(PROTO);
		expect(typeof hello.resume).toBe('boolean');
	});
});

describe('protocol constants (spec §5)', () => {
	it('PROTO is 1 and the close codes are verbatim', () => {
		expect(PROTO).toBe(1);
		expect(CLOSE).toEqual({
			replaced: 4001,
			slow: 4002,
			resync: 4003,
			proto: 4004,
			genUnsupported: 4005,
			unknownWorld: 4006,
			badToken: 4007,
			badName: 4008,
			nameTaken: 4009,
		});
	});
});

describe('T4: colour and fluid packing', () => {
	it('#FFF5E0 <-> 0x1FFF5E0', () => {
		expect(colorToInt('#FFF5E0')).toBe(0x1fff5e0);
		expect(intToColor(0x1fff5e0)).toBe('#FFF5E0');
	});

	it('#000000 packs to 0x1000000, not 0 (0 means no colour)', () => {
		expect(colorToInt('#000000')).toBe(0x1000000);
		expect(intToColor(0x1000000)).toBe('#000000');
		expect(intToColor(0)).toBeNull();
	});

	it('lowercase input unpacks to uppercase', () => {
		expect(intToColor(colorToInt('#fff5e0'))).toBe('#FFF5E0');
		expect(intToColor(colorToInt('#0a0b0c'))).toBe('#0A0B0C');
	});

	it('rejects a malformed colour instead of packing garbage', () => {
		expect(() => colorToInt('FFF5E0')).toThrow();
		expect(() => colorToInt('#FFF')).toThrow();
		expect(() => colorToInt('#GGGGGG')).toThrow();
	});

	it('round-trips every packed value the Go fixture uses', () => {
		for (const n of [0x1000000, 0x1fff5e0, 0x1ffffff]) expect(colorToInt(intToColor(n)!)).toBe(n);
	});

	it('fluid 0x80 and 0x8F (and colours) survive JSON through an EditOut', () => {
		const ops: Op[] = [
			[1, 64, 1, 13, 0x80, 0],
			[2, 64, 2, 13, 0x8f, 0],
			[4, 70, 4, 1000, 0, colorToInt('#FFF5E0')],
			[5, 70, 5, 1000, 0, colorToInt('#000000')],
		];
		const msg: EditOut = { t: 'edit', seq: 9, by: 1, cid: 5, ops };
		const back = JSON.parse(JSON.stringify(msg)) as EditOut;
		expect(back).toEqual(msg);
		expect(back.ops[0][4]).toBe(0x80);
		expect(back.ops[1][4]).toBe(0x8f);
		expect(back.ops[3][5]).toBe(0x1000000);
	});

	it("Go's ops-roundtrip.json reads back with fluid and colour intact", () => {
		const go = golden<EditOut>('ops-roundtrip.json');
		const fluids = go.ops.map((op) => op[4]);
		expect(fluids).toContain(0x80);
		expect(fluids).toContain(0x8f);
		expect(go.ops.map((op) => op[5])).toContain(colorToInt('#FFF5E0'));
		expect(JSON.parse(JSON.stringify(go))).toEqual(go);
	});
});
