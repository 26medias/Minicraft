import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { decodeChunk, decodeFluidMeta, BLOCKS_PER_CHUNK } from './codec';
import { worldSaveWireSchema, WORLD_ID_RE, type WorldSaveWire } from './schema';

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

const objectName = (id: string) => `worlds/${id}.json`;
const OBJECT_RE = /^worlds\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

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

function validateChunks(world: WorldSaveWire): string | null {
	for (const c of world.chunks) {
		let blocks: Uint8Array;
		try {
			blocks = decodeChunk(c.blocks);
		} catch {
			return `chunk ${c.cx},${c.cz} has undecodable blocks`;
		}
		if (blocks.length !== BLOCKS_PER_CHUNK) {
			return `chunk ${c.cx},${c.cz} decoded to ${blocks.length} bytes`;
		}
		if (c.fluidMeta !== undefined) {
			try {
				const m = decodeFluidMeta(c.fluidMeta);
				for (const idx of m.keys()) {
					if (!Number.isInteger(idx) || idx < 0 || idx >= BLOCKS_PER_CHUNK) {
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
		res.json({ ok: true });
	});

	app.get('/worlds', async (_req, res) => {
		try {
			const [files] = await bucket.getFiles({ prefix: 'worlds/' });
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

	app.get('/worlds/:id', async (req, res) => {
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

	app.put('/worlds/:id', async (req, res) => {
		const id = req.params.id;
		if (!WORLD_ID_RE.test(id)) {
			fail(res, 400, 'BAD_ID', 'id must be a uuid');
			return;
		}

		const parsed = worldSaveWireSchema.safeParse(req.body);
		if (!parsed.success) {
			fail(res, 400, 'BAD_BODY', parsed.error.issues[0]?.message ?? 'invalid body');
			return;
		}
		const world = parsed.data;
		if (world.id !== id) {
			fail(res, 400, 'ID_MISMATCH', 'body id does not match path id');
			return;
		}

		const chunkError = validateChunks(world);
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
			const shrink = await shrinkGuard(file, world);
			if (shrink) {
				fail(res, 400, 'SUSPICIOUS_SHRINK', shrink);
				return;
			}
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

	app.delete('/worlds/:id', async (req, res) => {
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

	return app;
}

/**
 * Whole-world replacement is only safe because the client marks every loaded chunk
 * modified. A structurally perfect world with almost no chunks would otherwise
 * silently truncate the stored one.
 */
async function shrinkGuard(file: FileLike, incoming: WorldSaveWire): Promise<string | null> {
	let stored: WorldSaveWire;
	try {
		const [buf] = await file.download();
		stored = JSON.parse(buf.toString()) as WorldSaveWire;
	} catch {
		return null;
	}
	const before = stored.chunks?.length ?? 0;
	if (before > 4 && incoming.chunks.length < before * 0.5) {
		return `refusing to shrink ${before} chunks to ${incoming.chunks.length}`;
	}
	return null;
}
