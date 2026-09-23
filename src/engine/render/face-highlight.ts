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
/** Face border and area box for a multi-block tier (spec §5). */
export const HIGHLIGHT_AREA = 0xff8c1a;
/** The area box sits this far outside the cells so its edges do not z-fight with block edges. */
export const AREA_BOX_PAD = 0.01;
/** Thickness of the area box's edge beams, in blocks. WebGL ignores line width, so 1 px lines vanish on snow (gate 2). */
export const AREA_EDGE = 0.06;

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
	/** Outline of the whole area (air cells included) for a multi-block tier: 12 thick edge beams. Hidden for single-cell tiers. */
	private box = new THREE.Object3D();

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

		// Drawn over terrain (no depth test): the part of the area inside the wall is exactly what
		// the warning is about. 12 unit-cube beams, placed and stretched by setArea.
		const beamGeo = new THREE.BoxGeometry(1, 1, 1);
		const beamMat = new THREE.MeshBasicMaterial({ color: HIGHLIGHT_AREA, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, fog: false });
		for (let i = 0; i < 12; i++) {
			const beam = new THREE.Mesh(beamGeo, beamMat);
			beam.renderOrder = 4;
			this.box.add(beam);
		}
		this.box.name = 'area-box';
		this.box.visible = false;
		scene.add(this.box);
	}

	/**
	 * The equipped tier's area around the aimed block, as inclusive integer corners (tools.areaBounds).
	 * `multi` false: today's white face outline only. `multi` true: orange face outline plus the box.
	 */
	setArea(min: readonly [number, number, number], max: readonly [number, number, number], multi: boolean): void {
		this.borderMaterial.color.setHex(multi ? HIGHLIGHT_AREA : HIGHLIGHT_WHITE);
		this.box.visible = multi && this.group.visible;
		if (!multi) return;
		// Outer corners of the padded box; each beam runs along one axis between two of them.
		const lo = [min[0] - AREA_BOX_PAD, min[1] - AREA_BOX_PAD, min[2] - AREA_BOX_PAD];
		const hi = [max[0] + 1 + AREA_BOX_PAD, max[1] + 1 + AREA_BOX_PAD, max[2] + 1 + AREA_BOX_PAD];
		let n = 0;
		for (let axis = 0; axis < 3; axis++) {
			const a = (axis + 1) % 3, b = (axis + 2) % 3;
			for (const ea of [lo[a], hi[a]]) for (const eb of [lo[b], hi[b]]) {
				const beam = this.box.children[n++];
				const pos = [0, 0, 0], scale = [AREA_EDGE, AREA_EDGE, AREA_EDGE];
				pos[axis] = (lo[axis] + hi[axis]) / 2;
				scale[axis] = hi[axis] - lo[axis] + AREA_EDGE; // overlap at the corners so they close
				pos[a] = ea;
				pos[b] = eb;
				beam.position.set(pos[0], pos[1], pos[2]);
				beam.scale.set(scale[0], scale[1], scale[2]);
			}
		}
	}

	show(x: number, y: number, z: number, face: Face): void {
		const { offset, euler } = faceTransform(face);
		this.group.position.set(x + offset[0], y + offset[1], z + offset[2]);
		this.group.rotation.set(euler[0], euler[1], euler[2]);
		this.group.visible = true;
	}

	hide(): void {
		this.group.visible = false;
		this.box.visible = false;
	}
}
