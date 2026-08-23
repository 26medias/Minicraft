/**
 * Uploads worlds from a localStorage backup export into the cloud.
 *
 *   npx tsx api/scripts/import-backup.ts backup/worlds.json            # dry run
 *   npx tsx api/scripts/import-backup.ts backup/worlds.json --write    # upload
 *
 * Each v1 world gets a uuid derived deterministically from its seed, so
 * re-running is idempotent and never creates a second copy. The script prints a
 * browser snippet that records the same uuids in `minicraft:v2:legacy-map:*`;
 * without it the deployed client would mint its OWN uuid on first play and the
 * world would appear twice.
 *
 * It only ever writes to the cloud. It does not touch the backup file, and the
 * v1 keys in the browser are left exactly as they are.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const API = process.env.MINICRAFT_API_URL;
const file = process.argv[2];
const write = process.argv.includes('--write');

if (!API || !file) {
	console.error('usage: MINICRAFT_API_URL=... npx tsx api/scripts/import-backup.ts <backup.json> [--write]');
	process.exit(1);
}

/** Stable uuid v4-shaped id derived from the seed, so imports are idempotent. */
function idForSeed(seed: string): string {
	const h = createHash('sha256').update(`minicraft:legacy:${seed}`).digest();
	const b = Buffer.from(h.subarray(0, 16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const x = b.toString('hex');
	return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

type Chunk = { cx: number; cz: number; blocks: string; fluidMeta?: string };

const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;

const worlds = new Map<string, { meta?: Record<string, unknown>; chunks: Chunk[] }>();
for (const [key, value] of Object.entries(data)) {
	const m = /^minicraft:v1:world:(-?\d+):(meta|chunk:(\d+):(\d+))$/.exec(key);
	if (!m) continue;
	const seed = m[1];
	if (!worlds.has(seed)) worlds.set(seed, { chunks: [] });
	const w = worlds.get(seed)!;
	if (m[2] === 'meta') {
		w.meta = JSON.parse(value) as Record<string, unknown>;
		continue;
	}
	const cx = Number(m[3]);
	const cz = Number(m[4]);
	// Two on-disk chunk formats exist: the JSON envelope, and a bare base64
	// blocks string from pre-Task-6 saves.
	let blocks = value;
	let fluidMeta: string | undefined;
	try {
		const parsed = JSON.parse(value) as { blocks: string; fluidMeta?: string };
		blocks = parsed.blocks;
		fluidMeta = parsed.fluidMeta;
	} catch {
		/* bare base64 */
	}
	const chunk: Chunk = { cx, cz, blocks };
	if (fluidMeta) chunk.fluidMeta = fluidMeta;
	w.chunks.push(chunk);
}

async function main() {
	const mapping: Record<string, string> = {};
	let failures = 0;

	for (const [seed, w] of worlds) {
		if (!w.meta) {
			console.log(`SKIP seed ${seed}: no meta record`);
			failures++;
			continue;
		}
		const id = idForSeed(seed);
		mapping[seed] = id;

		const body = {
			version: 2 as const,
			id,
			seed: Number(seed),
			name: String(w.meta.name ?? `World ${seed}`).slice(0, 64),
			createdAt: Number(w.meta.createdAt ?? Date.now()),
			updatedAt: Number(w.meta.updatedAt ?? Date.now()),
			player: w.meta.player,
			chunks: w.chunks,
			lights: w.meta.lights,
		};

		const label = `${body.name} (seed ${seed}, ${w.chunks.length} chunks)`;
		if (!write) {
			console.log(`DRY  ${label} -> ${id}`);
			continue;
		}

		// If it already exists this is a re-run: update in place rather than fork.
		const head = await fetch(`${API}/worlds/${id}`);
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (head.status === 200) {
			headers['If-Match'] = head.headers.get('X-Generation') ?? '';
			console.log(`UPD  ${label}`);
		} else {
			headers['If-None-Match'] = '*';
			console.log(`NEW  ${label}`);
		}

		const res = await fetch(`${API}/worlds/${id}`, {
			method: 'PUT',
			headers,
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			console.log(`     FAILED ${res.status} ${await res.text()}`);
			failures++;
			continue;
		}

		// Read it back and compare, so a silent truncation cannot pass as success.
		const check = await fetch(`${API}/worlds/${id}`);
		const stored = (await check.json()) as { chunks: Chunk[]; name: string };
		const same =
			stored.chunks.length === w.chunks.length &&
			JSON.stringify([...stored.chunks].sort(byCoord)) ===
				JSON.stringify([...w.chunks].sort(byCoord));
		console.log(`     verified: ${same ? 'byte-identical' : 'MISMATCH'}`);
		if (!same) failures++;
	}

	console.log(`\n${failures === 0 ? 'All worlds OK' : `${failures} failure(s)`}`);

	if (write) {
		console.log(
			'\n--- Run this in the DevTools console on https://noah.leap-forward.ca/minicraft/',
		);
		console.log('--- so the game adopts these exact ids instead of minting new ones:\n');
		for (const [seed, id] of Object.entries(mapping)) {
			console.log(`localStorage.setItem('minicraft:v2:legacy-map:${seed}', '${id}');`);
		}
		console.log('location.reload();');
	}
	process.exit(failures === 0 ? 0 : 1);
}

function byCoord(a: Chunk, b: Chunk) {
	return a.cx - b.cx || a.cz - b.cz;
}

void main();
