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
