/**
 * The TS side of the wire field lists, checked against the Go reflection golden file
 * `server/internal/proto/testdata/fields.json` (by `protocol.test.ts`) and against
 * `docs/protocol.md` (by `protocol-docs.test.ts`), spec §7.
 *
 * Keyed exactly like `fields.json`: golden message names, with `edit` (client → server) distinct
 * from `edit-out` (server → client, the same "t" but a different Go/TS type), and nested structs
 * keyed by path (`welcome.world`, `welcome.spawn`, `welcome.players`, `worlds-row.online`).
 *
 * `fields<T>()(...)` only compiles when the argument list names every key of `T` and no other, so
 * this file cannot drift from the TS types it lists — the two test files read `WIRE_FIELDS`
 * instead of keeping their own copies.
 */
import type {
	EditMsg,
	EditOut,
	ErrorMsg,
	ExtrasMsg,
	FxMsg,
	Hello,
	Join,
	Left,
	LeavingMsg,
	OnlinePlayer,
	Ping,
	PlayerInfo,
	Pos,
	Spawn,
	Tick,
	Welcome,
	WorldInfo,
	WorldListing,
} from './protocol';

function fields<T>() {
	return <const K extends readonly (keyof T & string)[]>(
		...keys: K & ([Exclude<keyof T, K[number]>] extends [never] ? unknown : { missing: Exclude<keyof T, K[number]> })
	): readonly string[] => keys;
}

export const WIRE_FIELDS: Record<string, readonly string[]> = {
	hello: fields<Hello>()('t', 'world', 'name', 'skin', 'bid', 'proto', 'gen', 'resume', 'ver', 'bot'),
	pos: fields<Pos>()('t', 'x', 'y', 'z', 'yaw', 'pitch'),
	ping: fields<Ping>()('t'),
	edit: fields<EditMsg>()('t', 'cid', 'ops'),
	fx: fields<FxMsg>()('t', 'kind', 'x', 'y', 'z', 'tier', 'dur', 'by', 'tool', 'face'),
	extras: fields<ExtrasMsg>()('t', 'data'),
	leaving: fields<LeavingMsg>()('t', 'secondsLeft', 'by'),
	welcome: fields<Welcome>()('t', 'you', 'world', 'spawn', 'extras', 'players', 'seq', 'catalogMax'),
	'edit-out': fields<EditOut>()('t', 'seq', 'by', 'cid', 'ops'),
	tick: fields<Tick>()('t', 'poses'),
	join: fields<Join>()('t', 'id', 'name', 'skin', 'bot'),
	left: fields<Left>()('t', 'id'),
	error: fields<ErrorMsg>()('t', 'code', 'message', 'min'),
	'worlds-row': fields<WorldListing>()('uuid', 'name', 'mustMine', 'createdAt', 'online'),
	'welcome.world': fields<WorldInfo>()('uuid', 'name', 'seed', 'gen', 'height', 'mustMine'),
	'welcome.spawn': fields<Spawn>()('mode', 'x', 'y', 'z', 'yaw', 'pitch', 'target'),
	'welcome.players': fields<PlayerInfo>()('id', 'name', 'skin', 'x', 'y', 'z', 'yaw', 'pitch', 'hasPos', 'bot'),
	'worlds-row.online': fields<OnlinePlayer>()('name', 'skin'),
};
