# Player Skins and Rig Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the coloured-box remote avatars with Minecraft-style skinned player rigs (six characters, walk/idle/swing animations, a layer-based animation structure) and a character picker.

**Architecture:** Pure modules for UV maths (`skin-uv.ts`), legacy-skin upgrade (`skin-legacy.ts`) and animation (`player-anim.ts`); a texture cache with an injectable loader (`skin-textures.ts`); a rig builder with shared geometry/materials (`player-rig.ts`); `RemotePlayers` swaps its box for a rig and drives the animation; the menu draws character previews from the same pixels.

**Tech Stack:** TypeScript, three 0.164, vitest (node environment), Vite, Playwright (e2e), sharp (tests only).

**Spec:** `docs/superpowers/specs/2026-09-24-player-skins-design.md` (rev 2). Read it before any task; it holds the tables this plan implements.

## Global Constraints

- Indentation: tabs (1 tab = 4 spaces), matching the codebase.
- No server or protocol change. `hello.skin` stays a string ≤ 32 bytes.
- `src/data/*.data.ts` stay pure (no three, no `import.meta.glob`).
- Every test runs in vitest's `node` environment; no DOM. Anything touching `Image`/canvas is injected.
- 1 skin px = `PX = 1.8 / 32` world units. Character faces −z; character's right = +x.
- `SKIN_FLIP_Y = false` (DataTexture from top-down rows). All uv maths and tests read it; nothing hard-codes a flip.
- Joints are in vanilla convention; the rig applies `pivot.rotation.order = 'ZYX'; pivot.rotation.set(-xRot, -yRot, +zRot)`.
- Shared geometries/materials/textures are never disposed by an avatar.
- Tests never hit `noah.leap-forward.ca` or `mc.leap-forward.ca`. Playwright headless only. Kill servers by port only (`fuser -k <port>/tcp`), never `pkill`.
- Stage explicit paths only (never `git add -A`); `.claude/agent-memory/` and scratch files must not be committed.
- Every task's verify step runs the FULL `npx vitest run`, `npx tsc -p tsconfig.json --noEmit` and `npm run lint`; each commit is green on all three.
- Setup once per worktree before running tests: `npm i` and `(cd api && npm i)` (do not commit `package-lock.json` changes in either) and `npm run build-atlas`.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

1. A friend who picked a colour on an older build (`'red'`) or sends an unknown id → renders as Milo, label/minimap coloured Milo-cyan on new clients; never crashes. (Task 5 test.)
2. The Enderman's 64×32 file → loads as a full 64×64 skin with left limbs mirrored; never blank, never half-transparent limbs. (Task 2 real-file test, Task 3 loader test.)
3. Image load failure / node without `Image` → texture stays blank, no unhandled rejection, avatar still renders. (Task 3 test.)
4. First pose, teleport/respawn jump, or two frames at the same timestamp → no NaN joints, no leg-flail spike. (Task 4 tests.)
5. Two avatars on the same skin, one leaves → the other keeps its texture/materials. (Task 5 test.)

---

### Task 1: Skin catalog, assets, URL module

**Files:**
- Create: `src/assets/skins/{milo,chip,crazy-fan-girl,jj,mikey,enderman}.png` (copy from `docs/skins/`)
- Modify: `src/data/skins.data.ts`
- Create: `src/engine/render/skin-urls.ts`
- Create: `src/data/skins.data.test.ts`
- Modify: `src/game/boot-session.test.ts:38`, `src/ui/mp-menu-model.test.ts:8,115,116,131`, `src/net/mp-client.test.ts:63` (colour ids → character ids)
- Modify: `src/engine/render/remote-players.test.ts` (only the colour assertions that Task 1 turns red)

**Interfaces:**
- Produces: `SKINS` (readonly rows `{ id, name, file, slim, color }`), `type SkinId`, `skinOf(id: string): SkinRow`, `skinColor(id: string): string`, `type SkinRow`; `skinUrl(id: string): string` (unknown → Milo's URL).

- [ ] **Step 1: Copy the PNGs**

```bash
mkdir -p src/assets/skins
cp docs/skins/{milo,chip,crazy-fan-girl,jj,mikey,enderman}.png src/assets/skins/
```

- [ ] **Step 2: Write the failing catalog test** (`src/data/skins.data.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKINS, skinOf, skinColor } from './skins.data';

const DIR = join(__dirname, '../assets/skins');

function pngSize(path: string): [number, number] {
	const b = readFileSync(path);
	expect(b.subarray(1, 4).toString('ascii')).toBe('PNG');
	return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function rgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lightness([r, g, b]: [number, number, number]): number {
	return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
}

describe('skin catalog', () => {
	it('lists the six characters, Milo first', () => {
		expect(SKINS.map((s) => s.id)).toEqual(['milo', 'chip', 'crazy-fan-girl', 'jj', 'mikey', 'enderman']);
		expect(SKINS.filter((s) => s.slim).map((s) => s.id)).toEqual(['milo', 'chip']);
	});

	it('every file exists and is 64×64 (the Enderman is legacy 64×32)', () => {
		for (const s of SKINS) {
			const p = join(DIR, s.file);
			expect(existsSync(p), s.file).toBe(true);
			expect(pngSize(p), s.file).toEqual(s.id === 'enderman' ? [64, 32] : [64, 64]);
		}
	});

	it('ids are unique and fit the 32-byte wire limit', () => {
		expect(new Set(SKINS.map((s) => s.id)).size).toBe(SKINS.length);
		for (const s of SKINS) expect(new TextEncoder().encode(s.id).length).toBeLessThanOrEqual(32);
	});

	it('unknown, empty and old colour ids resolve to Milo', () => {
		expect(skinOf('red')).toBe(SKINS[0]);
		expect(skinOf('')).toBe(SKINS[0]);
		expect(skinOf('plaid')).toBe(SKINS[0]);
		expect(skinColor('red')).toBe(SKINS[0].color);
		expect(skinOf('jj').id).toBe('jj');
	});

	it('colours are bright and far apart (minimap dots, label borders)', () => {
		for (const s of SKINS) {
			const l = lightness(rgb(s.color));
			expect(l, s.id).toBeGreaterThanOrEqual(0.3);
			expect(l, s.id).toBeLessThanOrEqual(0.75);
		}
		for (let i = 0; i < SKINS.length; i++) for (let j = i + 1; j < SKINS.length; j++) {
			const [a, b] = [rgb(SKINS[i].color), rgb(SKINS[j].color)];
			const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
			expect(d, `${SKINS[i].id}/${SKINS[j].id}`).toBeGreaterThanOrEqual(80);
		}
	});
});
```

- [ ] **Step 3: Run it — expect FAIL** (`npx vitest run src/data/skins.data.test.ts`: ids are colours).

- [ ] **Step 4: Rewrite `src/data/skins.data.ts`**

```ts
/**
 * Multiplayer characters (spec docs/superpowers/specs/2026-09-24-player-skins-design.md §3).
 * Order is the picker's display order; the first row is the default for unknown ids.
 * `color` is hand-picked (minimap dot, name-label border, toasts), never computed from the skin.
 * `slim` = 3-px arms (Alex model).
 */
export const SKINS = [
	{ id: 'milo', name: 'Milo', file: 'milo.png', slim: true, color: '#29C5E6' },
	{ id: 'chip', name: 'Chip', file: 'chip.png', slim: true, color: '#FF8A1F' },
	{ id: 'crazy-fan-girl', name: 'Crazy Fan Girl', file: 'crazy-fan-girl.png', slim: false, color: '#FF3FA4' },
	{ id: 'jj', name: 'JJ', file: 'jj.png', slim: false, color: '#D8261C' },
	{ id: 'mikey', name: 'Mikey', file: 'mikey.png', slim: false, color: '#7ED321' },
	{ id: 'enderman', name: 'Enderman', file: 'enderman.png', slim: false, color: '#CC00FA' },
] as const;

export type SkinRow = (typeof SKINS)[number];
export type SkinId = SkinRow['id'];

/** The row for `id`; anything unknown (old colour ids, "") is the first row. */
export function skinOf(id: string): SkinRow {
	return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

export function skinColor(id: string): string {
	return skinOf(id).color;
}
```

If the distance/lightness test fails, adjust the hex values (keep the hue: Milo cyan, Chip orange, Crazy Fan Girl hot pink, JJ red, Mikey lime, Enderman purple) until green.

- [ ] **Step 5: Create `src/engine/render/skin-urls.ts`** (no three import; the menu uses it too)

```ts
import { skinOf } from '../../data/skins.data';

/** Skin PNG URLs by file name (Vite inlines these tiny files as data: URIs). */
const URLS = import.meta.glob('../../assets/skins/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** The PNG URL for a skin id; unknown ids get the default skin's. */
export function skinUrl(id: string): string {
	const file = skinOf(id).file;
	const url = URLS[`../../assets/skins/${file}`];
	if (!url) throw new Error(`skin file missing: ${file}`);
	return url;
}
```

- [ ] **Step 6: Update colour ids in tests** — `boot-session.test.ts:38` `skin: 'blue'` → `skin: 'jj'`; `mp-menu-model.test.ts` lines 115/116 `'blue'` → `'jj'`, line 131 `'red'` → `'milo'`, line 8 `'red'` → `'milo'` (keep line 117's `'plaid'` → `null` case); `mp-client.test.ts:63` `'red'` → `'milo'`. In `remote-players.test.ts`, the three assertions that compare against the old hexes (label-border test ≈ line 65 `['#1E88E5', '#E53935']`, box-colour tests ≈ 82/87, ≈ 132 `'#43A047'`) turn red now, because old ids fall back to Milo: change the upserted ids to `'jj'`, `'milo'`, `'mikey'` and the expectations to `skinColor('jj')` etc. (import `skinColor`). The box itself stays until Task 5.

- [ ] **Step 7: Verify** — full `npx vitest run` PASS (no remaining red from old colour ids), `npx tsc -p tsconfig.json --noEmit` exit 0 (menu.ts still compiles: it reads `s.id`/`s.color`), `npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add src/assets/skins src/data/skins.data.ts src/data/skins.data.test.ts src/engine/render/skin-urls.ts src/game/boot-session.test.ts src/ui/mp-menu-model.test.ts src/net/mp-client.test.ts src/engine/render/remote-players.test.ts docs/superpowers/specs/2026-09-24-player-skins-design.md docs/superpowers/plans/2026-09-24-player-skins.md docs/skins-research.md docs/skins
git commit -m "feat(skins): six-character skin catalog, PNGs and URL module"
```

---

### Task 2: UV maths and legacy upgrade (pure)

**Files:**
- Create: `src/engine/render/skin-uv.ts`, `src/engine/render/skin-uv.test.ts`
- Create: `src/engine/render/skin-legacy.ts`, `src/engine/render/skin-legacy.test.ts`

**Interfaces:**
- Produces (`skin-uv.ts`): `SKIN_SIZE = 64`, `PX = 1.8 / 32`, `SKIN_FLIP_Y = false`, `type Rect = { x; y; w; h }`, `type FaceName = 'right'|'left'|'top'|'bottom'|'back'|'front'`, `FACE_ORDER: readonly FaceName[]` (= BoxGeometry group order `['right','left','top','bottom','back','front']`), `type Corner = 'TL'|'TR'|'BL'|'BR'`, `FACE_CORNERS: Record<FaceName, readonly [Corner, Corner, Corner, Corner]>` (per vertex v0..v3), `faceRects(u, v, w, h, d): Record<FaceName, Rect>`, `cornerPx(r: Rect, c: Corner): [number, number]`, `pxToUv(px, py): [number, number]`, `boxUVs(rects): Float32Array` (length 48), `type PartName = 'head'|'body'|'rightArm'|'leftArm'|'rightLeg'|'leftLeg'`, `type PartSpec = { name: PartName; size: [number, number, number]; pivot: [number, number, number]; offset: [number, number, number]; base: [number, number]; overlay: [number, number]; inflate: number }` (all in skin px), `partSpecs(slim: boolean): PartSpec[]`.
- Produces (`skin-legacy.ts`): `upgradeLegacySkin(src: Uint8ClampedArray): Uint8ClampedArray` (64×32 RGBA → 64×64 RGBA), `LEGACY_COPIES` (the table).

- [ ] **Step 1: Write failing `skin-uv.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { faceRects, partSpecs, boxUVs, FACE_ORDER, FACE_CORNERS, cornerPx, pxToUv, SKIN_FLIP_Y } from './skin-uv';

describe('faceRects', () => {
	it('head (0,0) 8×8×8', () => {
		expect(faceRects(0, 0, 8, 8, 8)).toEqual({
			right: { x: 0, y: 8, w: 8, h: 8 }, front: { x: 8, y: 8, w: 8, h: 8 },
			left: { x: 16, y: 8, w: 8, h: 8 }, back: { x: 24, y: 8, w: 8, h: 8 },
			top: { x: 8, y: 0, w: 8, h: 8 }, bottom: { x: 16, y: 0, w: 8, h: 8 },
		});
	});
	it('classic right arm (40,16) 4×12×4', () => {
		expect(faceRects(40, 16, 4, 12, 4)).toEqual({
			right: { x: 40, y: 20, w: 4, h: 12 }, front: { x: 44, y: 20, w: 4, h: 12 },
			left: { x: 48, y: 20, w: 4, h: 12 }, back: { x: 52, y: 20, w: 4, h: 12 },
			top: { x: 44, y: 16, w: 4, h: 4 }, bottom: { x: 48, y: 16, w: 4, h: 4 },
		});
	});
	it('slim right arm (40,16) 3×12×4', () => {
		expect(faceRects(40, 16, 3, 12, 4)).toEqual({
			right: { x: 40, y: 20, w: 4, h: 12 }, front: { x: 44, y: 20, w: 3, h: 12 },
			left: { x: 47, y: 20, w: 4, h: 12 }, back: { x: 51, y: 20, w: 3, h: 12 },
			top: { x: 44, y: 16, w: 3, h: 4 }, bottom: { x: 47, y: 16, w: 3, h: 4 },
		});
	});
});

describe('partSpecs', () => {
	it('classic and slim pivots/offsets match vanilla (spec §5)', () => {
		const c = Object.fromEntries(partSpecs(false).map((p) => [p.name, p]));
		const s = Object.fromEntries(partSpecs(true).map((p) => [p.name, p]));
		expect(c.head).toMatchObject({ size: [8, 8, 8], pivot: [0, 24, 0], offset: [0, 4, 0], base: [0, 0], overlay: [32, 0], inflate: 0.5 });
		expect(c.body).toMatchObject({ size: [8, 12, 4], pivot: [0, 24, 0], offset: [0, -6, 0], base: [16, 16], overlay: [16, 32], inflate: 0.25 });
		expect(c.rightArm).toMatchObject({ size: [4, 12, 4], pivot: [5, 22, 0], offset: [1, -4, 0], base: [40, 16], overlay: [40, 32] });
		expect(c.leftArm).toMatchObject({ size: [4, 12, 4], pivot: [-5, 22, 0], offset: [-1, -4, 0], base: [32, 48], overlay: [48, 48] });
		expect(s.rightArm).toMatchObject({ size: [3, 12, 4], pivot: [5, 21.5, 0], offset: [0.5, -4, 0] });
		expect(s.leftArm).toMatchObject({ size: [3, 12, 4], pivot: [-5, 21.5, 0], offset: [-0.5, -4, 0] });
		expect(c.rightLeg).toMatchObject({ size: [4, 12, 4], pivot: [1.9, 12, 0], offset: [0, -6, 0], base: [0, 16], overlay: [0, 32] });
		expect(c.leftLeg).toMatchObject({ size: [4, 12, 4], pivot: [-1.9, 12, 0], offset: [0, -6, 0], base: [16, 48], overlay: [0, 48] });
	});
});

describe('boxUVs', () => {
	it('writes each vertex at the corner §5 assigns it', () => {
		const rects = faceRects(0, 0, 8, 8, 8);
		const uv = boxUVs(rects);
		expect(uv).toHaveLength(48);
		FACE_ORDER.forEach((face, f) => {
			FACE_CORNERS[face].forEach((corner, k) => {
				const [px, py] = cornerPx(rects[face], corner);
				const [u, v] = pxToUv(px, py);
				expect(uv[(f * 4 + k) * 2]).toBeCloseTo(u, 9);
				expect(uv[(f * 4 + k) * 2 + 1]).toBeCloseTo(v, 9);
			});
		});
		expect(FACE_CORNERS.top).toEqual(['BR', 'BL', 'TR', 'TL']);
		expect(FACE_CORNERS.bottom).toEqual(['TR', 'TL', 'BR', 'BL']);
		expect(FACE_CORNERS.front).toEqual(['TL', 'TR', 'BL', 'BR']);
		expect(pxToUv(0, 16)).toEqual([0, SKIN_FLIP_Y ? 0.75 : 0.25]);
	});
});
```

(These pin numbers; orientation is proven through real geometry in Task 3.)

- [ ] **Step 2: Run — FAIL** (module missing).

- [ ] **Step 3: Implement `skin-uv.ts`**

```ts
/**
 * Minecraft skin UV maths (spec §5). Pure: no three. Skin pixels, y downward, 64×64.
 * The character faces −z; its right is +x. BoxGeometry groups: +x, −x, +y, −y, +z, −z.
 */
export const SKIN_SIZE = 64;
/** World units per skin pixel: the 32-px-tall model is 1.8 blocks. */
export const PX = 1.8 / 32;
/** Textures are DataTextures built from top-down rows, uploaded unflipped. */
export const SKIN_FLIP_Y = false;

export type Rect = { x: number; y: number; w: number; h: number };
export type FaceName = 'right' | 'left' | 'top' | 'bottom' | 'back' | 'front';
export type Corner = 'TL' | 'TR' | 'BL' | 'BR';

/** BoxGeometry's group order: +x (char right), −x, +y, −y, +z (back), −z (front). */
export const FACE_ORDER: readonly FaceName[] = ['right', 'left', 'top', 'bottom', 'back', 'front'];

const SIDE = ['TL', 'TR', 'BL', 'BR'] as const;
/**
 * Which rect corner each BoxGeometry vertex (v0..v3) of a face takes. Sides: v0 is the top-left seen
 * from outside. Top and bottom (vanilla): the rect's left column is at the character's right (+x) and
 * its last row at the front (−z).
 */
export const FACE_CORNERS: Record<FaceName, readonly [Corner, Corner, Corner, Corner]> = {
	right: SIDE, left: SIDE, back: SIDE, front: SIDE,
	top: ['BR', 'BL', 'TR', 'TL'],
	bottom: ['TR', 'TL', 'BR', 'BL'],
};

/** Vanilla box layout for a w×h×d box whose texture origin is (u, v). */
export function faceRects(u: number, v: number, w: number, h: number, d: number): Record<FaceName, Rect> {
	return {
		right: { x: u, y: v + d, w: d, h },
		front: { x: u + d, y: v + d, w, h },
		left: { x: u + d + w, y: v + d, w: d, h },
		back: { x: u + 2 * d + w, y: v + d, w, h },
		top: { x: u + d, y: v, w, h: d },
		bottom: { x: u + d + w, y: v, w, h: d },
	};
}

export function cornerPx(r: Rect, c: Corner): [number, number] {
	return [c === 'TL' || c === 'BL' ? r.x : r.x + r.w, c === 'TL' || c === 'TR' ? r.y : r.y + r.h];
}

export function pxToUv(px: number, py: number): [number, number] {
	return [px / SKIN_SIZE, SKIN_FLIP_Y ? 1 - py / SKIN_SIZE : py / SKIN_SIZE];
}

/** The `uv` attribute (24 vertices × 2) for a BoxGeometry with these face rects. */
export function boxUVs(rects: Record<FaceName, Rect>): Float32Array {
	const out = new Float32Array(48);
	FACE_ORDER.forEach((face, f) => {
		FACE_CORNERS[face].forEach((corner, k) => {
			const [u, v] = pxToUv(...cornerPx(rects[face], corner));
			out[(f * 4 + k) * 2] = u;
			out[(f * 4 + k) * 2 + 1] = v;
		});
	});
	return out;
}

export type PartName = 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';
export const PART_NAMES: readonly PartName[] = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];

/** Skin px, origin at the feet, y up. `offset` is the box centre relative to the pivot. */
export type PartSpec = {
	name: PartName;
	size: [number, number, number];
	pivot: [number, number, number];
	offset: [number, number, number];
	base: [number, number];
	overlay: [number, number];
	inflate: number;
};

export function partSpecs(slim: boolean): PartSpec[] {
	const aw = slim ? 3 : 4;
	const ay = slim ? 21.5 : 22;
	const ao = aw / 2 - 1;
	return [
		{ name: 'head', size: [8, 8, 8], pivot: [0, 24, 0], offset: [0, 4, 0], base: [0, 0], overlay: [32, 0], inflate: 0.5 },
		{ name: 'body', size: [8, 12, 4], pivot: [0, 24, 0], offset: [0, -6, 0], base: [16, 16], overlay: [16, 32], inflate: 0.25 },
		{ name: 'rightArm', size: [aw, 12, 4], pivot: [5, ay, 0], offset: [ao, -4, 0], base: [40, 16], overlay: [40, 32], inflate: 0.25 },
		{ name: 'leftArm', size: [aw, 12, 4], pivot: [-5, ay, 0], offset: [-ao, -4, 0], base: [32, 48], overlay: [48, 48], inflate: 0.25 },
		{ name: 'rightLeg', size: [4, 12, 4], pivot: [1.9, 12, 0], offset: [0, -6, 0], base: [0, 16], overlay: [0, 32], inflate: 0.25 },
		{ name: 'leftLeg', size: [4, 12, 4], pivot: [-1.9, 12, 0], offset: [0, -6, 0], base: [16, 48], overlay: [0, 48], inflate: 0.25 },
	];
}
```

(Arm offset: classic 4/2−1 = 1, slim 3/2−1 = 0.5 — matches §5.)

- [ ] **Step 4: Run skin-uv tests — PASS.**

- [ ] **Step 5: Write failing `skin-legacy.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { join } from 'node:path';
import { upgradeLegacySkin } from './skin-legacy';
import { faceRects, type FaceName } from './skin-uv';

const W = 64;
const px = (a: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(a.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

/** 64×32: every pixel unique and opaque (r = x·4, g = y·8, b = 77). Asymmetric by construction. */
function synthetic(): Uint8ClampedArray {
	const a = new Uint8ClampedArray(W * 32 * 4);
	for (let y = 0; y < 32; y++) for (let x = 0; x < W; x++) a.set([x * 4, y * 8, 77, 255], (y * W + x) * 4);
	return a;
}

describe('upgradeLegacySkin', () => {
	it('copies rows 0–31 unchanged', () => {
		const src = synthetic();
		const out = upgradeLegacySkin(src);
		expect(out).toHaveLength(W * W * 4);
		for (let y = 0; y < 32; y++) for (let x = 0; x < W; x++) expect(px(out, W, x, y)).toEqual(px(src, W, x, y));
	});

	it('each left-limb face is the matching right-limb face, sides swapped, columns reversed (oracle: faceRects, not LEGACY_COPIES)', () => {
		const src = synthetic();
		const out = upgradeLegacySkin(src);
		// The left limb seen from outside is the mirror image of the right limb: its right side
		// shows the right limb's LEFT side and vice versa; every face is mirrored left-right.
		const pairs: Array<[[number, number], [number, number]]> = [[[0, 16], [16, 48]], [[40, 16], [32, 48]]]; // leg, arm
		const from: Record<FaceName, FaceName> = { top: 'top', bottom: 'bottom', front: 'front', back: 'back', right: 'left', left: 'right' };
		for (const [[su, sv], [du, dv]] of pairs) {
			const sr = faceRects(su, sv, 4, 12, 4), dr = faceRects(du, dv, 4, 12, 4);
			for (const f of Object.keys(from) as FaceName[]) {
				const S = sr[from[f]], D = dr[f];
				for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) {
					expect(px(out, W, D.x + x, D.y + y), `${du},${dv} ${f}`).toEqual(px(src, W, S.x + S.w - 1 - x, S.y + y));
				}
			}
		}
	});

	it('leaves the new overlay areas transparent and forces the base areas opaque', () => {
		const src = synthetic();
		for (let i = 3; i < src.length; i += 4) src[i] = 10; // all nearly transparent
		const out = upgradeLegacySkin(src);
		expect(px(out, W, 2, 40)[3]).toBe(0); // right-leg pants (0,32)
		expect(px(out, W, 50, 50)[3]).toBe(0); // left sleeve (48,48)
		expect(px(out, W, 4, 60)[3]).toBe(0); // left pants (0,48)
		expect(px(out, W, 10, 10)[3]).toBe(255); // head
		expect(px(out, W, 20, 20)[3]).toBe(255); // body row band
		expect(px(out, W, 20, 52)[3]).toBe(255); // new left leg
		expect(px(out, W, 36, 52)[3]).toBe(255); // new left arm
		expect(px(out, W, 40, 10)[3]).toBe(10); // hat keeps its alpha
	});

	it('the real Enderman: 64×32, empty hat, left-leg front = mirrored right-leg front', async () => {
		const { data, info } = await sharp(join(__dirname, '../../assets/skins/enderman.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect([info.width, info.height]).toEqual([64, 32]);
		const src = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
		let hatOpaque = 0;
		for (let y = 0; y < 16; y++) for (let x = 32; x < 64; x++) if (px(src, W, x, y)[3] > 0) hatOpaque++;
		expect(hatOpaque).toBe(0); // so the Notch transparency hack is not needed
		const out = upgradeLegacySkin(src);
		for (let y = 0; y < 12; y++) for (let x = 0; x < 4; x++) {
			expect(px(out, W, 20 + x, 52 + y)).toEqual(px(src, W, 4 + 3 - x, 20 + y));
		}
	});
});
```

- [ ] **Step 6: Run — FAIL.**

- [ ] **Step 7: Implement `skin-legacy.ts`**

```ts
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
```

- [ ] **Step 8: Run both test files — PASS.** Then prove the instrument, one break at a time, run, confirm red, revert, and record each in the task report: (a) `(c.w - 1 - x)` → `x` (no mirror); (b) swap the leg right/left side destinations (`dx: 24` ↔ `dx: 16`); (c) swap the arm top/bottom destinations (`dx: 36` ↔ `dx: 40` on the 4×4 rows). Also swap `right`/`left` in `faceRects` and confirm `skin-uv.test.ts` FAILS (that file's hand-typed rects are the oracle for rect placement).

- [ ] **Step 9: Commit**

```bash
git add src/engine/render/skin-uv.ts src/engine/render/skin-uv.test.ts src/engine/render/skin-legacy.ts src/engine/render/skin-legacy.test.ts
git commit -m "feat(skins): vanilla skin UV layout and legacy 64×32 upgrade"
```

---

### Task 3: Texture cache and rig (orientation proven through geometry)

**Files:**
- Create: `src/engine/render/skin-textures.ts`, `src/engine/render/skin-textures.test.ts`
- Create: `src/engine/render/player-rig.ts`, `src/engine/render/player-rig.test.ts`

**Interfaces:**
- Consumes: Task 1 `skinOf`, `skinUrl`; Task 2 everything in `skin-uv.ts`, `upgradeLegacySkin`.
- Produces (`skin-textures.ts`): `type SkinPixels = { width: number; height: number; data: Uint8ClampedArray }`; `type SkinLoad = (url: string) => Promise<SkinPixels>`; `browserLoad: SkinLoad`; `loadSkinPixels(id: string, load?: SkinLoad): Promise<Uint8ClampedArray>` (always 64×64, legacy upgraded); `class SkinTextures { constructor(load?: SkinLoad); get(id: string): THREE.DataTexture; ready(id: string): Promise<void> }` — `get` resolves unknown ids to the default skin's texture (same object).
- Produces (`player-rig.ts`): `type Layer = 'base' | 'overlay'`; `class RigResources { constructor(textures: SkinTextures); geometry(part: PartName, slim: boolean, layer: Layer): THREE.BoxGeometry; material(id: string, layer: Layer): THREE.MeshBasicMaterial }`; `type Rig = { root: THREE.Group; pivots: Record<PartName, THREE.Object3D>; skinId: string; slim: boolean }`; `buildRig(res: RigResources, id: string): Rig`; `setRigSkin(rig: Rig, res: RigResources, id: string): void`; `applyJoints(rig: Rig, j: Joints): void` (`Joints` from Task 4 — define the type in `player-anim.ts` in this task as a type-only file if Task 4 is not done yet; Task 4 fills in the functions).

- [ ] **Step 1: Write failing `skin-textures.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { SkinTextures, loadSkinPixels, type SkinPixels } from './skin-textures';
import { SKIN_FLIP_Y } from './skin-uv';
import { skinUrl } from './skin-urls';
import { skinColor } from '../../data/skins.data';

const solid = (w: number, h: number, v: number): SkinPixels => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(v) });

describe('SkinTextures', () => {
	it('one shared, nearest-filtered texture per id, flipY = SKIN_FLIP_Y; unknown ids share the default', () => {
		const urls: string[] = [];
		const t = new SkinTextures(async (u) => { urls.push(u); return solid(64, 64, 200); });
		const a = t.get('jj');
		expect(t.get('jj')).toBe(a);
		expect(a).toBeInstanceOf(THREE.DataTexture);
		expect(a.flipY).toBe(SKIN_FLIP_Y);
		expect(a.magFilter).toBe(THREE.NearestFilter);
		expect(a.minFilter).toBe(THREE.NearestFilter);
		expect(a.generateMipmaps).toBe(false);
		expect(t.get('red')).toBe(t.get('milo'));
		expect(urls).toEqual([skinUrl('jj'), skinUrl('milo')]);
	});

	it('fills the texture when the image arrives; a legacy 64×32 image is upgraded', async () => {
		const t = new SkinTextures(async () => solid(64, 32, 90));
		const tex = t.get('enderman');
		const v0 = tex.version;
		await t.ready('enderman');
		const d = tex.image.data as Uint8Array;
		expect(tex.image.width).toBe(64);
		expect(tex.image.height).toBe(64);
		expect(d[(52 * 64 + 20) * 4]).toBe(90); // new left-leg front came from the upgrade
		expect(tex.version).toBeGreaterThan(v0); // needsUpdate was set after the fill
	});

	it("a failed load keeps the character-colour placeholder and never rejects", async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const t = new SkinTextures(async () => { throw new Error('no Image in node'); });
		const tex = t.get('mikey');
		await expect(t.ready('mikey')).resolves.toBeUndefined();
		const d = tex.image.data as Uint8Array;
		const hex = skinColor('mikey'); // e.g. '#7ED321' → literal sRGB bytes, never via THREE.Color
		expect(Array.from(d.subarray(0, 4))).toEqual([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('loadSkinPixels rejects a size that is neither 64×64 nor 64×32', async () => {
		await expect(loadSkinPixels('jj', async () => solid(32, 32, 1))).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `skin-textures.ts`**

```ts
import * as THREE from 'three';
import { skinOf } from '../../data/skins.data';
import { skinUrl } from './skin-urls';
import { SKIN_FLIP_Y, SKIN_SIZE } from './skin-uv';
import { upgradeLegacySkin } from './skin-legacy';

export type SkinPixels = { width: number; height: number; data: Uint8ClampedArray };
export type SkinLoad = (url: string) => Promise<SkinPixels>;

/**
 * Decodes a PNG URL in the browser (tests inject their own load: node has no Image). Browsers with
 * fingerprinting protection (Brave, Firefox resistFingerprinting) may add noise to getImageData;
 * skins can speckle there — acceptable for the family.
 */
export const browserLoad: SkinLoad = async (url) => {
	const img = new Image();
	img.src = url;
	await img.decode();
	const c = document.createElement('canvas');
	c.width = img.naturalWidth;
	c.height = img.naturalHeight;
	const ctx = c.getContext('2d');
	if (!ctx) throw new Error('no 2d context');
	ctx.drawImage(img, 0, 0);
	const d = ctx.getImageData(0, 0, c.width, c.height);
	return { width: d.width, height: d.height, data: d.data };
};

/** A skin's 64×64 RGBA pixels (legacy 64×32 upgraded), top row first. */
export async function loadSkinPixels(id: string, load: SkinLoad = browserLoad): Promise<Uint8ClampedArray> {
	const p = await load(skinUrl(id));
	if (p.width === 64 && p.height === 64) return p.data;
	if (p.width === 64 && p.height === 32) return upgradeLegacySkin(p.data);
	throw new Error(`skin ${id}: unsupported size ${p.width}×${p.height}`);
}

/**
 * One texture per skin, shared by every avatar wearing it; never disposed per avatar. The texture
 * exists (blank) at once so meshes build synchronously, and fills in when the image decodes.
 */
export class SkinTextures {
	private readonly tex = new Map<string, THREE.DataTexture>();
	private readonly pending = new Map<string, Promise<void>>();

	constructor(private readonly load: SkinLoad = browserLoad) {}

	get(id: string): THREE.DataTexture {
		const key = skinOf(id).id;
		let t = this.tex.get(key);
		if (t) return t;
		// Until the image decodes (or if it never does) the figure shows in the character's colour, not black.
		// The hex's own sRGB bytes: THREE.Color would convert to linear (ColorManagement is on) and darken it.
		const blank = new Uint8Array(SKIN_SIZE * SKIN_SIZE * 4);
		const n = parseInt(skinOf(key).color.slice(1), 16);
		for (let i = 0; i < blank.length; i += 4) blank.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], i);
		t = new THREE.DataTexture(blank, SKIN_SIZE, SKIN_SIZE);
		t.flipY = SKIN_FLIP_Y;
		t.magFilter = THREE.NearestFilter;
		t.minFilter = THREE.NearestFilter;
		t.generateMipmaps = false;
		t.colorSpace = THREE.SRGBColorSpace;
		t.needsUpdate = true;
		this.tex.set(key, t);
		const tt = t;
		this.pending.set(key, loadSkinPixels(key, this.load).then(
			(px) => { (tt.image.data as Uint8Array).set(px); tt.needsUpdate = true; },
			(e) => { console.warn(`skin ${key} failed to load`, e); },
		));
		return t;
	}

	/** Resolves once `id`'s image has been applied (or failed). */
	async ready(id: string): Promise<void> {
		this.get(id);
		await this.pending.get(skinOf(id).id);
	}
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Create the `Joints` type** in `src/engine/render/player-anim.ts` (Task 4 adds the functions; if Task 4 already ran, skip):

```ts
/** Joint angles in vanilla convention (y-down model space: positive xRot swings a limb back). */
export type Joints = { headX: number; rArmX: number; rArmZ: number; lArmX: number; lArmZ: number; rLegX: number; lLegX: number };
export const ZERO_JOINTS: Readonly<Joints> = { headX: 0, rArmX: 0, rArmZ: 0, lArmX: 0, lArmZ: 0, rLegX: 0, lLegX: 0 };
```

- [ ] **Step 6: Write failing `player-rig.test.ts`** — the orientation instrument (spec §8.2, §8.3, §8.7).

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RigResources, buildRig, setRigSkin, applyJoints, type Rig } from './player-rig';
import { SkinTextures, type SkinPixels } from './skin-textures';
import { faceRects, partSpecs, FACE_ORDER, FACE_CORNERS, PX, type FaceName, type Rect, type PartName } from './skin-uv';
import { ZERO_JOINTS } from './player-anim';
import { FpCamera } from './camera';

/**
 * Debug skin: a label per pixel. Each face rect of each part/layer gets a unique label; the pixel at
 * its image top-left gets `<label>:TL`, at its image top-right `<label>:TR`. Encoded into RGBA as an
 * index so it can be a real texture: R,G = index, B = 0, A = 255.
 */
function debugSkin(slim: boolean) {
	const labels: string[] = ['empty'];
	const grid = new Int32Array(64 * 64); // label index per pixel
	const put = (r: Rect, label: string) => {
		const i = labels.push(label) - 1, tl = labels.push(`${label}:TL`) - 1, tr = labels.push(`${label}:TR`) - 1;
		for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y * 64 + x] = i;
		grid[r.y * 64 + r.x] = tl;
		grid[r.y * 64 + r.x + r.w - 1] = tr;
	};
	for (const p of partSpecs(slim)) {
		for (const layer of ['base', 'overlay'] as const) {
			const [u, v] = layer === 'base' ? p.base : p.overlay;
			const rects = faceRects(u, v, ...p.size);
			for (const f of FACE_ORDER) put(rects[f], `${p.name}.${layer}.${f}`);
		}
	}
	const data = new Uint8ClampedArray(64 * 64 * 4);
	for (let i = 0; i < grid.length; i++) data.set([grid[i] & 255, grid[i] >> 8, 0, 255], i * 4);
	return { labels, pixels: { width: 64, height: 64, data } as SkinPixels };
}

async function rigWith(slim: boolean) {
	const { labels, pixels } = debugSkin(slim);
	const textures = new SkinTextures(async () => pixels);
	const id = slim ? 'milo' : 'jj';
	await textures.ready(id);
	const res = new RigResources(textures);
	const rig = buildRig(res, id);
	const scene = new THREE.Scene();
	scene.add(rig.root);
	rig.root.updateMatrixWorld(true);
	return { rig, labels, res };
}

/** Label under a hit, sampled with the texture's own flipY (never hard-coded). */
function labelAt(hit: THREE.Intersection, labels: string[]): string {
	const mat = (hit.object as THREE.Mesh).material as THREE.MeshBasicMaterial;
	const tex = mat.map as THREE.DataTexture;
	const uv = hit.uv!;
	const col = Math.min(63, Math.floor(uv.x * 64));
	const row = Math.min(63, Math.floor((tex.flipY ? 1 - uv.y : uv.y) * 64));
	const d = tex.image.data as Uint8Array;
	const k = (row * 64 + col) * 4;
	return labels[d[k] | (d[k + 1] << 8)];
}

/** Local outward normal and in-face axes (right, down) as seen from outside, per face (spec §5). */
const FACE_AXES: Record<FaceName, { n: THREE.Vector3; right: THREE.Vector3; down: THREE.Vector3 }> = {
	// sides, seen from outside: viewer's right = (−normal) × up
	front: { n: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(-1, 0, 0), down: new THREE.Vector3(0, -1, 0) },
	back: { n: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -1, 0) },
	right: { n: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(0, 0, -1), down: new THREE.Vector3(0, -1, 0) },
	left: { n: new THREE.Vector3(-1, 0, 0), right: new THREE.Vector3(0, 0, 1), down: new THREE.Vector3(0, -1, 0) },
	// top/bottom "image" axes from §5: rect left column at +x, last row at the front (−z)
	top: { n: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(-1, 0, 0), down: new THREE.Vector3(0, 0, -1) },
	bottom: { n: new THREE.Vector3(0, -1, 0), right: new THREE.Vector3(-1, 0, 0), down: new THREE.Vector3(0, 0, -1) },
};
```

**Independent check of the table** — ties `FACE_AXES` to the geometry and to §5's `FACE_CORNERS`, so the probe's axes cannot silently agree with a wrong mapping:

```ts
describe('FACE_AXES agrees with BoxGeometry + FACE_CORNERS', () => {
	it('image right = TL→TR, image down = TL→BL, normal = face normal', () => {
		const g = new THREE.BoxGeometry(2, 3, 5);
		const pos = g.getAttribute('position'), nor = g.getAttribute('normal');
		FACE_ORDER.forEach((face, f) => {
			const at = (c: string) => {
				const k = FACE_CORNERS[face].indexOf(c as never);
				return new THREE.Vector3().fromBufferAttribute(pos, f * 4 + k);
			};
			const right = at('TR').sub(at('TL')).normalize();
			const down = at('BL').sub(at('TL')).normalize();
			const n = new THREE.Vector3().fromBufferAttribute(nor, f * 4);
			expect(right.distanceTo(FACE_AXES[face].right), `${face} right`).toBeLessThan(1e-9);
			expect(down.distanceTo(FACE_AXES[face].down), `${face} down`).toBeLessThan(1e-9);
			expect(n.distanceTo(FACE_AXES[face].n), `${face} n`).toBeLessThan(1e-9);
		});
	});
});
```

(`cornerPx` is not needed in this file — import only what is used: `noUnusedLocals` is on.) If this check fails, re-derive from §5's prose (sides: v0 is the top-left seen from outside; top/bottom: rect's left column at +x, last row at −z) — never edit `FACE_CORNERS` to make it pass without re-reading §5.

Then the tests:

```ts
type Spot = 'centre' | 'TL' | 'TR';

/** Raycast one face of one mesh at its centre or at the centre of its image-TL / image-TR pixel. */
function probe(rig: Rig, part: PartName, layer: 'base' | 'overlay', face: FaceName, spot: Spot, slim: boolean, labels: string[]): string {
	const mesh = rig.pivots[part].getObjectByName(layer === 'base' ? part : `${part}Overlay`) as THREE.Mesh;
	mesh.geometry.computeBoundingBox();
	const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
	const ax = FACE_AXES[face];
	const half = (v: THREE.Vector3) => (Math.abs(v.x) * size.x + Math.abs(v.y) * size.y + Math.abs(v.z) * size.z) / 2;
	const spec = partSpecs(slim).find((p) => p.name === part)!;
	const rect = faceRects(0, 0, ...spec.size)[face]; // only w/h matter: pixels across and down
	// s, t ∈ [−1, 1] across the face (image right, image down); a corner pixel's centre is 1/n in.
	const s = spot === 'centre' ? 0 : spot === 'TL' ? -1 + 1 / rect.w : 1 - 1 / rect.w;
	const t = spot === 'centre' ? 0 : -1 + 1 / rect.h;
	const onFace = ax.n.clone().multiplyScalar(half(ax.n))
		.addScaledVector(ax.right, s * half(ax.right))
		.addScaledVector(ax.down, t * half(ax.down));
	const origin = mesh.localToWorld(onFace.clone().addScaledVector(ax.n, 1));
	const target = mesh.localToWorld(onFace.clone());
	const hits = new THREE.Raycaster(origin, target.sub(origin).normalize()).intersectObject(mesh, false);
	return hits.length ? labelAt(hits[0], labels) : 'miss';
}

describe('rig orientation (through real geometry and the real texture flipY)', () => {
	for (const slim of [false, true]) {
		it(`every face of every part and layer reads correctly (${slim ? 'slim' : 'classic'})`, async () => {
			const { rig, labels } = await rigWith(slim);
			const bad: string[] = [];
			for (const p of partSpecs(slim)) for (const layer of ['base', 'overlay'] as const) for (const f of FACE_ORDER) {
				const want = `${p.name}.${layer}.${f}`;
				const got = {
					centre: probe(rig, p.name, layer, f, 'centre', slim, labels),
					TL: probe(rig, p.name, layer, f, 'TL', slim, labels),
					TR: probe(rig, p.name, layer, f, 'TR', slim, labels),
				};
				if (got.centre !== want) bad.push(`${want}: centre → ${got.centre}`);
				if (got.TL !== `${want}:TL`) bad.push(`${want}: TL → ${got.TL}`);
				if (got.TR !== `${want}:TR`) bad.push(`${want}: TR → ${got.TR}`);
			}
			expect(bad).toEqual([]);
		});
	}

	it("seen from in front of the face, the character's right arm is on the viewer's left", async () => {
		const { rig } = await rigWith(false);
		const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
		cam.position.set(0, 1.0, -3); // arm mid-height is 18 px = 1.01
		cam.lookAt(0, 1.0, 0);
		cam.updateMatrixWorld();
		const ray = new THREE.Raycaster();
		// the right arm's centre is at x = 6 px = 0.34; at 3 blocks with fov 60 that is NDC ≈ 0.19,
		// on the screen's LEFT because the camera looks toward +z
		ray.setFromCamera(new THREE.Vector2(-0.19, 0), cam);
		const hit = ray.intersectObject(rig.root, true).find((h) => !h.object.name.endsWith('Overlay'));
		expect(hit?.object.name).toBe('rightArm');
	});
});
```

- [ ] **Step 7: Run — FAIL** (module missing).

- [ ] **Step 8: Implement `player-rig.ts`**

```ts
import * as THREE from 'three';
import { skinOf } from '../../data/skins.data';
import { SkinTextures } from './skin-textures';
import { faceRects, boxUVs, partSpecs, PART_NAMES, PX, type PartName } from './skin-uv';
import type { Joints } from './player-anim';

export type Layer = 'base' | 'overlay';

/**
 * Geometry per (part, arm model, layer) and material per (skin, layer), built on first use and
 * shared by every avatar. Nothing here is disposed per avatar (spec §5).
 */
export class RigResources {
	private readonly geos = new Map<string, THREE.BoxGeometry>();
	private readonly mats = new Map<string, THREE.MeshBasicMaterial>();

	constructor(readonly textures: SkinTextures) {}

	geometry(part: PartName, slim: boolean, layer: Layer): THREE.BoxGeometry {
		const key = `${part}/${slim}/${layer}`;
		let g = this.geos.get(key);
		if (g) return g;
		const spec = partSpecs(slim).find((p) => p.name === part)!;
		const grow = layer === 'overlay' ? spec.inflate * 2 : 0;
		const [w, h, d] = spec.size;
		g = new THREE.BoxGeometry((w + grow) * PX, (h + grow) * PX, (d + grow) * PX);
		const [u, v] = layer === 'base' ? spec.base : spec.overlay;
		g.setAttribute('uv', new THREE.BufferAttribute(boxUVs(faceRects(u, v, w, h, d)), 2));
		this.geos.set(key, g);
		return g;
	}

	material(id: string, layer: Layer): THREE.MeshBasicMaterial {
		const skin = skinOf(id).id;
		const key = `${skin}/${layer}`;
		let m = this.mats.get(key);
		if (m) return m;
		m = layer === 'base'
			? new THREE.MeshBasicMaterial({ map: this.textures.get(skin) })
			: new THREE.MeshBasicMaterial({ map: this.textures.get(skin), alphaTest: 0.5, transparent: false, side: THREE.DoubleSide });
		this.mats.set(key, m);
		return m;
	}
}

export type Rig = { root: THREE.Group; pivots: Record<PartName, THREE.Object3D>; skinId: string; slim: boolean };

/** Head/body/arms/legs pivots under `root`, positioned in world units, feet at the origin. */
export function buildRig(res: RigResources, id: string): Rig {
	const row = skinOf(id);
	const root = new THREE.Group();
	root.name = 'rig';
	const pivots = {} as Record<PartName, THREE.Object3D>;
	for (const spec of partSpecs(row.slim)) {
		const pivot = new THREE.Object3D();
		pivot.name = `${spec.name}Pivot`;
		pivot.rotation.order = 'ZYX';
		pivot.position.set(spec.pivot[0] * PX, spec.pivot[1] * PX, spec.pivot[2] * PX);
		for (const layer of ['base', 'overlay'] as const) {
			const mesh = new THREE.Mesh(res.geometry(spec.name, row.slim, layer), res.material(row.id, layer));
			mesh.name = layer === 'base' ? spec.name : `${spec.name}Overlay`;
			mesh.position.set(spec.offset[0] * PX, spec.offset[1] * PX, spec.offset[2] * PX);
			pivot.add(mesh);
		}
		pivots[spec.name] = pivot;
		root.add(pivot);
	}
	return { root, pivots, skinId: row.id, slim: row.slim };
}
```

Pivots are named `<part>Pivot` and meshes `<part>` / `<part>Overlay`, so `getObjectByName('rightArm')` finds the base mesh; `rig.pivots[part]` is the way to reach a pivot.

```ts
/** Swaps materials; when the arm model changes, the arm meshes take the other geometry and offsets. */
export function setRigSkin(rig: Rig, res: RigResources, id: string): void {
	const row = skinOf(id);
	const specs = partSpecs(row.slim);
	for (const name of PART_NAMES) {
		const spec = specs.find((p) => p.name === name)!;
		const pivot = rig.pivots[name];
		pivot.position.set(spec.pivot[0] * PX, spec.pivot[1] * PX, spec.pivot[2] * PX);
		for (const layer of ['base', 'overlay'] as const) {
			const mesh = pivot.getObjectByName(layer === 'base' ? name : `${name}Overlay`) as THREE.Mesh;
			mesh.geometry = res.geometry(name, row.slim, layer);
			mesh.material = res.material(row.id, layer);
			mesh.position.set(spec.offset[0] * PX, spec.offset[1] * PX, spec.offset[2] * PX);
		}
	}
	rig.skinId = row.id;
	rig.slim = row.slim;
}

/** Vanilla joints → three: order ZYX, x and y negated, z kept (spec §7). */
export function applyJoints(rig: Rig, j: Joints): void {
	rig.pivots.head.rotation.set(-j.headX, 0, 0);
	rig.pivots.rightArm.rotation.set(-j.rArmX, 0, j.rArmZ);
	rig.pivots.leftArm.rotation.set(-j.lArmX, 0, j.lArmZ);
	rig.pivots.rightLeg.rotation.set(-j.rLegX, 0, 0);
	rig.pivots.leftLeg.rotation.set(-j.lLegX, 0, 0);
}
```

- [ ] **Step 9: Add rig tests for pose, sharing and arm rebuild**

```ts
describe('rig posing and resources', () => {
	it('head front follows FpCamera.getLookDir for yaw/pitch pairs; body ignores pitch', async () => {
		const { rig } = await rigWith(false);
		const group = new THREE.Group();
		group.add(rig.root);
		for (const [yaw, pitch] of [[0, 0], [0.7, 0.5], [-2, -0.8], [3, 1.2]]) {
			group.rotation.set(0, yaw, 0);
			applyJoints(rig, { ...ZERO_JOINTS, headX: -pitch });
			group.updateMatrixWorld(true);
			const q = rig.pivots.head.getWorldQuaternion(new THREE.Quaternion());
			const front = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
			const cam = new FpCamera();
			cam.yaw = yaw; cam.pitch = pitch;
			expect(front.distanceTo(cam.getLookDir())).toBeLessThan(1e-6);
			const bq = rig.pivots.body.getWorldQuaternion(new THREE.Quaternion());
			expect(Math.abs(new THREE.Vector3(0, 0, -1).applyQuaternion(bq).y)).toBeLessThan(1e-9);
		}
	});

	it('a negative vanilla rArmX swings the arm forward (toward −z)', async () => {
		const { rig } = await rigWith(false);
		applyJoints(rig, { ...ZERO_JOINTS, rArmX: -1 });
		rig.root.updateMatrixWorld(true);
		const shoulder = rig.pivots.rightArm.getWorldPosition(new THREE.Vector3());
		const hand = rig.pivots.rightArm.localToWorld(new THREE.Vector3(0, -12 * PX, 0));
		expect(hand.z).toBeLessThan(shoulder.z - 0.3);
	});

	it('re-skin slim → classic changes arm width; materials are shared across rigs', async () => {
		const textures = new SkinTextures(async () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }));
		const res = new RigResources(textures);
		const a = buildRig(res, 'milo'), b = buildRig(res, 'milo');
		const arm = (r: Rig) => (r.pivots.rightArm.getObjectByName('rightArm') as THREE.Mesh);
		expect(arm(a).material).toBe(arm(b).material);
		const width = (r: Rig) => { const g = arm(r).geometry; g.computeBoundingBox(); return g.boundingBox!.getSize(new THREE.Vector3()).x / PX; };
		expect(width(a)).toBeCloseTo(3, 6);
		setRigSkin(a, res, 'jj');
		expect(width(a)).toBeCloseTo(4, 6);
		expect((arm(a).material as THREE.MeshBasicMaterial).map).toBe(textures.get('jj'));
		setRigSkin(a, res, 'milo');
		expect(width(a)).toBeCloseTo(3, 6);
	});
});
```

Also add (engine gate-2; each goes red on exactly its own break — `-j.rArmZ`, order `'XYZ'`, inflation 0):

```ts
describe('rig joints and overlays', () => {
	const res = new RigResources(new SkinTextures(async () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) })));
	const hand = (p: THREE.Object3D) => p.localToWorld(new THREE.Vector3(0, -12 * PX, 0));
	it('positive vanilla zRot moves each hand outward', () => {
		const rig = buildRig(res, 'jj');
		applyJoints(rig, { ...ZERO_JOINTS, rArmZ: 0.3, lArmZ: -0.3 });
		rig.root.updateMatrixWorld(true);
		expect(hand(rig.pivots.rightArm).x).toBeGreaterThan(rig.pivots.rightArm.getWorldPosition(new THREE.Vector3()).x + 0.05);
		expect(hand(rig.pivots.leftArm).x).toBeLessThan(rig.pivots.leftArm.getWorldPosition(new THREE.Vector3()).x - 0.05);
	});
	it('rotation order is vanilla ZYX (Rz·Rx)', () => {
		const rig = buildRig(res, 'jj');
		applyJoints(rig, { ...ZERO_JOINTS, rArmX: -1.2, rArmZ: -0.4 });
		const want = new THREE.Matrix4().makeRotationZ(-0.4).multiply(new THREE.Matrix4().makeRotationX(1.2));
		const got = new THREE.Matrix4().makeRotationFromEuler(rig.pivots.rightArm.rotation);
		got.elements.forEach((e, i) => expect(e).toBeCloseTo(want.elements[i], 9));
	});
	it('overlays are inflated 0.5 px (head) / 0.25 px (others) per side', () => {
		const rig = buildRig(res, 'jj');
		const size = (n: string) => { const g = (rig.root.getObjectByName(n) as THREE.Mesh).geometry; g.computeBoundingBox(); return g.boundingBox!.getSize(new THREE.Vector3()).divideScalar(PX); };
		expect(size('headOverlay').x - size('head').x).toBeCloseTo(1, 4);
		expect(size('bodyOverlay').y - size('body').y).toBeCloseTo(0.5, 4);
		expect(size('leftLegOverlay').z - size('leftLeg').z).toBeCloseTo(0.5, 4);
	});
	it('overlay material: alpha-tested, double-sided, not blended', () => {
		const m = res.material('jj', 'overlay');
		expect([m.alphaTest, m.side, m.transparent]).toEqual([0.5, THREE.DoubleSide, false]);
	});
});
```

(Precision 4, not 6: float32 geometry leaves ~6e-7.)

- [ ] **Step 10: Run — PASS.** Then prove the instrument, one wrong build at a time, run, confirm red, revert (record each in the report):
  1. swap `right`/`left` rects in `faceRects` → run **`skin-uv.test.ts`** (its hand-typed rects are the placement oracle; the raycast test is blind to rect placement by construction, because its debug skin is built from `faceRects` too — say so in a comment on the raycast test);
  2. mirror the front (`FACE_CORNERS.front = ['TR','TL','BR','BL']`);
  3. flip the front vertically (`['BL','BR','TL','TR']`);
  4. transpose the head front (swap x/y in `cornerPx` for the front face only, temporarily);
  5. top at BoxGeometry default (`FACE_CORNERS.top = ['TL','TR','BL','BR']`);
  6. `SKIN_FLIP_Y = true` in the loader only (set `t.flipY = !SKIN_FLIP_Y` in `SkinTextures.get`).
  7. `applyJoints` with `+j.headX` (pitch test must fail) and with `+j.rArmX` (swing-forward test must fail);
  8. `-j.rArmZ`, `rotation.order = 'XYZ'`, overlay inflate 0 (the 'rig joints and overlays' tests).

- [ ] **Step 11: Commit**

```bash
git add src/engine/render/skin-textures.ts src/engine/render/skin-textures.test.ts src/engine/render/player-rig.ts src/engine/render/player-rig.test.ts src/engine/render/player-anim.ts
git commit -m "feat(skins): shared skin textures and the player rig, orientation pinned by raycast"
```

---

### Task 4: Animation (pure)

**Files:**
- Modify: `src/engine/render/player-anim.ts` (Task 3 created the `Joints` type)
- Create: `src/engine/render/player-anim.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Joints`, `ZERO_JOINTS`, `type AnimState = { walkPhase: number; walkAmount: number; swingAt: number | null; lastX: number | null; lastZ: number | null; lastT: number | null; idleOffset: number }`, `newAnimState(idleOffset = 0): AnimState`, `type AnimInput = { now: number; x: number; z: number; pitch: number; mining: boolean }`, `type AnimLayer = (s: AnimState, inp: AnimInput, j: Joints) => void`, `LAYERS: AnimLayer[]`, `step(s, inp): void`, `triggerSwing(s, now): void`, `joints(s, inp): Joints`, `SWING_MS = 300`, `MINING_SWING_EVERY_MS = 200`, `TELEPORT_BLOCKS = 1`.

- [ ] **Step 1: Write failing `player-anim.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { newAnimState, step, joints, triggerSwing, SWING_MS, type AnimState, type AnimInput } from './player-anim';

const FRAME = 1000 / 60;

/** Moves along −z at `speed` blocks/s for `ms`, stepping every frame; returns the last input. */
function run(s: AnimState, from: AnimInput, speed: number, ms: number, extra: Partial<AnimInput> = {}): AnimInput {
	let inp = { ...from, ...extra };
	for (let t = 0; t < ms; t += FRAME) {
		inp = { ...inp, now: inp.now + FRAME, z: inp.z - speed * FRAME / 1000 };
		step(s, inp);
	}
	return inp;
}

const start: AnimInput = { now: 1000, x: 0, z: 0, pitch: 0, mining: false };
const finite = (o: object) => Object.values(o).every((v) => Number.isFinite(v));

describe('walk', () => {
	it('legs swing in opposite phase, arms opposite their same-side leg, and the stride advances', () => {
		const s = newAnimState();
		step(s, start);
		let inp = run(s, start, 4.3, 2000);
		const a = joints(s, inp);
		expect(Math.sign(a.rLegX)).toBe(-Math.sign(a.lLegX));
		expect(Math.sign(a.rArmX)).toBe(-Math.sign(a.rLegX));
		// half a stride later the right leg is on the other side: phase advances 20·amount per s,
		// a half cycle is π/0.6662 phase units.
		const halfStrideMs = (Math.PI / 0.6662) / (20 * s.walkAmount) * 1000;
		const before = joints(s, inp).rLegX;
		inp = run(s, inp, 4.3, halfStrideMs);
		const after = joints(s, inp).rLegX;
		expect(Math.abs(before)).toBeGreaterThan(0.05);
		expect(Math.sign(after)).toBe(-Math.sign(before));
	});

	it('stopping settles the walk to ~0 within a second', () => {
		const s = newAnimState();
		step(s, start);
		const inp = run(s, start, 4.3, 1000);
		run(s, inp, 0, 1000);
		expect(s.walkAmount).toBeLessThan(0.01);
	});

	it('pure vertical motion does not walk', () => {
		const s = newAnimState();
		step(s, start);
		let inp = start;
		for (let t = 0; t < 1000; t += FRAME) { inp = { ...inp, now: inp.now + FRAME }; step(s, inp); }
		// y is not an input at all: falling cannot drive the walk
		expect(s.walkAmount).toBeLessThan(0.01);
	});

	it('first frame and a repeated timestamp give finite joints', () => {
		const s = newAnimState();
		step(s, start);
		expect(finite(joints(s, start))).toBe(true);
		step(s, start); // same now AND same position: 0/0 without the dt guard
		expect(finite(joints(s, start))).toBe(true);
		expect(Number.isFinite(s.walkAmount)).toBe(true);
		step(s, { ...start, z: -0.1 }); // same now, moved
		expect(finite(joints(s, start))).toBe(true);
	});

	it('idle sway is offset per avatar', () => {
		const a = newAnimState(0), b = newAnimState(3);
		expect(joints(a, start).rArmZ).not.toBeCloseTo(joints(b, start).rArmZ, 6);
	});

	it('a teleport (over 1 block in one step) does not touch the walk', () => {
		const s = newAnimState();
		step(s, start);
		step(s, { ...start, now: start.now + FRAME, z: -20 });
		expect(s.walkAmount).toBe(0);
		expect(s.walkPhase).toBe(0);
	});
});

describe('swing', () => {
	it('mining restarts the swing every 200 ms; stopping lets the last swing finish', () => {
		const s = newAnimState();
		step(s, start);
		const starts = new Set<number>();
		let inp: AnimInput = { ...start, mining: true };
		for (let t = 0; t < 1000; t += FRAME) {
			inp = { ...inp, now: inp.now + FRAME };
			step(s, inp);
			if (s.swingAt !== null) starts.add(s.swingAt);
		}
		expect(starts.size).toBeGreaterThanOrEqual(4);
		const last = s.swingAt!;
		inp = { ...inp, mining: false, now: inp.now + FRAME };
		step(s, inp);
		expect(s.swingAt).toBe(last); // still running
		const idle = joints(newAnimState(), inp);
		expect(joints(s, inp).rArmX).not.toBeCloseTo(idle.rArmX, 3);
		inp = { ...inp, now: last + SWING_MS + 1 };
		step(s, inp);
		expect(s.swingAt).toBeNull();
		expect(joints(s, inp).rArmX).toBeCloseTo(joints(newAnimState(), inp).rArmX, 9);
	});

	it('a swing moves the right arm forward (vanilla xRot negative) at p = 0.16', () => {
		const s = newAnimState();
		step(s, start);
		triggerSwing(s, start.now);
		const inp = { ...start, now: start.now + 0.16 * SWING_MS };
		const base = joints(newAnimState(), inp).rArmX;
		expect(joints(s, inp).rArmX).toBeLessThan(base - 0.3);
	});
});

describe('head', () => {
	it('headX is vanilla pitch: minus the pose pitch', () => {
		const s = newAnimState();
		expect(joints(s, { ...start, pitch: 0.4 }).headX).toBeCloseTo(-0.4, 12);
	});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `player-anim.ts`** (keep the `Joints`/`ZERO_JOINTS` from Task 3)

```ts
/**
 * Remote-player animation (spec §7): pure, no three. Everything derives from the interpolated pose;
 * no network data beyond it. Joints are vanilla-convention angles (see player-rig applyJoints).
 * Add an animation = append one AnimLayer to LAYERS (+ whatever sets its state).
 */
export type Joints = { headX: number; rArmX: number; rArmZ: number; lArmX: number; lArmZ: number; rLegX: number; lLegX: number };
export const ZERO_JOINTS: Readonly<Joints> = { headX: 0, rArmX: 0, rArmZ: 0, lArmX: 0, lArmZ: 0, rLegX: 0, lLegX: 0 };

export const SWING_MS = 300;
export const MINING_SWING_EVERY_MS = 200;
/** A pose jump longer than this (blocks) is a teleport/respawn/first pose: it does not walk. */
export const TELEPORT_BLOCKS = 1;

/** `idleOffset` (s) desynchronises the idle sway between avatars, like vanilla's per-entity age. */
export type AnimState = { walkPhase: number; walkAmount: number; swingAt: number | null; lastX: number | null; lastZ: number | null; lastT: number | null; idleOffset: number };
export type AnimInput = { now: number; x: number; z: number; pitch: number; mining: boolean };
export type AnimLayer = (s: AnimState, inp: AnimInput, j: Joints) => void;

export function newAnimState(idleOffset = 0): AnimState {
	return { walkPhase: 0, walkAmount: 0, swingAt: null, lastX: null, lastZ: null, lastT: null, idleOffset };
}

export function triggerSwing(s: AnimState, now: number): void {
	s.swingAt = now;
}

/** Advances walk and swing state from a new pose. */
export function step(s: AnimState, inp: AnimInput): void {
	if (s.swingAt !== null && inp.now - s.swingAt >= SWING_MS) s.swingAt = null;
	if (inp.mining && (s.swingAt === null || inp.now - s.swingAt >= MINING_SWING_EVERY_MS)) s.swingAt = inp.now;
	const { lastX, lastZ, lastT } = s;
	s.lastX = inp.x; s.lastZ = inp.z;
	if (lastT === null || lastX === null || lastZ === null) { s.lastT = inp.now; return; }
	const dt = (inp.now - lastT) / 1000;
	if (dt <= 0) return; // keep lastT: the next step measures from it
	s.lastT = inp.now;
	const dist = Math.hypot(inp.x - lastX, inp.z - lastZ);
	if (dist > TELEPORT_BLOCKS) return;
	const target = Math.min(1, 0.2 * (dist / dt));
	s.walkAmount += (target - s.walkAmount) * (1 - Math.pow(0.6, 20 * dt));
	s.walkPhase += 20 * s.walkAmount * dt;
}

const idle: AnimLayer = (s, inp, j) => {
	const t = inp.now / 1000 + s.idleOffset;
	const z = Math.cos(1.8 * t) * 0.05 + 0.05;
	const x = Math.sin(1.34 * t) * 0.05;
	j.rArmZ += z; j.lArmZ -= z;
	j.rArmX += x; j.lArmX -= x;
};

const walk: AnimLayer = (s, _inp, j) => {
	const ph = s.walkPhase * 0.6662, a = s.walkAmount;
	j.rArmX += Math.cos(ph + Math.PI) * a;
	j.lArmX += Math.cos(ph) * a;
	j.rLegX += Math.cos(ph) * 1.4 * a;
	j.lLegX += Math.cos(ph + Math.PI) * 1.4 * a;
};

const swing: AnimLayer = (s, inp, j) => {
	if (s.swingAt === null) return;
	const p = (inp.now - s.swingAt) / SWING_MS;
	if (p < 0 || p >= 1) return;
	const f1 = Math.sin(Math.PI * (1 - Math.pow(1 - p, 4)));
	const headXv = -inp.pitch;
	j.rArmX -= f1 * 1.2 + Math.sin(p * Math.PI) * (0.7 - headXv) * 0.75;
	j.rArmZ += -0.4 * Math.sin(p * Math.PI);
};

export const LAYERS: AnimLayer[] = [idle, walk, swing];

export function joints(s: AnimState, inp: AnimInput): Joints {
	const j: Joints = { ...ZERO_JOINTS, headX: -inp.pitch };
	for (const layer of LAYERS) layer(s, inp, j);
	return j;
}
```

Note the dt = 0 branch: the position was recorded but `lastT` kept, so the next step's `dist` is measured from the new position over the full elapsed time — acceptable (sub-frame).

- [ ] **Step 4: Run — PASS.** Prove the instruments, one at a time, confirm red, revert, record: phase never advances (`s.walkPhase += 0`) → half-stride test FAILS; drop the `dt <= 0` guard → finite test FAILS (it steps the same timestamp at the same position: 0/0); idle using `inp.now` only → idle-offset test FAILS. (The "pure vertical motion" test cannot fail — y is not an input; it documents the contract.)

- [ ] **Step 5: Commit**

```bash
git add src/engine/render/player-anim.ts src/engine/render/player-anim.test.ts
git commit -m "feat(skins): layered player animation — idle, walk, swing (vanilla formulas)"
```

---

### Task 5: RemotePlayers uses the rig; main.ts wiring

**Files:**
- Modify: `src/engine/render/remote-players.ts`, `src/engine/render/remote-players.test.ts`
- Modify: `src/main.ts` (≈ lines 805–915 and the `edit` route ≈ 873; `__mc` ≈ 974)
- Create: `src/game/hand-edit.ts`, `src/game/hand-edit.test.ts`

**Interfaces:**
- Consumes: Task 3 `SkinTextures`, `RigResources`, `buildRig`, `setRigSkin`, `applyJoints`, `Rig`; Task 4 `newAnimState`, `step`, `joints`, `triggerSwing`, `AnimState`.
- Produces: `isHandEdit(ops: readonly Op[], blockAt: (x: number, y: number, z: number) => number): boolean` (`src/game/hand-edit.ts`); `RemotePlayersOptions.textures?: SkinTextures`; `update(now: number, camera: THREE.Camera, miners: ReadonlySet<number> = NO_MINERS): void`; `swing(id: number, now: number): void`; `positions()` unchanged (reports the raw skin id). DEV `__mc.camera` (the render camera) for Task 7.

- [ ] **Step 1: Update `remote-players.test.ts`** — every `new RemotePlayers(scene…)` gets `textures: fakeTextures()`:

```ts
import { SkinTextures } from './skin-textures';
const fakeTextures = () => new SkinTextures(async () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }));
```

Replace `findBox` with a rig lookup (`g.getObjectByName('head') as THREE.Mesh`). Replace the hex assertions:
- label-border test (≈ line 65): upsert `'jj'` then `'milo'` → `strokes` equal `[skinColor('jj'), skinColor('milo')]`.
- colour-box tests (≈ lines 82, 87): replace with "the head material's map is `textures.get('jj')`" and after re-skin `textures.get('milo')`.
- line ≈132 `'#43A047'` → `skinColor('mikey')` with upsert `'mikey'`.
- ids `'blue'`/`'red'`/`'green'` in other tests → `'jj'`/`'milo'`/`'mikey'` except where the test is about an unknown id.

Add:

```ts
it("an old colour id renders as Milo; positions() reports what the server sent", () => {
	const scene = new THREE.Scene();
	const textures = fakeTextures();
	const rp = new RemotePlayers(scene, { textures, createCanvas: () => fakeCanvas().canvas });
	rp.upsert(1, 'x', 'red');
	const head = scene.getObjectByName('head') as THREE.Mesh;
	expect((head.material as THREE.MeshBasicMaterial).map).toBe(textures.get('milo'));
	rp.pushPose(1, 0, pose(1, 64, 0));
	rp.update(0, new THREE.PerspectiveCamera());
	expect(rp.positions()[0].skin).toBe('red');
});

it('removing one of two same-skin avatars leaves the other its material and texture', () => {
	const scene = new THREE.Scene();
	const textures = fakeTextures();
	const rp = new RemotePlayers(scene, { textures, createCanvas: () => fakeCanvas().canvas });
	rp.upsert(1, 'a', 'jj');
	rp.upsert(2, 'b', 'jj');
	const head2 = scene.getObjectByName('remote-player-2')!.getObjectByName('head') as THREE.Mesh;
	const mat = head2.material as THREE.MeshBasicMaterial;
	let disposed = false;
	mat.addEventListener('dispose', () => { disposed = true; });
	let texDisposed = false;
	textures.get('jj').addEventListener('dispose', () => { texDisposed = true; });
	rp.remove(1);
	expect(disposed).toBe(false);
	expect(texDisposed).toBe(false);
	expect(head2.material).toBe(mat);
});

it('walking moves the legs (both signs seen)', () => {
	const scene = new THREE.Scene();
	const rp = new RemotePlayers(scene, { textures: fakeTextures(), createCanvas: () => fakeCanvas().canvas });
	rp.upsert(1, 'a', 'jj');
	const cam = new THREE.PerspectiveCamera();
	const leg = () => scene.getObjectByName('remote-player-1')!.getObjectByName('rightLegPivot')!.rotation.x;
	const seen = new Set<number>();
	for (let t = 0; t < 2200; t += 16) {
		rp.pushPose(1, t, pose(0, 64, -t * 0.0043));
		rp.update(t + 200, cam); // PoseBuffer renders 200 ms behind
		if (t > 1500) seen.add(Math.sign(leg()));
	}
	expect(seen.has(1) && seen.has(-1)).toBe(true);
});

/** Walks, then stands ~1.6 s so the walk has decayed; returns helpers and the current time. */
function settled() {
	const scene = new THREE.Scene();
	const rp = new RemotePlayers(scene, { textures: fakeTextures(), createCanvas: () => fakeCanvas().canvas });
	rp.upsert(1, 'a', 'jj');
	const cam = new THREE.PerspectiveCamera();
	let t = 0;
	for (; t < 1000; t += 16) { rp.pushPose(1, t, pose(0, 64, -t * 0.0043)); rp.update(t + 200, cam); }
	const z = -t * 0.0043;
	for (let k = 0; k < 100; k++, t += 16) { rp.pushPose(1, t, pose(0, 64, z)); rp.update(t + 200, cam); }
	const arm = () => scene.getObjectByName('remote-player-1')!.getObjectByName('rightArmPivot')!.rotation.x;
	return { scene, rp, cam, arm, now: t + 200, z };
}

it('a miner swings forward; without miners the arm stays still (negative control)', () => {
	const { rp, cam, arm, now } = settled();
	const idle = arm();
	rp.update(now + 100, cam);
	expect(Math.abs(arm() - idle)).toBeLessThan(0.05); // no miners: idle sway only
	const idle2 = arm();
	rp.update(now + 150, cam, new Set([1])); // swing starts
	rp.update(now + 200, cam, new Set([1])); // p ≈ 0.17
	expect(arm() - idle2).toBeGreaterThan(0.2); // three rotation.x = −rArmX: a forward chop is positive
});

it('swing(id) fires one swing without miners', () => {
	const { rp, cam, arm, now } = settled();
	rp.update(now + 50, cam);
	const idle = arm();
	rp.swing(1, now + 50);
	rp.update(now + 100, cam);
	expect(arm() - idle).toBeGreaterThan(0.2);
	rp.update(now + 500, cam);
	expect(Math.abs(arm() - idle)).toBeLessThan(0.05); // one swing, then back to idle
});

it('pitch reaches the head only', () => {
	const scene = new THREE.Scene();
	const rp = new RemotePlayers(scene, { textures: fakeTextures(), createCanvas: () => fakeCanvas().canvas });
	rp.upsert(1, 'a', 'jj');
	rp.pushPose(1, 0, { x: 0, y: 64, z: 0, yaw: 0.5, pitch: 0.6 });
	rp.update(0, new THREE.PerspectiveCamera());
	const g = scene.getObjectByName('remote-player-1')!;
	expect(g.getObjectByName('headPivot')!.rotation.x).toBeCloseTo(0.6, 9);
	expect(g.getObjectByName('bodyPivot')!.rotation.x).toBe(0);
	expect(g.rotation.y).toBeCloseTo(0.5, 9);
});
```

Two existing tests change meaning (not mechanically):
- "remove takes the group out of the scene and disposes of its geometry, materials…" (≈ line 90) → **invert**: after `remove`, the group is out of the scene and the label's material/texture are disposed, but the rig's geometry and materials are **not** (listen for `'dispose'` events on one geometry and one material; expect none).
- "update places the group at the interpolated pose (feet at y)…" (≈ line 141) → keep the group-position and yaw assertions; replace `box.position.y ≈ 0.9` with: the world-space bounding box of the rig (`new THREE.Box3().setFromObject(rig root)`) has `min.y` within 0.01 of the pose `y` (feet on the ground) and `max.y` within 0.05 of `y + 1.8` (overlay adds a little).

(Pivot names: `<part>Pivot` — Task 3.)

Add `src/game/hand-edit.test.ts` — the rule that decides whether a friend's `edit` is a hand action (place/break) or the world simulating (water/lava flow, drains):

```ts
import { describe, it, expect } from 'vitest';
import { isHandEdit } from './hand-edit';
import { BLOCKS, AIR } from '../data/blocks.data';
import type { Op } from '../net/protocol';

const STONE = 1;
const WATER = BLOCKS.findIndex((b) => b?.liquid === 'water');
const op = (id: number, x = 0): Op => [x, 64, 0, id, 0, 0];

describe('isHandEdit', () => {
	const world = new Map<string, number>([['0,64,0', STONE], ['1,64,0', WATER]]);
	const at = (x: number, y: number, z: number) => world.get(`${x},${y},${z}`) ?? AIR;
	it('placing a solid block is a hand edit', () => expect(isHandEdit([op(STONE, 5)], at)).toBe(true));
	it('breaking a solid block (air over stone) is a hand edit', () => expect(isHandEdit([op(AIR, 0)], at)).toBe(true));
	it('water spreading is not', () => expect(isHandEdit([op(WATER, 5), op(WATER, 6)], at)).toBe(false));
	it('water receding (air over water) is not', () => expect(isHandEdit([op(AIR, 1)], at)).toBe(false));
	it('air over air (a drain echo) is not', () => expect(isHandEdit([op(AIR, 9)], at)).toBe(false));
	it('an explosion-sized edit is not', () => expect(isHandEdit(Array.from({ length: 10 }, (_, i) => op(AIR, i === 0 ? 0 : 100 + i)), at)).toBe(false));
	it('a 3×3 pickaxe break is', () => expect(isHandEdit(Array.from({ length: 9 }, () => op(AIR, 0)), at)).toBe(true));
});
```

Adapt `STONE`/`WATER` lookups to the real catalog (read `src/data/blocks.base.data.ts`: `liquid: 'none' | 'water' | 'lava'`; AIR is 0; confirm id 1 is a solid). Implementation:

```ts
import { BLOCKS, AIR } from '../data/blocks.data';
import type { Op } from '../net/protocol';

/** Largest edit still treated as one hand action (a 3×3 area break); bigger ones are explosions. */
export const HAND_EDIT_MAX_OPS = 9;

const solid = (id: number) => id !== AIR && id >= 0 && (BLOCKS[id]?.liquid ?? 'none') === 'none';

/**
 * Whether a friend's `edit` is a hand action (spec §7): it places a non-liquid block, or turns a
 * non-liquid block into air. Liquid flow and drains write liquids or air over liquid/air, so they
 * never swing an arm. Call BEFORE the edit is applied: `blockAt` must still see the old blocks.
 */
export function isHandEdit(ops: readonly Op[], blockAt: (x: number, y: number, z: number) => number): boolean {
	if (ops.length === 0 || ops.length > HAND_EDIT_MAX_OPS) return false;
	return ops.some(([x, y, z, id]) => solid(id) || (id === AIR && solid(blockAt(x, y, z))));
}
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Rewrite `remote-players.ts`** — keep the label code and `LABEL_*` constants unchanged; replace box parts:

```ts
import * as THREE from 'three';
import { PoseBuffer, type Pose } from '../../game/pose-buffer';
import { skinColor } from '../../data/skins.data';
import { SkinTextures } from './skin-textures';
import { RigResources, buildRig, setRigSkin, applyJoints, type Rig } from './player-rig';
import { newAnimState, step, joints, triggerSwing, type AnimState } from './player-anim';

/**
 * Remote player avatars (spec docs/superpowers/specs/2026-09-24-player-skins-design.md): one group
 * per player — a skinned Minecraft rig that turns with yaw, tilts its head with pitch, walks, idles
 * and swings — and a name label that shows through hills and never shrinks below LABEL_MIN_PX.
 * No collisions: render-only. Skin textures, geometry and materials are shared, never disposed here.
 */
```

- `BOX_H` stays 1.8 (label height); remove `BOX_W`, `FRONT_SHADE`, `colourBox`.
- `Avatar` = `{ id, name, skin, group, rig: Rig, anim: AnimState, label, labelW, buffer, pose }`.
- `RemotePlayersOptions` gains `textures?: SkinTextures`; constructor: `this.res = new RigResources(opts.textures ?? new SkinTextures())`.
- New avatar: `anim: newAnimState(Math.random() * 10)` (idle sway not in lockstep).
- `isHandEdit` doc comment adds: "The liquid scheduler also writes a few solids itself (wet sponge, obsidian from lava meeting water); those rare edits swing the simulating friend's arm once — accepted." 
- `upsert`: new → `const rig = buildRig(this.res, skin); group.add(rig.root)`; existing with changed skin → `setRigSkin(existing.rig, this.res, skin)`; label logic unchanged.
- `remove`: `this.scene.remove(a.group); this.disposeLabel(a.label);` — no geometry/material disposal.
- `const NO_MINERS: ReadonlySet<number> = new Set();` and

```ts
update(now: number, camera: THREE.Camera, miners: ReadonlySet<number> = NO_MINERS): void {
	for (const a of this.avatars.values()) {
		const p = a.buffer.sample(now);
		a.pose = p;
		if (!p) { a.group.visible = false; continue; }
		a.group.visible = true;
		a.group.position.set(p.x, p.y, p.z);
		a.group.rotation.set(0, p.yaw, 0);
		const inp = { now, x: p.x, z: p.z, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p.pitch)), mining: miners.has(a.id) };
		step(a.anim, inp);
		applyJoints(a.rig, joints(a.anim, inp));
		this.scaleLabel(a, camera);
	}
}

/** A friend placed or broke a block: one arm swing. */
swing(id: number, now: number): void {
	const a = this.avatars.get(id);
	if (a) triggerSwing(a.anim, now);
}
```

- [ ] **Step 4: Run remote-players tests — PASS.** Run `npx tsc -p tsconfig.json --noEmit`.

- [ ] **Step 5: Wire `main.ts`**
  - In the frame callback (≈ 905–922): move the `remoteMining.active(...)` loop and its `cracks.retain(keep)` **above** `remote.update(...)`, collecting `const miners = new Set<number>()` (`miners.add(a.by)` inside the loop). Then `remote.update(now, renderer.camera, miners); minimap.update(...)` in that order. Nothing else in the block moves.
  - In the `edit` route (≈ 873): **before** `sync.onEdit(m, you);` (the world must still hold the old blocks) add
    ```ts
    // A friend's place or break swings their arm (spec §7); water flow, drains and explosions don't.
    if (m.by !== you && isHandEdit(m.ops, loadedBlock)) remote.swing(m.by, performance.now());
    ```
    (`loadedBlock` is defined above in the same block: it returns −1 for unloaded cells, which `isHandEdit` treats as not solid.) Import `isHandEdit` from `./game/hand-edit`.
  - In the DEV `__mc` object (≈ 974) add `camera: renderer.camera,` (for the e2e skins scenario).

- [ ] **Step 6: Verify** — `npx vitest run` (whole suite; env-only failures listed in the spec baseline must be gone after setup), `npx tsc -p tsconfig.json --noEmit`, `npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add src/engine/render/remote-players.ts src/engine/render/remote-players.test.ts src/main.ts src/game/hand-edit.ts src/game/hand-edit.test.ts
git commit -m "feat(skins): remote players render as skinned, animated rigs"
```

---

### Task 6: Character picker

**Files:**
- Create: `src/ui/skin-preview.ts`, `src/ui/skin-preview.test.ts`
- Modify: `src/ui/menu.ts` (`renderMultiName` ≈ 484–540, `renderMultiWorlds` "Playing as" ≈ 558–570), `src/ui/ui.css` (`.skin-swatch`, `.mp-dot`)
- Modify: `scripts/menu-smoke.ts:150,156`

**Interfaces:**
- Consumes: Task 1 `SKINS`, `skinOf`; Task 3 `loadSkinPixels`.
- Produces: `frontPixels(skin: Uint8ClampedArray, slim: boolean): Uint8ClampedArray` (16×32 RGBA), `facePixels(skin: Uint8ClampedArray): Uint8ClampedArray` (8×8 RGBA), `paintPreview(canvas: HTMLCanvasElement, id: string, kind: 'front' | 'face'): void`.

- [ ] **Step 1: Write failing `skin-preview.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { frontPixels, facePixels } from './skin-preview';

/** Skin where every pixel encodes its own coordinates (r = x, g = y, b = 1, a = 255). */
function coords(): Uint8ClampedArray {
	const a = new Uint8ClampedArray(64 * 64 * 4);
	for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) a.set([x, y, 1, 255], (y * 64 + x) * 4);
	return a;
}
const at = (a: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(a.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

/** Clears alpha in every overlay area (hat, jacket/sleeve/pants rows, left sleeve and pants). */
function noOverlays(a: Uint8ClampedArray): Uint8ClampedArray {
	const clear = (x0: number, y0: number, x1: number, y1: number) => {
		for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[(y * 64 + x) * 4 + 3] = 0;
	};
	clear(32, 0, 64, 16); clear(0, 32, 64, 48); clear(0, 48, 16, 64); clear(48, 48, 64, 64);
	return a;
}

describe('skin previews', () => {
	it('front: head, body, arms (char right on viewer left), legs from the vanilla front rects', () => {
		const f = frontPixels(noOverlays(coords()), false);
		expect(at(f, 16, 4, 0)).toEqual([8, 8, 1, 255]); // head front TL
		expect(at(f, 16, 4, 8)).toEqual([20, 20, 1, 255]); // body front TL
		expect(at(f, 16, 0, 8)).toEqual([44, 20, 1, 255]); // right arm front TL, viewer's left
		expect(at(f, 16, 12, 8)).toEqual([36, 52, 1, 255]); // left arm front TL
		expect(at(f, 16, 4, 20)).toEqual([4, 20, 1, 255]); // right leg front TL
		expect(at(f, 16, 8, 20)).toEqual([20, 52, 1, 255]); // left leg front TL
	});

	it('slim arms are 3 px: the outer column is empty', () => {
		const f = frontPixels(noOverlays(coords()), true);
		expect(at(f, 16, 0, 10)[3]).toBe(0);
		expect(at(f, 16, 1, 10)).toEqual([44, 22, 1, 255]);
		expect(at(f, 16, 15, 10)[3]).toBe(0);
	});

	it('an opaque hat pixel covers the face; a transparent one does not', () => {
		const skin = coords();
		skin.set([250, 0, 0, 255], (8 * 64 + 40) * 4); // hat front TL opaque
		skin.set([250, 0, 0, 0], (8 * 64 + 41) * 4); // next one transparent
		const face = facePixels(skin);
		expect(at(face, 8, 0, 0)).toEqual([250, 0, 0, 255]);
		expect(at(face, 8, 1, 0)).toEqual([9, 8, 1, 255]);
	});
});
```

Also add a table-driven overlay test (every overlay blit, top-left AND bottom-right):

```ts
it('every overlay front covers its part, corner to corner', () => {
	// [overlay front rect x, y, w, h] → [preview x, y] (classic arms)
	const cases: Array<[string, number, number, number, number, number, number]> = [
		['hat', 40, 8, 8, 8, 4, 0], ['jacket', 20, 36, 8, 12, 4, 8],
		['rightSleeve', 44, 36, 4, 12, 0, 8], ['leftSleeve', 52, 52, 4, 12, 12, 8],
		['rightPants', 4, 36, 4, 12, 4, 20], ['leftPants', 4, 52, 4, 12, 8, 20],
	];
	for (const [name, x, y, w, h, dx, dy] of cases) {
		const skin = noOverlays(coords());
		skin.set([250, 1, 2, 255], (y * 64 + x) * 4); // TL marker
		skin.set([250, 3, 4, 255], ((y + h - 1) * 64 + x + w - 1) * 4); // BR marker
		const f = frontPixels(skin, false);
		expect(at(f, 16, dx, dy), `${name} TL`).toEqual([250, 1, 2, 255]);
		expect(at(f, 16, dx + w - 1, dy + h - 1), `${name} BR`).toEqual([250, 3, 4, 255]);
	}
});
```

and in the first test, also check each base part's bottom-right pixel (e.g. body BR `at(f, 16, 11, 19)` = `[27, 31, 1, 255]`).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `skin-preview.ts`**

```ts
import { skinOf } from '../data/skins.data';
import { loadSkinPixels } from '../engine/render/skin-textures';

type Blit = { sx: number; sy: number; w: number; h: number; dx: number; dy: number };

function compose(skin: Uint8ClampedArray, w: number, h: number, blits: Blit[]): Uint8ClampedArray {
	const out = new Uint8ClampedArray(w * h * 4);
	for (const b of blits) {
		for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
			const s = ((b.sy + y) * 64 + b.sx + x) * 4;
			if (skin[s + 3] < 128) continue;
			out.set(skin.subarray(s, s + 4), ((b.dy + y) * w + b.dx + x) * 4);
		}
	}
	return out;
}

/** The character's front, 16×32: base then overlay for each part. Char's right is on the viewer's left. */
export function frontPixels(skin: Uint8ClampedArray, slim: boolean): Uint8ClampedArray {
	const aw = slim ? 3 : 4;
	return compose(skin, 16, 32, [
		{ sx: 8, sy: 8, w: 8, h: 8, dx: 4, dy: 0 }, { sx: 40, sy: 8, w: 8, h: 8, dx: 4, dy: 0 },
		{ sx: 20, sy: 20, w: 8, h: 12, dx: 4, dy: 8 }, { sx: 20, sy: 36, w: 8, h: 12, dx: 4, dy: 8 },
		{ sx: 44, sy: 20, w: aw, h: 12, dx: 4 - aw, dy: 8 }, { sx: 44, sy: 36, w: aw, h: 12, dx: 4 - aw, dy: 8 },
		{ sx: 36, sy: 52, w: aw, h: 12, dx: 12, dy: 8 }, { sx: 52, sy: 52, w: aw, h: 12, dx: 12, dy: 8 },
		{ sx: 4, sy: 20, w: 4, h: 12, dx: 4, dy: 20 }, { sx: 4, sy: 36, w: 4, h: 12, dx: 4, dy: 20 },
		{ sx: 20, sy: 52, w: 4, h: 12, dx: 8, dy: 20 }, { sx: 4, sy: 52, w: 4, h: 12, dx: 8, dy: 20 },
	]);
}

/** The face with its hat, 8×8. */
export function facePixels(skin: Uint8ClampedArray): Uint8ClampedArray {
	return compose(skin, 8, 8, [{ sx: 8, sy: 8, w: 8, h: 8, dx: 0, dy: 0 }, { sx: 40, sy: 8, w: 8, h: 8, dx: 0, dy: 0 }]);
}

/** Draws a preview into `canvas` once the skin decodes (CSS scales it with image-rendering: pixelated). */
export function paintPreview(canvas: HTMLCanvasElement, id: string, kind: 'front' | 'face'): void {
	const row = skinOf(id);
	const [w, h] = kind === 'front' ? [16, 32] : [8, 8];
	canvas.width = w;
	canvas.height = h;
	loadSkinPixels(row.id).then((px) => {
		const data = kind === 'front' ? frontPixels(px, row.slim) : facePixels(px);
		canvas.getContext('2d')?.putImageData(new ImageData(data, w, h), 0, 0);
	}, (e) => console.warn(`skin preview ${id} failed`, e));
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Menu.** In `renderMultiName`: section text `'Pick your character'`; for each `s` of `SKINS` build

```ts
const b = document.createElement('button');
b.className = 'skin-swatch';
b.id = `mp-skin-${s.id}`;
b.dataset.skin = s.id;
b.setAttribute('aria-label', s.name);
const c = document.createElement('canvas');
c.className = 'skin-front';
paintPreview(c, s.id, 'front');
const n = document.createElement('span');
n.className = 'skin-name';
n.textContent = s.name;
b.append(c, n);
b.onclick = () => { skin = s.id; paint(); };
```

(no `style.background`). Update the doc comment ("the 6 character buttons"). In `renderMultiWorlds`, replace the `.mp-dot` span with a small full-body preview (Chip's and JJ's faces alone look alike at this size): `const dot = document.createElement('canvas'); dot.className = 'mp-mini'; paintPreview(dot, skin, 'front');` and the text becomes `` `Playing as ${name} (${skinOf(skin).name})` ``. (`facePixels`/`'face'` stay available but unused by the menu; drop them if lint flags unused exports — it does not by default.) The world-list online dots (≈ 652) stay `skinColor`.

CSS in `ui.css`: `.menu-card button` (≈ line 121: `display:block; width:100%; margin; padding; background`) is more specific than `.skin-swatch`, so every rule must carry the `.menu-card` prefix and override those properties. Replace the `.skin-swatches` rule (≈ 873) and the `.menu-card .skin-swatch*` rules (≈ 879–892), and the `.mp-dot` rule (≈ 908) usage:

```css
.skin-swatches {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 10px;
	margin: 8px 0 16px;
}
.menu-card .skin-swatch {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	width: auto;
	height: auto;
	margin: 0;
	padding: 8px 4px;
	background: #3a3a3a;
	border: 3px solid transparent;
	border-radius: 8px;
}
.menu-card .skin-swatch:hover {
	background: #4a4a4a;
	border-color: rgba(255, 255, 255, 0.5);
}
.menu-card .skin-swatch.selected {
	background: #555;
	border-color: #fff;
	box-shadow: 0 0 0 2px #6fbf6f;
}
.skin-front {
	width: 48px;
	height: 96px;
	image-rendering: pixelated;
}
.skin-name {
	font-size: 13px;
	line-height: 1.2;
	text-align: center;
	overflow-wrap: anywhere;
}
.mp-mini {
	flex: none;
	width: 20px;
	height: 40px;
	image-rendering: pixelated;
}
```

Keep `.mp-dot` if the world-list online dots use it (they do: ≈ menu.ts 652) — only the "Playing as" line changes.

- [ ] **Step 6: `scripts/menu-smoke.ts`** — line 150: `count() === 6` and the message "screen 1 has the 6 character buttons"; line 156: `#mp-skin-jj`; line ≈275 autojoin `'blue'` → `'jj'`; any later assertion expecting `blue` in saved prefs → `jj`; a "Playing as" assertion, if any, → `.mp-mini` and the `(JJ)` text. Add: after screen 1 renders, wait until every `#mp-skins canvas` has non-zero pixels (`page.waitForFunction` reading `getImageData` of each canvas: some alpha > 0), assert it, then set the card's width in `page.evaluate` (`document.querySelector('.menu-card').style.width = '360px'`, then `'480px'`) and take an **element** screenshot of the card each time (a 360 px viewport would overflow; the card sizes to content between its min and max), saved to `$MENU_SMOKE_SCRATCH` (default: this session's scratchpad). Run: `npx tsx scripts/menu-smoke.ts --port 5176` (5173 is someone else's dev server; check the port is free with `ss -ltnp`; headless only). **Open both screenshots with the Read tool** and report: 3×2 grid, names under pictures, "Crazy Fan Girl" wraps inside its button, selected button visibly different.

- [ ] **Step 7: Verify** `npx vitest run src/ui`, `npx tsc -p tsconfig.json --noEmit`, `npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add src/ui/skin-preview.ts src/ui/skin-preview.test.ts src/ui/menu.ts src/ui/ui.css scripts/menu-smoke.ts
git commit -m "feat(skins): character picker with full-body previews"
```

---

### Task 7: End-to-end skins scenario, id sweep, docs

**Files:**
- Modify: `scripts/mp-e2e.ts` (ids at 381/382/765/812, `hexRgb('#E53935')` ≈ 555, new scenario `E10`)
- Modify: `scripts/perf-bench.ts:484-486` (ids → `'milo'`, `'jj'`, `'mikey'`)
- Modify: `server/internal/proto/validate.go` comment (≈ 54: example ids → `"milo"`, `"jj"`)
- Modify: `docs/multiplayer.md` (≈ 225 avatar paragraph; `skin` field notes at 77), `docs/skins-research.md` (assets now in `src/assets/skins/`; spec link)

**Interfaces:**
- Consumes: DEV `__mc.camera`, `__mc.mp.remote` (the `RemotePlayers`), `__mc.player`; Task 1 `skinColor`, `skinOf`.

- [ ] **Step 1: Id sweep** — `A_WHO` `{ name: 'Ana', skin: 'milo' }`, `B_WHO` `{ name: 'Bo', skin: 'jj' }`, `'green'` → `'mikey'`; replace `hexRgb('#E53935')` with `hexRgb(skinColor(A_WHO.skin))` (import `skinColor` from `../src/data/skins.data`). Update the file header comment (E10 listed).

- [ ] **Step 2: Add scenario E10.** Add `'E10'` to the hard-coded `needMp` list (≈ line 409) or `--only E10` never joins A and B. Place the block **textually after E9 and before E4** (later scenarios E6/E5 kill the server / end A's timer). Same `if (want('E10') && A && B)` / `scenario(...)` / `check(...)` pattern; read E9 (≈ 468) first and reuse its helpers for flying, positioning, aiming and mining. B is `B_WHO` = JJ (classic), A is `A_WHO` = Milo (slim).

Helpers to write inside the scenario (page-side code via `evaluate`):
- `place(page, x, y, z, yaw)`: set `__mc.player` flying (as E9 does), `__mc.player.position` = (x, y, z), `__mc.cam.yaw = yaw`, `__mc.cam.pitch = 0`; wait ≥ 600 ms so the other client's PoseBuffer (200 ms behind) has settled.
- `facePixel(viewer, id, mesh, face)`: on the viewer page, find `remote-player-<id>`, the named base mesh (`'head'`, `'body'`, `'rightArm'`, …), compute the world point at that face's centre pushed 0.001 outward (use the mesh's geometry bounding box and the face normal: front = local −z, back = +z), project with `__mc.camera` (`.project(camera)`), convert NDC → CSS px using the canvas `getBoundingClientRect()` (x = left + (ndc.x+1)/2·width, y = top + (1−ndc.y)/2·height). Return CSS px. Then `page.screenshot()` (PNG, CSS-px scale by default at deviceScaleFactor 1 — assert `devicePixelRatio === 1` on the page, or multiply) and decode with `sharp(...).raw()` to read the pixel.
- `skinPixel(file, face rect)`: decode `src/assets/skins/<file>` with sharp (upgrade 64×32 with `upgradeLegacySkin`), take the rect's centre pixel `(x + floor(w/2), y + floor(h/2))`; if the matching overlay pixel has alpha ≥ 128, use the overlay's instead.

Checks, in order:
1. **Measure first:** put B 3 blocks in front of A, facing A (A at (x, y, z) yaw 0 looks toward −z, so B at (x, y, z − 3) with yaw π). Compare A's view of B's head-front, body-front and right-arm-front centres with JJ's skin (front rects head (8,8,8,8), body (20,20,8,12), right arm (44,20,4,12)). Print the measured per-channel differences. `check(maxDiff ≤ 40, …)`. If a correct-looking screenshot still differs by more than 40, print the numbers and stop to report rather than widening the tolerance silently.
2. **Slim model, seen by B:** the same from B's page looking at A (Milo): head front and right-arm front (slim rect (44,20,3,12)).
3. **Back view:** turn B to yaw 0 (back toward A). On A: B's head-back centre (rect (24,8,8,8)) and body-back centre (rect (32,20,8,12)) match JJ within the tolerance.
4. **Enderman (legacy upgrade):** in a **fresh browser context** (sharing ctxA/ctxB would share localStorage and C would take over A): `const ctxC = await browser.newContext({ viewport: { width: 960, height: 600 } })`, `const c = await newPage(ctxC, { name: 'Cy', skin: 'enderman' }, 'C')`, `await joinWorld(c, BASE, WORLD, null)` (as the 4009 scenario does), `await ctxC.close()` at the end; place C facing A at 3 blocks. On A: C's head-front centre matches the Enderman's; C's `leftLeg` front centre matches the upgraded skin's left-leg front (rect (20,52,4,12)) — proves the upgrade reaches the GPU. Close C afterwards.
5. **Walk:** B faces A again; move B's `__mc.player.position` along −x by 0.07 per animation frame for 1.5 s (page-side loop with `requestAnimationFrame`). On A, sample `remote-player-<B>` → `rightLegPivot.rotation.x` every 50 ms: `check` both signs seen with |value| > 0.2.
6. **Swing, with a negative control:** B stands still ≥ 1.5 s (walk decays). On A: sample `rightArmPivot.rotation.x` for 500 ms → `check` max − min < 0.1 (no swing without mining). Then B starts mining a block **beside or below B** (not in front — a block between B and A would hide B in the screenshot), otherwise as E9 does. On A, within 500 ms: `check` some sample exceeds the idle mean by > 0.3 (positive: three's `rotation.x = −rArmX`, a forward chop is positive). Stop mining.
7. **Screenshots** to `SCRATCH`: `e10-front.png` (A sees JJ), `e10-milo.png` (B sees Milo), `e10-back.png`, `e10-enderman.png`, `e10-walk.png`, `e10-swing.png`, and A's minimap region `e10-minimap.png`. Print their paths.

The page guard that blocks non-localhost requests stays exactly as it is.

- [ ] **Step 3: Run the suite** — `MP_E2E_SCRATCH=/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad npx tsx scripts/mp-e2e.ts` (all scenarios; ports 18080/5174/5175 must be free — check with `ss -ltnp`; never kill a server you did not start). Expect all PASS. Also run once with `--only E10` to confirm it stands alone. Open every E10 screenshot with the Read tool and describe them in the report (each character recognisable, arms/legs attached, head on shoulders, not upside down, not mirrored — JJ's white shirt faces A in the front view, his hood in the back view; Milo's arms visibly thinner; the Enderman has both legs; minimap dots Milo-cyan and JJ-red).

- [ ] **Step 4: Docs** — `docs/multiplayer.md` ≈ 225: "Other players are Minecraft-style skinned rigs (six characters, `src/data/skins.data.ts`): the body turns with yaw, the head tilts with pitch, the legs walk, the right arm swings while mining or after a place/break. Old colour ids render as Milo." and the `skin` field row: "a character id (`milo`, `jj`, …); unknown ids fall back to Milo on the client". `docs/skins-research.md`: note the chosen PNGs now live in `src/assets/skins/` and link the spec. `validate.go` comment.

- [ ] **Step 5: Final verification** — `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`, `npm run lint`, `cd server && ~/.local/go/bin/go test ./...` (comment-only change, must stay green), `npm run build` (vite build succeeds; `dist/` not committed).

- [ ] **Step 6: Commit**

```bash
git add scripts/mp-e2e.ts scripts/perf-bench.ts server/internal/proto/validate.go docs/multiplayer.md docs/skins-research.md
git commit -m "test(skins): E10 rendered skins scenario; ids, docs"
```

Also commit the spec, plan and research record once (first task that commits may include them): `docs/superpowers/specs/2026-09-24-player-skins-design.md`, `docs/superpowers/plans/2026-09-24-player-skins.md`, `docs/skins-research.md`, `docs/skins/`.
