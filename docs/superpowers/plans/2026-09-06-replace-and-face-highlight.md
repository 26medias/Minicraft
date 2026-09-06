# Shift-to-replace and Face Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shift + right click overwrites the aimed block with the selected hotbar block; the aimed face is outlined whenever it is within reach.

**Architecture:** A pure `canReplace` rule in `actions.ts`; a `replaceBlock` method on `GameLoop` that reuses the mining-completion cleanup (extracted as `clearBlockEffects`); a `FaceHighlight` scene object driven from the loop's tick, which now raycasts once per tick and shares the hit with mining.

**Tech Stack:** TypeScript, Three.js, vitest (headless; `three` imports fine in node).

**Spec:** `docs/superpowers/specs/2026-09-06-replace-and-face-highlight-design.md`

## Global Constraints

- Indent with tabs (1 tab = 4 spaces).
- Stage explicit paths; never `git add -A`.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` then
  `Claude-Session: https://claude.ai/code/session_013iT9aEJFRZmSuCLmrCcEBz`.
- Never test against `https://noah.leap-forward.ca`; use `localhost:5173`.
- Every test must be run red first (on the wrong/missing implementation) before green.
- `npx vitest run` and `npm run build` must be green at the end of every task.

---

### Task 1: `canReplace` rule

**Files:**
- Modify: `src/game/actions.ts`
- Test: `src/game/actions.test.ts`

**Interfaces:**
- Produces: `canReplace(world: World, hit: VoxelHit, block: BlockId): boolean`.

- [ ] **Step 1: Write the failing tests** — append to `src/game/actions.test.ts` (add `canReplace` to the existing import from `./actions`, and `AIR` to the import from `../data/blocks.data`; add `import { indexOf } from '../engine/world/coords';`):

```ts
const dirtId = BLOCK_BY_NAME['dirt'].id;
const waterId = BLOCK_BY_NAME['water'].id;

describe('canReplace', () => {
	it('allows stone to be replaced by dirt', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, stoneId);
		expect(canReplace(w, hitAt(100, 60, 100), dirtId)).toBe(true);
	});

	it('refuses a same-block replace', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, stoneId);
		expect(canReplace(w, hitAt(100, 60, 100), stoneId)).toBe(false);
	});

	it('refuses air and liquid cells', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, AIR);
		w.setBlock(101, 60, 100, waterId);
		expect(canReplace(w, hitAt(100, 60, 100), stoneId)).toBe(false);
		expect(canReplace(w, hitAt(101, 60, 100), stoneId)).toBe(false);
	});

	it('refuses an unknown block id without throwing', () => {
		const w = new World(1);
		const c = w.ensureChunk(6, 6); // world (100, 60, 100) → chunk 6,6 local 4,60,4
		c.blocks[indexOf(4, 60, 4)] = 0xfffe;
		expect(() => canReplace(w, hitAt(100, 60, 100), stoneId)).not.toThrow();
		expect(canReplace(w, hitAt(100, 60, 100), stoneId)).toBe(false);
	});
});
```

`hitAt` and `stoneId` already exist at the top of this file. The unknown-id test asserts behaviour (false, no throw); `isSolid` already returns false for an unknown id before `def` is read, so the `!def` guard is belt-and-braces and this test does not isolate it.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/game/actions.test.ts`. Expected: FAIL, `canReplace` is not exported.

- [ ] **Step 3: Implement** — append to `src/game/actions.ts` (add `BLOCKS` to the import from `../data/blocks.data`):

```ts
/**
 * Shift + right click: may the block under the crosshair be overwritten by `block`?
 * Same mineability guard as GameLoop.updateMining; a same-id replace is refused so
 * the click is a true no-op (world.setBlock would flag the chunk modified).
 */
export function canReplace(world: World, hit: VoxelHit, block: BlockId): boolean {
	const existing = world.getBlock(hit.x, hit.y, hit.z);
	const def = BLOCKS[existing];
	if (!def || !isSolid(existing) || def.hardness <= 0) return false;
	return existing !== block;
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/game/actions.test.ts`. Expected: PASS. Mutation check: change `existing !== block` to `true`; the same-block test must fail; restore.

- [ ] **Step 5: Commit**

```bash
git add src/game/actions.ts src/game/actions.test.ts
git commit -m "feat(actions): canReplace rule for shift-to-replace"
```

---

### Task 2: `GameLoop.replaceBlock` and `clearBlockEffects`

**Files:**
- Modify: `src/game/loop.ts` (`updateMining` completion branch at ~lines 205–219; add two methods)
- Test: `src/game/loop.test.ts` (`makeLoop` at lines 19–45)

**Interfaces:**
- Consumes: `canReplace` from Task 1.
- Produces: `replaceBlock(hit: VoxelHit, newId: BlockId, lampColor: string): boolean` on `GameLoop`; fires `onWorldMutated` on success.

- [ ] **Step 1: Extend `makeLoop`** in `src/game/loop.test.ts` to take an optional real registry. Add `import { LightRegistry } from '../engine/render/light-registry';` and change the signature and constructor call:

```ts
function makeLoop(lights: LightRegistry | null = null) {
	// ... unchanged setup ...
	const loop = new GameLoop(
		world,
		renderer,
		new FpCamera(),
		player,
		keys,
		() => [0, 0, 1, 1],
		null,
		null,
		lights,
	);
	loop.start();
	const tick = (dt: number) => tickFn!(dt);
	return { loop, world, player, keys, tick, mounts: () => mounts };
}
```

Run `npx vitest run src/game/loop.test.ts` — still green.

- [ ] **Step 2: Write the failing tests** — append to `src/game/loop.test.ts` (add `import { indexOf } from '../engine/world/coords';` and `lamp`/`dirt` ids: `const lamp = BLOCK_BY_NAME['lamp'].id; const dirt = BLOCK_BY_NAME['dirt'].id;`):

```ts
describe('GameLoop.replaceBlock', () => {
	const hit = (x: number, y: number, z: number) =>
		({ x, y, z, face: 'py', distance: 1 }) as const;

	it('overwrites the block and fires onWorldMutated once', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, stone);
		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};
		expect(loop.replaceBlock(hit(260, 40, 260), dirt, '#ffffff')).toBe(true);
		expect(world.getBlock(260, 40, 260)).toBe(dirt);
		expect(mutations).toBe(1);
	});

	it('is a true no-op for a same-block replace', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, stone);
		const chunk = world.ensureChunk(16, 16);
		chunk.modified = false;
		chunk.liquidFrontier.clear();
		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};
		expect(loop.replaceBlock(hit(260, 40, 260), stone, '#ffffff')).toBe(false);
		expect(chunk.modified).toBe(false);
		expect(chunk.liquidFrontier.size).toBe(0);
		expect(mutations).toBe(0);
	});

	it('cancels a primed TNT fuse', () => {
		const { loop, world } = makeLoop();
		world.setBlock(260, 40, 260, tnt);
		world.setBlock(261, 40, 260, stone);
		expect(loop.ignite(hit(260, 40, 260))).toBe(true);
		expect(loop.replaceBlock(hit(260, 40, 260), dirt, '#ffffff')).toBe(true);
		loop.simulate(TNT_PRIME_FUSE + 0.1);
		// detonate() ignores what sits at the origin, so a leaked fuse still
		// destroys the neighbour.
		expect(world.getBlock(261, 40, 260)).toBe(stone);
		expect(world.getBlock(260, 40, 260)).toBe(dirt);
	});

	it('registers a replaced-in lamp and lights the chunk in its colour', () => {
		// updateLightsForBlockChange reads the colour through lights.getColor and
		// packs it into chunk.lights, so a lamp registered *after* the light
		// update would be lit white. Compare a red lamp against a white one.
		const lit = (color: string) => {
			const lights = new LightRegistry(new THREE.Scene());
			const { loop, world } = makeLoop(lights);
			world.setBlock(260, 40, 260, stone);
			const chunk = world.ensureChunk(16, 16);
			chunk.lights.fill(0);
			expect(loop.replaceBlock(hit(260, 40, 260), lamp, color)).toBe(true);
			expect(lights.getColor(260, 40, 260)).toBe(color);
			return chunk.lights[indexOf(4, 40, 4)];
		};
		const red = lit('#ff0000');
		const white = lit('#ffffff');
		expect(red).not.toBe(0);
		expect(white).not.toBe(0);
		expect(red).not.toBe(white);
	});

	it('unregisters a lamp replaced by stone', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world } = makeLoop(lights);
		world.setBlock(260, 40, 260, lamp);
		lights.add(260, 40, 260, '#ff8800');
		expect(loop.replaceBlock(hit(260, 40, 260), stone, '#ffffff')).toBe(true);
		expect(lights.getColor(260, 40, 260)).toBeNull();
	});

	it('cancels in-progress mining on the replaced cell', () => {
		const lights = new LightRegistry(new THREE.Scene());
		const { loop, world, player, tick } = makeLoop(lights);
		// Player at (260, 40, 260), eye y = 41.6, yaw 0 looks toward -z.
		player.flying = true; // no gravity, so the eye stays put
		world.setBlock(260, 41, 257, stone);
		loop.setLeftMouseDown(true);
		tick(0.05); // starts mining
		tick(0.05); // accumulates
		expect(loop.miningProgress()).toBeGreaterThan(0);

		expect(loop.replaceBlock(hit(260, 41, 257), lamp, '#ff8800')).toBe(true);
		expect(loop.miningProgress()).toBe(0);

		// Mouse still held: mining restarts on the lamp and eventually breaks it
		// (lamp hardness 0.3). A stale mining record would finish with stone's id
		// and skip lights.remove, orphaning the light.
		for (let i = 0; i < 40 && world.getBlock(260, 41, 257) !== AIR; i++) tick(0.05);
		expect(world.getBlock(260, 41, 257)).toBe(AIR);
		expect(lights.getColor(260, 41, 257)).toBeNull();
	});
});
```

- [ ] **Step 3: Run to verify it fails** — `npx vitest run src/game/loop.test.ts`. Expected: FAIL, `replaceBlock` is not a function.

- [ ] **Step 4: Implement** in `src/game/loop.ts`. Add `canReplace` to the import from `./actions`. Replace the mining-completion branch:

```ts
		this.mining.elapsed += dt;
		if (this.mining.elapsed >= this.mining.duration) {
			const { target, blockId } = this.mining;
			this.mining = null;
			this.clearBlockEffects(target.x, target.y, target.z, blockId);
			this.world.setBlock(target.x, target.y, target.z, AIR);
			this.markChunkDirtyAround(target.x, target.z);
			this.applyLightUpdate(target.x, target.y, target.z);
			this.onBlockBroken?.({ x: target.x, y: target.y, z: target.z, blockId });
		}
```

and add, after `ignite`:

```ts
	/**
	 * Everything that must happen when the block at (x,y,z) stops existing:
	 * a primed TNT loses its fuse, a lamp loses its light, and break particles
	 * spawn. Shared by mining completion and shift-to-replace. Call before the
	 * world write.
	 */
	private clearBlockEffects(x: number, y: number, z: number, oldId: BlockId): void {
		const k = tntKey(x, y, z);
		if (this.primedTnt.delete(k)) this.overlay?.remove(x, y, z);
		if (oldId === LAMP_ID) this.lights?.remove(x, y, z);
		this.particles?.spawnBreak(x, y, z, oldId);
	}

	/**
	 * Shift + right click: overwrite the aimed block with `newId`. Returns false
	 * (and touches nothing) when canReplace refuses. Fires onWorldMutated, not
	 * onBlockBroken: nothing was mined.
	 */
	replaceBlock(hit: VoxelHit, newId: BlockId, lampColor: string): boolean {
		if (!canReplace(this.world, hit, newId)) return false;
		const { x, y, z } = hit;
		const oldId = this.world.getBlock(x, y, z);
		const m = this.mining;
		if (m && m.target.x === x && m.target.y === y && m.target.z === z) this.mining = null;
		this.clearBlockEffects(x, y, z, oldId);
		this.world.setBlock(x, y, z, newId);
		// lights.add must precede applyLightUpdate, which reads the colour back.
		if (newId === LAMP_ID) this.lights?.add(x, y, z, lampColor);
		this.markChunkDirtyAround(x, z);
		this.applyLightUpdate(x, y, z);
		this.onWorldMutated?.();
		return true;
	}
```

- [ ] **Step 5: Run to verify it passes** — `npx vitest run src/game`. Expected: PASS. Mutation checks, each restored afterwards: (a) delete the `this.mining = null` line → the mining test fails; (b) swap `lights.add` after `applyLightUpdate` → the lamp-colour test fails (both runs come out white); (c) remove the `canReplace` guard → the no-op test fails. Not covered by any test, manual only (Task 5): `markChunkDirtyAround` (a missing call shows as the swapped block not re-meshing), and `clearBlockEffects` running before vs after `setBlock` (no observable difference today; the order is convention).

- [ ] **Step 6: Commit**

```bash
git add src/game/loop.ts src/game/loop.test.ts
git commit -m "feat(loop): replaceBlock with shared block-removal effects"
```

---

### Task 3: `FaceHighlight`

**Files:**
- Create: `src/engine/render/face-highlight.ts`
- Test: `src/engine/render/face-highlight.test.ts`

**Interfaces:**
- Produces: `faceTransform(face: Face): { offset: readonly [number, number, number]; euler: readonly [number, number, number] }`, `HIGHLIGHT_EPS = 0.004`, `class FaceHighlight { constructor(scene: THREE.Scene); show(x, y, z, face: Face): void; hide(): void }`.

- [ ] **Step 1: Write the failing test** — `src/engine/render/face-highlight.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { faceTransform, HIGHLIGHT_EPS, FaceHighlight } from './face-highlight';
import type { Face } from '../../data/blocks.data';

const NORMALS: Record<Face, [number, number, number]> = {
	px: [1, 0, 0],
	nx: [-1, 0, 0],
	py: [0, 1, 0],
	ny: [0, -1, 0],
	pz: [0, 0, 1],
	nz: [0, 0, -1],
};

describe('faceTransform', () => {
	for (const face of Object.keys(NORMALS) as Face[]) {
		it(`orients the quad outward on ${face}`, () => {
			const { offset, euler } = faceTransform(face);
			const n = new THREE.Vector3(...NORMALS[face]);
			const rotated = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...euler));
			expect(rotated.distanceTo(n)).toBeLessThan(1e-9);
			const fromCentre = new THREE.Vector3(offset[0] - 0.5, offset[1] - 0.5, offset[2] - 0.5);
			expect(fromCentre.length()).toBeCloseTo(0.5 + HIGHLIGHT_EPS, 9);
			expect(fromCentre.normalize().distanceTo(n)).toBeLessThan(1e-9);
		});
	}
});

describe('FaceHighlight', () => {
	it('is hidden until shown, and placed on the face when shown', () => {
		const scene = new THREE.Scene();
		const h = new FaceHighlight(scene);
		const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
		expect(group.visible).toBe(false);
		h.show(10, 20, 30, 'py');
		expect(group.visible).toBe(true);
		expect(group.position.toArray()).toEqual([10.5, 21 + HIGHLIGHT_EPS, 30.5]);
		h.hide();
		expect(group.visible).toBe(false);
		expect(scene.children.filter((c) => c instanceof THREE.Group)).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/engine/render/face-highlight.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `src/engine/render/face-highlight.ts`:

```ts
import * as THREE from 'three';
import type { Face } from '../../data/blocks.data';

/** Outward nudge along the face normal: >50 depth LSBs at reach, no z-fight. */
export const HIGHLIGHT_EPS = 0.004;
const INSET = 0.005; // keep edges out of neighbouring blocks' planes
const BORDER = 1 / 16; // one texel wide
const FILL_OPACITY = 0.2;
const BORDER_OPACITY = 0.85;

type Transform = { offset: readonly [number, number, number]; euler: readonly [number, number, number] };

const H = Math.PI / 2;
const E = HIGHLIGHT_EPS;
const TRANSFORMS: Readonly<Record<Face, Transform>> = Object.freeze({
	px: { offset: [1 + E, 0.5, 0.5], euler: [0, H, 0] },
	nx: { offset: [-E, 0.5, 0.5], euler: [0, -H, 0] },
	py: { offset: [0.5, 1 + E, 0.5], euler: [-H, 0, 0] },
	ny: { offset: [0.5, -E, 0.5], euler: [H, 0, 0] },
	pz: { offset: [0.5, 0.5, 1 + E], euler: [0, 0, 0] },
	nz: { offset: [0.5, 0.5, -E], euler: [0, Math.PI, 0] },
});

/** Block-relative centre and rotation that put a +Z-facing unit quad flush on `face`. */
export function faceTransform(face: Face): Transform {
	return TRANSFORMS[face];
}

function material(color: number, opacity: number, renderOrder: number) {
	const m = new THREE.MeshBasicMaterial({
		color,
		transparent: true,
		opacity,
		depthTest: true,
		depthWrite: false,
		side: THREE.FrontSide,
		fog: false,
		polygonOffset: true,
		polygonOffsetFactor: -1,
		polygonOffsetUnits: -1,
	});
	return { m, renderOrder };
}

/**
 * Outline of the face under the crosshair: a dark translucent fill (reads on
 * white wool / snow) plus a white one-texel border (reads on obsidian). One
 * group, added to the scene once; show/hide only toggle visibility.
 */
export class FaceHighlight {
	private group = new THREE.Group();

	constructor(scene: THREE.Scene) {
		const side = 1 - 2 * INSET;
		const fill = material(0x000000, FILL_OPACITY, 2);
		const fillMesh = new THREE.Mesh(new THREE.PlaneGeometry(side, side), fill.m);
		fillMesh.renderOrder = fill.renderOrder;
		this.group.add(fillMesh);

		const border = material(0xffffff, BORDER_OPACITY, 3);
		const horizontal = new THREE.PlaneGeometry(side, BORDER);
		// Verticals stop short of the horizontals so corners are not painted twice.
		const vertical = new THREE.PlaneGeometry(BORDER, side - 2 * BORDER);
		const edge = side / 2 - BORDER / 2;
		for (const [geo, x, y] of [
			[horizontal, 0, edge],
			[horizontal, 0, -edge],
			[vertical, edge, 0],
			[vertical, -edge, 0],
		] as const) {
			const mesh = new THREE.Mesh(geo, border.m);
			mesh.position.set(x, y, 0);
			mesh.renderOrder = border.renderOrder;
			this.group.add(mesh);
		}

		this.group.visible = false;
		scene.add(this.group);
	}

	show(x: number, y: number, z: number, face: Face): void {
		const { offset, euler } = faceTransform(face);
		this.group.position.set(x + offset[0], y + offset[1], z + offset[2]);
		this.group.rotation.set(euler[0], euler[1], euler[2]);
		this.group.visible = true;
	}

	hide(): void {
		this.group.visible = false;
	}
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/engine/render/face-highlight.test.ts`. Expected: PASS. Mutation check: flip the sign of `py`'s Euler → that case fails; restore.

- [ ] **Step 5: Commit**

```bash
git add src/engine/render/face-highlight.ts src/engine/render/face-highlight.test.ts
git commit -m "feat(render): FaceHighlight outline for the aimed face"
```

---

### Task 4: Wire the highlight, the Shift branch, and the README

**Files:**
- Modify: `src/game/loop.ts` (constructor params, `tick`, `updateMining`)
- Modify: `src/main.ts` (construction near line 330; `mousedown` handler near line 388)
- Modify: `README.md` (Movement line ~82, Interaction list ~85–88)
- Test: `src/game/loop.test.ts`

**Interfaces:**
- Consumes: `FaceHighlight` (Task 3), `replaceBlock` (Task 2).

- [ ] **Step 1: Write the failing test** — append to `src/game/loop.test.ts`. Extend `makeLoop` once more with a second optional parameter `highlight: FaceHighlight | null = null` passed as the 10th constructor argument (after `lights`), and add `import { FaceHighlight, HIGHLIGHT_EPS } from '../engine/render/face-highlight';`.

```ts
describe('GameLoop face highlight', () => {
	function makeHighlight() {
		const scene = new THREE.Scene();
		const h = new FaceHighlight(scene);
		const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
		return { h, group };
	}

	it('shows the aimed face within reach and hides it beyond reach or when paused', () => {
		const { h, group } = makeHighlight();
		const { loop, world, player, tick } = makeLoop(null, h);
		player.flying = true;
		// yaw 0 looks toward -z from eye (260, 41.6, 260); reach is 6.
		world.setBlock(260, 41, 257, stone);
		tick(0.05);
		expect(group.visible).toBe(true);
		expect(group.position.z).toBeCloseTo(258 + HIGHLIGHT_EPS, 6); // pz face of the block at z=257

		loop.paused = true;
		tick(0.05);
		expect(group.visible).toBe(false);
		loop.paused = false;

		world.setBlock(260, 41, 257, AIR);
		// Reach is inclusive (raycastVoxel loops while t <= 6): a block whose near
		// face is 6.0 away is still hit. z=251 puts the face at 9.0, clearly out.
		world.setBlock(260, 41, 251, stone);
		tick(0.05);
		expect(group.visible).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/game/loop.test.ts`. Expected: FAIL (constructor ignores the argument; `group.visible` stays false on the first assertion).

- [ ] **Step 3: Implement in `src/game/loop.ts`.** Add `import type { FaceHighlight } from '../engine/render/face-highlight';`, a private field `private aim: VoxelHit | null = null;`, and a constructor parameter after `lights`:

```ts
		private lights: LightRegistry | null = null,
		private highlight: FaceHighlight | null = null,
```

In `tick`, on the paused early-return add `this.highlight?.hide();` before `return;`. After `this.cam.sync(this.renderer.camera);` and before `this.updateMining(dt);`:

```ts
		// One raycast per tick, shared by the highlight and mining. Must run after
		// the camera sync so it sees this frame's eye position. `fwd` is this
		// tick's look direction (yaw/pitch do not change inside a tick).
		this.aim = raycastVoxel(this.world, eye, [fwd.x, fwd.y, fwd.z], REACH);
		if (this.aim) this.highlight?.show(this.aim.x, this.aim.y, this.aim.z, this.aim.face);
		else this.highlight?.hide();
```

In `updateMining`, replace the three lines computing `eye`, `dir`, `hit` with `const hit = this.aim;`.

- [ ] **Step 4: Run** — `npx vitest run src/game`. Expected: PASS, including the mining tests from Task 2 (they now depend on `this.aim`).

- [ ] **Step 5: Wire `src/main.ts`.** Add `import { FaceHighlight } from './engine/render/face-highlight';`. After `const overlay = new PrimedOverlay(renderer.scene);` add `const highlight = new FaceHighlight(renderer.scene);` and pass `highlight` as the last `GameLoop` constructor argument after `lights`. In the `mousedown` handler, directly after the `if (id === undefined || id === AIR) return;` line and before `const placed = placeBlock(...)`:

```ts
				if (e.shiftKey) {
					// Replace the aimed block instead of building next to it. All the
					// shared guards above (paused, pointer lock, hit, non-empty slot)
					// have already run; replaceBlock marks autosave dirty itself.
					loop.replaceBlock(hit, id, opts.currentLightColor);
					return;
				}
```

- [ ] **Step 6: README.** In the fly/swim paragraph change "Space and Shift have no effect during fly/swim." to "Space has no effect during fly/swim." In Interaction, after the Right click bullet add:

```md
- **Shift + Right click** — replace the block you're aiming at with the selected one (instead of building next to it).
```

and, as its own bullet directly after the Shift + Right click bullet (so it reads as applying to mining, placing and replacing):

```md
- The face you're aiming at is highlighted when it's close enough to reach.
```

- [ ] **Step 7: Full check** — `npx vitest run` and `npm run build`. Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add src/game/loop.ts src/game/loop.test.ts src/main.ts README.md
git commit -m "feat(game): shift-to-replace and aimed-face highlight wired"
```

---

### Task 5: Manual verification (orchestrator, in the browser)

Run `npm run dev`, open `http://localhost:5173`, create a throwaway world.

- [ ] Highlight legible on white wool, snow, obsidian, glass at up to 6 blocks; gone past reach; hidden while the inventory (I) is open (inventory sets `loop.paused`); still shown while the colour picker (C) is open (the picker does not pause). Border corners not noticeably brighter.
- [ ] Shift + right click: stone → dirt swaps in place and re-meshes immediately; stone → stone does nothing; primed TNT (E) then Shift + right click cancels the fuse; lamp swapped in glows in the picked colour; replacing the block under your own feet does not trap or fling the player; replacing it with water drops you into swim mode.
- [ ] Shift + right click on a block opens no browser context menu and keeps pointer lock, in Chrome **and Firefox**. Firefox lets Shift + right click bypass `contextmenu` `preventDefault` by default; the only suppression today is that listener. Fallback if red: also call `preventDefault()` on the `mousedown` for button 2 and, if the menu still shows, additionally accept `Ctrl + right click` as the replace modifier and document both.
- [ ] Delete the throwaway world (local and cloud).
