import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RemotePlayers, LABEL_MIN_PX } from './remote-players';
import { skinColor } from '../../data/skins.data';
import { SkinTextures } from './skin-textures';

const pose = (x: number, y: number, z: number, yaw = 0) => ({ x, y, z, yaw, pitch: 0 });

const fakeTextures = () => new SkinTextures(async () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }));

function findSprite(g: THREE.Object3D): THREE.Sprite {
	let s: THREE.Sprite | null = null;
	g.traverse((o) => { if (o instanceof THREE.Sprite) s = o; });
	if (!s) throw new Error('no label sprite');
	return s;
}

/** A stand-in 2D canvas (the tests run in node): records what the label draws. */
function fakeCanvas() {
	const calls: string[] = [];
	const ctx = {
		font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textAlign: '', textBaseline: '',
		measureText: (s: string) => ({ width: s.length * 18 }),
		fillRect: () => calls.push('fillRect'),
		strokeRect: () => calls.push('strokeRect'),
		fillText: (s: string) => calls.push(`fillText:${s}:${ctx.font}:${ctx.fillStyle}`),
		clearRect: () => {},
	};
	const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
	return { canvas, ctx, calls };
}

describe('RemotePlayers', () => {
	it('upsert adds exactly one group to the scene; a second upsert of the same id does not add another', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene, { textures: fakeTextures() });
		rp.upsert(7, 'Noah', 'jj');
		expect(scene.children).toHaveLength(1);
		expect(scene.children[0]).toBeInstanceOf(THREE.Group);
		rp.upsert(7, 'Noah', 'milo');
		expect(scene.children).toHaveLength(1);
		rp.upsert(8, 'Léa', 'mikey');
		expect(scene.children).toHaveLength(2);
	});

	it('a re-skin redraws the label border in the new colour and disposes the old label', () => {
		const scene = new THREE.Scene();
		const strokes: string[] = [];
		const rp = new RemotePlayers(scene, {
			textures: fakeTextures(),
			createCanvas: () => {
				const { canvas } = fakeCanvas();
				const ctx = (canvas as unknown as { getContext(): { strokeRect: () => void; strokeStyle: string } }).getContext();
				ctx.strokeRect = () => strokes.push(ctx.strokeStyle);
				return canvas;
			},
		});
		rp.upsert(1, 'Noah', 'jj');
		const oldMat = findSprite(scene.children[0]).material as THREE.SpriteMaterial;
		let oldDisposed = false;
		oldMat.addEventListener('dispose', () => { oldDisposed = true; });
		rp.upsert(1, 'Noah', 'milo');
		expect(strokes).toEqual([skinColor('jj'), skinColor('milo')]);
		expect(oldDisposed).toBe(true);
		rp.upsert(1, 'Noah', 'milo'); // unchanged: no redraw
		expect(strokes).toHaveLength(2);
	});

	it('the head shows the skin texture; a re-skin swaps it', () => {
		const scene = new THREE.Scene();
		const textures = fakeTextures();
		const rp = new RemotePlayers(scene, { textures, createCanvas: () => fakeCanvas().canvas });
		rp.upsert(1, 'Noah', 'jj');
		const head = scene.getObjectByName('head') as THREE.Mesh;
		expect((head.material as THREE.MeshBasicMaterial).map).toBe(textures.get('jj'));
		rp.upsert(1, 'Noah', 'milo');
		const head2 = scene.getObjectByName('head') as THREE.Mesh;
		expect((head2.material as THREE.MeshBasicMaterial).map).toBe(textures.get('milo'));
	});

	it('remove takes the group out of the scene and disposes the label, but not the shared rig geometry/materials', () => {
		const scene = new THREE.Scene();
		const { canvas } = fakeCanvas();
		const rp = new RemotePlayers(scene, { textures: fakeTextures(), createCanvas: () => canvas });
		rp.upsert(3, 'Noah', 'jj');
		const g = scene.children[0];
		const disposed: string[] = [];
		const head = g.getObjectByName('head') as THREE.Mesh;
		head.geometry.addEventListener('dispose', () => disposed.push('rigGeo'));
		(head.material as THREE.Material).addEventListener('dispose', () => disposed.push('rigMat'));
		const sprite = findSprite(g);
		const sm = sprite.material as THREE.SpriteMaterial;
		sm.addEventListener('dispose', () => disposed.push('labelMat'));
		sm.map!.addEventListener('dispose', () => disposed.push('labelTex'));
		rp.remove(3);
		expect(scene.children).toHaveLength(0);
		expect(disposed).not.toContain('rigGeo');
		expect(disposed).not.toContain('rigMat');
		expect(disposed).toContain('labelMat');
		expect(disposed).toContain('labelTex');
		expect(rp.positions()).toEqual([]);
		rp.remove(3); // idempotent
	});

	it('the label shows through terrain: depthTest false, renderOrder 999', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene, { textures: fakeTextures() });
		rp.upsert(1, 'Noah', 'jj');
		const s = findSprite(scene.children[0]);
		expect((s.material as THREE.SpriteMaterial).depthTest).toBe(false);
		expect(s.renderOrder).toBe(999);
	});

	it('the label is drawn on a white background, bordered in the skin colour, bold 32 px text', () => {
		const scene = new THREE.Scene();
		const { canvas, calls } = fakeCanvas();
		const strokes: string[] = [];
		const ctx = (canvas as unknown as { getContext(): { strokeRect: () => void; strokeStyle: string } }).getContext();
		ctx.strokeRect = () => strokes.push(ctx.strokeStyle);
		const rp = new RemotePlayers(scene, { textures: fakeTextures(), createCanvas: () => canvas });
		rp.upsert(1, 'Noah', 'mikey');
		expect(calls).toContain('fillRect');
		expect(strokes).toEqual([skinColor('mikey')]);
		const text = calls.find((c) => c.startsWith('fillText:'))!;
		expect(text).toMatch(/^fillText:Noah:bold 32px /);
		const s = findSprite(scene.children[0]);
		expect((s.material as THREE.SpriteMaterial).map).toBeInstanceOf(THREE.CanvasTexture);
		expect(canvas.width).toBeGreaterThan(0);
		expect(canvas.height).toBeGreaterThan(0);
	});

	it('update places the group at the interpolated pose (feet on the ground) and turns it to face yaw', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene, { textures: fakeTextures() });
		const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
		rp.upsert(1, 'Noah', 'jj');
		rp.pushPose(1, 0, pose(0, 64, 0));
		rp.pushPose(1, 100, pose(2, 64, 0, 1));
		rp.update(250, camera);
		const g = scene.children[0];
		expect(g.position.x).toBeCloseTo(1, 9);
		expect(g.position.y).toBeCloseTo(64, 9);
		expect(g.rotation.y).toBeCloseTo(0.5, 9);
		expect(g.visible).toBe(true);
		const rigRoot = g.getObjectByName('rig')!;
		const box = new THREE.Box3().setFromObject(rigRoot);
		// Feet on the ground: the base leg geometry's bottom is exactly at y=0, but the pants overlay
		// (spec §5 inflate 0.25 px) overhangs it by 0.25 px = 0.0140625 world units.
		expect(Math.abs(box.min.y - g.position.y)).toBeLessThan(0.02);
		expect(Math.abs(box.max.y - (g.position.y + 1.8))).toBeLessThan(0.05); // overlay adds a little
		expect(rp.positions()).toEqual([{ id: 1, name: 'Noah', skin: 'jj', x: 1, y: 64, z: 0 }]);
	});

	it('a player with no pose yet is hidden and not listed in positions()', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene, { textures: fakeTextures() });
		rp.upsert(1, 'Noah', 'jj');
		rp.update(1000, new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
		expect(scene.children[0].visible).toBe(false);
		expect(rp.positions()).toEqual([]);
	});

	it('pushPose for an unknown id is ignored', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene, { textures: fakeTextures() });
		rp.pushPose(42, 0, pose(0, 0, 0));
		rp.update(500, new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
		expect(scene.children).toHaveLength(0);
		expect(rp.positions()).toEqual([]);
	});

	function projectedLabelPx(distance: number, viewportPx: number): number {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene, { textures: fakeTextures() });
		rp.setViewportHeight(viewportPx);
		const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
		camera.position.set(0, 64 + 2.2, 0); // eye level with the label, looking down −z
		camera.lookAt(0, 64 + 2.2, -1);
		camera.updateMatrixWorld();
		rp.upsert(1, 'Noah', 'jj');
		rp.pushPose(1, 0, pose(0, 64, -distance));
		rp.update(1000, camera);
		scene.updateMatrixWorld(true);
		const s = findSprite(scene.children[0]);
		const c = new THREE.Vector3();
		s.getWorldPosition(c);
		const top = c.clone().add(new THREE.Vector3(0, s.scale.y / 2, 0)).project(camera);
		const bot = c.clone().add(new THREE.Vector3(0, -s.scale.y / 2, 0)).project(camera);
		return ((top.y - bot.y) / 2) * viewportPx;
	}

	it('at 100 blocks, 75° FOV, 800 px viewport the label is at least 20 px tall (catches an unscaled label)', () => {
		expect(LABEL_MIN_PX).toBe(20);
		expect(projectedLabelPx(100, 800)).toBeGreaterThanOrEqual(20 - 1e-6);
	});

	it('close up the label keeps its natural size (the minimum does not blow it up)', () => {
		const near = projectedLabelPx(3, 800);
		expect(near).toBeGreaterThan(20);
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene, { textures: fakeTextures() });
		rp.upsert(1, 'Noah', 'jj');
		const natural = findSprite(scene.children[0]).scale.y;
		rp.pushPose(1, 0, pose(0, 64, -3));
		const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
		camera.position.set(0, 66.2, 0);
		camera.updateMatrixWorld();
		rp.update(1000, camera);
		expect(findSprite(scene.children[0]).scale.y).toBeCloseTo(natural, 9);
	});

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
});
