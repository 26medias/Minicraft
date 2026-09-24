/**
 * Docs sync (plan D1, spec §11): the message-type and close-code tables in
 * `docs/multiplayer.md` must match the implemented protocol. The TS side is
 * `src/net/protocol.ts` (`CLIENT_MSG_TYPES`, `SERVER_MSG_TYPES`, `CLOSE`, each
 * tied to its type by the compiler); the Go side is
 * `server/internal/proto/proto.go`, checked by a text grep.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLIENT_MSG_TYPES, CLOSE, SERVER_MSG_TYPES } from './protocol';

const DOC = 'docs/multiplayer.md';
const GO_PROTO = 'server/internal/proto/proto.go';

/**
 * The body rows of the first markdown table after the heading line `heading`,
 * as trimmed cells with backticks stripped. Throws when the heading or the table
 * is missing, so a renamed section fails loudly instead of comparing nothing.
 */
function tableAfter(md: string, heading: string): string[][] {
	const lines = md.split('\n');
	const h = lines.findIndex((l) => l.trim() === heading);
	if (h < 0) throw new Error(`${DOC}: no heading "${heading}"`);
	let i = h + 1;
	while (i < lines.length && !lines[i].trim().startsWith('|')) {
		if (lines[i].startsWith('#')) throw new Error(`${DOC}: no table under "${heading}"`);
		i++;
	}
	if (i >= lines.length) throw new Error(`${DOC}: no table under "${heading}"`);
	const rows: string[][] = [];
	// Skip the header row and the |---| separator.
	for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
		const cells = lines[i]
			.trim()
			.replace(/^\||\|$/g, '')
			.split('|')
			.map((c) => c.trim().replace(/`/g, ''));
		rows.push(cells);
	}
	if (rows.length === 0) throw new Error(`${DOC}: empty table under "${heading}"`);
	return rows;
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('docs/multiplayer.md matches the implemented protocol', () => {
	const md = readFileSync(DOC, 'utf8');
	const go = readFileSync(GO_PROTO, 'utf8');

	it('client → server message types equal CLIENT_MSG_TYPES', () => {
		const types = tableAfter(md, '### Client → server').map((r) => r[0]);
		expect(new Set(types).size).toBe(types.length);
		expect(sorted(types)).toEqual(sorted(CLIENT_MSG_TYPES));
	});

	it('server → client message types equal SERVER_MSG_TYPES', () => {
		const types = tableAfter(md, '### Server → client').map((r) => r[0]);
		expect(new Set(types).size).toBe(types.length);
		expect(sorted(types)).toEqual(sorted(SERVER_MSG_TYPES));
	});

	it('every documented message type is a Go T… constant', () => {
		for (const t of new Set([...CLIENT_MSG_TYPES, ...SERVER_MSG_TYPES])) {
			expect(go, `proto.go has no T… = "${t}"`).toMatch(new RegExp(`\\bT\\w+\\s*=\\s*"${t}"`));
		}
	});

	it('the close-code table equals CLOSE, key for key and value for value', () => {
		const rows = tableAfter(md, '### Close and error codes');
		const doc: Record<string, number> = {};
		for (const [code, key] of rows) {
			expect(code, `close-code row "${code}"`).toMatch(/^\d{4}$/);
			expect(doc[key], `duplicate close key ${key}`).toBeUndefined();
			doc[key] = Number(code);
		}
		expect(doc).toEqual({ ...CLOSE });
	});

	it('every close code is a Go Close… constant with the same value', () => {
		for (const code of Object.values(CLOSE)) {
			expect(go, `proto.go has no Close… = ${code}`).toMatch(new RegExp(`\\bClose\\w+\\s*=\\s*${code}\\b`));
		}
	});
});
