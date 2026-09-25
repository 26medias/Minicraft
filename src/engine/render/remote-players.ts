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

export const LABEL_MIN_PX = 20;

const BOX_H = 1.8;
/** The label's natural world height, and its centre above the feet. */
const LABEL_H = 0.35;
const LABEL_Y = BOX_H + 0.4;
const FONT_PX = 32;
const PAD_X = 12;
const BORDER = 4;
const CANVAS_H = FONT_PX + 2 * (BORDER + 6);

type LabelCanvas = HTMLCanvasElement | OffscreenCanvas;

export type RemotePlayersOptions = {
	/** Canvas factory for the name label; defaults to `document.createElement('canvas')` when there is a DOM. */
	createCanvas?: () => LabelCanvas | null;
	/** Shared skin textures; defaults to a fresh (browser-loading) SkinTextures. */
	textures?: SkinTextures;
};

type Avatar = {
	id: number;
	name: string;
	skin: string;
	/** Robot badge (protocol/bots plan, task 3): the label draws `🤖 ${name}`. */
	bot: boolean;
	group: THREE.Group;
	rig: Rig;
	anim: AnimState;
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

const NO_MINERS: ReadonlySet<number> = new Set();

export class RemotePlayers {
	private avatars = new Map<number, Avatar>();
	private viewportHeight: number;
	private readonly createCanvas: () => LabelCanvas | null;
	private readonly res: RigResources;
	private readonly tmp = new THREE.Vector3();

	constructor(private readonly scene: THREE.Scene, opts: RemotePlayersOptions = {}) {
		this.createCanvas = opts.createCanvas ?? defaultCanvas;
		this.res = new RigResources(opts.textures ?? new SkinTextures());
		this.viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
	}

	/** The drawing buffer's height in CSS px, for the label's minimum on-screen size. */
	setViewportHeight(px: number): void {
		this.viewportHeight = px;
	}

	/** Adds a player, or updates an existing one's name, skin and bot badge. */
	upsert(id: number, name: string, skin: string, bot = false): void {
		const existing = this.avatars.get(id);
		if (existing) {
			if (existing.name === name && existing.skin === skin && existing.bot === bot) return;
			if (existing.skin !== skin) setRigSkin(existing.rig, this.res, skin);
			existing.name = name;
			existing.skin = skin;
			existing.bot = bot;
			this.replaceLabel(existing);
			return;
		}
		const group = new THREE.Group();
		group.name = `remote-player-${id}`;
		group.visible = false;
		const rig = buildRig(this.res, skin);
		group.add(rig.root);
		const a: Avatar = {
			id, name, skin, bot, group, rig, anim: newAnimState(Math.random() * 10),
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
		this.disposeLabel(a.label);
	}

	/** A pose received at local time `t` (ms). Unknown ids are ignored. */
	pushPose(id: number, t: number, pose: Pose): void {
		this.avatars.get(id)?.buffer.push(t, pose);
	}

	/** Moves every avatar to its interpolated pose, animates it and keeps each label at least LABEL_MIN_PX tall. */
	update(now: number, camera: THREE.Camera, miners: ReadonlySet<number> = NO_MINERS): void {
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

	positions(): Array<{ id: number; name: string; skin: string; x: number; y: number; z: number; bot: boolean }> {
		const out: Array<{ id: number; name: string; skin: string; x: number; y: number; z: number; bot: boolean }> = [];
		for (const a of this.avatars.values()) {
			if (!a.pose) continue;
			out.push({ id: a.id, name: a.name, skin: a.skin, x: a.pose.x, y: a.pose.y, z: a.pose.z, bot: a.bot });
		}
		return out;
	}

	private buildLabel(a: Avatar): void {
		const mat = new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true });
		const canvas = this.createCanvas();
		let aspect = 3;
		if (canvas) {
			const labelText = a.bot ? `🤖 ${a.name}` : a.name;
			aspect = drawLabel(canvas, labelText, skinColor(a.skin));
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
