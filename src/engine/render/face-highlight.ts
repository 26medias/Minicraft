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
