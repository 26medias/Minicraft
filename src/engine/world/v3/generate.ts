import type { Chunk } from '../chunk';
import { V3, TERRA } from './blocks';
import { fields, fbm3, clamp, smooth } from './fields';
import { column, type Col, BIOME, SEA, ENT_T, DEEPSLATE_Y, DEEP_BLEND, LAVA_Y, SURF_MARGIN, RAVINE_FLOOR, cheeseDensity, tunnelDensity, isBeach, snowLine } from './columns';
import { hashv } from './prng';
import { stage5 } from './features';
import { stage6 } from './trees';

export const H = 256, CX = 16, CZ = 16, LAT = 4;
/** Asymmetric pad −4/+5 (spec §2): every column at local −1..16 has its four cell corners inside the grid. */
export const PAD = 4, PAD_HI = 5, PW = CX + PAD + PAD_HI; // 25

export type Ctx = { blocks: Uint16Array; bx: number; bz: number; poolLog?: number[] /* test-only: pool() pushes every index it writes when present */ };
export type Setter = (at: number) => number;
/** Write world voxel (x,y,z) if it lies inside this chunk and 1 ≤ y ≤ 254. `f` returns the new id, or −1 to leave it. */
export function put(c: Ctx, x: number, y: number, z: number, f: Setter): void {
	const lx = x - c.bx, lz = z - c.bz;
	if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 1 || y > 254) return;
	const i = y * 256 + lz * 16 + lx; const v = f(c.blocks[i]); if (v >= 0) c.blocks[i] = v;
}
/** Work counters (spec §2, §11.13): incremented AT THE POINT OF EVALUATION, reset per chunk. */
export const W = { nodes: 0, replays: 0, instances: 0 };
export type Capture = { S?: Float32Array; Dch?: Float32Array; Dtn?: Float32Array; NX?: number; NY?: number; entFlag?: boolean[]; caveCeil?: Float32Array; kind?: Uint8Array; PW?: number; PAD?: number; poolLog?: number[] /* filled by pool() with every index it writes */ };

export function generateChunkV3(chunk: Chunk, seed: number, capture?: Capture): void {
	if (chunk.height !== H) throw new RangeError('generator v3 needs a 256-high chunk');
	W.nodes = 0; W.replays = 0; W.instances = 0;
	const blocks = chunk.blocks; const f = fields(seed);
	const bx = chunk.cx * CX, bz = chunk.cz * CZ; const cx = chunk.cx, cz = chunk.cz;
	// ---- stage 1: padded columns
	const cols: Col[] = new Array(PW * PW); let maxH = 0;
	for (let pz = 0; pz < PW; pz++) for (let px = 0; px < PW; px++) { const c = column(seed, bx + px - PAD, bz + pz - PAD); cols[pz * PW + px] = c; if (c.h > maxH) maxH = c.h; }
	const col = (lx: number, lz: number) => cols[(lz + PAD) * PW + (lx + PAD)];
	const ampCell = new Float32Array(PW * PW);
	for (let pz = 0; pz < PW; pz++) for (let px = 0; px < PW; px++) {
		const wx = bx + px - PAD, wz = bz + pz - PAD; const x0 = (wx & ~3) - bx + PAD, z0 = (wz & ~3) - bz + PAD;
		if (x0 < 0 || z0 < 0 || x0 + 4 >= PW || z0 + 4 >= PW) { ampCell[pz * PW + px] = NaN; continue; } // only columns beyond local 17; never read
		ampCell[pz * PW + px] = Math.max(cols[z0 * PW + x0].amp, cols[z0 * PW + x0 + 4].amp, cols[(z0 + 4) * PW + x0].amp, cols[(z0 + 4) * PW + x0 + 4].amp);
	}
	const wn = new Uint8Array(PW * PW), caveCeil = new Float32Array(PW * PW);
	for (let pz = 1; pz < PW - 1; pz++) for (let px = 1; px < PW - 1; px++) {
		let m = 999; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const k = (pz + dz) * PW + px + dx; m = Math.min(m, cols[k].hRaw - ampCell[k]); }
		wn[pz * PW + px] = m < SEA + 2 ? 1 : 0; caveCeil[pz * PW + px] = m - SURF_MARGIN;
	}
	const yTop = Math.min(H - 4, Math.ceil((maxH + 28) / LAT) * LAT);
	// ---- stage 2: lattice — S (shape), Dch (cheese), Dtn (tunnels)
	const NX = CX / LAT + 1, NY = yTop / LAT + 1, NXX = NX * NX;
	const S = new Float32Array(NX * NY * NX), Dch = new Float32Array(NX * NY * NX), Dtn = new Float32Array(NX * NY * NX);
	const entAt = (ix: number, iz: number) => { const c = col(ix * LAT, iz * LAT); return c.ent > ENT_T && wn[(iz * LAT + PAD) * PW + ix * LAT + PAD] === 0; };
	for (let iz = 0; iz < NX; iz++) for (let ix = 0; ix < NX; ix++) {
		const c = col(ix * LAT, iz * LAT); const wx = bx + ix * LAT, wz = bz + iz * LAT; const boost = entAt(ix, iz);
		for (let iy = 0; iy < NY; iy++) {
			W.nodes++; const y = iy * LAT; const k = (iy * NX + iz) * NX + ix; const d = c.hRaw - y;
			S[k] = c.amp > 0 && Math.abs(d) < 40 ? c.amp * fbm3(f.SHAPE, wx / 44, y / 30, wz / 44, 3) * smooth(1 - Math.abs(d) / 40) : 0;
			if (y > c.h + 4 || y < 2) { Dch[k] = -99; Dtn[k] = -99; continue; }
			Dch[k] = cheeseDensity(f, wx, y, wz);
			Dtn[k] = tunnelDensity(f, wx, y, wz, c.h, boost);
		}
	}
	const cellCh = new Uint8Array(NX * NY * NX), cellTn = new Uint8Array(NX * NY * NX);
	for (let iy = 0; iy < NY - 1; iy++) for (let iz = 0; iz < NX - 1; iz++) for (let ix = 0; ix < NX - 1; ix++) {
		const k = (iy * NX + iz) * NX + ix; const ks = [k, k + 1, k + NX, k + NX + 1, k + NXX, k + NXX + 1, k + NXX + NX, k + NXX + NX + 1];
		cellCh[k] = ks.some((q) => Dch[q] > 0) ? 1 : 0; cellTn[k] = ks.some((q) => Dtn[q] > 0) ? 1 : 0;
	}
	// ---- stage 3: fill — kind 0 terrain-air, 1 solid, 2 cave-air, 3 water
	const kind = new Uint8Array(CX * H * CZ);
	const tri8 = (A: Float32Array, k0: number, k1: number, fx: number, fy: number, fz: number) => {
		const a00 = A[k0] + (A[k0 + 1] - A[k0]) * fx, a01 = A[k0 + NX] + (A[k0 + NX + 1] - A[k0 + NX]) * fx;
		const a10 = A[k1] + (A[k1 + 1] - A[k1]) * fx, a11 = A[k1 + NX] + (A[k1 + NX + 1] - A[k1 + NX]) * fx;
		const a0 = a00 + (a01 - a00) * fz, a1 = a10 + (a11 - a10) * fz; return a0 + (a1 - a0) * fy;
	};
	for (let lz = 0; lz < CZ; lz++) for (let lx = 0; lx < CX; lx++) {
		const c = col(lx, lz); const wx = bx + lx, wz = bz + lz; const pi = (lz + PAD) * PW + lx + PAD;
		const ent = c.ent > ENT_T && wn[pi] === 0; const ceil = caveCeil[pi];
		const rav = c.ravW > 0 && wn[pi] === 0 ? Math.abs(f.RAV(wx / 230, wz / 230)) : 9;
		const ravBottom = Math.round(c.h - c.ravDepth); const inRavine = rav < c.ravW * 0.4;
		const ix = lx >> 2, iz = lz >> 2, fx = (lx & 3) / LAT, fz = (lz & 3) / LAT; const base = lz * 16 + lx;
		const flat = col(ix * LAT, iz * LAT).amp === 0 && col(ix * LAT + 4, iz * LAT).amp === 0 && col(ix * LAT, iz * LAT + 4).amp === 0 && col(ix * LAT + 4, iz * LAT + 4).amp === 0;
		for (let y = 0; y < yTop; y++) {
			const iy = y >> 2, fy = (y & 3) / LAT; const k0 = (iy * NX + iz) * NX + ix, k1 = k0 + NXX;
			const dt = flat ? c.hRaw - y : c.hRaw - y + tri8(S, k0, k1, fx, fy, fz);
			let kd: number;
			if (dt <= 0) kd = y <= SEA ? 3 : 0;
			else {
				kd = 1;
				const deepEnough = dt > SURF_MARGIN && y < ceil;
				if (y >= 2 && !(inRavine && y >= ravBottom - RAVINE_FLOOR && y < ravBottom)) { // ravine floor stays solid
					if (deepEnough && (!ent || y < ceil - 18) && cellCh[k0] === 1 && tri8(Dch, k0, k1, fx, fy, fz) > 0) kd = 2; // deep cheese (≥ 24 below the surface in entrance zones)
					else if (ent && y >= c.hRaw - 14 && dt > -2 && cellCh[k0] === 1 && tri8(Dch, k0, k1, fx, fy, fz) > 0) kd = 2; // shallow cheese pit, floor ≥ h − 14
					else if ((deepEnough || (ent && dt > -2)) && cellTn[k0] === 1 && tri8(Dtn, k0, k1, fx, fy, fz) > 0) kd = 2; // tunnels may breach in entrance zones
				}
				if (kd === 1 && rav < 9 && y >= ravBottom && y < c.h + 60) {
					const w = c.ravW * (0.4 + 0.6 * clamp((y - ravBottom) / (c.h - ravBottom), 0, 1));
					if (rav < w) kd = 2;
				}
			}
			kind[y * 256 + base] = kd;
		}
	}
	// ---- stage 4: surface (precedence: underwater > beach/bank > snow line > stony peak > biome)
	for (let lz = 0; lz < CZ; lz++) for (let lx = 0; lx < CX; lx++) {
		const c = col(lx, lz); const wx = bx + lx, wz = bz + lz;
		const patch = f.PATCH(wx / 9, wz / 9); const beach = isBeach(c); const sl = c.land === BIOME.snowy ? -999 : snowLine(c); const rocky = c.amp > 8;
		let depth = 99, prevAir = true;
		for (let y = yTop - 1; y >= 0; y--) {
			const i = y * 256 + lz * 16 + lx; const kd = kind[i];
			if (y === 0) { blocks[i] = V3.bedrock; continue; }
			if (kd === 0) { blocks[i] = V3.air; prevAir = true; depth = 99; continue; }
			if (kd === 3) { blocks[i] = y === SEA && c.land === BIOME.snowy ? V3.ice : V3.water; prevAir = true; depth = 99; continue; }
			if (kd === 2) { blocks[i] = y <= LAVA_Y ? V3.lava : V3.air; prevAir = y > c.hRaw - 9; depth = 99; continue; }
			depth = prevAir ? 0 : depth + 1; prevAir = false;
			let id = V3.stone;
			if (y < DEEPSLATE_Y - DEEP_BLEND) id = V3.deepslate;
			else if (y < DEEPSLATE_Y + DEEP_BLEND && (hashv(wx, y, wz) & 255) / 256 < (DEEPSLATE_Y + DEEP_BLEND - y) / (2 * DEEP_BLEND)) id = V3.deepslate;
			if (depth <= 8 && y > c.hRaw - 9 - depth) {
				const underWater = kind[i + 256] === 3;
				if (underWater) id = depth === 0 ? (c.h > SEA - 10 ? (patch > 0.35 ? V3.gravel : V3.sand) : patch > 0.2 ? V3.clay : V3.gravel) : depth < 3 ? V3.sand : id;
				else if (beach || c.river > 0.6) id = depth < 4 ? (c.land === BIOME.snowy || c.land === BIOME.taiga ? V3.gravel : V3.sand) : id;
				else if (y >= sl) id = depth === 0 ? V3.snow_block : depth < 3 ? V3.dirt : id;
				else if (rocky) { /* stone */ }
				else switch (c.land) {
					case BIOME.desert: id = depth < 3 ? V3.sand : depth < 8 ? V3.sandstone : id; break;
					case BIOME.badlands: id = depth === 0 && y <= SEA + 8 ? V3.red_sand : y >= 100 ? TERRA[y & 15] : id; break;
					case BIOME.taiga: id = depth === 0 ? (patch > 0.45 ? V3.podzol : V3.grass_block) : depth < 4 ? V3.dirt : id; break;
					case BIOME.savanna: id = depth === 0 ? (patch > 0.55 ? V3.coarse_dirt : V3.grass_block) : depth < 4 ? V3.dirt : id; break;
					default: id = depth === 0 ? V3.grass_block : depth < 4 ? V3.dirt : id;
				}
			}
			blocks[i] = id;
		}
	}
	const ctx: Ctx = { blocks, bx, bz, poolLog: capture?.poolLog };
	stage5(ctx, seed, cx, cz, col, wn, caveCeil, kind, yTop, f); // underground features + pools + decoration (no-op until Task 4)
	stage6(ctx, seed, cx, cz); // trees (no-op until Task 5)
	if (capture) { capture.S = S; capture.Dch = Dch; capture.Dtn = Dtn; capture.NX = NX; capture.NY = NY; capture.caveCeil = caveCeil; capture.kind = kind; capture.PW = PW; capture.PAD = PAD; capture.entFlag = Array.from({ length: NX * NX }, (_, k) => entAt(k % NX, (k / NX) | 0)); }
	chunk.dirty = true; chunk.modified = false;
}
