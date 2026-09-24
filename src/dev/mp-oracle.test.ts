// Plan I2: the end-to-end suite's oracles. worldHash must see block and fluid changes and ignore
// fluidMeta insertion order; refReplay must be deterministic and must actually move the world.
import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { ChunkOverlay } from '../engine/world/overlay';
import { AIR, WATER, isLiquid, isSolid } from '../data/blocks.data';
import { overlayCells, refReplay, worldHash } from './mp-oracle';

const SEED = 3;

/** An inland surface cell near the centre (T3's rule): solid ground, no liquid within 10, two air above. */
function inland(w: World): { x: number; y: number; z: number } {
	for (let r = 0; r < 200; r += 4) for (let dx = -r; dx <= r; dx += 4) for (const dz of r === 0 ? [0] : [-r, r]) {
		const x = 256 + dx, z = 256 + dz;
		let y = w.height - 2;
		while (y > 1 && w.getBlock(x, y, z) === AIR) y--;
		const g = w.getBlock(x, y, z);
		if (!isSolid(g) || isLiquid(g)) continue;
		let wet = false;
		for (let ax = -10; ax <= 10 && !wet; ax++) for (let az = -10; az <= 10 && !wet; az++) for (let ay = -3; ay <= 2; ay++) if (isLiquid(w.getBlock(x + ax, y + ay, z + az))) { wet = true; break; }
		if (!wet && w.getBlock(x, y + 1, z) === AIR && w.getBlock(x, y + 2, z) === AIR) return { x, y: y + 1, z };
	}
	throw new Error('no inland cell');
}

function around(x: number, z: number): Array<[number, number]> {
	const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
	const out: Array<[number, number]> = [];
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push([cx + dx, cz + dz]);
	return out;
}

describe('worldHash', () => {
	it('changes with a block and with a fluid distance, not with fluidMeta insertion order', () => {
		const w = World.create(SEED);
		const chunks = around(256, 256);
		for (const [cx, cz] of chunks) w.ensureChunk(cx, cz);
		const h0 = worldHash(w, chunks);
		expect(h0).not.toBeNull();
		w.setBlock(256, 5, 256, AIR === 0 ? 1 : 0);
		const h1 = worldHash(w, chunks);
		expect(h1).not.toBe(h0);
		const c = w.getChunk(16, 16)!;
		c.fluidMeta.set(10, 0x83);
		c.fluidMeta.set(5, 0x81);
		const h2 = worldHash(w, chunks);
		expect(h2).not.toBe(h1);
		c.fluidMeta.clear();
		c.fluidMeta.set(5, 0x81);
		c.fluidMeta.set(10, 0x83);
		expect(worldHash(w, chunks)).toBe(h2);
		c.fluidMeta.set(10, 0x84);
		expect(worldHash(w, chunks)).not.toBe(h2);
	});

	it('is null when a chunk is not loaded (it never generates one)', () => {
		const w = World.create(SEED);
		expect(worldHash(w, [[3, 3]])).toBeNull();
		expect(w.getChunk(3, 3)).toBeUndefined();
	});
});

describe('overlayCells', () => {
	it('round-trips through ChunkOverlay.loadSnapshot', () => {
		const o = new ChunkOverlay();
		o.set(17, 70, 300, 1, 0, 0);
		o.set(511, 0, 0, WATER, 0x82, 0);
		o.set(0, 255, 511, 5, 0, 0x1ff00ff);
		const cells = overlayCells(o);
		expect(cells.length).toBe(18);
		const back = new ChunkOverlay();
		back.loadSnapshot(Int32Array.from(cells));
		expect(back.get(17, 70, 300)).toEqual([1, 0, 0]);
		expect(back.get(511, 0, 0)).toEqual([WATER, 0x82, 0]);
		expect(back.get(0, 255, 511)).toEqual([5, 0, 0x1ff00ff]);
	});
});

describe('refReplay', () => {
	it('a pour settles, spreads water, and replays to the same hash; the base overlay is applied', { timeout: 60_000 }, () => {
		const probe = World.create(SEED);
		const s = inland(probe);
		const chunks = around(s.x, s.z);
		const common = { seed: SEED, height: probe.height, gen: probe.genVersion, chunks, player: [s.x + 8.5, s.y + 1, s.z + 0.5] as [number, number, number] };
		const pour = [{ t: 0, kind: 'set' as const, x: s.x, y: s.y, z: s.z, id: WATER }];
		const a = refReplay(pour, { ...common, base: [] });
		const b = refReplay(pour, { ...common, base: [] });
		expect(a).not.toBeNull();
		expect(a!.hash).toBe(b!.hash);
		expect(a!.writes).toBeGreaterThan(1);
		const pristine = World.create(SEED);
		for (const [cx, cz] of chunks) pristine.ensureChunk(cx, cz);
		expect(a!.hash).not.toBe(worldHash(pristine, chunks));
		// A base cell far from the water shows in the hash.
		const withBase = refReplay(pour, { ...common, base: [s.x + 12, s.y + 5, s.z, 1, 0, 0] });
		expect(withBase!.hash).not.toBe(a!.hash);
	});
});
