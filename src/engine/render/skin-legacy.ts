/**
 * Legacy 64×32 skin → 64×64 (spec §4), vanilla's algorithm: rows 0–31 copied, rows 32–63
 * transparent, each right-limb face copied mirrored into the left-limb rects, base areas forced
 * opaque. The Notch hat-transparency hack is not implemented (no roster skin needs it).
 */
export type LegacyCopy = { sx: number; sy: number; dx: number; dy: number; w: number; h: number };

export const LEGACY_COPIES: readonly LegacyCopy[] = [
	// leg: top, bottom, right side, front, left side, back
	{ sx: 4, sy: 16, dx: 20, dy: 48, w: 4, h: 4 },
	{ sx: 8, sy: 16, dx: 24, dy: 48, w: 4, h: 4 },
	{ sx: 0, sy: 20, dx: 24, dy: 52, w: 4, h: 12 },
	{ sx: 4, sy: 20, dx: 20, dy: 52, w: 4, h: 12 },
	{ sx: 8, sy: 20, dx: 16, dy: 52, w: 4, h: 12 },
	{ sx: 12, sy: 20, dx: 28, dy: 52, w: 4, h: 12 },
	// arm
	{ sx: 44, sy: 16, dx: 36, dy: 48, w: 4, h: 4 },
	{ sx: 48, sy: 16, dx: 40, dy: 48, w: 4, h: 4 },
	{ sx: 40, sy: 20, dx: 40, dy: 52, w: 4, h: 12 },
	{ sx: 44, sy: 20, dx: 36, dy: 52, w: 4, h: 12 },
	{ sx: 48, sy: 20, dx: 32, dy: 52, w: 4, h: 12 },
	{ sx: 52, sy: 20, dx: 44, dy: 52, w: 4, h: 12 },
];

const OPAQUE: ReadonlyArray<[number, number, number, number]> = [[0, 0, 32, 16], [0, 16, 64, 32], [16, 48, 48, 64]];

export function upgradeLegacySkin(src: Uint8ClampedArray): Uint8ClampedArray {
	if (src.length !== 64 * 32 * 4) throw new Error(`legacy skin must be 64×32 RGBA, got ${src.length} bytes`);
	const out = new Uint8ClampedArray(64 * 64 * 4);
	out.set(src);
	for (const c of LEGACY_COPIES) {
		for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
			const s = ((c.sy + y) * 64 + c.sx + (c.w - 1 - x)) * 4;
			const d = ((c.dy + y) * 64 + c.dx + x) * 4;
			out.set(src.subarray(s, s + 4), d);
		}
	}
	for (const [x0, y0, x1, y1] of OPAQUE) {
		for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[(y * 64 + x) * 4 + 3] = 255;
	}
	return out;
}
