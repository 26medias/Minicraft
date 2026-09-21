/** Numeric hash streams for worldgen v3 (spec §10). Integer ops and Math.imul only — bit-exact on every engine. */
export function mix32(h: number): number {
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}
export function streamSeed(seed: number, cx: number, cz: number, feature: number): number {
	let h = mix32((seed | 0) ^ 0x3a5f0d1b);
	h = mix32(h ^ Math.imul(cx | 0, 0x9e3779b1));
	h = mix32(h ^ Math.imul(cz | 0, 0x85ebca77));
	h = mix32(h ^ Math.imul(feature | 0, 0xc2b2ae3d));
	return h;
}
/** Sub-stream for attempt `i` of a feature list: independent of who replays it. */
export function subSeed(base: number, i: number): number {
	return mix32(base ^ Math.imul(i + 1, 0x9e3779b1));
}
export function mulberry32(a: number): () => number {
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
export const F = { TREE: 1, ORE: 2, BLOB: 3, POCKET: 4, GEODE: 5, POOL: 6 } as const;
/** White noise on WORLD coordinates — identical on both sides of a chunk plane. */
export function hashv(x: number, y: number, z: number): number {
	return mix32(mix32(Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) ^ Math.imul(z, 83492791));
}
