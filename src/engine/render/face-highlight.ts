import * as THREE from 'three';
import type { Face } from '../../data/blocks.data';

/** Outward nudge along the face normal: >50 depth LSBs at reach, no z-fight. */
export const HIGHLIGHT_EPS = 0.004;
const INSET = 0.005; // keep edges out of neighbouring blocks' planes
const BORDER = 1 / 16; // one texel wide
const FILL_OPACITY = 0.2;
const BORDER_OPACITY = 0.85;
/** Face border for a single-cell pickaxe tier (today's look). */
export const HIGHLIGHT_WHITE = 0xffffff;
/** Face border for a multi-block tier (spec §5). */
export const HIGHLIGHT_AREA = 0xff8c1a;
/** Warm glow laid over each block an area break will remove. */
export const GLOW_COLOR = 0xffa033;
const GLOW_OPACITY = 0.35;
/** Slightly larger than a block so its faces sit in front of the block's own faces (no z-fight). */
const GLOW_SIZE = 1.01;
/** The largest glow: a Tunnel TNT's preview, 3 × 3 × 24 (toys spec §3.4). Emerald's 5×5×5 area is 125. */
export const MAX_GLOW_CELLS = 216;

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
	private borderMaterial: THREE.MeshBasicMaterial;
	/**
	 * A faint self-lit glow on each block the area break will remove (playtest: a wireframe of the whole area
	 * shape was unreadable, worst in the dark). Unlit so it shows in caves; a translucent tint (not additive,
	 * which washes out to white on snow) so the texture stays readable; depth-tested so only the faces he can
	 * see light up, never blocks through a wall.
	 */
	private glow: THREE.InstancedMesh;
	private glowKey = '';

	constructor(scene: THREE.Scene) {
		const side = 1 - 2 * INSET;
		const fill = material(0x000000, FILL_OPACITY, 2);
		const fillMesh = new THREE.Mesh(new THREE.PlaneGeometry(side, side), fill.m);
		fillMesh.renderOrder = fill.renderOrder;
		this.group.add(fillMesh);

		const border = material(HIGHLIGHT_WHITE, BORDER_OPACITY, 3);
		this.borderMaterial = border.m;
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

		this.glow = new THREE.InstancedMesh(
			new THREE.BoxGeometry(GLOW_SIZE, GLOW_SIZE, GLOW_SIZE),
			new THREE.MeshBasicMaterial({
				color: GLOW_COLOR,
				transparent: true,
				opacity: GLOW_OPACITY,
				depthTest: true,
				depthWrite: false,
				fog: false,
			}),
			MAX_GLOW_CELLS,
		);
		this.glow.name = 'area-glow';
		this.glow.count = 0;
		this.glow.frustumCulled = false; // instances sit far from the geometry's own bounds
		this.glow.renderOrder = 4;
		this.glow.visible = false;
		scene.add(this.glow);
	}

	/**
	 * The blocks the equipped tier's break will remove (loop.removableCells). `multi` false: today's white
	 * face outline and no glow. `multi` true: orange face outline plus a glow on each cell.
	 */
	setCells(cells: ReadonlyArray<{ x: number; y: number; z: number }>, multi: boolean): void {
		this.borderMaterial.color.setHex(multi ? HIGHLIGHT_AREA : HIGHLIGHT_WHITE);
		const n = multi ? Math.min(cells.length, MAX_GLOW_CELLS) : 0;
		this.glow.visible = n > 0 && this.group.visible;
		let key = '';
		for (let i = 0; i < n; i++) key += `${cells[i].x},${cells[i].y},${cells[i].z};`;
		if (key === this.glowKey) return; // same cells as last frame: nothing to upload
		this.glowKey = key;
		const m = new THREE.Matrix4();
		for (let i = 0; i < n; i++) {
			m.makeTranslation(cells[i].x + 0.5, cells[i].y + 0.5, cells[i].z + 0.5);
			this.glow.setMatrixAt(i, m);
		}
		this.glow.count = n;
		this.glow.instanceMatrix.needsUpdate = true;
	}

	show(x: number, y: number, z: number, face: Face): void {
		const { offset, euler } = faceTransform(face);
		this.group.position.set(x + offset[0], y + offset[1], z + offset[2]);
		this.group.rotation.set(euler[0], euler[1], euler[2]);
		this.group.visible = true;
	}

	hide(): void {
		this.group.visible = false;
		this.glow.visible = false;
	}
}
