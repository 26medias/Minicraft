import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RemotePlayers, LABEL_MIN_PX } from './remote-players';
import { skinColor } from '../../data/skins.data';

const pose = (x: number, y: number, z: number, yaw = 0) => ({ x, y, z, yaw, pitch: 0 });

function findSprite(g: THREE.Object3D): THREE.Sprite {
	let s: THREE.Sprite | null = null;
	g.traverse((o) => { if (o instanceof THREE.Sprite) s = o; });
	if (!s) throw new Error('no label sprite');
	return s;
}

function findBox(g: THREE.Object3D): THREE.Mesh {
	let m: THREE.Mesh | null = null;
	g.traverse((o) => { if (o instanceof THREE.Mesh && !(o instanceof THREE.Sprite)) m = o; });
	if (!m) throw new Error('no box');
	return m;
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
		const rp = new RemotePlayers(scene);
		rp.upsert(7, 'Noah', 'blue');
		expect(scene.children).toHaveLength(1);
		expect(scene.children[0]).toBeInstanceOf(THREE.Group);
		rp.upsert(7, 'Noah', 'red');
		expect(scene.children).toHaveLength(1);
		rp.upsert(8, 'Léa', 'green');
		expect(scene.children).toHaveLength(2);
	});

	it('a re-skin redraws the label border in the new colour and disposes the old label', () => {
		const scene = new THREE.Scene();
		const strokes: string[] = [];
		const rp = new RemotePlayers(scene, {
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

	it('the box is 0.6 × 1.8 × 0.6 in the skin colour, with a darker front face', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene);
		rp.upsert(1, 'Noah', 'jj');
		const box = findBox(scene.children[0]);
		const geo = box.geometry as THREE.BoxGeometry;
		expect(geo.parameters).toMatchObject({ width: 0.6, height: 1.8, depth: 0.6 });
		const mats = box.material as THREE.MeshBasicMaterial[];
		expect(mats).toHaveLength(6);
		// Face order is +x, −x, +y, −y, +z, −z; the front is −z (the camera's forward at yaw 0).
		const side = mats[0].color.getHexString().toUpperCase();
		expect(`#${side}`).toBe(skinColor('jj').toUpperCase());
		const front = mats[5].color;
		expect(front.r + front.g + front.b).toBeLessThan(mats[0].color.r + mats[0].color.g + mats[0].color.b);
		// The re-skin recolours it.
		rp.upsert(1, 'Noah', 'milo');
		expect(`#${(findBox(scene.children[0]).material as THREE.MeshBasicMaterial[])[0].color.getHexString().toUpperCase()}`).toBe(skinColor('milo').toUpperCase());
	});

	it('remove takes the group out of the scene and disposes of its geometry, materials and texture', () => {
		const scene = new THREE.Scene();
		const { canvas } = fakeCanvas();
		const rp = new RemotePlayers(scene, { createCanvas: () => canvas });
		rp.upsert(3, 'Noah', 'pink');
		const g = scene.children[0];
		const disposed: string[] = [];
		const box = findBox(g);
		box.geometry.addEventListener('dispose', () => disposed.push('boxGeo'));
		for (const m of box.material as THREE.Material[]) m.addEventListener('dispose', () => disposed.push('boxMat'));
		const sprite = findSprite(g);
		const sm = sprite.material as THREE.SpriteMaterial;
		sm.addEventListener('dispose', () => disposed.push('labelMat'));
		sm.map!.addEventListener('dispose', () => disposed.push('labelTex'));
		rp.remove(3);
		expect(scene.children).toHaveLength(0);
		expect(disposed.filter((d) => d === 'boxGeo')).toHaveLength(1);
		expect(disposed.filter((d) => d === 'boxMat').length).toBeGreaterThanOrEqual(2);
		expect(disposed).toContain('labelMat');
		expect(disposed).toContain('labelTex');
		expect(rp.positions()).toEqual([]);
		rp.remove(3); // idempotent
	});

	it('the label shows through terrain: depthTest false, renderOrder 999', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene);
		rp.upsert(1, 'Noah', 'blue');
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
		const rp = new RemotePlayers(scene, { createCanvas: () => canvas });
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

	it('update places the group at the interpolated pose (feet at y) and turns it to face yaw', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene);
		const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
		rp.upsert(1, 'Noah', 'blue');
		rp.pushPose(1, 0, pose(0, 64, 0));
		rp.pushPose(1, 100, pose(2, 64, 0, 1));
		rp.update(250, camera);
		const g = scene.children[0];
		expect(g.position.x).toBeCloseTo(1, 9);
		expect(g.position.y).toBeCloseTo(64, 9);
		expect(g.rotation.y).toBeCloseTo(0.5, 9);
		expect(g.visible).toBe(true);
		const box = findBox(g);
		expect(box.position.y).toBeCloseTo(0.9, 9); // box bottom at the feet
		expect(rp.positions()).toEqual([{ id: 1, name: 'Noah', skin: 'blue', x: 1, y: 64, z: 0 }]);
	});

	it('a player with no pose yet is hidden and not listed in positions()', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene);
		rp.upsert(1, 'Noah', 'blue');
		rp.update(1000, new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
		expect(scene.children[0].visible).toBe(false);
		expect(rp.positions()).toEqual([]);
	});

	it('pushPose for an unknown id is ignored', () => {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene);
		rp.pushPose(42, 0, pose(0, 0, 0));
		rp.update(500, new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
		expect(scene.children).toHaveLength(0);
		expect(rp.positions()).toEqual([]);
	});

	function projectedLabelPx(distance: number, viewportPx: number): number {
		const scene = new THREE.Scene();
		const rp = new RemotePlayers(scene);
		rp.setViewportHeight(viewportPx);
		const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
		camera.position.set(0, 64 + 2.2, 0); // eye level with the label, looking down −z
		camera.lookAt(0, 64 + 2.2, -1);
		camera.updateMatrixWorld();
		rp.upsert(1, 'Noah', 'blue');
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
		const rp = new RemotePlayers(scene);
		rp.upsert(1, 'Noah', 'blue');
		const natural = findSprite(scene.children[0]).scale.y;
		rp.pushPose(1, 0, pose(0, 64, -3));
		const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
		camera.position.set(0, 66.2, 0);
		camera.updateMatrixWorld();
		rp.update(1000, camera);
		expect(findSprite(scene.children[0]).scale.y).toBeCloseTo(natural, 9);
	});
});
