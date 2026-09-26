/**
 * Pixel rules for scripts/import-textures.ts and the texture guard tests (texture replacement spec §5).
 * Pure: RGBA Uint8Array tiles in, RGBA out; no fs, no sharp.
 */
import { averageRgb, type Rgb } from './atlas-derive';

export const TILE = 16;
export const meanRgb = averageRgb;

const lumOf = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export function meanLum(raw: Uint8Array): number {
	let s = 0, n = 0;
	for (let i = 0; i < raw.length; i += 4) if (raw[i + 3] > 0) { s += lumOf(raw[i], raw[i + 1], raw[i + 2]); n++; }
	return n === 0 ? 0 : s / n;
}

export function lumStd(raw: Uint8Array): number {
	const m = meanLum(raw);
	let s = 0, n = 0;
	for (let i = 0; i < raw.length; i += 4) if (raw[i + 3] > 0) { const d = lumOf(raw[i], raw[i + 1], raw[i + 2]) - m; s += d * d; n++; }
	return n === 0 ? 0 : Math.sqrt(s / n);
}

export function clipFraction(raw: Uint8Array): number {
	let c = 0, n = 0;
	for (let i = 0; i < raw.length; i += 4) if (raw[i + 3] > 0) { n++; if (raw[i] === 255 || raw[i + 1] === 255 || raw[i + 2] === 255) c++; }
	return n === 0 ? 0 : c / n;
}

export function alphaZeroFraction(raw: Uint8Array): number {
	let c = 0;
	for (let i = 3; i < raw.length; i += 4) if (raw[i] === 0) c++;
	return c / (raw.length / 4);
}

export function hueSat([r, g, b]: Rgb): { hue: number; sat: number } {
	const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
	const sat = max === 0 ? 0 : d / max;
	if (d === 0) return { hue: 0, sat };
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return { hue: (h * 60 + 360) % 360, sat };
}

export function toLab([r, g, b]: Rgb): [number, number, number] {
	const lin = (c: number) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
	const [R, G, B] = [lin(r), lin(g), lin(b)];
	const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505;
	const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
	const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089;
	const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE(a: Rgb, b: Rgb): number {
	const [l1, a1, b1] = toLab(a), [l2, a2, b2] = toLab(b);
	return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

export type AlphaMode = 'keep' | 'opaque' | 'cutout' | 'translucent';

export function normaliseAlpha(raw: Uint8Array, mode: AlphaMode): Uint8Array {
	const out = new Uint8Array(raw);
	if (mode === 'keep' || mode === 'translucent') return out;
	if (mode === 'cutout') {
		for (let i = 3; i < out.length; i += 4) out[i] = out[i] >= 128 ? 255 : 0;
		return out;
	}
	// opaque: every alpha-0 pixel takes the colour of the nearest pixel with alpha > 0 (Chebyshev rings).
	const n = TILE;
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
		const o = (y * n + x) * 4;
		if (raw[o + 3] === 0) {
			found: for (let r = 1; r < n; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
				const s = (yy * n + xx) * 4;
				if (raw[s + 3] > 0) { out[o] = raw[s]; out[o + 1] = raw[s + 1]; out[o + 2] = raw[s + 2]; break found; }
			}
		}
		out[o + 3] = 255;
	}
	return out;
}

/** Source-over: overlay (alpha × overlayAlpha, clamped to 255) on base. Result alpha is base's. */
export function composite(base: Uint8Array, over: Uint8Array, overlayAlpha = 1): Uint8Array {
	const out = new Uint8Array(base);
	for (let i = 0; i < out.length; i += 4) {
		const a = Math.min(255, over[i + 3] * overlayAlpha) / 255;
		for (let c = 0; c < 3; c++) out[i + c] = Math.round(over[i + c] * a + base[i + c] * (1 - a));
	}
	return out;
}
