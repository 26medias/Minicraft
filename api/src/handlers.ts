import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { z } from 'zod';
import { decodeChunk, decodeFluidMeta, LEGACY_BLOCKS_PER_CHUNK } from './codec';
import {
	inventorySchema,
	toolsSchema,
	worldSaveWireSchema,
	worldSaveWireSchemaV3,
	WORLD_ID_RE,
	type WorldSaveWire,
} from './schema';

export const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ALLOWED_ORIGINS = [
	'https://noah.leap-forward.ca',
	'http://localhost:5173',
	'http://127.0.0.1:5173',
	// `vite preview` — used to rehearse the production bundle before deploying.
	'http://localhost:4173',
	'http://127.0.0.1:4173',
];

/** Minimal structural view of the bucket, so tests can inject a fake. */
export type SaveOpts = {
	preconditionOpts?: { ifGenerationMatch?: string | number };
	metadata?: { contentType?: string; cacheControl?: string; metadata?: Record<string, string> };
};

export interface BucketLike {
	file(name: string): FileLike;
	getFiles(opts?: { prefix?: string }): Promise<[FileLike[]]>;
}
export interface FileLike {
	name: string;
	save(contents: string, opts?: SaveOpts): Promise<void>;
	download(): Promise<[Buffer]>;
	getMetadata(): Promise<[{ generation: string; size: number; metadata: Record<string, string> }]>;
	delete(opts?: { ifGenerationMatch?: string | number }): Promise<void>;
}

/** `WorldSaveWire.version` is `literal(2)`, so `WorldSaveWireV3 extends WorldSaveWire` is FALSE and a
 *  generic bounded by WorldSaveWire does not typecheck (TS2322 on the schema, TS2339 on .height).
 *  vitest never type-checks, so this only surfaces in `cd api && npx tsc --noEmit` — run it. */
export type WireBase = Omit<WorldSaveWire, 'version'> & { version: 2 | 3 };

/** One storage namespace: the old `/worlds` (v2, fixed 64-tall) or `/v3/worlds`. */
type Namespace<W extends WireBase> = {
	routePrefix: string; // '/worlds' | '/v3/worlds'
	objectPrefix: string; // 'worlds/' | 'worlds3/'
	schema: z.ZodType<W>;
	blocksPerChunk: (w: W) => number;
	extraMetadata: (w: W) => Record<string, string>; // {} | { height, genVersion }
	extraSummary: (custom: Record<string, string>) => Record<string, unknown>; // {} | { height, genVersion }
};

// The FULL anchored uuid group, exactly as the old namespace always had it.
const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function objectRe(prefix: string): RegExp {
	return new RegExp(`^${prefix.replace(/\//g, '\\/')}(${UUID_SRC})\\.json$`);
}

function isPreconditionFailure(err: unknown): boolean {
	const code = (err as { code?: number }).code;
	return code === 412;
}
function isNotFound(err: unknown): boolean {
	const code = (err as { code?: number }).code;
	return code === 404;
}

function fail(res: Response, status: number, code: string, error: string) {
	res.status(status).json({ code, error });
}

/**
 * Rejects a body over the cap. This has to run before req.body is touched:
 * functions-framework mounts its own parsers at limit '1024mb' ahead of the
 * handler, so express.json({limit}) never fires.
 */
function bodyTooLarge(req: Request): boolean {
	const len = Number(req.headers['content-length'] ?? 0);
	return Number.isFinite(len) && len > MAX_BODY_BYTES;
}

function validateChunks(world: WireBase, len: number): string | null {
	for (const c of world.chunks) {
		let blocks: Uint16Array;
		try {
			blocks = decodeChunk(c.blocks, len);
		} catch {
			return `chunk ${c.cx},${c.cz} has undecodable blocks`;
		}
		if (blocks.length !== len) {
			return `chunk ${c.cx},${c.cz} decoded to ${blocks.length} bytes`;
		}
		if (c.fluidMeta !== undefined) {
			try {
				const m = decodeFluidMeta(c.fluidMeta);
				for (const idx of m.keys()) {
					if (!Number.isInteger(idx) || idx < 0 || idx >= len) {
						return `chunk ${c.cx},${c.cz} has fluidMeta index ${idx} out of range`;
					}
				}
			} catch {
				return `chunk ${c.cx},${c.cz} has undecodable fluidMeta`;
			}
		}
	}
	return null;
}

export function createApp(bucket: BucketLike): Express {
	const app = express();

	app.use((req: Request, res: Response, next: NextFunction) => {
		const origin = req.headers.origin;
		const allow =
			origin && ALLOWED_ORIGINS.includes(origin)
				? origin
				: /^http:\/\/(192\.168|10\.|172\.)[\d.]+:5173$/.test(origin ?? '')
					? origin!
					: ALLOWED_ORIGINS[0];
		res.setHeader('Access-Control-Allow-Origin', allow);
		res.setHeader('Vary', 'Origin');
		res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-Match, If-None-Match');
		res.setHeader('Access-Control-Expose-Headers', 'X-Generation');
		if (req.method === 'OPTIONS') {
			res.status(204).end();
			return;
		}
		next();
	});

	app.use((req: Request, res: Response, next: NextFunction) => {
		if (bodyTooLarge(req)) {
			fail(res, 413, 'TOO_LARGE', `body exceeds ${MAX_BODY_BYTES} bytes`);
			return;
		}
		next();
	});

	app.use(express.json({ limit: '64mb' }));

	app.get('/health', (_req, res) => {
		// playerExtras: this build stores inventory/tools/mustMine and runs the
		// old-client guard. `deploy.sh --verify` asserts it.
		res.json({ ok: true, codec: 3, playerExtras: 1 });
	});

	registerWorldRoutes(app, bucket, {
		routePrefix: '/worlds',
		objectPrefix: 'worlds/',
		schema: worldSaveWireSchema,
		blocksPerChunk: () => LEGACY_BLOCKS_PER_CHUNK,
		extraMetadata: () => ({}),
		extraSummary: () => ({}),
	});

	registerWorldRoutes(app, bucket, {
		routePrefix: '/v3/worlds',
		objectPrefix: 'worlds3/',
		schema: worldSaveWireSchemaV3,
		blocksPerChunk: (w) => 16 * w.height * 16,
		extraMetadata: (w) => ({ height: String(w.height), genVersion: String(w.genVersion) }),
		extraSummary: (custom) => ({
			height: Number(custom.height),
			genVersion: Number(custom.genVersion),
		}),
	});

	return app;
}

function registerWorldRoutes<W extends WireBase>(
	app: Express,
	bucket: BucketLike,
	ns: Namespace<W>,
): void {
	const objectName = (id: string) => `${ns.objectPrefix}${id}.json`;
	const OBJECT_RE = objectRe(ns.objectPrefix);

	app.get(ns.routePrefix, async (_req, res) => {
		try {
			const [files] = await bucket.getFiles({ prefix: ns.objectPrefix });
			const out = [];
			for (const f of files) {
				const m = OBJECT_RE.exec(f.name);
				if (!m) continue;
				const id = m[1];
				try {
					const [meta] = await f.getMetadata();
					const custom = meta.metadata ?? {};
					const seed = Number(custom.seed);
					const createdAt = Number(custom.createdAt);
					const updatedAt = Number(custom.updatedAt);
					const ok =
						typeof custom.name === 'string' &&
						custom.name.length > 0 &&
						Number.isFinite(seed) &&
						Number.isFinite(createdAt) &&
						Number.isFinite(updatedAt);
					if (!ok) {
						// Never skip: a real world vanishing from the menu is the exact
						// "looks lost" failure the no-index design exists to avoid.
						out.push({
							id,
							seed: 0,
							name: `Recovered world ${id.slice(0, 8)}`,
							createdAt: 0,
							updatedAt: 0,
							origin: 'cloud' as const,
							sizeBytes: Number(meta.size) || 0,
							generation: meta.generation,
							degraded: true,
						});
						continue;
					}
					out.push({
						id,
						seed,
						name: custom.name,
						createdAt,
						updatedAt,
						origin: 'cloud' as const,
						sizeBytes: Number(meta.size) || 0,
						generation: meta.generation,
						...ns.extraSummary(custom),
					});
				} catch {
					out.push({
						id,
						seed: 0,
						name: `Recovered world ${id.slice(0, 8)}`,
						createdAt: 0,
						updatedAt: 0,
						origin: 'cloud' as const,
						degraded: true,
					});
				}
			}
			out.sort((a, b) => b.updatedAt - a.updatedAt);
			res.json(out);
		} catch (err) {
			fail(res, 500, 'SERVER', (err as Error).message);
		}
	});

	app.get(`${ns.routePrefix}/:id`, async (req, res) => {
		const id = req.params.id;
		if (!WORLD_ID_RE.test(id)) {
			fail(res, 400, 'BAD_ID', 'id must be a uuid');
			return;
		}
		try {
			const file = bucket.file(objectName(id));
			const [meta] = await file.getMetadata();
			const [buf] = await file.download();
			res.setHeader('X-Generation', meta.generation);
			res.json({ ...JSON.parse(buf.toString()), generation: meta.generation });
		} catch (err) {
			if (isNotFound(err)) {
				fail(res, 404, 'NOT_FOUND', 'no such world');
				return;
			}
			fail(res, 500, 'SERVER', (err as Error).message);
		}
	});

	app.put(`${ns.routePrefix}/:id`, async (req, res) => {
		const id = req.params.id;
		if (!WORLD_ID_RE.test(id)) {
			fail(res, 400, 'BAD_ID', 'id must be a uuid');
			return;
		}

		const parsed = ns.schema.safeParse(req.body);
		if (!parsed.success) {
			fail(res, 400, 'BAD_BODY', parsed.error.issues[0]?.message ?? 'invalid body');
			return;
		}
		const world = parsed.data;
		if (world.id !== id) {
			fail(res, 400, 'ID_MISMATCH', 'body id does not match path id');
			return;
		}

		const chunkError = validateChunks(world, ns.blocksPerChunk(world));
		if (chunkError) {
			fail(res, 400, 'BAD_CHUNK', chunkError);
			return;
		}

		const ifMatch = req.headers['if-match'];
		const ifNoneMatch = req.headers['if-none-match'];
		let precondition: string | number | undefined;
		if (typeof ifMatch === 'string' && ifMatch.length > 0) {
			precondition = ifMatch;
		} else if (ifNoneMatch === '*') {
			precondition = 0;
		} else {
			// No precondition is no protection; refusing is safer than a blind write.
			fail(res, 428, 'PRECONDITION_REQUIRED', 'send If-Match or If-None-Match: *');
			return;
		}

		const file = bucket.file(objectName(id));

		if (precondition !== 0) {
			let stored: StoredWorld | null;
			try {
				stored = await readStored(file);
			} catch (err) {
				// Never guess: saving without the stored object could wipe the counts
				// an old client does not send. The client retries a 503.
				fail(res, 503, 'UNAVAILABLE', `could not read the stored world: ${(err as Error).message}`);
				return;
			}
			const shrink = shrinkGuard(stored, world);
			if (shrink) {
				fail(res, 400, 'SUSPICIOUS_SHRINK', shrink);
				return;
			}
			keepStoredExtras(stored, world);
		}

		try {
			await file.save(JSON.stringify(world), {
				// The real client takes the precondition under preconditionOpts.
				// A top-level ifGenerationMatch is silently IGNORED by GCS — the
				// deployed API returned 200 for a stale generation until this was fixed.
				preconditionOpts: { ifGenerationMatch: precondition },
				metadata: {
					contentType: 'application/json',
					cacheControl: 'no-store',
					metadata: {
						name: world.name,
						seed: String(world.seed),
						createdAt: String(world.createdAt),
						updatedAt: String(world.updatedAt),
						...ns.extraMetadata(world),
					},
				},
			});
			const [meta] = await file.getMetadata();
			res.setHeader('X-Generation', meta.generation);
			res.json({ updatedAt: world.updatedAt, generation: meta.generation });
		} catch (err) {
			if (isPreconditionFailure(err)) {
				fail(res, 409, 'CONFLICT', 'world was changed elsewhere');
				return;
			}
			fail(res, 500, 'SERVER', (err as Error).message);
		}
	});

	app.delete(`${ns.routePrefix}/:id`, async (req, res) => {
		const id = req.params.id;
		if (!WORLD_ID_RE.test(id)) {
			fail(res, 400, 'BAD_ID', 'id must be a uuid');
			return;
		}
		const ifMatch = req.headers['if-match'];
		try {
			// A plain delete of the live object leaves a recoverable noncurrent
			// version. A generation-TARGETED delete would destroy permanently.
			await bucket.file(objectName(id)).delete(
				typeof ifMatch === 'string' && ifMatch.length > 0
					? { ifGenerationMatch: ifMatch }
					: {},
			);
			res.status(204).end();
		} catch (err) {
			if (isNotFound(err)) {
				fail(res, 404, 'NOT_FOUND', 'no such world');
				return;
			}
			if (isPreconditionFailure(err)) {
				fail(res, 409, 'CONFLICT', 'world was changed elsewhere');
				return;
			}
			fail(res, 500, 'SERVER', (err as Error).message);
		}
	});
}

/** The stored object as read back, trusted for nothing until each field is checked. */
type StoredWorld = { chunks?: unknown; player?: { inventory?: unknown; tools?: unknown }; mustMine?: unknown };

/**
 * The stored object, or `null` when there is none. Only a real 404 means "nothing
 * stored": any other download error THROWS, and the PUT answers 503. Turning an error
 * into "nothing stored" (what shrinkGuard used to do) would let an old client's save
 * drop the stored counts, tools and mode. A body that downloads but does not parse
 * reads as `{}`: nothing in it can be kept, and refusing would wedge the world.
 */
async function readStored(file: FileLike): Promise<StoredWorld | null> {
	let buf: Buffer;
	try {
		[buf] = await file.download();
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
	try {
		const parsed: unknown = JSON.parse(buf.toString());
		return typeof parsed === 'object' && parsed !== null ? (parsed as StoredWorld) : {};
	} catch {
		return {};
	}
}

/**
 * Whole-world replacement is only safe because the client marks every loaded chunk
 * modified. A structurally perfect world with almost no chunks would otherwise
 * silently truncate the stored one.
 */
function shrinkGuard(stored: StoredWorld | null, incoming: WireBase): string | null {
	const before = Array.isArray(stored?.chunks) ? stored.chunks.length : 0;
	if (before > 4 && incoming.chunks.length < before * 0.5) {
		return `refusing to shrink ${before} chunks to ${incoming.chunks.length}`;
	}
	return null;
}

/**
 * Old-client guard (crafting spec §10). A bundle from before crafting sends no
 * inventory, tools or mustMine, and a PUT replaces the object whole, so a stale
 * cached bundle would wipe them. Each field the save OMITS is carried over from the
 * stored object, if the stored value is itself valid. A field that is sent always
 * wins, including an empty inventory `{}` and `mustMine: false`.
 */
function keepStoredExtras(stored: StoredWorld | null, world: WireBase): void {
	if (!stored) return;
	if (world.player.inventory === undefined) {
		const inv = inventorySchema.safeParse(stored.player?.inventory);
		if (inv.success) world.player.inventory = inv.data;
	}
	if (world.player.tools === undefined) {
		const tools = toolsSchema.safeParse(stored.player?.tools);
		if (tools.success) world.player.tools = tools.data;
	}
	if (world.mustMine === undefined && typeof stored.mustMine === 'boolean') {
		world.mustMine = stored.mustMine;
	}
}
