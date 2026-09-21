import { z } from 'zod';

const int = z.number().int();

export const WORLD_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const WORLD_CHUNKS_X = 32;
export const WORLD_CHUNKS_Z = 32;
export const MAX_CHUNKS = WORLD_CHUNKS_X * WORLD_CHUNKS_Z;

// Everything both wire versions share. v2 (`worldSaveWireSchema`) is frozen:
// its behaviour must not change, so anything v3-only goes in the v3 object.
const baseShape = {
	id: z.string().regex(WORLD_ID_RE),
	// int32 and MAY BE NEGATIVE: the menu mints seeds with `Number(input) | 0`.
	seed: int,
	name: z.string().min(1).max(64),
	createdAt: int.nonnegative(),
	updatedAt: int.nonnegative(),
	player: z.object({
		// Floats, negatives allowed, deliberately unclamped to world bounds.
		x: z.number(),
		y: z.number(),
		z: z.number(),
		yaw: z.number(),
		pitch: z.number(),
		hotbar: z.array(int).max(64),
		selected: int.nonnegative(),
	}),
	chunks: z
		.array(
			z.object({
				cx: int.min(0).max(WORLD_CHUNKS_X - 1),
				cz: int.min(0).max(WORLD_CHUNKS_Z - 1),
				blocks: z.string(),
				fluidMeta: z.string().optional(),
			}),
		)
		.max(MAX_CHUNKS),
	lights: z
		.array(
			z.object({
				x: int,
				y: int,
				z: int,
				color: z.string().max(32),
			}),
		)
		.max(4096)
		.optional(),
	lastSyncedGeneration: z.string().nullable().optional(),
};

function noDuplicateChunks(
	w: { chunks: { cx: number; cz: number }[] },
	ctx: z.RefinementCtx,
): void {
	const seen = new Set<string>();
	for (const c of w.chunks) {
		const k = `${c.cx},${c.cz}`;
		if (seen.has(k)) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate chunk ${k}` });
		}
		seen.add(k);
	}
}

export const worldSaveWireSchema = z
	.object({ version: z.literal(2), ...baseShape })
	.superRefine(noDuplicateChunks);

export type WorldSaveWire = z.infer<typeof worldSaveWireSchema>;

// v3 is additive and strict: a stored record's height is authoritative, so an
// unknown or missing key is refused rather than stripped.
export const worldSaveWireSchemaV3 = z
	.object({
		version: z.literal(3),
		height: z.union([z.literal(64), z.literal(256)]),
		genVersion: int.min(1),
		...baseShape,
	})
	.strict()
	.superRefine(noDuplicateChunks);

// NOT an intersection with WorldSaveWire: `version: 2 & 3` is uninhabitable.
export type WorldSaveWireV3 = z.infer<typeof worldSaveWireSchemaV3>;
