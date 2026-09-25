/**
 * Docs sync (spec §7): `docs/protocol.md` must match the implemented protocol on three axes:
 * - the message-type sets and close codes, against `src/net/protocol.ts`;
 * - every message's field list (including `?` markers) against the Go reflection golden file
 *   `server/internal/proto/testdata/fields.json`, keyed by golden name (`edit` for the
 *   client → server row, `edit-out` for the server → client one; nested structs keyed by path,
 *   e.g. `welcome.world`);
 * - the same field list, `?` stripped, against the TS side of that golden data,
 *   `src/net/wire-fields.ts` (the same list `protocol.test.ts` checks against the golden file, so
 *   this test and that one can't independently drift from the TS types).
 *
 * Nested structures in the fields column use one format: `name{sub, sub2?, …}` for a nested
 * object, `name[{sub, sub2?, …}]` for an array of them — `parseFieldList` below is the only
 * parser for it, so the doc has to use exactly this shape or the test errors out (not silently
 * skips).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLIENT_MSG_TYPES, CLOSE, SERVER_MSG_TYPES } from './protocol';
import { WIRE_FIELDS } from './wire-fields';

const DOC = 'docs/protocol.md';
const GO_PROTO = 'server/internal/proto/proto.go';
const FIELDS_JSON = 'server/internal/proto/testdata/fields.json';

/**
 * The body rows of the first markdown table after the heading line `heading`, as trimmed cells
 * with backticks stripped. Throws when the heading or the table is missing, so a renamed section
 * fails loudly instead of comparing nothing.
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

// ── the fields-column grammar ──

type FieldNode = { name: string; optional: boolean; nested?: { sub: FieldNode[] } };

/** Splits a fields cell on top-level commas, i.e. commas outside `{...}` / `[...]`. */
function splitTopLevel(s: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of s) {
		if (ch === '{' || ch === '[') depth++;
		if (ch === '}' || ch === ']') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	if (cur.trim() !== '') parts.push(cur);
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const ARRAY_RE = /^([A-Za-z][A-Za-z0-9_]*)\[\{([\s\S]*)\}\](\??)$/;
const OBJECT_RE = /^([A-Za-z][A-Za-z0-9_]*)\{([\s\S]*)\}(\??)$/;
const SCALAR_RE = /^([A-Za-z][A-Za-z0-9_]*)(\??)$/;

function parseOne(tok: string): FieldNode {
	let m = ARRAY_RE.exec(tok);
	if (m) return { name: m[1], optional: m[3] === '?', nested: { sub: parseFieldList(m[2]) } };
	m = OBJECT_RE.exec(tok);
	if (m) return { name: m[1], optional: m[3] === '?', nested: { sub: parseFieldList(m[2]) } };
	m = SCALAR_RE.exec(tok);
	if (m) return { name: m[1], optional: m[2] === '?' };
	throw new Error(`${DOC}: cannot parse field token "${tok}"`);
}

function parseFieldList(cell: string): FieldNode[] {
	const trimmed = cell.trim();
	if (trimmed === '' || trimmed === '—' || trimmed === '-') return [];
	return splitTopLevel(trimmed).map(parseOne);
}

const withMarks = (nodes: FieldNode[]) => nodes.map((n) => n.name + (n.optional ? '?' : ''));
const stripMarks = (marked: readonly string[]) => marked.map((f) => f.replace(/\?$/, ''));

describe('docs/protocol.md matches the implemented protocol', () => {
	const md = readFileSync(DOC, 'utf8');
	const go = readFileSync(GO_PROTO, 'utf8');
	const fieldsJson = JSON.parse(readFileSync(FIELDS_JSON, 'utf8')) as Record<string, string[]>;

	const clientRows = tableAfter(md, '### Client → server');
	const serverRows = tableAfter(md, '### Server → client');

	it('client → server message types equal CLIENT_MSG_TYPES', () => {
		const types = clientRows.map((r) => r[0]);
		expect(new Set(types).size).toBe(types.length);
		expect(sorted(types)).toEqual(sorted(CLIENT_MSG_TYPES));
	});

	it('server → client message types equal SERVER_MSG_TYPES', () => {
		const types = serverRows.map((r) => r[0]);
		expect(new Set(types).size).toBe(types.length);
		expect(sorted(types)).toEqual(sorted(SERVER_MSG_TYPES));
	});

	it('every documented message type is a Go T… constant', () => {
		for (const t of new Set([...CLIENT_MSG_TYPES, ...SERVER_MSG_TYPES])) {
			expect(go, `proto.go has no T… = "${t}"`).toMatch(new RegExp(`\\bT\\w+\\s*=\\s*"${t}"`));
		}
	});

	it('the close-code table equals CLOSE, key for key and value for value', () => {
		const rows = tableAfter(md, '### Close and error codes').filter((r) => r[0] !== '1008');
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

	/**
	 * Checks one message row's fields cell against `fields.json[goldenKey]` (with `?` markers,
	 * plus the implied `t` every wire message carries but no row repeats) and against
	 * `WIRE_FIELDS[goldenKey]` (the same list with `?` stripped), then recurses into any nested
	 * sub-structure under `${goldenKey}.${name}`.
	 */
	function checkFields(nodes: FieldNode[], goldenKey: string, path: string, withT: boolean): void {
		const golden = fieldsJson[goldenKey];
		expect(golden, `fields.json has no "${goldenKey}" (${path})`).toBeDefined();
		const doc = withMarks(nodes);
		const docWithT = withT ? ['t', ...doc] : doc;
		expect(sorted(docWithT), `${path}: fields vs fields.json["${goldenKey}"]`).toEqual(sorted(golden));

		const ts = WIRE_FIELDS[goldenKey];
		expect(ts, `WIRE_FIELDS has no "${goldenKey}" (${path})`).toBeDefined();
		expect(sorted(stripMarks(docWithT)), `${path}: fields vs WIRE_FIELDS["${goldenKey}"]`).toEqual(sorted(ts));

		for (const n of nodes) {
			if (n.nested) checkFields(n.nested.sub, `${goldenKey}.${n.name}`, `${path}.${n.name}`, false);
		}
	}

	describe('client → server fields', () => {
		for (const [t, fieldsCell] of clientRows.map((r) => [r[0], r[1]] as const)) {
			it(`${t}: doc fields match fields.json and WIRE_FIELDS`, () => {
				checkFields(parseFieldList(fieldsCell), t, `Client → server ${t}`, true);
			});
		}
	});

	describe('server → client fields', () => {
		for (const [t, fieldsCell] of serverRows.map((r) => [r[0], r[1]] as const)) {
			// The server's `edit` row is a different Go/TS type from the client's (EditOut vs
			// Edit), keyed `edit-out` in the golden data.
			const goldenKey = t === 'edit' ? 'edit-out' : t;
			it(`${t}: doc fields match fields.json["${goldenKey}"] and WIRE_FIELDS`, () => {
				checkFields(parseFieldList(fieldsCell), goldenKey, `Server → client ${t}`, true);
			});
		}
	});
});
