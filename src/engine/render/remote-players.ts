import * as THREE from 'three';
import { PoseBuffer, type Pose } from '../../game/pose-buffer';
import { skinColor } from '../../data/skins.data';

/**
 * Remote player avatars (spec §7.3): one group per player, a 0.6 × 1.8 × 0.6
 * box in the skin colour with a darker front face showing yaw, and a name
 * label that shows through hills and never shrinks below LABEL_MIN_PX on
 * screen. No collisions: this is render-only.
 */

export const LABEL_MIN_PX = 20;

const BOX_W = 0.6;
const BOX_H = 1.8;
/** The label's natural world height, and its centre above the feet. */
const LABEL_H = 0.35;
const LABEL_Y = BOX_H + 0.4;
const FONT_PX = 32;
const PAD_X = 12;
const BORDER = 4;
const CANVAS_H = FONT_PX + 2 * (BORDER + 6);
/** How much darker the front face is. */
const FRONT_SHADE = 0.55;

type LabelCanvas = HTMLCanvasElement | OffscreenCanvas;

export type RemotePlayersOptions = {
	/** Canvas factory for the name label; defaults to `document.createElement('canvas')` when there is a DOM. */
	createCanvas?: () => LabelCanvas | null;
};

type Avatar = {
	id: number;
	name: string;
	skin: string;
	group: THREE.Group;
	box: THREE.Mesh;
	boxMats: THREE.MeshBasicMaterial[];
	label: THREE.Sprite;
	/** Label world size at its natural scale. */
	labelW: number;
	buffer: PoseBuffer;
	pose: Pose | null;
};

function defaultCanvas(): LabelCanvas | null {
	if (typeof document === 'undefined') return null;
	return document.createElement('canvas');
}

export class RemotePlayers {
	private avatars = new Map<number, Avatar>();
	private viewportHeight: number;
	private readonly createCanvas: () => LabelCanvas | null;
	private readonly tmp = new THREE.Vector3();

	constructor(private readonly scene: THREE.Scene, opts: RemotePlayersOptions = {}) {
		this.createCanvas = opts.createCanvas ?? defaultCanvas;
		this.viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
	}

	/** The drawing buffer's height in CSS px, for the label's minimum on-screen size. */
	setViewportHeight(px: number): void {
		this.viewportHeight = px;
	}

	/** Adds a player, or updates an existing one's name and skin. */
	upsert(id: number, name: string, skin: string): void {
		const existing = this.avatars.get(id);
		if (existing) {
			if (existing.name === name && existing.skin === skin) return;
			if (existing.skin !== skin) this.colourBox(existing.boxMats, skin);
			existing.name = name;
			existing.skin = skin;
			this.replaceLabel(existing);
			return;
		}
		const group = new THREE.Group();
		group.name = `remote-player-${id}`;
		group.visible = false;
		const boxMats = Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial());
		this.colourBox(boxMats, skin);
		const box = new THREE.Mesh(new THREE.BoxGeometry(BOX_W, BOX_H, BOX_W), boxMats);
		box.position.y = BOX_H / 2;
		group.add(box);
		const a: Avatar = {
			id, name, skin, group, box, boxMats,
			label: new THREE.Sprite(), labelW: LABEL_H,
			buffer: new PoseBuffer(), pose: null,
		};
		this.buildLabel(a);
		group.add(a.label);
		this.avatars.set(id, a);
		this.scene.add(group);
	}

	remove(id: number): void {
		const a = this.avatars.get(id);
		if (!a) return;
		this.avatars.delete(id);
		this.scene.remove(a.group);
		a.box.geometry.dispose();
		for (const m of a.boxMats) m.dispose();
		this.disposeLabel(a.label);
	}

	/** A pose received at local time `t` (ms). Unknown ids are ignored. */
	pushPose(id: number, t: number, pose: Pose): void {
		this.avatars.get(id)?.buffer.push(t, pose);
	}

	/** Moves every avatar to its interpolated pose and keeps each label at least LABEL_MIN_PX tall. */
	update(now: number, camera: THREE.Camera): void {
		for (const a of this.avatars.values()) {
			const p = a.buffer.sample(now);
			a.pose = p;
			if (!p) {
				a.group.visible = false;
				continue;
			}
			a.group.visible = true;
			a.group.position.set(p.x, p.y, p.z);
			a.group.rotation.set(0, p.yaw, 0);
			this.scaleLabel(a, camera);
		}
	}

	positions(): Array<{ id: number; name: string; skin: string; x: number; y: number; z: number }> {
		const out: Array<{ id: number; name: string; skin: string; x: number; y: number; z: number }> = [];
		for (const a of this.avatars.values()) {
			if (!a.pose) continue;
			out.push({ id: a.id, name: a.name, skin: a.skin, x: a.pose.x, y: a.pose.y, z: a.pose.z });
		}
		return out;
	}

	private colourBox(mats: THREE.MeshBasicMaterial[], skin: string): void {
		const c = new THREE.Color(skinColor(skin));
		// Face order: +x, −x, +y, −y, +z, −z. The front is −z, the camera's forward at yaw 0.
		for (let i = 0; i < 6; i++) mats[i].color.copy(c);
		mats[5].color.multiplyScalar(FRONT_SHADE);
	}

	private buildLabel(a: Avatar): void {
		const mat = new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true });
		const canvas = this.createCanvas();
		let aspect = 3;
		if (canvas) {
			aspect = drawLabel(canvas, a.name, skinColor(a.skin));
			const tex = new THREE.CanvasTexture(canvas);
			tex.colorSpace = THREE.SRGBColorSpace;
			tex.minFilter = THREE.LinearFilter;
			tex.generateMipmaps = false;
			mat.map = tex;
		}
		a.label.material = mat;
		a.label.renderOrder = 999;
		a.label.position.set(0, LABEL_Y, 0);
		a.labelW = LABEL_H * aspect;
		a.label.scale.set(a.labelW, LABEL_H, 1);
	}

	private replaceLabel(a: Avatar): void {
		this.disposeLabel(a.label);
		this.buildLabel(a);
	}

	private disposeLabel(label: THREE.Sprite): void {
		const mat = label.material as THREE.SpriteMaterial;
		mat.map?.dispose();
		mat.dispose();
	}

	/** Grows the label so its projected height is at least LABEL_MIN_PX; never shrinks it below natural. */
	private scaleLabel(a: Avatar, camera: THREE.Camera): void {
		let k = 1;
		if (camera instanceof THREE.PerspectiveCamera && this.viewportHeight > 0) {
			a.group.updateMatrixWorld();
			a.label.getWorldPosition(this.tmp);
			camera.updateMatrixWorld();
			const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
			const dir = new THREE.Vector3();
			camera.getWorldDirection(dir);
			// Depth along the view axis is what perspective divides by.
			const depth = this.tmp.sub(camPos).dot(dir);
			if (depth > 0) {
				const worldPerPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / (camera.zoom * this.viewportHeight);
				const minH = LABEL_MIN_PX * worldPerPx;
				if (minH > LABEL_H) k = minH / LABEL_H;
			}
		}
		a.label.scale.set(a.labelW * k, LABEL_H * k, 1);
	}
}

/** Draws the name label; returns its width / height aspect. */
function drawLabel(canvas: LabelCanvas, name: string, border: string): number {
	const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
	if (!ctx) return 3;
	const font = `bold ${FONT_PX}px system-ui, sans-serif`;
	ctx.font = font;
	const textW = Math.ceil(ctx.measureText(name).width);
	canvas.width = Math.max(CANVAS_H, textW + 2 * (PAD_X + BORDER));
	canvas.height = CANVAS_H;
	// Resizing a canvas resets its context state.
	ctx.fillStyle = '#FFFFFF';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.strokeStyle = border;
	ctx.lineWidth = BORDER;
	ctx.strokeRect(BORDER / 2, BORDER / 2, canvas.width - BORDER, canvas.height - BORDER);
	ctx.font = font;
	ctx.fillStyle = '#000000';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(name, canvas.width / 2, canvas.height / 2);
	return canvas.width / canvas.height;
}
