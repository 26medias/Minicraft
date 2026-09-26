# Texture Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Mojang block texture and crack stage in `src/assets/blocks/` with CC BY-SA art from four
pinned packs, with provenance, licence, credits and guard tests, without changing any block id, catalog row or save.

**Architecture:** One pure data file (`texture-sources.data.ts`) names a source for each of the 458 output PNGs.
One pure module (`texture-import.ts`) holds every pixel rule: alpha normalisation, compositing, grey-tint with
target luminance, and the measurements. A by-hand script (`import-textures.ts`) does the I/O: fetch the packs at
their pinned commits, apply the rules, write PNGs and `SOURCES.json`, and delete everything else. The atlas build
keeps reading `src/assets/blocks/`; only its tint table and `greyTint` gain change. Guard tests pin provenance,
alpha, tints, ore visibility and derived-tile quality.

**Tech Stack:** TypeScript, tsx, sharp, vitest (node environment, `src/**/*.test.ts` only), Vite (`public/` copied
to `dist/`).

**Spec:** `docs/superpowers/specs/2026-09-26-texture-replacement-design.md` (rev 3.1). Read it before any task.

## Global Constraints

- Work only in the worktree `/home/julien/Projects/Minicraft/.claude/worktrees/textures` (branch `textures`).
  Never `cd` to `/home/julien/Projects/Minicraft`.
- 1 tab = 4 spaces; match the surrounding style (tabs in TS files).
- **Never `git add -A` or `git add .`.** Stage explicit paths. `.claude/agent-memory/` is git-ignored; leave it.
- No block id, catalog row, `blocks.catalog.data.ts`, `blocks.catalog.ids.json` or `blocks.base.data.ts` change. No
  `gen-catalog` run.
- Pinned packs (spec §4.1):
  - `ppce`: https://github.com/Athemis/PixelPerfectionCE @ `28e38cab7c1f03f86364ef704f705bebcc13cb3d`
  - `refi`: https://github.com/MysticTempest/REFI_Textures @ `33f1f719930d1d202beaa5fa6251c26d3a711149`
  - `bauniclonia`: https://codeberg.org/mirtilo/Bauniclonia.git @ `77318ecabc046efb2caa9237a9efb45c7b401523`
  - `mineclonia`: https://codeberg.org/mineclonia/mineclonia @ `c1898e3951ded8b3445f4396cc7d7b17844da357`
- Local checkouts at exactly those commits already exist (use `--packs-dir` to avoid network):
  `S=/tmp/claude-1000/-home-julien-Projects-Minicraft/6b90f23a-dd68-4f0c-bacc-dad25a29d5a5/scratchpad`:
  - `ppce`: `$S/ppce`
  - `refi`: `$S/packs/refi`
  - `bauniclonia`: `$S/packs/bauniclonia`
  - `mineclonia`: `$S/packs/mineclonia` (textures only)
- Fixed numbers from the spec:
  - `targetLum` defaults to **180**; plain TNT rows use **150**, froglights **210**, creaking heart **120**.
  - Tint cap: saturation **< 0.30**. Grey threshold: **< 0.27**. Hue band **45°–150°**.
  - `HUE_EXEMPT = ['pale_oak_leaves', 'cherry_leaves']`, `UNTINTED_GREY = ['pale_oak_leaves']`.
  - Ores: **≥ 12 px** at ΔE > **25** from the host mean; `deepslate_coal_ore` uses ΔE > **12**.
  - Derived tiles: luminance std **> 8**, clipped pixels **≤ 50%**.
  - Import refusal: **> 5% alpha-0 pixels** on an opaque block's non-`over` row.
- Mojang pixels must never enter the tree after Task 4. The `--sheet` output never goes inside the repo.
- Headless only for browser work: Playwright headless, the production save API blocked (reuse the pattern in
  `scripts/menu-smoke.ts`), `localhost:5173` only. Never the production site; never a headed browser.

## Review Focus

1. **A block added later with no source row.** Expectation: `npm test` goes red, naming the missing texture. It
   must not silently fall back to an old file. Test: Task 4, `texture-provenance.test.ts`, "every texture a block
   uses is a row".
2. **Running the importer twice.** Expectation: the second run is a no-op (byte-identical PNGs, the same
   `SOURCES.json`). Test: Task 3, `texture-import.test.ts`, "encodePng is deterministic"; plus Task 7 re-import diff.
3. **The importer with an unreachable pack or wrong commit.** Expectation: exits non-zero with the pack name and
   commit before writing anything, so there is no half-written `src/assets/blocks/`. Test: Task 3,
   "resolveRows / validate before write" (the write phase starts only after every row renders in memory).
4. **One texture used by two blocks with different alpha flags.** Expectation: the importer fails loudly. Test:
   Task 2, `alphaModeFor` throws on conflicting flags.
5. **The credits link at the `/minicraft/` subpath.** Expectation: the "Texture credits" link opens `CREDITS.txt`
   next to `index.html` (relative href, base `./`). Test: Task 5, the link's `href` is exactly `CREDITS.txt` (no
   leading slash), plus the Task 7 look run clicking it.

---

### Task 1: Pixel rules module and the luminance-normalised `greyTint`

**Files:**
- Create: `src/data/texture-import.ts`
- Create: `src/data/texture-import.test.ts`
- Modify: `src/data/atlas-derive.ts` (the `greyTint` gain, the `DERIVED_TEXTURES` value type)
- Modify: `src/data/atlas-derive.test.ts` (rewrite the "equal luminance" check; add std/clip checks)
- Modify: `scripts/build-atlas.ts:86-90` (pass `targetLum` through)

**Interfaces:**
- Produces (in `src/data/texture-import.ts`, all pure, RGBA `Uint8Array` of 16×16×4 unless stated):
  - `export const TILE = 16`
  - `export function meanLum(raw: Uint8Array): number` (Rec. 601 over alpha > 0; 0 if none)
  - `export function lumStd(raw: Uint8Array): number`
  - `export function clipFraction(raw: Uint8Array): number` (share of alpha > 0 pixels with any channel = 255)
  - `export function meanRgb(raw: Uint8Array): Rgb` (re-exports `averageRgb`)
  - `export function hueSat(rgb: Rgb): { hue: number; sat: number }` (HSV of one colour; hue 0..360)
  - `export function toLab(rgb: Rgb): [number, number, number]`, `export function deltaE(a: Rgb, b: Rgb): number`
  - `export function alphaZeroFraction(raw: Uint8Array): number`
  - `export type AlphaMode = 'keep' | 'opaque' | 'cutout' | 'translucent'`
  - `export function normaliseAlpha(raw: Uint8Array, mode: AlphaMode): Uint8Array`
  - `export function composite(base: Uint8Array, over: Uint8Array, overlayAlpha = 1): Uint8Array`
- Produces (in `atlas-derive.ts`): `greyTint(raw: Uint8Array, tint: Rgb, targetLum = DEFAULT_TARGET_LUM): Uint8Array`,
  `export const DEFAULT_TARGET_LUM = 180`, and the `DERIVED_TEXTURES` value type
  `{ source: string; tint: Rgb; targetLum?: number }`. `TINT_GAIN` is removed.

- [ ] **Step 1: Write the failing tests for the pixel rules**

```ts
// src/data/texture-import.test.ts
import { describe, it, expect } from 'vitest';
import {
	TILE, alphaZeroFraction, clipFraction, composite, deltaE, hueSat, lumStd, meanLum, normaliseAlpha,
} from './texture-import';

const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];
function tileOf(fn: (i: number) => number[]): Uint8Array {
	const out = new Uint8Array(TILE * TILE * 4);
	for (let i = 0; i < TILE * TILE; i++) out.set(fn(i), i * 4);
	return out;
}

describe('texture-import pixel rules', () => {
	it('meanLum ignores alpha-0 pixels', () => {
		const t = tileOf((i) => (i % 2 ? px(255, 255, 255) : px(0, 0, 0, 0)));
		expect(meanLum(t)).toBeCloseTo(255, 0);
	});
	it('lumStd is 0 for a flat tile and > 0 for a checker', () => {
		expect(lumStd(tileOf(() => px(90, 90, 90)))).toBe(0);
		expect(lumStd(tileOf((i) => (i % 2 ? px(0, 0, 0) : px(200, 200, 200))))).toBeGreaterThan(50);
	});
	it('clipFraction counts pixels with any channel at 255', () => {
		expect(clipFraction(tileOf((i) => (i < 64 ? px(255, 10, 10) : px(10, 10, 10))))).toBeCloseTo(0.25, 5);
	});
	it('hueSat of a pure green is 120° and 1', () => {
		expect(hueSat([0, 200, 0])).toEqual({ hue: 120, sat: 1 });
	});
	it('deltaE is 0 for equal colours and large for black vs white', () => {
		expect(deltaE([10, 20, 30], [10, 20, 30])).toBe(0);
		expect(deltaE([0, 0, 0], [255, 255, 255])).toBeGreaterThan(99);
	});
	it('alphaZeroFraction counts only fully transparent pixels', () => {
		expect(alphaZeroFraction(tileOf((i) => (i < 128 ? px(1, 1, 1, 0) : px(1, 1, 1, 140))))).toBe(0.5);
	});
	it('normaliseAlpha: opaque fills holes from the nearest opaque neighbour and forces 255', () => {
		const t = tileOf((i) => (i === 0 ? px(0, 0, 0, 0) : px(50, 60, 70, 140)));
		const o = normaliseAlpha(t, 'opaque');
		expect([...o.slice(0, 4)]).toEqual([50, 60, 70, 255]);
		for (let i = 3; i < o.length; i += 4) expect(o[i]).toBe(255);
	});
	it('normaliseAlpha: cutout snaps to 0/255 at 128; translucent and keep leave alpha alone', () => {
		const t = tileOf((i) => px(9, 9, 9, i % 2 ? 127 : 128));
		const c = normaliseAlpha(t, 'cutout');
		expect(c[3]).toBe(255); expect(c[7]).toBe(0);
		expect(normaliseAlpha(t, 'keep')).toEqual(t);
		expect(normaliseAlpha(t, 'translucent')).toEqual(t);
	});
	it('composite puts an overlay over a base; overlayAlpha scales the overlay', () => {
		const base = tileOf(() => px(100, 100, 100));
		const over = tileOf((i) => (i === 0 ? px(0, 0, 0, 48) : px(0, 0, 0, 0)));
		const once = composite(base, over, 1);
		const thrice = composite(base, over, 3);
		expect(once[0]).toBeGreaterThan(thrice[0]);                  // ×3 overlay is darker
		expect([...once.slice(4, 8)]).toEqual([100, 100, 100, 255]); // untouched pixel
		expect(once[3]).toBe(255);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/data/texture-import.test.ts`
Expected: FAIL, "Failed to resolve import './texture-import'".

- [ ] **Step 3: Implement `src/data/texture-import.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify the new tests pass**

Run: `npx vitest run src/data/texture-import.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Rewrite the `greyTint` test first (it must fail on the constant-gain code)**

In `src/data/atlas-derive.test.ts`, replace the block from `// Equal luminance in → equal colour out` to the end
of that `it` with:

```ts
		// Gain comes from the source's own brightness (spec §5.6): a dark and a bright source give
		// the same mean output luminance. Catches a constant gain, which scaled TNT and shroomlight alike.
		const dark = new Uint8Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? 255 : 40 + (i % 7)));
		const bright = new Uint8Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? 255 : 160 + (i % 7)));
		const lum = (t: Uint8Array) => { let s = 0; for (let i = 0; i < t.length; i += 4) s += 0.299 * t[i] + 0.587 * t[i + 1] + 0.114 * t[i + 2]; return s / (t.length / 4); };
		const a = greyTint(dark, [255, 255, 255], 120), b = greyTint(bright, [255, 255, 255], 120);
		expect(Math.abs(lum(a) - lum(b))).toBeLessThan(2);
		expect(Math.abs(lum(a) - 120)).toBeLessThan(3);
```

And add a new test at the end of the `describe('derived TNT textures (spec §6)'…)` block:

```ts
	it('every DERIVED_TEXTURES tile keeps its texture: luminance std > 8, at most 50% clipped (spec §5.6)', async () => {
		// Catches a gain that washes a tile out (launch_pad clipped 52% at gain 2.5) or flattens it
		// to a swatch (froglights at constant gain clipped 100%).
		const { lumStd, clipFraction } = await import('./texture-import');
		for (const [name, d] of Object.entries(DERIVED_TEXTURES)) {
			const out = greyTint(await tile(d.source), d.tint, d.targetLum);
			expect(lumStd(out), `${name} std`).toBeGreaterThan(8);
			expect(clipFraction(out), `${name} clip`).toBeLessThanOrEqual(0.5);
		}
	});
```

Run: `npx vitest run src/data/atlas-derive.test.ts`
Expected: FAIL on "greyscale-then-tint" (constant gain: `lum(a)` ≠ `lum(b)`).

- [ ] **Step 6: Implement the target-luminance gain**

In `src/data/atlas-derive.ts`:
- Replace the file comment's first bullet with
  `DERIVED_TEXTURES: a block tile turned to greyscale, then tinted to a target luminance (Big/Mega TNT, the toys, launch_pad; texture spec §5.6);`.
- Replace `TINT_GAIN` and its comment with:

```ts
/** Mean luminance a derived tile is scaled to (texture spec §5.6). 180 is the only tried value where every derived tile passes the brightness assertions. */
export const DEFAULT_TARGET_LUM = 180;
```

- Change the value type in `DERIVED_TEXTURES` and in `toyTints()` from `{ source: string; tint: Rgb }` to
  `{ source: string; tint: Rgb; targetLum?: number }`.
- Replace `greyTint` with:

```ts
/** RGBA in, RGBA out: luminance (Rec. 601) scaled so the tile's mean luminance (alpha > 0) is targetLum, × tint / 255, clamped; alpha kept. */
export function greyTint(raw: Uint8Array, tint: Rgb, targetLum = DEFAULT_TARGET_LUM): Uint8Array {
	let s = 0, n = 0;
	for (let i = 0; i < raw.length; i += 4) if (raw[i + 3] > 0) { s += 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]; n++; }
	const gain = n === 0 || s === 0 ? 0 : targetLum / (s / n);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 4) {
		const l = (0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]) * gain;
		out[i] = Math.min(255, Math.round((l * tint[0]) / 255));
		out[i + 1] = Math.min(255, Math.round((l * tint[1]) / 255));
		out[i + 2] = Math.min(255, Math.round((l * tint[2]) / 255));
		out[i + 3] = raw[i + 3];
	}
	return out;
}
```

In `scripts/build-atlas.ts`, change `greyTint(raw, derived.tint)` to `greyTint(raw, derived.tint, derived.targetLum)`.
Search the repo for other `TINT_GAIN` uses: `grep -rn TINT_GAIN src scripts`. Expected: none left.

- [ ] **Step 7: Run the derive tests on today's (Mojang) art**

Run: `npx vitest run src/data/atlas-derive.test.ts src/data/texture-import.test.ts`
Expected: PASS, including every existing hue test. The gain model was checked on Mojang TNT (mean luminance
85–127) in gate 1. If a hue test fails, stop and report; do not edit its assertion.

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`. Expected: no errors.

```bash
git add src/data/texture-import.ts src/data/texture-import.test.ts src/data/atlas-derive.ts src/data/atlas-derive.test.ts scripts/build-atlas.ts
git commit -m "feat(textures): pixel rules module; greyTint scales to a target luminance"
```

---

### Task 2: The source data file and its structural tests

**Files:**
- Create: `src/data/texture-sources.data.ts` (generated once by the Step 3 script, then hand-maintained)
- Create: `src/data/texture-sources.ts` (types, `PACKS`, resolution helpers)
- Create: `src/data/texture-sources.test.ts`

**Interfaces:**
- Consumes: `BLOCKS` (`src/data/blocks.data.ts`), `textureNames` (`src/data/catalog-rules.ts`), `DERIVED_TEXTURES`.
- Produces (in `texture-sources.ts`):

```ts
export type Pack = 'ppce' | 'bauniclonia' | 'refi' | 'mineclonia';
export type Rgb = [number, number, number];
export type TextureSource =
	| { pack: Pack; file: string; alpha?: 'keep' }
	| { over: string; pack: Pack; file: string; overlayAlpha?: number }
	| { derive: 'tint'; pack: Pack; file: string; tint: Rgb; targetLum?: number }
	| { same: string };
export const PACKS: Record<Pack, { repo: string; commit: string; licence: string; licenceUri: string; authors: string; url: string }>;
export const CRACK_STAGES: string[];                  // destroy_stage_0..9
export const TRACED_SOURCES: Array<{ pack: Pack; file: string }>; // the 23 PP files, spec §3
export const TEXTURE_TINTED: string[];                // names in build-atlas TEXTURE_TINTS (single source of truth)
export const HUE_EXEMPT: string[];                    // ['pale_oak_leaves', 'cherry_leaves']
export const UNTINTED_GREY: string[];                 // ['pale_oak_leaves']
export function requiredTextureNames(): string[];     // non-retired BLOCKS textures that are not DERIVED_TEXTURES keys, plus CRACK_STAGES
export function alphaModeFor(name: string): AlphaMode; // spec §5.1; throws on conflicting block flags
export function resolveOrder(rows: Record<string, TextureSource>): string[]; // targets of over/same before dependants; throws on cycle or unknown target
```

- Produces (in `texture-sources.data.ts`): `export const TEXTURE_SOURCES: Record<string, TextureSource>` with exactly
  `requiredTextureNames()` as keys.

- [ ] **Step 1: Write `src/data/texture-sources.ts`**

```ts
/** Types and helpers for texture-sources.data.ts (texture replacement spec §4.1, §5.1). Pure. */
import type { AlphaMode } from './texture-import';
import { BLOCKS } from './blocks.data';
import { textureNames } from './catalog-rules';
import { DERIVED_TEXTURES } from './atlas-derive';

export type Pack = 'ppce' | 'bauniclonia' | 'refi' | 'mineclonia';
export type Rgb = [number, number, number];
export type TextureSource =
	| { pack: Pack; file: string; alpha?: 'keep' }
	| { over: string; pack: Pack; file: string; overlayAlpha?: number }
	| { derive: 'tint'; pack: Pack; file: string; tint: Rgb; targetLum?: number }
	| { same: string };

export const PACKS: Record<Pack, { repo: string; commit: string; licence: string; licenceUri: string; authors: string; url: string }> = {
	ppce: {
		repo: 'https://github.com/Athemis/PixelPerfectionCE', url: 'https://github.com/Athemis/PixelPerfectionCE',
		commit: '28e38cab7c1f03f86364ef704f705bebcc13cb3d', licence: 'CC BY-SA 4.0',
		licenceUri: 'https://creativecommons.org/licenses/by-sa/4.0/',
		authors: 'Hugh "XSSheep" Rutland and the Pixel Perfection CE contributors (StonePendant, freejusticehere, Stingraych, Nova_Wostra, lazerl0rd, Athemis and others)',
	},
	refi: {
		repo: 'https://github.com/MysticTempest/REFI_Textures', url: 'https://content.luanti.org/packages/MysticTempest/refi_textures/',
		commit: '33f1f719930d1d202beaa5fa6251c26d3a711149', licence: 'CC BY-SA 4.0',
		licenceUri: 'https://creativecommons.org/licenses/by-sa/4.0/', authors: 'MysticTempest',
	},
	bauniclonia: {
		repo: 'https://codeberg.org/mirtilo/Bauniclonia.git', url: 'https://content.luanti.org/packages/Mirtilo/bauniclonia/',
		commit: '77318ecabc046efb2caa9237a9efb45c7b401523', licence: 'CC BY-SA 4.0',
		licenceUri: 'https://creativecommons.org/licenses/by-sa/4.0/', authors: 'Mirtilo',
	},
	mineclonia: {
		repo: 'https://codeberg.org/mineclonia/mineclonia', url: 'https://codeberg.org/mineclonia/mineclonia',
		commit: 'c1898e3951ded8b3445f4396cc7d7b17844da357',
		licence: 'CC BY-SA 4.0 (textures based on Pixel Perfection); other files CC BY-SA 3.0, adapted under 4.0',
		licenceUri: 'https://creativecommons.org/licenses/by-sa/4.0/',
		authors: 'the Mineclonia contributors; Pixel Perfection by XSSheep; Pixel Perfection Legacy by Nova Wostra',
	},
};

export const CRACK_STAGES = Array.from({ length: 10 }, (_, i) => `destroy_stage_${i}`);

/** Pixel Perfection CE files that trace Mojang's (spec §3, trace score ≥ 0.81). Never a row's pack+file. */
export const TRACED_SOURCES: Array<{ pack: Pack; file: string }> = [
	'green_glazed_terracotta', 'light_blue_glazed_terracotta', 'red_glazed_terracotta', 'lime_glazed_terracotta',
	'pink_glazed_terracotta', 'purple_glazed_terracotta', 'yellow_glazed_terracotta',
	'loom_side', 'loom_bottom', 'loom_top', 'loom_front', 'smithing_table_front', 'smithing_table_side', 'smithing_table_bottom',
	'bee_nest_top', 'bee_nest_front', 'bee_nest_side', 'bee_nest_bottom', 'beehive_front', 'beehive_side', 'beehive_end',
	'lodestone_side', 'tnt_bottom',
].map((n) => ({ pack: 'ppce' as const, file: `assets/minecraft/textures/block/${n}.png` }));

/** Grey masks the atlas tints (spec §5.2). build-atlas's TEXTURE_TINTS keys must equal this list. */
export const TEXTURE_TINTED = ['grass_block_top', 'oak_leaves', 'jungle_leaves', 'mangrove_leaves', 'birch_leaves'];
export const HUE_EXEMPT = ['pale_oak_leaves', 'cherry_leaves'];
export const UNTINTED_GREY = ['pale_oak_leaves'];

export function requiredTextureNames(): string[] {
	const names = new Set<string>(CRACK_STAGES);
	for (const b of BLOCKS) {
		if (b.retired || !b.textures) continue;
		for (const t of textureNames(b.textures)) if (!DERIVED_TEXTURES[t]) names.add(t);
	}
	return [...names].sort();
}

export function alphaModeFor(name: string): AlphaMode {
	if (CRACK_STAGES.includes(name)) return 'keep';
	const modes = new Set<AlphaMode>();
	for (const b of BLOCKS) {
		if (b.retired || !b.textures || !textureNames(b.textures).includes(name)) continue;
		modes.add(b.liquid !== 'none' ? 'keep' : !b.transparent ? 'opaque' : b.translucent ? 'translucent' : 'cutout');
	}
	if (modes.size > 1) throw new Error(`Texture ${name} is used by blocks with different alpha flags: ${[...modes].join(', ')}`);
	const [m] = modes;
	if (!m) throw new Error(`Texture ${name} is used by no block`);
	return m;
}

export function resolveOrder(rows: Record<string, TextureSource>): string[] {
	const order: string[] = [], state = new Map<string, 'visiting' | 'done'>();
	const visit = (n: string, from?: string) => {
		const row = rows[n];
		if (!row) throw new Error(`Row ${from ?? '?'} refers to unknown row ${n}`);
		if (state.get(n) === 'done') return;
		if (state.get(n) === 'visiting') throw new Error(`Cycle through ${n}`);
		state.set(n, 'visiting');
		const dep = 'over' in row ? row.over : 'same' in row ? row.same : null;
		if (dep) visit(dep, n);
		state.set(n, 'done');
		order.push(n);
	};
	for (const n of Object.keys(rows).sort()) visit(n);
	return order;
}
```

- [ ] **Step 2: Write the failing structural tests**

```ts
// src/data/texture-sources.test.ts
import { describe, it, expect } from 'vitest';
import { TEXTURE_SOURCES } from './texture-sources.data';
import {
	CRACK_STAGES, PACKS, TRACED_SOURCES, alphaModeFor, requiredTextureNames, resolveOrder, type TextureSource,
} from './texture-sources';

describe('texture-sources data (spec §4.1, §6)', () => {
	it('has exactly one row per required texture: 448 block textures + 10 crack stages', () => {
		// Catches a block added later with no source row (Review Focus 1) and a stale extra row.
		expect(Object.keys(TEXTURE_SOURCES).sort()).toEqual(requiredTextureNames());
		expect(requiredTextureNames()).toHaveLength(458);
	});
	it('never takes a traced Pixel Perfection file, including through derive/over rows', () => {
		for (const [name, r] of Object.entries(TEXTURE_SOURCES)) {
			if (!('pack' in r)) continue;
			expect(TRACED_SOURCES.some((t) => t.pack === r.pack && t.file === r.file), name).toBe(false);
		}
	});
	it('every pack is pinned to a full 40-char commit', () => {
		for (const p of Object.values(PACKS)) expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
	});
	it('over/same rows resolve after their targets, and cycles are refused', () => {
		const order = resolveOrder(TEXTURE_SOURCES);
		for (const [name, r] of Object.entries(TEXTURE_SOURCES)) {
			const dep = 'over' in r ? r.over : 'same' in r ? r.same : null;
			if (dep) expect(order.indexOf(dep), name).toBeLessThan(order.indexOf(name));
		}
		const cyclic: Record<string, TextureSource> = { a: { same: 'b' }, b: { same: 'a' } };
		expect(() => resolveOrder(cyclic)).toThrow(/Cycle/);
	});
	it('alpha modes follow spec §5.1', () => {
		expect(alphaModeFor('water_still')).toBe('keep');
		expect(alphaModeFor('lava_still')).toBe('keep');
		expect(alphaModeFor('destroy_stage_3')).toBe('keep');
		expect(alphaModeFor('stone')).toBe('opaque');
		expect(alphaModeFor('slime_block')).toBe('opaque');
		expect(alphaModeFor('oak_leaves')).toBe('cutout');
		expect(alphaModeFor('blue_stained_glass')).toBe('translucent');
		expect(CRACK_STAGES).toHaveLength(10);
	});
	it('every texture has a consistent alpha mode (no texture shared by conflicting blocks)', () => {
		// Review Focus 4: alphaModeFor throws on a conflict; run it over every row.
		for (const name of Object.keys(TEXTURE_SOURCES)) expect(() => alphaModeFor(name), name).not.toThrow();
	});
});
```

Run: `npx vitest run src/data/texture-sources.test.ts`
Expected: FAIL, "Failed to resolve import './texture-sources.data'".

Check the assumption behind `slime_block` first: `grep -n "slime_block" src/data/*.ts`. If `slime_block` is
not the texture of an opaque block (`slime_pad`), stop and report.

- [ ] **Step 3: Generate `texture-sources.data.ts` (one-off script, not committed)**

Save as `$S/gen-sources.ts` and run with `npx tsx $S/gen-sources.ts` from the worktree. It reads the gate-verified
fill map `$S/fill-final.json` (fields: `mc`, `bn`/`rf` → `{ file, path, corr }`), applies the spec's rules, and
prints the TS file.

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { requiredTextureNames } from '/home/julien/Projects/Minicraft/.claude/worktrees/textures/src/data/texture-sources';

const S = '/tmp/claude-1000/-home-julien-Projects-Minicraft/6b90f23a-dd68-4f0c-bacc-dad25a29d5a5/scratchpad';
const ROOT = { ppce: `${S}/ppce`, refi: `${S}/packs/refi`, bauniclonia: `${S}/packs/bauniclonia`, mineclonia: `${S}/packs/mineclonia` };
const PP = 'assets/minecraft/textures/block';
const TRACED = new Set(['green_glazed_terracotta','light_blue_glazed_terracotta','red_glazed_terracotta','lime_glazed_terracotta','pink_glazed_terracotta','purple_glazed_terracotta','yellow_glazed_terracotta','loom_side','loom_bottom','loom_top','loom_front','smithing_table_front','smithing_table_side','smithing_table_bottom','bee_nest_top','bee_nest_front','bee_nest_side','bee_nest_bottom','beehive_front','beehive_side','beehive_end','lodestone_side','tnt_bottom']);
type F = { file: string; path: string; corr: number } | null;
const fill: Record<string, { bn: F; rf: F }> = Object.fromEntries((JSON.parse(readFileSync(`${S}/fill-final.json`, 'utf8')) as any[]).map((e) => [e.mc, e]));
const rel = (pack: keyof typeof ROOT, abs: string) => relative(ROOT[pack], abs);
const RED = '[0xe0, 0x40, 0x2c]';
const rows: Record<string, string> = {};
const plain = (pack: string, file: string, extra = '') => `{ pack: '${pack}', file: '${file}'${extra} }`;
const fromFill = (n: string, prefer?: 'bn' | 'rf') => {
	const e = fill[n]; if (!e) throw new Error(`no fill entry for ${n}`);
	const ok = (c: F) => c && c.corr <= 0.8;
	let pick: 'bn' | 'rf';
	if (prefer) pick = prefer;
	else if (ok(e.bn)) pick = 'bn';
	else if (ok(e.rf)) pick = 'rf';
	else pick = (e.bn && e.rf) ? (e.bn.corr <= e.rf.corr ? 'bn' : 'rf') : (e.bn ? 'bn' : 'rf');
	const c = e[pick]!; const pack = pick === 'bn' ? 'bauniclonia' : 'refi';
	return plain(pack, rel(pack, c.path));
};
for (const n of requiredTextureNames()) {
	if (TRACED.has(n) || !existsSync(`${ROOT.ppce}/${PP}/${n}.png`)) continue;
	rows[n] = plain('ppce', `${PP}/${n}.png`);
}
Object.assign(rows, {
	iron_block: plain('refi', 'textures/default_mcl_core/default_steel_block.png'),
	clay: plain('bauniclonia', 'mineclonia/ITEMS/mcl_core/default_clay.png'),
	birch_leaves: plain('bauniclonia', 'mineclonia/ITEMS/mcl_core/mcl_core_leaves_birch.png'),
	tnt_side: `{ derive: 'tint', pack: 'ppce', file: '${PP}/tnt_side2.png', tint: ${RED}, targetLum: 150 }`,
	tnt_top: `{ derive: 'tint', pack: 'ppce', file: '${PP}/tnt_top2.png', tint: ${RED}, targetLum: 150 }`,
	tnt_bottom: `{ derive: 'tint', pack: 'ppce', file: '${PP}/tnt_top1.png', tint: ${RED}, targetLum: 150 }`,
	copper_ore: `{ over: 'stone', pack: 'bauniclonia', file: '__BN_COPPER__' }`,
	muddy_mangrove_roots_side: `{ over: 'mud', pack: 'bauniclonia', file: '__BN_ROOTS_SIDE__' }`,
	muddy_mangrove_roots_top: `{ over: 'mud', pack: 'bauniclonia', file: '__BN_ROOTS_TOP__' }`,
	suspicious_sand_0: `{ over: 'sand', pack: 'mineclonia', file: '__SUS__', overlayAlpha: 3 }`,
	suspicious_gravel_0: `{ over: 'gravel', pack: 'mineclonia', file: '__SUS__', overlayAlpha: 3 }`,
	sculk_catalyst_bottom: plain('mineclonia', '__CATALYST__'),
	ochre_froglight_side: `{ derive: 'tint', pack: 'ppce', file: '${PP}/shroomlight.png', tint: [0xf2, 0xc1, 0x4e], targetLum: 210 }`,
	verdant_froglight_side: `{ derive: 'tint', pack: 'ppce', file: '${PP}/shroomlight.png', tint: [0x7f, 0xd3, 0x6b], targetLum: 210 }`,
	pearlescent_froglight_side: `{ derive: 'tint', pack: 'ppce', file: '${PP}/shroomlight.png', tint: [0xe4, 0xa6, 0xe8], targetLum: 210 }`,
	ochre_froglight_top: `{ same: 'ochre_froglight_side' }`,
	verdant_froglight_top: `{ same: 'verdant_froglight_side' }`,
	pearlescent_froglight_top: `{ same: 'pearlescent_froglight_side' }`,
	creaking_heart_awake: `{ derive: 'tint', pack: 'bauniclonia', file: '__BN_PALE_LOG__', tint: [0x6e, 0x5a, 0x50], targetLum: 120 }`,
	creaking_heart_top_awake: `{ derive: 'tint', pack: 'bauniclonia', file: '__BN_PALE_LOG_TOP__', tint: [0x6e, 0x5a, 0x50], targetLum: 120 }`,
	deepslate_coal_ore: fromFill('deepslate_coal_ore', 'bn'),
});
for (const n of requiredTextureNames()) if (!rows[n]) rows[n] = fromFill(n);
const out = [
	"// Source of every PNG in src/assets/blocks/ (texture replacement spec §4.1). One row per file.",
	"// Swap a tile by editing its row, then `npm run import-textures`. Candidates: `npm run import-textures -- --sheet <name>`.",
	"import type { TextureSource } from './texture-sources';",
	'',
	'export const TEXTURE_SOURCES: Record<string, TextureSource> = {',
	...Object.keys(rows).sort().map((n) => `\t${n}: ${rows[n]},`),
	'};',
	'',
].join('\n');
writeFileSync('src/data/texture-sources.data.ts', out);
console.log(Object.keys(rows).length, 'rows');
```

Before running, replace each `__PLACEHOLDER__` path with the real pack-relative path found by:

```bash
for n in mcl_copper_ore mcl_mangrove_roots_side mcl_mangrove_roots_top mcl_pale_oak_log mcl_pale_oak_log_top; do find $S/packs/bauniclonia -name "$n.png" | sed "s#$S/packs/bauniclonia/##"; done
for n in mcl_sus_nodes_suspicious_overlay mcl_sculk_catalyst_bottom; do find $S/packs/mineclonia -name "$n.png" | sed "s#$S/packs/mineclonia/##"; done
find $S/packs/refi/textures -name default_steel_block.png; find $S/packs/bauniclonia -name default_clay.png -o -name mcl_core_leaves_birch.png
```

Correct the `iron_block` / `clay` / `birch_leaves` paths to what `find` prints (REFI paths start `textures/…`,
relative to the REFI repo root). Expected output:
`458 rows`. Then run `npx prettier --write src/data/texture-sources.data.ts`.

- [ ] **Step 4: Run the structural tests**

Run: `npx vitest run src/data/texture-sources.test.ts`
Expected: PASS (6 tests). If the 458 count fails, print the symmetric difference and fix the rows; do not change
`requiredTextureNames`.

- [ ] **Step 5: Commit**

```bash
git add src/data/texture-sources.ts src/data/texture-sources.data.ts src/data/texture-sources.test.ts
git commit -m "feat(textures): source data for all 458 block textures and crack stages"
```

---

### Task 3: The import script (fetch, render, refuse, write, sheet)

**Files:**
- Create: `src/data/texture-render.ts` (pure: row → tile, given a pack-file reader)
- Create: `src/data/texture-render.test.ts`
- Create: `scripts/import-textures.ts` (I/O)
- Modify: `package.json` (add `"import-textures": "tsx scripts/import-textures.ts"`)

**Interfaces:**
- Consumes: Task 1 pixel rules, Task 2 `TEXTURE_SOURCES`, `PACKS`, `alphaModeFor`, `resolveOrder`, `greyTint`.
- Produces:
  - `renderAll(rows: Record<string, TextureSource>, readPack: (pack: Pack, file: string) => Uint8Array): Map<string, Uint8Array>`
    Throws `ImportRefusal` naming the row when a non-`over` row feeding an opaque texture has alpha-0 fraction > 0.05.
  - `export class ImportRefusal extends Error {}`
  - `import-textures.ts` CLI:
    `npm run import-textures [-- --packs-dir <dir>] [--sheet <name...> [--out <png>]]`, where `<dir>` holds one
    subdir per pack named by its `Pack` id.

- [ ] **Step 1: Write the failing tests for `renderAll`**

```ts
// src/data/texture-render.test.ts
import { describe, it, expect } from 'vitest';
import { ImportRefusal, renderAll } from './texture-render';
import { TILE } from './texture-import';
import type { TextureSource } from './texture-sources';

const solid = (r: number, g: number, b: number, a = 255) => {
	const t = new Uint8Array(TILE * TILE * 4);
	for (let i = 0; i < t.length; i += 4) t.set([r, g, b, a], i);
	return t;
};
const holes = (frac: number) => {
	const t = solid(200, 100, 50);
	for (let i = 0; i < Math.round(TILE * TILE * frac); i++) t[i * 4 + 3] = 0;
	return t;
};

describe('renderAll (spec §4.2, §5)', () => {
	const files: Record<string, Uint8Array> = { 'stone.png': solid(120, 120, 120), 'ore.png': holes(0.3), 'slime.png': solid(90, 200, 90, 140) };
	const read = (_p: string, f: string) => { const t = files[f]; if (!t) throw new Error(`missing ${f}`); return t; };

	it('refuses an overlay-style source on an opaque block unless it is an over row', () => {
		const rows: Record<string, TextureSource> = { stone: { pack: 'ppce', file: 'stone.png' }, copper_ore: { pack: 'bauniclonia', file: 'ore.png' } };
		expect(() => renderAll(rows, read)).toThrow(ImportRefusal);
		expect(() => renderAll(rows, read)).toThrow(/copper_ore/);
	});
	it('accepts the same source as an over row and composites it on the base', () => {
		const rows: Record<string, TextureSource> = { stone: { pack: 'ppce', file: 'stone.png' }, copper_ore: { over: 'stone', pack: 'bauniclonia', file: 'ore.png' } };
		const out = renderAll(rows, read).get('copper_ore')!;
		expect([...out.slice(0, 4)]).toEqual([120, 120, 120, 255]);   // a hole shows stone, not a smear
		expect([...out.slice(-4)]).toEqual([200, 100, 50, 255]);
	});
	it('lets uniformly semi-transparent art through and forces it opaque (slime alpha 140)', () => {
		const out = renderAll({ slime_block: { pack: 'ppce', file: 'slime.png' } }, read).get('slime_block')!;
		for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
	});
	it('same copies the target bytes exactly', () => {
		const m = renderAll({ stone: { pack: 'ppce', file: 'stone.png' }, cobblestone: { same: 'stone' } }, read);
		expect(m.get('cobblestone')).toEqual(m.get('stone'));
	});
	it('derive tints a pack file to its target luminance', () => {
		const m = renderAll({ stone: { derive: 'tint', pack: 'ppce', file: 'stone.png', tint: [255, 0, 0], targetLum: 100 } }, read);
		const t = m.get('stone')!;
		expect(t[1]).toBe(0); expect(t[0]).toBeGreaterThan(0);
	});
	it('renders nothing when any row fails: the error happens before the caller writes', () => {
		// Review Focus 3: renderAll is all-or-nothing, so import-textures writes only after it returns.
		const rows: Record<string, TextureSource> = { stone: { pack: 'ppce', file: 'stone.png' }, cobblestone: { pack: 'ppce', file: 'missing.png' } };
		expect(() => renderAll(rows, read)).toThrow(/missing/);
	});
});
```

Run: `npx vitest run src/data/texture-render.test.ts`
Expected: FAIL, "Failed to resolve import './texture-render'".

Note: these tests use real texture names (`stone`, `copper_ore`, `slime_block`, `cobblestone`), because
`alphaModeFor` reads the real `BLOCKS`: stone and copper_ore are opaque, and slime_block is opaque.

- [ ] **Step 2: Implement `src/data/texture-render.ts`**

```ts
/** Row → 16×16 RGBA tile (texture replacement spec §4.2, §5). Pure; the caller supplies pack-file pixels. */
import { greyTint } from './atlas-derive';
import { alphaZeroFraction, composite, normaliseAlpha } from './texture-import';
import { alphaModeFor, resolveOrder, type Pack, type TextureSource } from './texture-sources';

export class ImportRefusal extends Error {}
const MAX_ALPHA_ZERO = 0.05;

export function renderAll(rows: Record<string, TextureSource>, readPack: (pack: Pack, file: string) => Uint8Array): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	for (const name of resolveOrder(rows)) {
		const row = rows[name];
		const mode = alphaModeFor(name);
		let tile: Uint8Array;
		if ('same' in row) {
			tile = new Uint8Array(out.get(row.same)!);
		} else if ('over' in row) {
			tile = composite(out.get(row.over)!, readPack(row.pack, row.file), row.overlayAlpha ?? 1);
		} else {
			const src = readPack(row.pack, row.file);
			if (mode === 'opaque' && alphaZeroFraction(src) > MAX_ALPHA_ZERO)
				throw new ImportRefusal(`${name}: ${row.pack}/${row.file} has ${(alphaZeroFraction(src) * 100).toFixed(1)}% fully transparent pixels on an opaque block; make it an \`over\` row`);
			tile = 'derive' in row ? greyTint(src, row.tint, row.targetLum) : src;
		}
		out.set(name, normaliseAlpha(tile, 'same' in row ? 'keep' : mode));
	}
	return out;
}
```

Run: `npx vitest run src/data/texture-render.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 3: Write `src/data/texture-png.ts` (decode and encode, shared by the script and the tests)**

```ts
/** PNG decode/encode for the texture importer and guard tests (texture replacement spec §4.2). */
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { TILE } from './texture-import';

/** Frame 0 of a PNG as 16×16 RGBA (animated strips are taller than wide; other sizes nearest-resized). */
export async function decodePng(path: string): Promise<Uint8Array> {
	if (!existsSync(path)) throw new Error(`Missing file ${path}`);
	const meta = await sharp(path).metadata();
	const w = meta.width ?? TILE;
	let img = sharp(path);
	if ((meta.height ?? w) > w) img = img.extract({ left: 0, top: 0, width: w, height: w });
	const { data, info } = await img.resize(TILE, TILE, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	if (info.width !== TILE || info.height !== TILE || info.channels !== 4) throw new Error(`Bad decode of ${path}`);
	return new Uint8Array(data);
}

/** Deterministic PNG bytes for a tile (Review Focus 2): fixed settings, no metadata. */
export async function encodePng(tile: Uint8Array, size = TILE): Promise<Buffer> {
	return sharp(Buffer.from(tile), { raw: { width: size, height: size, channels: 4 } })
		.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
}
```

`creditsText` is written in Task 5. For now, create `src/data/texture-credits.ts` containing only
`export function creditsText(_rows: unknown): string { return ''; }` so the script typechecks. Task 5 replaces it.

- [ ] **Step 4: Write `scripts/import-textures.ts`**

```ts
/**
 * Writes src/assets/blocks/*.png, SOURCES.json, CREDITS.md and public/CREDITS.txt from
 * src/data/texture-sources.data.ts (texture replacement spec §4.2). Run by hand:
 *   npm run import-textures [-- --packs-dir <dir>] [--sheet <name...> [--out <png>]]
 * Without --packs-dir each pack is fetched at its pinned commit into a temp dir. Nothing is written until every row renders.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import sharp from 'sharp';
import { TILE } from '../src/data/texture-import';
import { decodePng, encodePng } from '../src/data/texture-png';
import { renderAll } from '../src/data/texture-render';
import { PACKS, type Pack } from '../src/data/texture-sources';
import { TEXTURE_SOURCES } from '../src/data/texture-sources.data';
import { creditsText } from '../src/data/texture-credits';

const ASSETS = 'src/assets/blocks';
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function fetchPack(pack: Pack, into: string): string {
	const dir = join(into, pack);
	const { repo, commit } = PACKS[pack];
	try {
		execFileSync('git', ['init', '-q', dir]);
		execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', repo, commit]);
		execFileSync('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
	} catch (e) {
		throw new Error(`Could not fetch ${pack} (${repo} @ ${commit}): ${(e as Error).message}`);
	}
	return dir;
}

function checkCommit(pack: Pack, dir: string): void {
	const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
	if (head !== PACKS[pack].commit) throw new Error(`${pack} checkout at ${dir} is ${head}, pinned ${PACKS[pack].commit}`);
}

/** --sheet: current tile and pack candidates for the named textures, 8× nearest. Never inside the repo. */
async function writeSheet(names: string[], roots: Record<Pack, string>): Promise<void> {
	const out = resolve(arg('--out') ?? join(tmpdir(), `texture-sheet-${Date.now()}.png`));
	if (out.startsWith(resolve('.') + '/')) throw new Error(`--out must be outside the repo (got ${out})`);
	const Z = 8, cell = TILE * Z + 8;
	const rows = names.map((n) => {
		const c = [{ label: 'current', path: join(ASSETS, `${n}.png`) }];
		for (const p of Object.keys(roots) as Pack[]) {
			const hits = execFileSync('find', [roots[p], '-iname', `*${n}*.png`]).toString().split('\n').filter(Boolean).slice(0, 8);
			for (const h of hits) c.push({ label: `${p}:${h.slice(roots[p].length + 1)}`, path: h });
		}
		return c;
	});
	const layers: sharp.OverlayOptions[] = [];
	for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
		if (!existsSync(rows[r][c].path)) continue;
		const big = await sharp(Buffer.from(await decodePng(rows[r][c].path)), { raw: { width: TILE, height: TILE, channels: 4 } })
			.resize(TILE * Z, TILE * Z, { kernel: 'nearest' }).png().toBuffer();
		layers.push({ input: big, left: c * cell, top: r * cell });
		console.log(`${names[r]} [${c}] ${rows[r][c].label}`);
	}
	const width = Math.max(1, ...rows.map((c) => c.length)) * cell;
	await sharp({ create: { width, height: Math.max(1, rows.length) * cell, channels: 4, background: { r: 40, g: 40, b: 44, alpha: 1 } } })
		.composite(layers).png().toFile(out);
	console.log(`Sheet: ${out}`);
}

async function main() {
	const packsDir = arg('--packs-dir');
	const tmp = packsDir ? null : mkdtempSync(join(tmpdir(), 'minicraft-packs-'));
	try {
		const roots = {} as Record<Pack, string>;
		for (const p of Object.keys(PACKS) as Pack[]) {
			roots[p] = packsDir ? resolve(packsDir, p) : fetchPack(p, tmp!);
			checkCommit(p, roots[p]);
		}
		const sheetAt = argv.indexOf('--sheet');
		if (sheetAt >= 0) {
			const outPath = arg('--out');
			await writeSheet(argv.slice(sheetAt + 1).filter((a) => !a.startsWith('--') && a !== outPath), roots);
			return;
		}
		// renderAll is synchronous: decode every pack file first.
		const decoded = new Map<string, Uint8Array>();
		for (const r of Object.values(TEXTURE_SOURCES)) if ('pack' in r) {
			const key = `${r.pack}\u0000${r.file}`;
			if (!decoded.has(key)) decoded.set(key, await decodePng(join(roots[r.pack], r.file)));
		}
		const tiles = renderAll(TEXTURE_SOURCES, (p, f) => decoded.get(`${p}\u0000${f}`)!); // throws before any write
		const sources: Record<string, unknown> = {};
		for (const [name, tile] of [...tiles].sort(([a], [b]) => a.localeCompare(b))) {
			const png = await encodePng(tile);
			writeFileSync(join(ASSETS, `${name}.png`), png);
			const r = TEXTURE_SOURCES[name];
			const sha256 = createHash('sha256').update(png).digest('hex');
			sources[name] = 'same' in r ? { same: r.same, sha256 } : { ...r, commit: PACKS[r.pack].commit, sha256 };
		}
		for (const f of readdirSync(ASSETS)) if (f.endsWith('.png') && !tiles.has(f.slice(0, -4))) unlinkSync(join(ASSETS, f));
		writeFileSync(join(ASSETS, 'SOURCES.json'), JSON.stringify(sources, null, '\t') + '\n');
		const credits = creditsText(TEXTURE_SOURCES);
		writeFileSync('CREDITS.md', credits);
		mkdirSync('public', { recursive: true });
		writeFileSync('public/CREDITS.txt', credits);
		console.log(`Wrote ${tiles.size} textures to ${ASSETS}`);
	} finally {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	}
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); exit(1); });
```

Add to `package.json` scripts: `"import-textures": "tsx scripts/import-textures.ts",`.

- [ ] **Step 5: Add a determinism test for `encodePng`**

```ts
// src/data/texture-png.test.ts
import { describe, it, expect } from 'vitest';
import { encodePng } from './texture-png';

describe('encodePng (Review Focus 2)', () => {
	it('is byte-identical across runs, so a re-import is a no-op in git', async () => {
		const t = new Uint8Array(16 * 16 * 4).map((_, i) => (i * 37) % 256);
		expect(Buffer.compare(await encodePng(t), await encodePng(t))).toBe(0);
	});
});
```

Run: `npx vitest run src/data/texture-png.test.ts src/data/texture-render.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Dry run on the sheet (no writes to the repo)**

Run: `npm run import-textures -- --packs-dir $S/packdirs --sheet copper_ore tnt_side --out /tmp/claude-1000/sheet-check.png`,
where `$S/packdirs` is a directory of symlinks you create first:

```bash
mkdir -p $S/packdirs && ln -sfn $S/ppce $S/packdirs/ppce && ln -sfn $S/packs/refi $S/packdirs/refi && ln -sfn $S/packs/bauniclonia $S/packdirs/bauniclonia && ln -sfn $S/packs/mineclonia $S/packdirs/mineclonia
```

Expected: `Sheet: /tmp/claude-1000/sheet-check.png`, and `git status --short` shows no change under `src/assets/`.
If `checkCommit` fails for `mineclonia` because `$S/packs/mineclonia` is not a git checkout (it holds textures only),
fetch it properly: `git -C $S/packs init -q mineclonia-git && git -C $S/packs/mineclonia-git fetch -q --depth 1 https://codeberg.org/mineclonia/mineclonia c1898e3951ded8b3445f4396cc7d7b17844da357 && git -C $S/packs/mineclonia-git checkout -q FETCH_HEAD`,
point the symlink at it, and re-check that the Task 2 mineclonia paths exist there.

- [ ] **Step 7: Commit**

```bash
git add src/data/texture-render.ts src/data/texture-render.test.ts src/data/texture-png.ts src/data/texture-png.test.ts src/data/texture-credits.ts scripts/import-textures.ts package.json
git commit -m "feat(textures): import-textures script (pinned packs, refusal, deterministic PNGs, --sheet)"
```

---

### Task 4: Guard tests first (red on Mojang art), then the import

**Files:**
- Create: `src/data/mojang-tile-hashes.json` (sha256 of decoded frame-0 RGBA; hashes, no pixels)
- Create: `src/data/texture-provenance.test.ts`
- Create: `src/data/texture-alpha.test.ts`
- Create: `src/data/texture-tints.test.ts`
- Create: `src/data/texture-ores.test.ts`
- Create: `src/data/texture-derived.test.ts`
- Modify: `scripts/build-atlas.ts:22-32` (`TEXTURE_TINTS` keyed from `TEXTURE_TINTED`)
- Replace: `src/assets/blocks/*.png` (via the importer), create `src/assets/blocks/SOURCES.json`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: the committed art. The guard tests read `src/assets/blocks/*.png` through a helper
  `readTile(name): Promise<Uint8Array>` defined in `src/data/texture-test-util.ts` (sharp, frame 0, 16×16 RGBA),
  shared by all five test files.

- [ ] **Step 1: Hash Mojang's tiles BEFORE anything is replaced**

Save as `$S/hash-mojang.ts` and run with `npx tsx $S/hash-mojang.ts` from the worktree:

```ts
import { createHash } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
const out: string[] = [];
for (const f of readdirSync('src/assets/blocks').filter((f) => f.endsWith('.png')).sort()) {
	const p = `src/assets/blocks/${f}`;
	const m = await sharp(p).metadata(); const w = m.width ?? 16;
	let img = sharp(p); if ((m.height ?? w) > w) img = img.extract({ left: 0, top: 0, width: w, height: w });
	const { data } = await img.resize(16, 16, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	out.push(createHash('sha256').update(data).digest('hex'));
}
writeFileSync('src/data/mojang-tile-hashes.json', JSON.stringify([...new Set(out)].sort(), null, '\t') + '\n');
console.log(out.length, 'hashes');
```

Expected: `1083 hashes`. Check `git log -1 --format=%H -- src/assets/blocks` equals `main`'s tree for that path
(`git diff main --stat -- src/assets/blocks` prints nothing) before running, so the hashes are Mojang's.

- [ ] **Step 2: Write the shared test helper and the five guard test files**

```ts
// src/data/texture-test-util.ts
import { decodePng } from './texture-png';
export const readTile = (name: string): Promise<Uint8Array> => decodePng(`src/assets/blocks/${name}.png`);
```

```ts
// src/data/texture-provenance.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { TEXTURE_SOURCES } from './texture-sources.data';
import { requiredTextureNames } from './texture-sources';
import { readTile } from './texture-test-util';
import mojang from './mojang-tile-hashes.json';

describe('texture provenance (spec §6)', () => {
	const files = readdirSync('src/assets/blocks').filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort();
	it('the PNG files are exactly the source rows: no stray file, none missing', () => {
		// Review Focus 1 + stray Mojang PNGs: a leftover or re-added file goes red here.
		expect(files).toEqual(Object.keys(TEXTURE_SOURCES).sort());
		expect(files).toEqual(requiredTextureNames());
	});
	it('every PNG matches its SOURCES.json sha256', () => {
		const sources = JSON.parse(readFileSync('src/assets/blocks/SOURCES.json', 'utf8')) as Record<string, { sha256: string }>;
		for (const n of files) {
			const sha = createHash('sha256').update(readFileSync(`src/assets/blocks/${n}.png`)).digest('hex');
			expect(sha, n).toBe(sources[n]?.sha256);
		}
	});
	it('no shipped tile decodes to a Mojang tile', async () => {
		const set = new Set(mojang as string[]);
		for (const n of files) expect(set.has(createHash('sha256').update(await readTile(n)).digest('hex')), n).toBe(false);
	});
});
```

```ts
// src/data/texture-alpha.test.ts
import { describe, it, expect } from 'vitest';
import { BLOCKS } from './blocks.data';
import { classifyAlpha, textureNames } from './catalog-rules';
import { DERIVED_TEXTURES } from './atlas-derive';
import { CRACK_STAGES } from './texture-sources';
import { readTile } from './texture-test-util';

const alphas = (t: Uint8Array) => Array.from({ length: t.length / 4 }, (_, i) => t[i * 4 + 3]);

describe('texture alpha agrees with the catalog flags (spec §5.1)', () => {
	it('every non-liquid block: classifyAlpha over its faces matches transparent/translucent', async () => {
		for (const b of BLOCKS) {
			if (b.retired || !b.textures || b.liquid !== 'none') continue;
			const faces = textureNames(b.textures).map((t) => DERIVED_TEXTURES[t]?.source ?? t);
			let transparent = false, translucent = false;
			for (const f of faces) { const c = classifyAlpha(alphas(await readTile(f))); transparent ||= c.transparent; translucent ||= c.translucent; }
			expect({ name: b.name, transparent, translucent }).toEqual({ name: b.name, transparent: b.transparent, translucent: b.translucent });
		}
	});
	it('water keeps partial alpha; lava is opaque; crack stages are 0/255', async () => {
		const w = alphas(await readTile('water_still'));
		expect(w.some((a) => a > 0 && a < 255)).toBe(true);
		expect(alphas(await readTile('lava_still')).every((a) => a === 255)).toBe(true);
		for (const s of CRACK_STAGES) expect(alphas(await readTile(s)).every((a) => a === 0 || a === 255), s).toBe(true);
	});
});
```

```ts
// src/data/texture-tints.test.ts
import { describe, it, expect } from 'vitest';
import { HUE_EXEMPT, TEXTURE_TINTED, UNTINTED_GREY, requiredTextureNames } from './texture-sources';
import { TEXTURE_TINTS } from '../../scripts/build-atlas-tints';
import { hueSat, meanLum, meanRgb } from './texture-import';
import { readTile } from './texture-test-util';

function tinted(t: Uint8Array, c: [number, number, number]) {
	const o = new Uint8Array(t);
	for (let i = 0; i < o.length; i += 4) for (let k = 0; k < 3; k++) o[i + k] = Math.round((t[i + k] * c[k]) / 255);
	return o;
}
const leafy = requiredTextureNames().filter((n) => n.endsWith('_leaves') || n === 'grass_block_top');

describe('texture tints (spec §5.2)', () => {
	it('TEXTURE_TINTS keys are exactly TEXTURE_TINTED', () => {
		expect(Object.keys(TEXTURE_TINTS).sort()).toEqual([...TEXTURE_TINTED].sort());
	});
	it('(a) every tinted texture is a grey mask: saturation of mean RGB < 0.30', async () => {
		for (const n of TEXTURE_TINTED) expect(hueSat(meanRgb(await readTile(n))).sat, n).toBeLessThan(0.3);
	});
	it('(b) every grey leaves/grass-top texture is tinted or on UNTINTED_GREY', async () => {
		for (const n of leafy) if (hueSat(meanRgb(await readTile(n))).sat < 0.27)
			expect(TEXTURE_TINTED.includes(n) || UNTINTED_GREY.includes(n), n).toBe(true);
	});
	it('(c) after tinting, foliage is green, saturated and not near-black (except HUE_EXEMPT)', async () => {
		for (const n of leafy) {
			if (HUE_EXEMPT.includes(n)) continue;
			const t = await readTile(n), c = TEXTURE_TINTS[n];
			const out = c ? tinted(t, c) : t;
			const { hue, sat } = hueSat(meanRgb(out));
			expect(hue, `${n} hue`).toBeGreaterThanOrEqual(45); expect(hue, `${n} hue`).toBeLessThanOrEqual(150);
			expect(sat, `${n} sat`).toBeGreaterThan(0.25);
			expect(meanLum(out), `${n} lum`).toBeGreaterThan(40);
		}
	});
	it('(d) birch_leaves is tinted', () => expect(TEXTURE_TINTED).toContain('birch_leaves'));
});
```

`TEXTURE_TINTS` must be importable without running the atlas build, so move it out of `build-atlas.ts` into
`scripts/build-atlas-tints.ts` (Step 4 below). vitest only collects tests from `src/`, but a test may import from
`scripts/`.

```ts
// src/data/texture-ores.test.ts
import { describe, it, expect } from 'vitest';
import { requiredTextureNames } from './texture-sources';
import { deltaE, meanRgb } from './texture-import';
import { readTile } from './texture-test-util';

const host = (n: string) => (n.startsWith('deepslate_') ? 'deepslate' : n.startsWith('nether_') ? 'netherrack' : 'stone');
const threshold = (n: string) => (n === 'deepslate_coal_ore' ? 12 : 25);

describe('ores stay findable (spec §5.3)', () => {
	it('every *_ore has ≥ 12 pixels far from its shipped host stone', async () => {
		for (const n of requiredTextureNames().filter((x) => x.endsWith('_ore'))) {
			const h = meanRgb(await readTile(host(n)));
			const t = await readTile(n);
			let far = 0;
			for (let i = 0; i < t.length; i += 4) if (deltaE([t[i], t[i + 1], t[i + 2]], h) > threshold(n)) far++;
			expect(far, `${n} vs ${host(n)}`).toBeGreaterThanOrEqual(12);
		}
	});
	it('the instrument can go red: plain deepslate is not findable as an ore', async () => {
		const h = meanRgb(await readTile('deepslate')); const t = await readTile('deepslate');
		let far = 0;
		for (let i = 0; i < t.length; i += 4) if (deltaE([t[i], t[i + 1], t[i + 2]], h) > 12) far++;
		expect(far).toBeLessThan(12);
	});
});
```

```ts
// src/data/texture-derived.test.ts
import { describe, it, expect } from 'vitest';
import { TEXTURE_SOURCES } from './texture-sources.data';
import { clipFraction, lumStd } from './texture-import';
import { readTile } from './texture-test-util';

describe('importer-derived tiles keep their texture (spec §5.4, §5.6)', () => {
	it('every derive/over row: luminance std > 8 and ≤ 50% clipped', async () => {
		// The build-atlas DERIVED_TEXTURES are checked in atlas-derive.test.ts; these are the importer's baked rows
		// (plain TNT, froglights, creaking heart, copper, roots, suspicious blocks).
		for (const [n, r] of Object.entries(TEXTURE_SOURCES)) {
			if (!('derive' in r) && !('over' in r)) continue;
			const t = await readTile(n);
			expect(lumStd(t), `${n} std`).toBeGreaterThan(8);
			expect(clipFraction(t), `${n} clip`).toBeLessThanOrEqual(0.5);
		}
	});
});
```

- [ ] **Step 3: Run the guard tests on the Mojang tree — they must go red**

Run: `npx vitest run src/data/texture-provenance.test.ts src/data/texture-derived.test.ts`
Expected: FAIL. Provenance: 1083 files ≠ 458 rows, no `SOURCES.json`, and every tile is a Mojang hash.
This proves the instrument can go red. Record the failure summary in the commit message of Step 6.

- [ ] **Step 4: Move `TEXTURE_TINTS` into `scripts/build-atlas-tints.ts` and set it per spec §5.2**

```ts
// scripts/build-atlas-tints.ts
/** Grey masks tinted at build time; no biomes, so one colour each (texture replacement spec §5.2). Keys = TEXTURE_TINTED. */
export const TEXTURE_TINTS: Record<string, [number, number, number]> = {
	grass_block_top: [0x79, 0xc0, 0x5a], // plains-biome grass green
	oak_leaves: [0x77, 0xab, 0x2f],
	jungle_leaves: [0x77, 0xab, 0x2f],
	mangrove_leaves: [0x77, 0xab, 0x2f],
	birch_leaves: [0x80, 0xa7, 0x55],
};
```

In `scripts/build-atlas.ts` delete the old `TEXTURE_TINTS` block and its comment, and add
`import { TEXTURE_TINTS } from './build-atlas-tints.js';`.
water_still, acacia, dark_oak and spruce are no longer tinted (spec §5.2).

- [ ] **Step 5: Run the import**

```bash
npm run import-textures -- --packs-dir $S/packdirs
```

Expected: `Wrote 458 textures to src/assets/blocks`. Then:
- `ls src/assets/blocks/*.png | wc -l` → `458`
- `git status --short src/assets/blocks | grep -c '^ D'` → `625`

If the importer throws an `ImportRefusal`, stop and report the row. Do not loosen the rule.

- [ ] **Step 6: Run the whole suite and the atlas build**

Run: `npm run build-atlas && npx vitest run src && npm run typecheck`
Expected: `Wrote 478 tiles to public/atlas.png`, all tests PASS, no type errors. `atlas-derive.test.ts` hue tests
must pass on the new TNT (gate re-check: all pass with plain TNT at 150). On any failure, stop and report the test
name and values; do not edit assertions or spec numbers.

- [ ] **Step 7: Commit (explicit paths; the deletions are staged by path)**

```bash
git add src/assets/blocks        # git ≥ 2.0 stages the 625 deletions too
git add src/data/mojang-tile-hashes.json src/data/texture-test-util.ts src/data/texture-provenance.test.ts src/data/texture-alpha.test.ts src/data/texture-tints.test.ts src/data/texture-ores.test.ts src/data/texture-derived.test.ts scripts/build-atlas.ts scripts/build-atlas-tints.ts CREDITS.md public/CREDITS.txt
git status --short   # must show nothing unstaged under src/ or scripts/, and no .claude/ paths staged
git commit -m "feat(textures): replace Mojang block textures with CC BY-SA packs; provenance, alpha, tint, ore and derived-tile guards"
```

`src/assets/blocks` is owned by the importer, so staging the whole directory is safe; nothing else is staged
by directory.

---

### Task 5: Credits, licence notice and the pause-menu link

**Files:**
- Modify: `src/data/texture-credits.ts` (the real `creditsText`)
- Create: `src/data/texture-credits.test.ts`
- Create: `src/assets/blocks/LICENSE.md`
- Modify: `src/ui/pause-menu.ts` (a "Texture credits" link on the card)
- Modify: `src/ui/ui.css` if needed for the link style (reuse `.menu-back` look)
- Regenerate: `CREDITS.md`, `public/CREDITS.txt` (by re-running the importer)

**Interfaces:**
- Produces: `creditsText(rows: Record<string, TextureSource>): string`, the text that is written to both files.

- [ ] **Step 1: Write the failing credits test**

```ts
// src/data/texture-credits.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { creditsText } from './texture-credits';
import { TEXTURE_SOURCES } from './texture-sources.data';
import { PACKS } from './texture-sources';

describe('texture credits (spec §4.4)', () => {
	const text = creditsText(TEXTURE_SOURCES);
	it('names every pack: authors, URL, pinned commit, licence URI', () => {
		for (const p of Object.values(PACKS)) {
			expect(text).toContain(p.authors); expect(text).toContain(p.url); expect(text).toContain(p.commit); expect(text).toContain(p.licenceUri);
		}
		expect(text).toContain('Nova Wostra');
	});
	it('says the tiles were modified, and how, with the list of derived/overlay rows', () => {
		expect(text).toMatch(/modified/i);
		for (const w of ['frame 0', 'alpha', 'tinted', 'composited']) expect(text).toContain(w);
		for (const [n, r] of Object.entries(TEXTURE_SOURCES)) if ('derive' in r || 'over' in r) expect(text, n).toContain(n);
	});
	it('carries the warranty disclaimer and the share-alike scope note', () => {
		expect(text).toMatch(/without warrant/i);
		expect(text).toMatch(/does not extend to the game code/i);
	});
	it('the committed CREDITS.md and public/CREDITS.txt are the current text', () => {
		expect(readFileSync('CREDITS.md', 'utf8')).toBe(text);
		expect(readFileSync('public/CREDITS.txt', 'utf8')).toBe(text);
	});
});
```

Run: `npx vitest run src/data/texture-credits.test.ts`
Expected: FAIL (the stub returns '').

- [ ] **Step 2: Implement `creditsText`**

```ts
/** CREDITS.md / public/CREDITS.txt text (texture replacement spec §4.4). Pure. */
import { PACKS, type Pack, type TextureSource } from './texture-sources';

export function creditsText(rows: Record<string, TextureSource>): string {
	const used = new Set<Pack>();
	for (const r of Object.values(rows)) if ('pack' in r) used.add(r.pack);
	const derived = Object.entries(rows).filter(([, r]) => 'derive' in r || 'over' in r).map(([n, r]) =>
		'derive' in r ? `- ${n}: ${r.pack} ${r.file}, greyscaled and tinted` : `- ${n}: ${(r as { pack: Pack; file: string }).pack} ${(r as { file: string }).file}, composited over ${(r as { over: string }).over}`);
	const packs = (Object.keys(PACKS) as Pack[]).filter((p) => used.has(p)).map((p) => {
		const x = PACKS[p];
		return [`## ${p}`, `- Authors: ${x.authors}`, `- Source: ${x.url} (${x.repo} @ ${x.commit})`, `- Licence: ${x.licence} — ${x.licenceUri}`].join('\n');
	});
	return [
		'# Minicraft texture credits',
		'',
		'The block textures in Minicraft (src/assets/blocks/, and public/atlas.png built from them) are adaptations of the',
		'following works, used under Creative Commons Attribution-ShareAlike licences.',
		'',
		...packs.flatMap((s) => [s, '']),
		'## Changes',
		'',
		'All tiles were modified: cropped to frame 0 of any animation, resized to 16×16 where needed, and their alpha',
		'normalised to the game\'s block flags (forced opaque, snapped to 0/255, or kept). Some tiles were greyscaled and',
		'tinted, and some were composited from two sources. Grass tops and some leaves are tinted when the atlas is built.',
		'Derived and composited tiles:',
		'',
		...derived,
		'',
		'## Licence scope',
		'',
		'These adapted textures are licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).',
		'public/atlas.png is a collection of these tiles; the share-alike licence applies to the tiles and does not extend to the game code.',
		'',
		'The works are provided as-is, without warranties of any kind; see the licence text.',
		'',
	].join('\n');
}
```

- [ ] **Step 3: Regenerate the credits files and run the test**

Run: `npm run import-textures -- --packs-dir $S/packdirs && npx vitest run src/data/texture-credits.test.ts src/data/texture-provenance.test.ts`
Expected: PASS. `git status --short src/assets/blocks` shows no change, since the re-import is deterministic.

- [ ] **Step 4: The licence notice file**

```md
<!-- src/assets/blocks/LICENSE.md -->
# Licence of the files in this folder

The PNG files here are adaptations of Pixel Perfection CE, REFI Textures, Bauniclonia and Mineclonia textures,
licensed **CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/). Authors, sources, pinned commits and
the list of changes are in `CREDITS.md` at the repository root. `SOURCES.json` records the source of every file.

This licence covers these images only. The Minicraft code is not licensed under CC BY-SA.
```

Also add `LICENSE.md` and `SOURCES.json` to the provenance test's ignored non-PNG files. They are already
excluded, because the test filters `*.png`. Confirm this, and do not change the test.

- [ ] **Step 5: The pause-menu link (Review Focus 5)**

In `src/ui/pause-menu.ts`, in the `else` branch of `render()` after the Quit button line, add:

```ts
			const credits = document.createElement('a');
			credits.id = 'pause-credits';
			credits.className = 'menu-credits';
			credits.href = 'CREDITS.txt'; // relative: next to index.html at any subpath (vite base './')
			credits.target = '_blank';
			credits.rel = 'noopener';
			credits.textContent = 'Texture credits';
			card.appendChild(credits);
```

In `src/ui/ui.css`, add next to the other `.menu-*` rules:

```css
.menu-credits { display: block; margin-top: 12px; font-size: 13px; opacity: 0.7; color: inherit; text-align: center; }
.menu-credits:hover { opacity: 1; }
```

There is no DOM test environment (vitest runs in node). `scripts/menu-smoke.ts` is the pause-menu smoke. Add to it,
where it asserts the pause card's buttons, a check that `#pause-credits` exists with
`getAttribute('href') === 'CREDITS.txt'`. Mirror the existing selector-check style in that file. Run it in Task 7.

- [ ] **Step 6: Typecheck, test, commit**

Run: `npm run typecheck && npx vitest run src`
Expected: PASS.

```bash
git add src/data/texture-credits.ts src/data/texture-credits.test.ts src/assets/blocks/LICENSE.md src/ui/pause-menu.ts src/ui/ui.css scripts/menu-smoke.ts CREDITS.md public/CREDITS.txt
git commit -m "feat(textures): CC BY-SA credits (repo + bundle), licence notice, pause-menu credits link"
```

---

### Task 6: Hand-run audit script and the docs

**Files:**
- Create: `scripts/audit-textures.ts`
- Modify: `package.json` (`"audit-textures": "tsx scripts/audit-textures.ts"`)
- Modify: `CLAUDE.md` (Assets section), `README.md` (Textures line, tree comment, licence section),
  `docs/specs.md` (Mojang risk), `docs/inventory.md` (add-a-block procedure), `docs/crafting.md` (Slime Pad wording),
  `docs/liquids.md` (water not tinted), `docs/persistence.md` (deploy: upload `CREDITS.txt`)
- Modify: `docs/texture-fill-map.md` (a header note: historical; the data file is now the truth)

**Interfaces:**
- Consumes: `TEXTURE_SOURCES`, `readTile`-style decoding. The Minecraft jar at
  `${MINECRAFT_JAR:-~/.minecraft/versions/1.21.6/1.21.6.jar}`.

- [ ] **Step 1: Write `scripts/audit-textures.ts`**

```ts
/**
 * Pre-merge provenance audit (texture replacement spec §6.1). Reads the local Minecraft jar; never commits Mojang pixels.
 * Prints, per shipped tile, the trace score against Mojang's same-name tile, and exits 1 if any tile is ≥ 95% identical.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env, exit } from 'node:process';
import sharp from 'sharp';

const JAR = env.MINECRAFT_JAR ?? join(env.HOME ?? '', '.minecraft/versions/1.21.6/1.21.6.jar');
async function rgba(p: string): Promise<Float64Array> {
	const m = await sharp(p).metadata(); const w = m.width ?? 16;
	let img = sharp(p); if ((m.height ?? w) > w) img = img.extract({ left: 0, top: 0, width: w, height: w });
	const { data } = await img.resize(16, 16, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return Float64Array.from(data);
}
function trace(a: Float64Array, b: Float64Array): number {
	const la: number[] = [], lb: number[] = [];
	for (let i = 0; i < a.length; i += 4) {
		la.push(((a[i] + a[i + 1] + a[i + 2]) / 3) * (a[i + 3] / 255));
		lb.push(((b[i] + b[i + 1] + b[i + 2]) / 3) * (b[i + 3] / 255));
	}
	const ma = la.reduce((s, x) => s + x, 0) / la.length, mb = lb.reduce((s, x) => s + x, 0) / lb.length;
	let n = 0, da = 0, db = 0;
	for (let i = 0; i < la.length; i++) { n += (la[i] - ma) * (lb[i] - mb); da += (la[i] - ma) ** 2; db += (lb[i] - mb) ** 2; }
	return n / Math.sqrt(da * db + 1e-9);
}
function identical(a: Float64Array, b: Float64Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) < 8) s++;
	return s / (a.length / 4);
}
async function main() {
	if (!existsSync(JAR)) { console.error(`Minecraft jar not found at ${JAR}. Set MINECRAFT_JAR.`); exit(2); }
	const tmp = mkdtempSync(join(tmpdir(), 'minicraft-audit-'));
	try {
		execFileSync('unzip', ['-oq', JAR, 'assets/minecraft/textures/block/*', '-d', tmp]);
		const dir = join(tmp, 'assets/minecraft/textures/block');
		let bad = 0; const flagged: string[] = [];
		for (const f of readdirSync('src/assets/blocks').filter((f) => f.endsWith('.png')).sort()) {
			const m = join(dir, f);
			if (!existsSync(m)) continue;
			const a = await rgba(join('src/assets/blocks', f)), b = await rgba(m);
			const t = trace(a, b), id = identical(a, b);
			if (id >= 0.95) bad++;
			if (t > 0.8 || id >= 0.95) flagged.push(`${f.slice(0, -4)}\ttrace ${t.toFixed(2)}\tidentical ${(id * 100).toFixed(0)}%`);
		}
		console.log(flagged.length ? flagged.join('\n') : 'No tile scores above 0.8.');
		console.log(`${bad} tiles ≥ 95% identical to Mojang.`);
		exit(bad > 0 ? 1 : 0);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
}
main().catch((e) => { console.error(e); exit(1); });
```

Add `"audit-textures": "tsx scripts/audit-textures.ts",` to `package.json`.

- [ ] **Step 2: Run the audit**

Run: `npm run audit-textures`
Expected: `0 tiles ≥ 95% identical to Mojang.` and exit code 0. The flagged list should be the known structural ones
(ring log tops such as `cherry_log_top` and `pale_oak_log_top`; planks, bricks, glass frames) with trace 0.8–0.95.
Save the full output to `$S/audit-output.txt`; it goes into the merge note (Task 7).

- [ ] **Step 3: Update the docs**

Make each edit below with a short, factual paragraph. Do not add commentary beyond these facts.
- `CLAUDE.md`, the Assets section: replace both paragraphs with:
  - Block textures in `src/assets/blocks/` are CC BY-SA 4.0 adaptations of Pixel Perfection CE, REFI, Bauniclonia
    and Mineclonia; see `CREDITS.md`, `src/assets/blocks/LICENSE.md` and `SOURCES.json`.
  - They are written by `npm run import-textures` from `src/data/texture-sources.data.ts`. Never hand-edit a PNG
    there; never add Mojang art. Swap a tile by editing its row and re-running the import (`--sheet <name>` shows
    candidates).
  - `npm run audit-textures` (needs the local Minecraft jar) is the pre-merge provenance check.
  - Player skins in `src/assets/skins/` and the menu art in `src/assets/menu/` are still not licensed for
    redistribution.
- `README.md`: the Textures line → "CC BY-SA 4.0 texture packs (see CREDITS.md)"; the tree comment for
  `src/assets/blocks`; the licence section → code licence unchanged ("TBD"), textures CC BY-SA 4.0, skins and menu
  art not licensed.
- `docs/specs.md`: in the risk list, the "gate the subdomain until Mojang textures are replaced" item → replaced for
  block textures (this change); skins and menu art remain.
- `docs/inventory.md`: replace the jar extraction procedure with: add the texture's row to
  `texture-sources.data.ts` → `npm run import-textures` → `npm run gen-catalog`. gen-catalog still needs the jar for
  models and blockstates, and it now classifies alpha from the new art.
- `docs/crafting.md:136`: "Slime Pad uses Mojang's slime_block" → "Slime Pad uses the slime_block texture".
- `docs/liquids.md:40`: water is drawn blue-green by the texture pack and is no longer tinted at build time.
- `docs/persistence.md`, in the manual website deploy steps: also upload `dist/CREDITS.txt` next to `index.html`
  (short cache, like `index.html`).
- `docs/texture-fill-map.md`: a first line under the title: "Historical: the research map that fed
  `src/data/texture-sources.data.ts`, which is now the source of truth. The artifact linked below contains Mojang tiles
  and stays private."

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-textures.ts package.json CLAUDE.md README.md docs/specs.md docs/inventory.md docs/crafting.md docs/liquids.md docs/persistence.md docs/texture-fill-map.md
git commit -m "docs(textures): new asset provenance, import/audit procedure, credits deploy step"
```

---

### Task 7: Verification, re-import reproducibility and the look review

**Files:**
- Create: `scripts/texture-look.ts` (headless screenshots; not deployed)
- No other code changes. On a finding, fix it in the task that owns the code and re-run.

- [ ] **Step 1: Full checks**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS, and `dist/CREDITS.txt` exists (`ls dist/CREDITS.txt`).

- [ ] **Step 2: Re-import reproducibility from a fresh fetch (spec §6.2)**

```bash
npm run import-textures        # no --packs-dir: fetches every pack at its pinned commit
git diff --exit-code -- src/assets/blocks CREDITS.md public/CREDITS.txt && echo REPRODUCIBLE
```

Expected: `REPRODUCIBLE`. A diff means a row reads something the pinned commit does not have, or decoding is not
deterministic. Stop and report.

- [ ] **Step 3: Menu smoke (credits link) and the existing smokes**

Run: `npm run smoke:menu && npm run smoke:crafting`
Expected: PASS, including the new `#pause-credits` href check. These smokes already block the production save API.

- [ ] **Step 4: Look screenshots**

Write `scripts/texture-look.ts` by copying the browser setup from `scripts/menu-smoke.ts`: headless Chromium, the
production save API routes aborted, `localhost:5173`, and a fresh world with a fixed seed. Keep that file's world
setup and its way of placing blocks through the debug/cheat hooks the smokes already use. Do not invent new hooks;
if placement needs one that does not exist, stop and report.

Build these scenes by placing blocks, and save one PNG each to
`/tmp/claude-1000/-home-julien-Projects-Minicraft/6b90f23a-dd68-4f0c-bacc-dad25a29d5a5/scratchpad/look/`:
- `01-spawn.png`, `02-grassland.png`
- `03-birch-forest.png` (a few birch trees: log + birch_leaves)
- `04-deepslate-mine.png` (a deepslate wall with every deepslate ore)
- `05-stone-ores.png` (a stone wall with every stone ore, including copper)
- `06-clay-by-water.png`
- `07-house.png` (planks of every wood, glass, furnace, crafting table)
- `08-glass-wall.png` (glass and all stained glass)
- `09-tnt-row.png` (TNT, Big, Mega and the five toys)
- `10-wools.png` (all 16 wools), `11-concrete.png`
- `12-derived.png` (the 16 derive/over tiles: TNT faces, froglights, creaking heart, copper ore, roots, suspicious,
  plus sculk_catalyst)

Run: `npm run dev` in the background, then `npx tsx scripts/texture-look.ts`. Stop the dev server with
`fuser -k 5173/tcp` (by port only).

- [ ] **Step 5: Old-vs-new sheet for the user**

Generate `look/00-old-vs-new.png`: every one of the 458 names, Mojang (from `main`, via
`git show main:src/assets/blocks/<name>.png`) above the new tile, 8× nearest, 24 per row, labelled. Write it to the
scratchpad only, never the repo.

- [ ] **Step 6: Commit the look script, then hand over for approval**

```bash
git add scripts/texture-look.ts
git commit -m "test(textures): headless look screenshots for the texture review"
```

Then stop. The controller publishes `00-old-vs-new.png` and the scene shots to the user as a private artifact
(Mojang tiles inside) and asks for approval or row swaps. Row swaps loop back through Task 4 Step 5 (re-import) and
Task 7. The approval and the audit output go in the merge commit message. Merging is the user's call.
