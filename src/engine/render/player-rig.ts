import * as THREE from 'three';
import { skinOf } from '../../data/skins.data';
import { SkinTextures } from './skin-textures';
import { faceRects, boxUVs, partSpecs, PART_NAMES, PX, type PartName } from './skin-uv';
import type { Joints } from './player-anim';

export type Layer = 'base' | 'overlay';

/**
 * Geometry per (part, arm model, layer) and material per (skin, layer), built on first use and
 * shared by every avatar. Nothing here is disposed per avatar (spec §5).
 */
export class RigResources {
	private readonly geos = new Map<string, THREE.BoxGeometry>();
	private readonly mats = new Map<string, THREE.MeshBasicMaterial>();

	constructor(readonly textures: SkinTextures) {}

	geometry(part: PartName, slim: boolean, layer: Layer): THREE.BoxGeometry {
		const key = `${part}/${slim}/${layer}`;
		let g = this.geos.get(key);
		if (g) return g;
		const spec = partSpecs(slim).find((p) => p.name === part)!;
		const grow = layer === 'overlay' ? spec.inflate * 2 : 0;
		const [w, h, d] = spec.size;
		g = new THREE.BoxGeometry((w + grow) * PX, (h + grow) * PX, (d + grow) * PX);
		const [u, v] = layer === 'base' ? spec.base : spec.overlay;
		g.setAttribute('uv', new THREE.BufferAttribute(boxUVs(faceRects(u, v, w, h, d)), 2));
		this.geos.set(key, g);
		return g;
	}

	material(id: string, layer: Layer): THREE.MeshBasicMaterial {
		const skin = skinOf(id).id;
		const key = `${skin}/${layer}`;
		let m = this.mats.get(key);
		if (m) return m;
		m = layer === 'base'
			? new THREE.MeshBasicMaterial({ map: this.textures.get(skin) })
			: new THREE.MeshBasicMaterial({ map: this.textures.get(skin), alphaTest: 0.5, transparent: false, side: THREE.DoubleSide });
		this.mats.set(key, m);
		return m;
	}
}

export type Rig = { root: THREE.Group; pivots: Record<PartName, THREE.Object3D>; skinId: string; slim: boolean };

/** Head/body/arms/legs pivots under `root`, positioned in world units, feet at the origin. */
export function buildRig(res: RigResources, id: string): Rig {
	const row = skinOf(id);
	const root = new THREE.Group();
	root.name = 'rig';
	const pivots = {} as Record<PartName, THREE.Object3D>;
	for (const spec of partSpecs(row.slim)) {
		const pivot = new THREE.Object3D();
		pivot.name = `${spec.name}Pivot`;
		pivot.rotation.order = 'ZYX';
		pivot.position.set(spec.pivot[0] * PX, spec.pivot[1] * PX, spec.pivot[2] * PX);
		for (const layer of ['base', 'overlay'] as const) {
			const mesh = new THREE.Mesh(res.geometry(spec.name, row.slim, layer), res.material(row.id, layer));
			mesh.name = layer === 'base' ? spec.name : `${spec.name}Overlay`;
			mesh.position.set(spec.offset[0] * PX, spec.offset[1] * PX, spec.offset[2] * PX);
			pivot.add(mesh);
		}
		pivots[spec.name] = pivot;
		root.add(pivot);
	}
	return { root, pivots, skinId: row.id, slim: row.slim };
}

/** Swaps materials; when the arm model changes, the arm meshes take the other geometry and offsets. */
export function setRigSkin(rig: Rig, res: RigResources, id: string): void {
	const row = skinOf(id);
	const specs = partSpecs(row.slim);
	for (const name of PART_NAMES) {
		const spec = specs.find((p) => p.name === name)!;
		const pivot = rig.pivots[name];
		pivot.position.set(spec.pivot[0] * PX, spec.pivot[1] * PX, spec.pivot[2] * PX);
		for (const layer of ['base', 'overlay'] as const) {
			const mesh = pivot.getObjectByName(layer === 'base' ? name : `${name}Overlay`) as THREE.Mesh;
			mesh.geometry = res.geometry(name, row.slim, layer);
			mesh.material = res.material(row.id, layer);
			mesh.position.set(spec.offset[0] * PX, spec.offset[1] * PX, spec.offset[2] * PX);
		}
	}
	rig.skinId = row.id;
	rig.slim = row.slim;
}

/** Vanilla joints → three: order ZYX, x and y negated, z kept (spec §7). */
export function applyJoints(rig: Rig, j: Joints): void {
	rig.pivots.head.rotation.set(-j.headX, 0, 0);
	rig.pivots.rightArm.rotation.set(-j.rArmX, 0, j.rArmZ);
	rig.pivots.leftArm.rotation.set(-j.lArmX, 0, j.lArmZ);
	rig.pivots.rightLeg.rotation.set(-j.rLegX, 0, 0);
	rig.pivots.leftLeg.rotation.set(-j.lLegX, 0, 0);
}
