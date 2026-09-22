import { describe, it, expect } from 'vitest';
import { applySave, worldFromSave } from './apply-save';
import { SaveCorrupt } from '../persistence/errors';
import type { WorldSave } from '../persistence/adapter';

const ID = '11111111-1111-4111-8111-111111111111';
function base(over: Partial<WorldSave>): WorldSave {
	return { version: 2, height: 64, genVersion: 1, id: ID, seed: 1, name: 'w', createdAt: 0, updatedAt: 0, player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 }, chunks: [], ...over };
}

describe('worldFromSave / applySave', () => {
	it('builds a World from the record, not from any summary', () => {
		const w = worldFromSave(base({ version: 3, height: 256, genVersion: 2 }));
		expect(w.height).toBe(256); expect(w.genVersion).toBe(2); expect(w.saveVersion).toBe(3);
	});
	it('applies matching chunks and marks them modified', () => {
		const blocks = new Uint16Array(16384); blocks[5] = 3;
		const w = worldFromSave(base({ chunks: [{ cx: 0, cz: 0, blocks }] }));
		applySave(w, base({ chunks: [{ cx: 0, cz: 0, blocks }] }));
		expect(w.getChunk(0, 0)!.blocks[5]).toBe(3);
		expect(w.getChunk(0, 0)!.modified).toBe(true);
	});
	it('refuses a 16384 chunk in a 256 world before writing anything', () => {
		const w = worldFromSave(base({ version: 3, height: 256, genVersion: 2 }));
		const good = new Uint16Array(65536); good[7] = 3;
		const bad = new Uint16Array(16384);
		expect(() => applySave(w, base({ version: 3, height: 256, genVersion: 2, chunks: [{ cx: 0, cz: 0, blocks: good }, { cx: 1, cz: 0, blocks: bad }] }))).toThrow(SaveCorrupt);
		expect(w.getChunk(0, 0)).toBeUndefined(); // nothing applied
	});
	it('refuses a chunk whose coordinates are outside the world (a malformed key yields NaN)', () => {
		const w = worldFromSave(base({}));
		const blocks = new Uint16Array(16384);
		expect(() => applySave(w, base({ chunks: [{ cx: Number.NaN, cz: 0, blocks }] }))).toThrow(SaveCorrupt);
		expect(() => applySave(w, base({ chunks: [{ cx: 32, cz: 0, blocks }] }))).toThrow(SaveCorrupt);
		expect(() => applySave(w, base({ chunks: [{ cx: 1.5, cz: 0, blocks }] }))).toThrow(SaveCorrupt);
		expect(w.getChunk(0, 0)).toBeUndefined();
	});
});
