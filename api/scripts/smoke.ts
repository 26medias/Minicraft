/**
 * End-to-end smoke test against a deployed minicraft-api.
 * Uses throwaway uuids only — it must never touch a real world.
 *
 *   MINICRAFT_API_URL=https://... npx tsx api/scripts/smoke.ts
 */
import { randomUUID } from 'node:crypto';
import { encodeChunk, BLOCKS_PER_CHUNK } from '../src/codec';
import type { WorldSaveWire } from '../src/schema';

const BASE = process.env.MINICRAFT_API_URL;
if (!BASE) {
	console.error('MINICRAFT_API_URL is required');
	process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

function chunk(cx: number, cz: number, fill: number) {
	const b = new Uint8Array(BLOCKS_PER_CHUNK);
	b.fill(fill);
	return { cx, cz, blocks: encodeChunk(b) };
}

function world(id: string, over: Partial<WorldSaveWire> = {}): WorldSaveWire {
	return {
		version: 2,
		id,
		seed: -4242,
		name: 'Château 🏰 Noah',
		createdAt: 1000,
		updatedAt: 2000,
		player: { x: 1.5, y: 60, z: -2.25, yaw: 0.5, pitch: -0.1, hotbar: [1, 2], selected: 0 },
		chunks: [chunk(0, 0, 3), chunk(1, 0, 5)],
		...over,
	} as WorldSaveWire;
}

async function main() {
	const id = randomUUID();
	console.log(`==> Smoke test against ${BASE}`);
	console.log(`    throwaway world ${id}`);

	const health = await fetch(`${BASE}/health`);
	check('health 200', health.status === 200);

	const w = world(id);
	const put = await fetch(`${BASE}/worlds/${id}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
		body: JSON.stringify(w),
	});
	const putBody = (await put.json()) as { generation?: string };
	check('PUT new world 200', put.status === 200, `status ${put.status}`);
	check('PUT returns a generation', Boolean(putBody.generation));

	const get = await fetch(`${BASE}/worlds/${id}`);
	const got = (await get.json()) as WorldSaveWire;
	check('GET 200', get.status === 200);
	check('round-trip is byte-identical', JSON.stringify(got.chunks) === JSON.stringify(w.chunks));
	check('emoji name survived', got.name === 'Château 🏰 Noah', got.name);
	check('negative seed survived', got.seed === -4242, String(got.seed));

	const list = (await (await fetch(`${BASE}/worlds`)).json()) as { id: string; name: string }[];
	check(
		'LIST includes the world',
		list.some((x) => x.id === id),
		`${list.length} worlds listed`,
	);

	const stale = await fetch(`${BASE}/worlds/${id}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'If-Match': '999' },
		body: JSON.stringify(w),
	});
	check('stale generation gets 409', stale.status === 409, `status ${stale.status}`);

	const noPre = await fetch(`${BASE}/worlds/${id}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(w),
	});
	check('missing precondition gets 428', noPre.status === 428, `status ${noPre.status}`);

	const corrupt = await fetch(`${BASE}/worlds/${id}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'If-Match': String(putBody.generation) },
		body: JSON.stringify({ ...w, chunks: [{ cx: 0, cz: 0, blocks: 'not-base64!!!' }] }),
	});
	check('corrupt chunk gets 400', corrupt.status === 400, `status ${corrupt.status}`);

	const stillGood = (await (await fetch(`${BASE}/worlds/${id}`)).json()) as WorldSaveWire;
	check('rejected write left the world intact', stillGood.chunks.length === 2);

	const badId = await fetch(`${BASE}/worlds/not-a-uuid`);
	check('non-uuid id gets 400', badId.status === 400, `status ${badId.status}`);

	const del = await fetch(`${BASE}/worlds/${id}`, { method: 'DELETE' });
	check('DELETE 204', del.status === 204, `status ${del.status}`);

	const gone = await fetch(`${BASE}/worlds/${id}`);
	check('GET after delete 404', gone.status === 404, `status ${gone.status}`);

	console.log(failures === 0 ? '==> smoke passed' : `==> ${failures} check(s) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
