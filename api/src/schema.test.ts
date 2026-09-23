import { describe, it, expect } from 'vitest';
import { worldSaveWireSchema, worldSaveWireSchemaV3 } from './schema';
import { validWire, validWireV3, manyChunks } from './testFixtures';

describe('worldSaveWireSchema', () => {
	it('accepts a valid world', () => {
		expect(worldSaveWireSchema.safeParse(validWire()).success).toBe(true);
	});

	it('accepts a negative seed', () => {
		// menu.ts mints seeds with `Number(input) | 0`, which can be negative.
		expect(worldSaveWireSchema.safeParse(validWire({ seed: -12345 })).success).toBe(true);
	});

	it('accepts negative float player coordinates', () => {
		const w = validWire();
		w.player = { ...w.player, x: -3.5, y: 61.25, z: -0.001, yaw: -3.1, pitch: 0.2 };
		expect(worldSaveWireSchema.safeParse(w).success).toBe(true);
	});

	it('accepts a hotbar larger than nine slots', () => {
		const w = validWire();
		w.player = { ...w.player, hotbar: Array.from({ length: 19 }, (_, i) => i + 1) };
		expect(worldSaveWireSchema.safeParse(w).success).toBe(true);
	});

	it('accepts zero chunks', () => {
		expect(worldSaveWireSchema.safeParse(validWire({ chunks: [] })).success).toBe(true);
	});

	it('rejects duplicate chunk coordinates', () => {
		const w = validWire();
		w.chunks = [w.chunks[0], { ...w.chunks[0] }];
		expect(worldSaveWireSchema.safeParse(w).success).toBe(false);
	});

	it('rejects out-of-range chunk coordinates', () => {
		const w = validWire();
		w.chunks = [{ ...w.chunks[0], cx: 32 }];
		expect(worldSaveWireSchema.safeParse(w).success).toBe(false);
	});

	it('rejects more than 1024 chunks', () => {
		expect(worldSaveWireSchema.safeParse(validWire({ chunks: manyChunks(1025) })).success).toBe(
			false,
		);
	});

	it('rejects a non-uuid id', () => {
		expect(worldSaveWireSchema.safeParse(validWire({ id: 'nope' })).success).toBe(false);
	});

	it('rejects an empty or oversized name', () => {
		expect(worldSaveWireSchema.safeParse(validWire({ name: '' })).success).toBe(false);
		expect(worldSaveWireSchema.safeParse(validWire({ name: 'x'.repeat(65) })).success).toBe(
			false,
		);
	});

	it('rejects version 1', () => {
		expect(
			worldSaveWireSchema.safeParse({ ...validWire(), version: 1 as never }).success,
		).toBe(false);
	});
});

describe('worldSaveWireSchemaV3', () => {
	it('accepts a valid v3 world', () => {
		expect(worldSaveWireSchemaV3.safeParse(validWireV3()).success).toBe(true);
	});

	it('rejects a height other than 64 or 256', () => {
		expect(worldSaveWireSchemaV3.safeParse({ ...validWireV3(), height: 128 }).success).toBe(false);
	});

	it('rejects version 2', () => {
		expect(worldSaveWireSchemaV3.safeParse({ ...validWireV3(), version: 2 }).success).toBe(false);
	});

	it('is refused by the frozen v2 schema', () => {
		expect(worldSaveWireSchema.safeParse(validWireV3()).success).toBe(false);
	});
});
describe('crafting fields (crafting spec §10)', () => {
	const EXTRAS = {
		inventory: { stone: 12, dirt: 0, deepslate_emerald_ore: 1 },
		tools: { owned: [0, 1, 3], equipped: 3 },
	};
	const v2With = (player: object, top: object = {}) =>
		({ ...validWire(), ...top, player: { ...validWire().player, ...player } }) as unknown;
	const v3With = (player: object, top: object = {}) =>
		({ ...validWireV3(), ...top, player: { ...validWireV3().player, ...player } }) as unknown;

	it('keeps inventory, tools and mustMine in the parsed output of both schemas', () => {
		// Catches: fields missing from the schema. The v2 object strips unknown keys, so
		// a schema without them "accepts" the body and silently drops the counts; the
		// strict v3 object refuses it outright.
		for (const [schema, body] of [
			[worldSaveWireSchema, v2With(EXTRAS, { mustMine: true })],
			[worldSaveWireSchemaV3, v3With(EXTRAS, { mustMine: true })],
		] as const) {
			const r = schema.safeParse(body);
			expect(r.success).toBe(true);
			if (!r.success) continue;
			expect(r.data.player).toMatchObject(EXTRAS);
			expect((r.data as { mustMine?: boolean }).mustMine).toBe(true);
		}
	});

	it('still accepts pre-crafting bodies without the fields', () => {
		// Catches: making any of the three required, which would 400 every save from
		// an old cached bundle (the API must be deployable alone).
		expect(worldSaveWireSchema.safeParse(validWire()).success).toBe(true);
		expect(worldSaveWireSchemaV3.safeParse(validWireV3()).success).toBe(true);
	});

	it('refuses bad counts and tiers', () => {
		// Catches: a schema that strips instead of validating (today's nested player
		// object does exactly that), and bounds that are missing. mustMine is left out
		// of these bodies so the only thing wrong is the player field.
		const bad: object[] = [
			{ inventory: { stone: -1 } },
			{ inventory: { stone: 1.5 } },
			{ inventory: { stone: '3' } },
			{ inventory: [1, 2] },
			{ inventory: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`b${i}`, 1])) },
			{ tools: { owned: [16], equipped: 0 } },
			{ tools: { owned: [-1], equipped: 0 } },
			{ tools: { owned: Array.from({ length: 17 }, () => 0), equipped: 0 } },
			{ tools: { owned: [0], equipped: 16 } },
			{ tools: { owned: [0] } },
		];
		for (const player of bad) {
			expect(worldSaveWireSchemaV3.safeParse(v3With(player)).success, JSON.stringify(player).slice(0, 60)).toBe(false);
			expect(worldSaveWireSchema.safeParse(v2With(player)).success, JSON.stringify(player).slice(0, 60)).toBe(false);
		}
		expect(worldSaveWireSchemaV3.safeParse(v3With({}, { mustMine: 'yes' })).success).toBe(false);
	});

	it('accepts the loose upper bounds', () => {
		// Catches: bounds tied to today's 8 tiers or catalog size, which would force an
		// API redeploy for the next tier.
		const player = {
			inventory: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`b${i}`, 100000])),
			tools: { owned: Array.from({ length: 16 }, (_, i) => i), equipped: 15 },
		};
		expect(worldSaveWireSchemaV3.safeParse(v3With(player, { mustMine: false })).success).toBe(true);
	});

	it('v3 still refuses unknown top-level keys alongside mustMine', () => {
		// Catches: loosening `.strict()` (or `.passthrough()`) to let mustMine in.
		expect(worldSaveWireSchemaV3.safeParse(v3With(EXTRAS, { mustMine: true, bogus: 1 })).success).toBe(false);
	});
});
