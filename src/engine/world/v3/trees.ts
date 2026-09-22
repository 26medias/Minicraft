import { V3 } from './blocks';
import { streamSeed, mulberry32, hashv, F } from './prng';
import { column, BIOME, SEA, ENT_T, isBeach, snowLine, flatCell, inRavineChannel, tunnelFree } from './columns';
import { put, W, type Ctx, type Setter } from './generate';

export type Species = { name: 'oak' | 'birch' | 'spruce' | 'acacia' | 'cherry'; h0: number; h1: number; draw: (c: Ctx, t: TreeInst) => void };
export type TreeInst = { x: number; z: number; h: number; hh: number; r1: number; r2: number; sp: Species };
export const GROUND_OK: ReadonlySet<number> = new Set([V3.dirt, V3.grass_block, V3.podzol, V3.coarse_dirt, V3.snow_block]);

/** Test seam: `treeTemplate` swaps the writer to record instead of writing. */
let writer: ((c: Ctx, x: number, y: number, z: number, f: Setter) => void) | null = null;
const w = (c: Ctx, x: number, y: number, z: number, f: Setter) => (writer ? writer(c, x, y, z, f) : put(c, x, y, z, f));
const leaf = (c: Ctx, x: number, y: number, z: number, id: number) => w(c, x, y, z, (at) => (at === V3.air ? id : -1));
const logp = (c: Ctx, x: number, y: number, z: number, id: number) => w(c, x, y, z, () => id);
const plug = (c: Ctx, t: TreeInst) => w(c, t.x, t.h, t.z, (at) => (GROUND_OK.has(at) ? -1 : V3.dirt));

function blobCanopy(c: Ctx, t: TreeInst, log: number, lv: number): void {
	plug(c, t); const top = t.h + t.hh;
	for (let y = t.h + 1; y <= top; y++) logp(c, t.x, y, t.z, log);
	for (let dy = -3; dy <= 0; dy++) {
		const y = top + dy; const r = dy >= -1 ? 1 : 2;
		for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
			if (dx === 0 && dz === 0 && dy < 0) continue;
			const corner = Math.abs(dx) === r && Math.abs(dz) === r;
			if (corner && (r === 1 || hashv(t.x + dx, y, t.z + dz) % 2 === 0)) continue;
			leaf(c, t.x + dx, y, t.z + dz, lv);
		}
	}
	for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) leaf(c, t.x + dx, top + 1, t.z + dz, lv);
}
export const SPECIES: Record<Species['name'], Species> = {
	oak: { name: 'oak', h0: 4, h1: 6, draw: (c, t) => blobCanopy(c, t, V3.oak_log, V3.oak_leaves) },
	birch: { name: 'birch', h0: 5, h1: 7, draw: (c, t) => blobCanopy(c, t, V3.birch_log, V3.birch_leaves) },
	spruce: { name: 'spruce', h0: 6, h1: 10, draw: (c, t) => {
		plug(c, t); const top = t.h + t.hh;
		for (let y = t.h + 1; y <= top; y++) logp(c, t.x, y, t.z, V3.spruce_log);
		leaf(c, t.x, top + 1, t.z, V3.spruce_leaves);
		let r = 1;
		for (let y = top; y >= t.h + 3; y--) { for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { if (dx === 0 && dz === 0) continue; if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; leaf(c, t.x + dx, y, t.z + dz, V3.spruce_leaves); } r = r === 1 ? 2 : 1; }
	} },
	acacia: { name: 'acacia', h0: 5, h1: 6, draw: (c, t) => {
		plug(c, t); const dir = t.r1 < 0.5 ? [1, 0] : [0, 1]; const sgn = t.r2 < 0.5 ? 1 : -1; let x = t.x, z = t.z; const top = t.h + t.hh;
		for (let y = t.h + 1; y <= top; y++) { if (y === top - 1) { x += dir[0] * sgn; z += dir[1] * sgn; } logp(c, x, y, z, V3.acacia_log); } // the bend: two logs off the base column
		for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) { if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; leaf(c, x + dx, top, z + dz, V3.acacia_leaves); }
		for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) leaf(c, x + dx, top + 1, z + dz, V3.acacia_leaves);
	} },
	cherry: { name: 'cherry', h0: 4, h1: 5, draw: (c, t) => {
		plug(c, t); const top = t.h + t.hh;
		for (let y = t.h + 1; y <= top; y++) logp(c, t.x, y, t.z, V3.cherry_log);
		for (let dy = -1; dy <= 1; dy++) { const y = top + dy; const r = dy === 1 ? 2 : 3; for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dz * dz > r * r + 1) continue; if (dy === 1 && dx === 0 && dz === 0) continue; leaf(c, t.x + dx, y, t.z + dz, V3.cherry_leaves); } }
		leaf(c, t.x, top + 2, t.z, V3.cherry_leaves);
	} },
};
export const TREES: Partial<Record<number, { n0: number; n1: number; species: Species[] }>> = {
	[BIOME.plains]: { n0: 0, n1: 2, species: [SPECIES.oak] },
	[BIOME.forest]: { n0: 8, n1: 12, species: [SPECIES.oak, SPECIES.oak, SPECIES.birch] },
	[BIOME.cherry]: { n0: 2, n1: 4, species: [SPECIES.cherry] },
	[BIOME.taiga]: { n0: 6, n1: 9, species: [SPECIES.spruce] },
	[BIOME.snowy]: { n0: 1, n1: 2, species: [SPECIES.spruce] },
	[BIOME.savanna]: { n0: 1, n1: 2, species: [SPECIES.acacia] },
};
const memo = new Map<string, TreeInst[]>();
export function evictTrees(seed: number, cx: number, cz: number): void { memo.delete(`${seed}:${cx}:${cz}`); }
/** Pure: trees whose trunk origin lies in chunk (cx, cz). Memoised; never cleared mid-map. */
export function treesOf(seed: number, cx: number, cz: number): TreeInst[] {
	const k = `${seed}:${cx}:${cz}`; let v = memo.get(k); if (v) return v;
	v = treesOfRaw(seed, cx, cz); memo.set(k, v); return v;
}
function treesOfRaw(seed: number, cx: number, cz: number): TreeInst[] {
	const rt = mulberry32(streamSeed(seed, cx, cz, F.TREE));
	const cc = column(seed, cx * 16 + 8, cz * 16 + 8); const spec = TREES[cc.biome]; const out: TreeInst[] = [];
	if (!spec) return out;
	const n = spec.n0 + ((rt() * (spec.n1 - spec.n0 + 1)) | 0);
	for (let a = 0; a < n; a++) {
		const lx = (rt() * 16) | 0, lz = (rt() * 16) | 0; const sp = spec.species[(rt() * spec.species.length) | 0]; const hh = sp.h0 + ((rt() * (sp.h1 - sp.h0 + 1)) | 0); const r1 = rt(), r2 = rt();
		const x = cx * 16 + lx, z = cz * 16 + lz;
		if (out.some((t) => Math.abs(t.x - x) < 3 && Math.abs(t.z - z) < 3)) continue;
		const c = column(seed, x, z);
		if (c.h < SEA + 1 || isBeach(c) || c.river > 0.2 || inRavineChannel(seed, x, z) || c.biome !== cc.biome || c.h >= snowLine(c) || !flatCell(seed, x, z)) continue;
		if (c.ent > ENT_T && !tunnelFree(seed, x, z, c.h)) continue; // no tree over a tunnel mouth (§8)
		out.push({ x, z, h: c.h, hh, r1, r2, sp });
	}
	return out;
}
/** The voxels a tree writes into an empty world: [x, y, z, id] (leaves only where nothing recorded yet, logs overwrite). */
export function treeTemplate(t: TreeInst): [number, number, number, number][] {
	const seen = new Map<string, number>(); const c: Ctx = { blocks: new Uint16Array(0), bx: 0, bz: 0 };
	const saved = writer; writer = (_c, x, y, z, f) => { const k = `${x},${y},${z}`; const v = f(seen.get(k) ?? V3.air); if (v >= 0) seen.set(k, v); };
	try { t.sp.draw(c, t); } finally { writer = saved; }
	const out: [number, number, number, number][] = []; for (const [k, v] of seen) { const [x, y, z] = k.split(',').map(Number); out.push([x, y, z, v]); } return out;
}
/** Stage 6: replay the 3 × 3 origins' tree lists, write only our voxels. */
export function stage6(ctx: Ctx, seed: number, cx: number, cz: number): void {
	const { bx, bz } = ctx;
	for (let ncz = cz - 1; ncz <= cz + 1; ncz++) for (let ncx = cx - 1; ncx <= cx + 1; ncx++) {
		if (ncx < 0 || ncz < 0 || ncx > 31 || ncz > 31) continue;
		W.replays++; for (const t of treesOf(seed, ncx, ncz)) { if (t.x + 4 >= bx && t.x - 4 <= bx + 15 && t.z + 4 >= bz && t.z - 4 <= bz + 15) W.instances++; t.sp.draw(ctx, t); }
	}
}
