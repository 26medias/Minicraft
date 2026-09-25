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
	// The debug skin is built from `faceRects` itself, so this raycast test is blind to a wrong
	// `faceRects` (rect placement) by construction — that class of break is caught only by
	// skin-uv.test.ts's hand-typed rects, which are the placement oracle.
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
