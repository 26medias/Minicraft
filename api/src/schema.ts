import { z } from 'zod';

const int = z.number().int();

export const WORLD_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const WORLD_CHUNKS_X = 32;
export const WORLD_CHUNKS_Z = 32;
export const MAX_CHUNKS = WORLD_CHUNKS_X * WORLD_CHUNKS_Z;

// Crafting fields (crafting spec §10). Loose bounds on purpose: a later pickaxe
// tier or a few hundred more blocks must not need an API redeploy.
export const MAX_INVENTORY_KEYS = 2000;
export const MAX_TOOL_TIER = 15;
export const MAX_OWNED_TOOLS = 16;

export const inventorySchema = z
	.record(z.string(), int.nonnegative())
	.refine((r) => Object.keys(r).length <= MAX_INVENTORY_KEYS, {
		message: `inventory has more than ${MAX_INVENTORY_KEYS} keys`,
	});

export const toolsSchema = z.object({
	owned: z.array(int.min(0).max(MAX_TOOL_TIER)).max(MAX_OWNED_TOOLS),
	equipped: int.min(0).max(MAX_TOOL_TIER),
});

// Everything both wire versions share. v2 (`worldSaveWireSchema`) is frozen in
// the sense that nothing it accepted may start being refused: it may only grow
// by OPTIONAL fields (the crafting fields below). Anything v3-only goes in the
// v3 object.
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
		// Optional: a save from a bundle older than crafting has neither.
		inventory: inventorySchema.optional(),
		tools: toolsSchema.optional(),
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
	// "Must mine to build". Optional for the same reason; missing means false.
	mustMine: z.boolean().optional(),
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
