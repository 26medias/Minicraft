# Player skins and rig — design (2026-09-24, rev 2 after gate 1)

Branch `skins`, cut from `multiplayer`. Research: `docs/skins-research.md`.
Gate 1 (rigour, engine, boundaries, kid) findings are folded in; see §12.

## 1. Goal

Replace the remote-player coloured box (`src/engine/render/remote-players.ts`) with a
Minecraft-style player: six boxes (head, body, two arms, two legs) textured from a real Minecraft
skin, with the overlay layer, simple animations (walk, idle, arm swing), and an animation structure
where adding an animation later is adding one function.

The picker offers **six characters**: Milo, Chip, Crazy Fan Girl, JJ, Mikey, Enderman. The 8 colour
swatches go away.

Non-goals: third-person view of yourself, world lighting on avatars (they stay unlit
`MeshBasicMaterial`), held items, capes, uploaded skins, body-yaw lag, body twist during the swing,
sneaking, "character already taken" logic, **any server or protocol change**.

## 2. Decisions (Julien)

- Skin PNGs **are committed** in `src/assets/skins/` (repo is public; chosen knowingly).
- Roster = the six characters. Old saved colour ids (`red`, `blue`, …), `""` and any unknown id
  resolve to the **default skin, Milo** (first row). Two players may pick the same character.
- **Looking left/right rotates the whole body. Looking up/down tilts only the head.**
- Label text: "Crazy Fan Girl" (Noah's words), id `crazy-fan-girl`.

## 3. Skin catalog (pure data)

`src/data/skins.data.ts` rows, in picker order (Milo first = default):

```ts
{ id: 'milo',           name: 'Milo',           file: 'milo.png',           slim: true,  color: '#29C5E6' },
{ id: 'chip',           name: 'Chip',           file: 'chip.png',           slim: true,  color: '#FF8A1F' },
{ id: 'crazy-fan-girl', name: 'Crazy Fan Girl', file: 'crazy-fan-girl.png', slim: false, color: '#FF3FA4' },
{ id: 'jj',             name: 'JJ',             file: 'jj.png',             slim: false, color: '#D8261C' },
{ id: 'mikey',          name: 'Mikey',          file: 'mikey.png',          slim: false, color: '#7ED321' },
{ id: 'enderman',       name: 'Enderman',       file: 'enderman.png',       slim: false, color: '#CC00FA' },
```

- `color` is **hand-picked** (never computed from pixels): it drives the minimap dot, name-label
  border, leave toast and menu online dots, so it must be bright and distinct (no black, no white).
  The implementer may nudge the hex values but must keep the §8.5 distance test green.
- `slim` = 3-px arms. Data, never detected.
- `skinOf(id)` returns the row (unknown → `SKINS[0]`); `skinColor(id)` keeps its contract.
- This file stays pure: no `import.meta.glob`, no three.

`src/engine/render/skin-urls.ts` (no three import, so `menu.ts` can use it too):
`import.meta.glob('../../assets/skins/*.png', { eager: true, query: '?url', import: 'default' })`
→ `skinUrl(id): string` via the row's `file`. (Vite inlines these ≤ 2 KB files as data URIs; fine.)

`mp-prefs.ts isSkin` already turns a saved `'red'` into `null` → default; `boot.ts` autojoin already
falls back to `SKINS[0]`. Both unchanged.

## 4. Skin images and textures

- `src/assets/skins/{milo,chip,crazy-fan-girl,jj,mikey,enderman}.png`, copied from `docs/skins/`.
  `docs/skins/` stays as the research record (alternates are referenced by the research doc).
- The Enderman is **legacy 64×32** and is committed as-is. It is upgraded to 64×64 **at load time**
  by a pure function `upgradeLegacySkin(src: Uint8ClampedArray /*64×32 RGBA*/): Uint8ClampedArray
  /*64×64 RGBA*/` in `src/engine/render/skin-legacy.ts`, the vanilla algorithm:
  1. copy rows 0–31, rows 32–63 transparent;
  2. mirrored copies (each rect flipped horizontally), source → destination; tops/bottoms 4×4,
     sides 4×12:

     | | Leg | Arm |
     |---|---|---|
     | top | (4,16)→(20,48) | (44,16)→(36,48) |
     | bottom | (8,16)→(24,48) | (48,16)→(40,48) |
     | right side | (0,20)→(24,52) | (40,20)→(40,52) |
     | front | (4,20)→(20,52) | (44,20)→(36,52) |
     | left side | (8,20)→(16,52) | (48,20)→(32,52) |
     | back | (12,20)→(28,52) | (52,20)→(44,52) |
  3. force alpha 255 on (0,0)–(32,16), (0,16)–(64,32), (16,48)–(48,64).
  The Notch hat-transparency hack is not implemented (Enderman hat has 0 opaque pixels; asserted in
  a test).
- `src/engine/render/skin-textures.ts`: `SkinTextures` class, one texture per skin id, created on
  first use, **shared** by all avatars. Browser path: load the image (via an injectable
  `load(url) → Promise<ImageData-like {width,height,data}>`, default uses `Image` + canvas
  `getImageData`), upgrade if 64×32, then build a `THREE.DataTexture(data, 64, 64)` with
  `flipY = SKIN_FLIP_Y`, `NearestFilter` min/mag, no mipmaps, `SRGBColorSpace`, `needsUpdate`.
  Until the image arrives, the texture exists (empty, then filled), so meshes can be built
  synchronously. Tests inject `load`.
- `export const SKIN_FLIP_Y` lives in `skin-uv.ts`, is used by the UV code, set by the loader, and
  read back by tests from `material.map.flipY` (§8.2). Since we build a `DataTexture` from top-down
  rows, `SKIN_FLIP_Y = false` is the expected value; the UV math must agree with it.
- Base layers are opaque in all six skins; base material is opaque (`alphaTest` off).

## 5. Rig geometry

Units: 1 skin px = `PX = 1.8 / 32` world units (model exactly 1.8 tall, like the current box).
Coordinates below in px, origin at the feet, y up, **character faces −z, character's right = +x**
(forward × up = (0,0,−1)×(0,1,0) = +x; matches `FpCamera.getRight = (cos yaw, 0, −sin yaw)`).

| Part | Size w×h×d | Pivot | Box centre rel. to pivot | Base UV | Overlay UV | Overlay inflate |
|---|---|---|---|---|---|---|
| Head | 8×8×8 | (0, 24, 0) | (0, +4, 0) | (0,0) | (32,0) | 0.5 |
| Body | 8×12×4 | (0, 24, 0) | (0, −6, 0) | (16,16) | (16,32) | 0.25 |
| Right arm, classic | 4×12×4 | (+5, 22, 0) | (+1, −4, 0) | (40,16) | (40,32) | 0.25 |
| Left arm, classic | 4×12×4 | (−5, 22, 0) | (−1, −4, 0) | (32,48) | (48,48) | 0.25 |
| Right arm, slim | 3×12×4 | (+5, 21.5, 0) | (+0.5, −4, 0) | (40,16) | (40,32) | 0.25 |
| Left arm, slim | 3×12×4 | (−5, 21.5, 0) | (−0.5, −4, 0) | (32,48) | (48,48) | 0.25 |
| Right leg | 4×12×4 | (+1.9, 12, 0) | (0, −6, 0) | (0,16) | (0,32) | 0.25 |
| Left leg | 4×12×4 | (−1.9, 12, 0) | (0, −6, 0) | (16,48) | (0,48) | 0.25 |

**Face rects** — `faceRects(u, v, w, h, d)` (argument order fixed: origin first, then size), skin px,
y downward:

| Face | Rect (x, y, width, height) | BoxGeometry group |
|---|---|---|
| right side (char's right, +x) | (u, v+d, d, h) | 0 (+x) |
| left side (−x) | (u+d+w, v+d, d, h) | 1 (−x) |
| top (+y) | (u+d, v, w, d) | 2 (+y) |
| bottom (−y) | (u+d+w, v, w, d) | 3 (−y) |
| back (+z) | (u+2d+w, v+d, w, h) | 4 (+z) |
| front (−z) | (u+d, v+d, w, h) | 5 (−z) |

**Vertex → rect corner** (BoxGeometry face f uses vertices 4f..4f+3; TL=(x,y), TR=(x+w,y),
BL=(x,y+h), BR=(x+w,y+h)):

| Faces | v0 | v1 | v2 | v3 |
|---|---|---|---|---|
| four sides (+x, −x, +z, −z) | TL | TR | BL | BR |
| top (+y) | BR | BL | TR | TL |
| bottom (−y) | TR | TL | BR | BL |

Meaning, for top and bottom (vanilla): the rect's **left column is at the character's right (+x)**
and its **last row is at the front (−z)**. For the sides, v0 is the top-left seen from outside.
Pixel → uv: `u = px/64`, `v = SKIN_FLIP_Y ? 1 − py/64 : py/64`. No UV inset.

`boxUVs(rects)` writes the `uv` attribute of a `BoxGeometry(w·PX, h·PX, d·PX)`.

**Meshes and names:** each part is a pivot `Object3D` named `head|body|rightArm|leftArm|rightLeg|
leftLeg` holding two meshes named `<part>` (base) and `<part>Overlay`. Overlay material:
`alphaTest: 0.5`, `transparent: false`, `side: DoubleSide` (vanilla draws overlays without culling).
Base material: opaque, `FrontSide`.

**Shared resources:** geometries are built once per (part, arm model, layer) — at most 16 — and
materials once per (skin, layer) — 12. They are cached module-wide and **never disposed by an
avatar**. `remove()` disposes only the avatar's label (and its own Object3Ds). Changing an avatar's
skin swaps materials; if `slim` differs, the two arm pivots' meshes are swapped to the other
geometry (a rebuild of the arms, not only a re-texture).

## 6. Hierarchy and posing

```
group (position = feet, rotation.y = yaw)        ← whole body turns with yaw
 ├─ head pivot (x-rotation from pitch)           ← only the head tilts
 ├─ body pivot
 ├─ rightArm / leftArm / rightLeg / leftLeg pivots (rotations from animation)
 └─ label sprite (unchanged)
```

Pitch: pose `pitch > 0` = looking up (`FpCamera`: `getLookDir().y = sin(pitch)`,
`Euler(pitch, yaw, 0, 'YXZ')`). The head's local front is −z. Requirement: the head front direction
(local (0,0,−1) transformed by the head's world quaternion) equals `FpCamera.getLookDir()` for the
same yaw/pitch. Pitch clamped to ±π/2.

## 7. Animation

`src/engine/render/player-anim.ts` — pure, no three:

```ts
export type AnimState = { walkPhase: number; walkAmount: number; swingAt: number | null; lastX: number | null; lastZ: number | null; lastT: number | null };
export type AnimInput = { now: number /* ms */; x: number; z: number; pitch: number; mining: boolean };
export type Joints = { headX: number; rArmX: number; rArmZ: number; lArmX: number; lArmZ: number; rLegX: number; lLegX: number };
export type AnimLayer = (s: AnimState, inp: AnimInput, j: Joints) => void;   // adds into j
export const LAYERS: Layer[] = [idle, walk, swing];
export function step(s: AnimState, inp: AnimInput): void;   // advances state from the new pose
export function triggerSwing(s: AnimState, now: number): void;
export function joints(s: AnimState, inp: AnimInput): Joints;   // zero, then every layer
```

**Joints are in vanilla convention** (y-down model space: positive xRot swings a limb *back*).
The rig applies each: `pivot.rotation.order = 'ZYX'; pivot.rotation.set(-xRot, -yRot, +zRot)`.
Head: `headX = -pitch` in vanilla terms (vanilla pitch is positive looking down), applied through the
same conversion, so looking up tilts the face up (§8.6).

- **step**: `dt = (now − lastT)/1000`. If `lastT === null` or `dt <= 0`, record position/time and
  return (no division; joints stay finite). Horizontal distance `dist`; if `dist > 1` block
  (teleport/respawn/first pose), record and return without touching the walk. Otherwise
  `v = dist/dt`, `target = min(1, 0.2·v)`, `walkAmount += (target − walkAmount)·(1 − 0.6^(20·dt))`,
  `walkPhase += 20·walkAmount·dt`. Vertical motion never drives the walk (only x/z are used).
- **walk** (vanilla): `rArmX += cos(ph·0.6662 + π)·a`, `lArmX += cos(ph·0.6662)·a`,
  `rLegX += cos(ph·0.6662)·1.4·a`, `lLegX += cos(ph·0.6662 + π)·1.4·a` (ph = walkPhase,
  a = walkAmount).
- **idle** (vanilla, t in s): `rArmZ += cos(1.8t)·0.05 + 0.05`, `lArmZ −= cos(1.8t)·0.05 + 0.05`,
  `rArmX += sin(1.34t)·0.05`, `lArmX −= sin(1.34t)·0.05`.
- **swing** (vanilla attack): `SWING_MS = 300`, `p = (now − swingAt)/SWING_MS`; when `p ≥ 1`,
  `swingAt = null`. For `0 ≤ p < 1`: `f1 = sin(π·(1 − (1−p)^4))`,
  `rArmX −= f1·1.2 + sin(p·π)·(0.7 − headXv)·0.75` (headXv = vanilla head pitch = −pitch),
  `rArmZ += −0.4·sin(p·π)`.
  **Mining:** while `mining`, `step` restarts the swing every `MINING_SWING_EVERY_MS = 200`
  (vanilla's quick half-chops). When mining stops, the running swing finishes to p = 1.
  **Place/break by a friend:** an incoming `edit` with `by ≠ you` that is a *hand edit* calls
  `triggerSwing` once for that avatar. A hand edit (`src/game/hand-edit.ts`, checked **before** the
  edit is applied) has 1–9 ops and at least one op that writes a non-liquid block or writes air over a
  non-liquid block. Water/lava flow and drains (liquid or air over liquid/air) never swing; edits of
  more than 9 ops (explosions) never swing.

`RemotePlayers` API: `update(now, camera, miners: ReadonlySet<number> = EMPTY)` (optional, existing
call sites unchanged) and `swing(id, now)`. `main.ts`: the `remoteMining.active(...)` loop moves
**before** `remote.update`, together with its `cracks.retain(keep)`; it builds the `miners` set;
`minimap.update` stays after `remote.update`. The `edit` handler calls `remote.swing(m.by, now)`
for small edits by others.

Adding an animation later = one `Layer` appended to `LAYERS` + whatever sets its state.

## 8. Tests — each must be able to go red

Every test module runs in vitest's `node` environment; nothing needs a DOM (inject `load`).

1. **faceRects** exact values for head `(0,0,8,8,8)`, classic right arm `(40,16,4,12,4)`, slim right
   arm `(40,16,3,12,4)`.
2. **Orientation, through the real geometry** (`player-rig.test.ts`): a generated debug skin as a
   plain RGBA/label array: each face rect of every part and both layers filled with a unique label,
   and **two asymmetric markers per face**: the pixel at the rect's image top-left and at its image
   top-right (for top/bottom faces, "image" corners of the rect as defined in §5). Build the rig
   with an injected texture holding that array. For each part, each face, base and overlay
   **separately** (`intersectObject(<named mesh>)`), both arm models: raycast from outside toward
   the face centre → sample label at `hit.uv` using `material.map.flipY` (never a hard-coded flip)
   → must be that face. Raycast near the two corners that §5 says map to TL and TR → must hit the
   TL and TR markers. The implementer shows, once, in the task report, that each of these wrong
   builds fails: sides swapped, front mirrored, front flipped vertically, head front transposed,
   top face left at BoxGeometry default, loader flipY ≠ `SKIN_FLIP_Y`.
3. **Character's right**: a camera at (0, 1.6, −3) looking at the character at the origin (yaw 0)
   raycasts through the screen's left half at arm height → hits `rightArm`.
4. **Loader**: `SkinTextures` with an injected `load` returns textures whose `flipY === SKIN_FLIP_Y`,
   `magFilter === NearestFilter`, and the same object for the same id (shared).
5. **Legacy upgrade** (pure): synthetic 64×32 where every source face has an **asymmetric** pattern
   (left column ≠ right column): at each destination rect the columns are reversed relative to the
   source; rows 32–63 outside the copied rects are transparent; forced-opaque regions have alpha 255.
   Plus the real file: decode `src/assets/skins/enderman.png` with `sharp` (existing devDependency),
   assert 64×32, hat region 0 opaque pixels, and `upgradeLegacySkin` output has the left-leg front
   equal to the mirrored right-leg front.
6. **Catalog**: every row's file exists and its PNG header says 64×64 (or 64×32 for the Enderman);
   ids unique, ≤ 32 bytes; `SKINS[0].id === 'milo'`; `skinOf('red') === SKINS[0]`;
   `skinOf('') === SKINS[0]`; every pair of colours has Euclidean RGB distance ≥ 80, and every colour
   has HSL lightness in [0.3, 0.75] (no black, no white).
7. **Pose**: for yaw/pitch pairs {(0,0), (0.7,0.5), (−2,−0.8), (3,1.2)}: the head front vector
   (local (0,0,−1) by the head's world quaternion) is within 1e-6 of `FpCamera.getLookDir()` for the
   same yaw/pitch; the body pivot's world quaternion ignores pitch (its front has y = 0).
8. **Animation** (pure + rig):
   - swing at p = 0.16: the right hand (world position of the arm's bottom-centre) is further along
     the character's front (−z at yaw 0) than the shoulder — the arm chops **forward**;
   - walking at 4.3 blocks/s for 2 s: `rLegX` changes sign between two samples half a stride apart;
     `rLegX` and `lLegX` have opposite signs; `rArmX` has the opposite sign of `rLegX`;
   - standing still 1 s after walking: `walkAmount < 0.01`;
   - pure vertical motion (falling 10 blocks/s): `walkAmount` stays < 0.01;
   - first frame, and two steps at the same `now`: all joints finite;
   - a 20-block jump between two poses: `walkAmount` unchanged;
   - mining true for 1 s: at least 4 swing starts; mining false mid-swing: the swing runs to p = 1,
     then joints return to idle+walk only.
9. **RemotePlayers**: `upsert(1, 'x', 'red')` → the head material's `map` is **the same object** as
   `SkinTextures.get('milo')`; `positions()` reports the raw id (`'red'`, what the server sent) —
   the minimap then colours it via `skinColor` fallback. Re-skin Milo → JJ: arm geometry width
   becomes 4 px; JJ → Milo back to 3 px. Two avatars on the same skin, remove one: the other's
   materials/texture are not disposed. `update` without `miners` still works.
10. **Existing suites**: `npm test`, `npx tsc -p tsconfig.json --noEmit`, `npm run lint`,
    `scripts/menu-smoke.ts`, `scripts/mp-e2e.ts` — updated to character ids (see §10).
    Setup first: `npm i`, `npm run build-atlas` (baseline has env-only failures otherwise).
11. **Rendered check, an instrument** (new `--only skins` scenario in `scripts/mp-e2e.ts`, which
    already runs headless Chromium, its own Vite on :5174 and a local `mcserver` on a temp DB, and
    blocks non-localhost requests; set `MP_E2E_SCRATCH` to this session's scratchpad):
    client A = Milo (slim), client B = JJ (classic). Put B facing A at 3 blocks. On A's canvas,
    project world points of B's head front centre, body front centre and right-arm front centre to
    screen pixels, read those pixels (`readPixels`/screenshot), and compare with the JJ skin pixel at
    that face's centre (tolerance ΔRGB ≤ 40, unlit). Also: B walks (move `__mc.player.position` over
    frames) → A sees B's `rightLeg` pivot rotation change sign; B mines (send `fx mine`) → A sees
    `rightArm` rotation depart from idle. Save screenshots (standing, walking, mining, and A's
    minimap with both dots) to the scratchpad; the implementer views them and reports.

## 9. UI

- Multiplayer screen 1: heading "Pick your character". Six buttons (`#mp-skin-<id>`, `.skin-swatch`,
  `.selected`), each showing the character's **full front** (head+hat, body+jacket, arms+sleeves,
  legs+pants, composed like `docs/skins/front-sheet.png`) drawn nearest-neighbour to a canvas about
  48×96 CSS px, with the name below. Slim arms drawn 3 px wide.
- Screen 2's "Playing as ● Noah": the dot becomes the character's 8×8 face (+hat) at ~24 px.
- World list online dots stay colour dots (`skinColor`).
- The drawing helpers (`drawFront`, `drawFace`) are pure over RGBA arrays + a canvas, in
  `src/ui/skin-preview.ts`, reusing the loader's decode + `upgradeLegacySkin`.

## 10. Files touched

New: `src/assets/skins/*.png`, `src/engine/render/{skin-uv,skin-legacy,skin-urls,skin-textures,
player-rig,player-anim}.ts` + tests, `src/ui/skin-preview.ts`.

Changed:
- `src/data/skins.data.ts` (rows, `skinOf`)
- `src/engine/render/remote-players.ts` (+ test: hard-coded hexes at ~65/82/87/132)
- `src/main.ts` (loop reorder, miners set, edit swing)
- `src/ui/menu.ts` (+ CSS) picker and "playing as"
- `src/game/boot-session.test.ts:38`, `src/ui/mp-menu-model.test.ts:115,116,131`,
  `src/net/mp-client.test.ts:63` (colour ids → character ids; tsc catches the typed ones)
- `scripts/mp-e2e.ts` (character ids; `hexRgb('#E53935')` at ~555 → `skinColor(A_WHO.skin)`;
  new `skins` scenario), `scripts/menu-smoke.ts` (6 buttons, `#mp-skin-jj`),
  `scripts/perf-bench.ts` (cosmetic ids)
- `server/internal/proto/validate.go` comment (stale colour examples) — comment only
- `docs/multiplayer.md` (avatar paragraph), `docs/skins-research.md` (assets now in
  `src/assets/skins/`)

## 11. Sequencing

Multiplayer is **not deployed yet**. Skins merge into `multiplayer` before its first deploy, so no
live player ever has a saved colour; the "saved colour → Milo" path is only a safety net.

## 12a. Gate-2 disposition (plan review)

Accepted: legacy test oracle from `faceRects` (not the code's own table); rig tests for zRot sign,
ZYX order, overlay inflation and overlay material; the raycast test documented as blind to rect
placement (the hand-typed `faceRects` numbers are that oracle); dt-guard test at the same position;
remote-player swing tests with a settle and a negative control, plus `swing()` and pitch tests; the
two existing remote-player tests inverted (no shared disposal; feet on the ground); Task 1 fixes the
tests it turns red, and every task runs the full suite; the hand-edit rule (water flow must not
swing); the picker CSS carries the `.menu-card` prefix, 3×2 grid, wrapping names, green ring; "Playing
as" shows a small full-body preview and the character name; menu-smoke waits for the paint and saves
360/480 px screenshots; E10 is in `needMp`, sits before E4, checks Milo (slim), a back view and the
Enderman's upgraded left leg, measures the colour tolerance first, and has a negative control for the
swing; idle sway offset per avatar; the placeholder texture is the character's colour, not black.

For Julien: purge the Cloudflare cache for `/minicraft/` at deploy so both families get skins at once
(an old cached client shows a new player as a coloured box).

## 12. Gate-1 disposition

Accepted: picker shows full body (kid B1); hand-picked colours + distance test (kid B2); two
markers per face (rigour B1); flipY read from the texture + `SKIN_FLIP_Y` (rigour B2); pitch test
as a full vector vs `getLookDir` (rigour B3); asymmetric legacy test (rigour B4); walk test with
sign change, dt = 0, first frame, vertical motion (rigour B5); rotation conversion `(-x, -y, +z)`,
order ZYX (engine B1); explicit top/bottom vertex mapping (engine B2); shared resources never
disposed, arm rebuild on slim change (engine B3, boundary N3/N4); injectable loader (boundary B1);
corrected pivots incl. slim 21.5 and legs ±1.9, vanilla walk/swing/idle formulas, DoubleSide
overlays; complete consumer list; `update` `miners` optional; URL module outside `*.data.ts`;
rendered check as an mp-e2e scenario with assertions; swing on a friend's place/break (`edit.by`).

Changed approach: the legacy upgrade runs **at load time** (pure function) instead of an offline
script — no second copy of the Enderman to keep in sync, and the pure function is fully testable.

Rejected / decided: scale stays 1.8 tall (not vanilla 1.875) — matches the current avatar and hitbox;
no UV inset (NearestFilter with exact texel edges; revisit only if seams show in §8.11);
no body twist; vanilla 200 ms half-chops while mining.
