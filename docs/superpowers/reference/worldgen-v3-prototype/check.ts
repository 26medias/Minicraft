// Map-wide checker: every §11 assertion + statistics, over the seeds given on argv. Usage: tsx check.ts 1,2,3,...
import { generateChunkV3, column, B, NAME, BIOME, BIOME_NAME, SEA, treesOf, treeTemplate, oresOf, isEntrance, snowLine, isBeach, ORES, T, POOLS_PLACED, DEEPSLATE_Y, DEEP_BLEND } from './proto.ts';
import * as P from './proto.ts';
const CI = new Set([1, 2, 3, 5, 8, 13, 21, 34]);
const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number);
const H = 256;
const ORE_IDS: Record<string, number[]> = { coal: [50, 60], iron: [51, 61], copper: [52, 62], gold: [53, 63], lapis: [54, 64], redstone: [55, 65], diamond: [56, 66], emerald: [57, 67] };
const BANDS: [number, number, string][] = [[1, 24, '1-23'], [24, 48, '24-47'], [48, 80, '48-79'], [80, 120, '80-119'], [120, 256, '120+']];
const LOGS = new Set([70, 72, 74, 76, 78]), LEAVES = new Set([71, 73, 75, 77, 79]);
const TERRA = new Set([32, 33, 34, 35, 36, 37, 38]);
// §7 band table transcribed BY HAND (never imported from the generator): [y0, y1] per row of each family
const BANDS_HAND: Record<string, [number, number][]> = { coal: [[60, 200]], iron: [[16, 112], [140, 230]], copper: [[50, 130]], gold: [[6, 70], [40, 120]], lapis: [[12, 76]], redstone: [[4, 40]], diamond: [[4, 36], [4, 30]], emerald: [[100, 220]] };
const isLiq = (v: number) => v === 17 || v === 18;
const isSolid = (v: number) => v > 0 && !isLiq(v);
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const agg: Record<string, number[]> = {}; const push = (k: string, v: number) => { (agg[k] ??= []).push(v); };
const exact: Record<string, number> = {}; const seedExact: Record<string, number> = {}; const ex = (k: string, v: number) => { exact[k] = (exact[k] ?? 0) + v; seedExact[k] = (seedExact[k] ?? 0) + v; };
for (const seed of seeds) {
	const world = new Map<number, Uint16Array>(); const times: number[] = [];
	for (const k of Object.keys(T)) (T as any)[k] = 0;
	const t0 = performance.now();
	const kinds = new Map<number, Uint8Array>(); let wNodes = 0, replayBad = 0, instMax = 0, instSum = 0;
	for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) { const b = new Uint16Array(16 * H * 16); times.push(generateChunkV3(b, seed, cx, cz).ms); world.set(cz * 32 + cx, b); kinds.set(cz * 32 + cx, (globalThis as any).LAST_KIND); wNodes = Math.max(wNodes, P.W.nodes); if (cx > 0 && cz > 0 && cx < 31 && cz < 31) { if (P.W.replays !== 46) replayBad++; } instMax = Math.max(instMax, P.W.instances); instSum += P.W.instances; }
	ex('T13.replaysNot46', replayBad); push('T13.nodesMax', wNodes); push('T13.instancesMax', instMax); push('T13.instancesMean', instSum / 1024); if (wNodes > 1600) ex('T13.nodesOver1600', 1);
	const getKind = (x: number, y: number, z: number) => kinds.get((z >> 4) * 32 + (x >> 4))![y * 256 + (z & 15) * 16 + (x & 15)];
	const wall = performance.now() - t0;
	const get = (x: number, y: number, z: number) => { if (x < 0 || z < 0 || x > 511 || z > 511 || y < 0 || y > 255) return -1; return world.get((z >> 4) * 32 + (x >> 4))![y * 256 + (z & 15) * 16 + (x & 15)]; };
	const ts = times.slice(1).sort((a, b) => a - b); // drop the warm-up (first) chunk
	push('time.mean', ts.reduce((a, b) => a + b) / ts.length); push('time.p95', q(ts, 0.95)); push('time.max', ts[ts.length - 1]); push('time.first', times[0]);
	push('time.wall.s', wall / 1000);
	for (const k of ['cols', 'lattice', 'fill', 'surface', 'features', 'deco', 'trees']) push('stage.' + k, (T as any)[k] / T.n);
	// columns
	const cols: any[] = new Array(512 * 512); const top = new Int16Array(512 * 512), terr = new Int16Array(512 * 512);
	for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { cols[z * 512 + x] = column(seed, x, z);
		let y = 255; while (y > 0 && (get(x, y, z) === 0 || get(x, y, z) >= 70)) y--; top[z * 512 + x] = y; // first non-air non-tree
		let ys = y; while (ys > 0 && (isLiq(get(x, ys, z)) || get(x, ys, z) === 40)) ys--; terr[z * 512 + x] = ys; }
	const flatC = new Uint8Array(512 * 512); for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) flatC[z * 512 + x] = P.flatCell(seed, x, z) ? 1 : 0;
	const entCWater = new Uint8Array(512 * 512); for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) entCWater[z * 512 + x] = P.waterNear(seed, x, z) ? 1 : 0;
	const entC = new Uint8Array(512 * 512); for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) entC[z * 512 + x] = cols[z * 512 + x].ent > P.ENT_T && entCWater[z * 512 + x] === 0 ? 1 : 0;
	const flat9 = new Uint8Array(512 * 512); for (let z = 1; z < 511; z++) for (let x = 1; x < 511; x++) { let ok = 1; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!flatC[(z + dz) * 512 + x + dx]) ok = 0; flat9[z * 512 + x] = ok; }
	// pit depth: land columns not in a ravine channel: h − terrain top (terrain top = highest non-air/liquid/ice/log/leaf voxel)
	{ let mx = 0, over24 = 0, over30 = 0; for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { const c = cols[z * 512 + x]; if (c.h <= SEA) continue; if (c.ravW > 0 && P.inRavineChannel(seed, x, z)) continue; const d = c.h - terr[z * 512 + x]; if (d > mx) mx = d; if (d > 24) over24++; if (d > 30) over30++; } push('pit.maxDepth', mx); push('pit.over24', over24); ex('pit.over30', over30); }
	// T3 bedrock
	{ let bad = 0, high = 0; for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { if (get(x, 0, z) !== B.bedrock) bad++; for (let y = 1; y < 256; y++) if (get(x, y, z) === B.bedrock) bad++; for (let y = 253; y < 256; y++) if (get(x, y, z) !== 0) high++; } ex('T3.bedrockBad', bad); ex('T3.blocksAbove252', high); }
	// T4 heights
	{ const hs: number[] = []; let water = 0, land = 0, flat = 0, river = 0, ocean = 0; const bio = new Map<number, number>();
		for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { const i = z * 512 + x; hs.push(terr[i]); const t = get(x, top[i], z); if (isLiq(t) || t === 40) water++; const c = cols[i]; bio.set(c.biome, (bio.get(c.biome) ?? 0) + 1); if (c.river > 0.6) river++; if (c.biome === 0) ocean++; }
		for (let z = 2; z < 510; z++) for (let x = 2; x < 510; x++) { const h = terr[z * 512 + x]; if (h <= SEA) continue; land++; const d = Math.max(Math.abs(terr[z * 512 + x + 2] - h), Math.abs(terr[z * 512 + x - 2] - h), Math.abs(terr[(z + 2) * 512 + x] - h), Math.abs(terr[(z - 2) * 512 + x] - h)); if (d <= 2) flat++; }
		push('h.min', q(hs, 0)); push('h.p10', q(hs, 0.1)); push('h.median', q(hs, 0.5)); push('h.p90', q(hs, 0.9)); push('h.max', q(hs, 1)); push('water.pct', 100 * water / 262144); push('flat.pct', 100 * flat / land); push('river.pct', 100 * river / 262144);
		push('biomes.distinct', [...bio.keys()].filter((k) => k !== 0).length);
		for (const [k, v] of bio) push('biome.' + BIOME_NAME[k], 100 * v / 262144);
		let changes = 0, prev = -1, shortRuns = 0, run = 0; const sz = P.spawnInfo(seed).z;
		for (let x = 0; x < 512; x++) { const b = cols[sz * 512 + x].biome; if (b !== prev) { if (prev >= 0) { changes++; if (run < 6) shortRuns++; } prev = b; run = 0; } run++; }
		push('biome.changesRow', changes); push('biome.shortRunsRow', shortRuns);
	}
	// T5 water, T6 caves, T7 ores, T8 blobs, deco, ravines, floating, per-x density
	{ let badSide = 0, badBelow = 0, aboveSea = 0, iceBad = 0, lavaAbove10Bad = 0; const caveAir = BANDS.map(() => 0), rock = BANDS.map(() => 0);
		const ore: Record<string, number[]> = {}; for (const k in ORE_IDS) ore[k] = BANDS.map(() => 0); let oreOut = 0, oreBad = 0, dsAbove = 0, plainBelow = 0;
		const cnt = new Map<number, number>(); let nonAir = 0, budOrphan = 0, tuffHigh = 0, floaters = 0, caveLowAir = 0;
		const oreByX = new Array(16).fill(0), oreByZ = new Array(16).fill(0), solidByX = new Array(16).fill(0), solidByZ = new Array(16).fill(0);
		let contBorder = 0, contBorderN = 0, contInner = 0, contInnerN = 0, terraBad = 0, ceilBad = 0, ceilN = 0, contBorderZ = 0, contBorderZN = 0, contInnerZ = 0, contInnerZN = 0, ceilBadAmp = 0, ceilNAmp = 0;
		const bandOf = (y: number) => BANDS.findIndex(([a, b]) => y >= a && y < b);
		for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) {
			const i = z * 512 + x; const c = cols[i]; const h = terr[i]; const ent = entC[i] === 1;
			for (let y = 1; y < 256; y++) {
				const v = get(x, y, z); if (v === 0) continue; nonAir++; cnt.set(v, (cnt.get(v) ?? 0) + 1);
				if (v === 17 || v === 40) { if (y > SEA) aboveSea++; if (v === 40 && (y !== SEA || c.land !== BIOME.snowy)) iceBad++; if ([get(x + 1, y, z), get(x - 1, y, z), get(x, y, z + 1), get(x, y, z - 1)].includes(0)) badSide++; if (get(x, y - 1, z) === 0) badBelow++; }
				if (v === 18) { if ([get(x + 1, y, z), get(x - 1, y, z), get(x, y, z + 1), get(x, y, z - 1)].includes(0)) badSide++; if (get(x, y - 1, z) === 0) badBelow++; }
				if (v === B.tuff && y >= 66) tuffHigh++;
				if (v === B.budding) { const nb = [get(x + 1, y, z), get(x - 1, y, z), get(x, y, z + 1), get(x, y, z - 1), get(x, y + 1, z), get(x, y - 1, z)]; if (!nb.some((w) => w === B.amethyst || w === B.calcite || w === B.smooth_basalt)) budOrphan++; }
				if (TERRA.has(v) && P.column(seed, x, z).land !== BIOME.badlands) terraBad++;
				if (v >= 50 && v <= 67) {
					const o = ORES.find((r) => r.id === v || r.id + 10 === v)!; const name = NAME[v].replace('d_', ''); ore[name][bandOf(y)]++;
					if (!BANDS_HAND[name].some(([a, b]) => y >= a && y <= b)) oreOut++;
					if (v >= 60 && y >= DEEPSLATE_Y + DEEP_BLEND) dsAbove++; if (v < 60 && y < DEEPSLATE_Y - DEEP_BLEND) plainBelow++;
					oreByX[x & 15]++; oreByZ[z & 15]++;
					const e = get(x + 1, y, z); if (e === v) { if ((x & 15) === 15) contBorder++; else if ((x & 15) === 7) contInner++; }
					if ((x & 15) === 15) contBorderN++; else if ((x & 15) === 7) contInnerN++;
					const ez = get(x, y, z + 1); if (ez === v) { if ((z & 15) === 15) contBorderZ++; else if ((z & 15) === 7) contInnerZ++; }
					if ((z & 15) === 15) contBorderZN++; else if ((z & 15) === 7) contInnerZN++;
					void o;
				}
				if (isSolid(v)) { solidByX[x & 15]++; solidByZ[z & 15]++; }
			}
			for (let y = 1; y < h; y++) { const v = get(x, y, z); const bi = bandOf(y); rock[bi]++; if (v === 0 || v === 18 || v === 43 || v === 44) caveAir[bi]++; if (v === 0 && y <= 10) caveLowAir++;
				if (getKind(x, y, z) === 2 && !ent && c.ravW === 0 && !flat9[i]) { ceilNAmp++; let okc = true; for (let dz = -1; dz <= 1 && okc; dz++) for (let dx = -1; dx <= 1 && okc; dx++) { const xx = x + dx, zz = z + dz; if (xx < 0 || zz < 0 || xx > 511 || zz > 511) continue; const cn = cols[zz * 512 + xx]; if (cn.ravW > 0 || entC[zz * 512 + xx] === 1) continue; if (terr[zz * 512 + xx] - y < 6) okc = false; } if (!okc) ceilBadAmp++; }
				if (v === 0 && !ent && c.ravW === 0 && flat9[i]) { ceilN++; // observable ceiling: for every non-entrance, non-ravine column of the 3x3: highest solid − y ≥ 6 and no water in (y, y+6]
					let okc = true; for (let dz = -1; dz <= 1 && okc; dz++) for (let dx = -1; dx <= 1 && okc; dx++) { const xx = x + dx, zz = z + dz; if (xx < 0 || zz < 0 || xx > 511 || zz > 511) continue; const cn = cols[zz * 512 + xx]; if (cn.ravW > 0 || entC[zz * 512 + xx] === 1) continue; if (terr[zz * 512 + xx] - y < 6) okc = false; } if (!okc) { ceilBad++; if (ceilBad <= 3) console.error('ceil viol seed', seed, x, y, z, 'h', c.h, 'terr', h); } }
			}
			// floaters: solid voxel with 6 air neighbours
			for (let y = 3; y < 250; y++) { const v = get(x, y, z); if (isSolid(v) && !LEAVES.has(v) && get(x, y - 1, z) === 0 && get(x, y + 1, z) === 0 && get(x + 1, y, z) === 0 && get(x - 1, y, z) === 0 && get(x, y, z + 1) === 0 && get(x, y, z - 1) === 0) floaters++; }
		}
		ex('T5.waterOrLavaAirSide', badSide); ex('T5.waterOrLavaAirBelow', badBelow); ex('T5.waterAboveSea', aboveSea); ex('T5.iceBad', iceBad); ex('T6.caveAirAtOrBelow10', caveLowAir); ex('T6.ceilingViolations', ceilBad); push('T6.ceilingChecked', ceilN);
		for (let i = 0; i < 5; i++) push('cave.' + BANDS[i][2], 100 * caveAir[i] / Math.max(1, rock[i]));
		for (const k in ORE_IDS) { const t = ore[k].reduce((a, b) => a + b); push('ore.' + k, t / 1024); for (let i = 0; i < 5; i++) push(`oreband.${k}.${BANDS[i][2]}`, ore[k][i] / 1024); }
		ex('T7.oreOutsideBand', oreOut); ex('T7.deepslateOreAbove52', dsAbove); ex('T7.plainOreBelow44', plainBelow); ex('T7.oreBad', oreBad);
		const pct = (id: number) => 100 * (cnt.get(id) ?? 0) / nonAir;
		for (const n of ['granite', 'diorite', 'andesite', 'tuff', 'calcite', 'gravel', 'clay', 'dirt', 'sand', 'sandstone', 'moss', 'dripstone', 'amethyst', 'budding', 'smooth_basalt', 'lava', 'water', 'snow', 'ice', 'podzol', 'coarse', 'red_sand', 'terracotta', 'deepslate', 'stone']) push('pct.' + n, pct((B as any)[n]));
		push('count.amethyst', cnt.get(B.amethyst) ?? 0); push('count.moss', cnt.get(B.moss) ?? 0); push('count.dripstone', cnt.get(B.dripstone) ?? 0); push('count.lava', cnt.get(B.lava) ?? 0); push('count.floaters', floaters);
		ex('T8.tuffAtOrAbove66', tuffHigh); ex('T8.buddingOrphan', budOrphan); ex('T10.terracottaOutsideBadlands', terraBad);
		const oreDensX = oreByX.map((o, i) => 100 * o / solidByX[i]); const inner = (oreDensX[7] + oreDensX[8]) / 2;
		push('seam.oreDensX0', oreDensX[0]); push('seam.oreDensX15', oreDensX[15]); push('seam.oreDensInner', inner); push('seam.oreDensMaxDev', Math.max(...oreDensX.map((d) => Math.abs(d - inner))));
		push('seam.contBorder', 100 * contBorder / contBorderN); push('seam.contInner', 100 * contInner / contInnerN);
		push('seam.contBorderZ', 100 * contBorderZ / contBorderZN); push('seam.contInnerZ', 100 * contInnerZ / contInnerZN);
		const oreDensZ = oreByZ.map((o, i) => 100 * o / solidByZ[i]); const innerZ = (oreDensZ[7] + oreDensZ[8]) / 2; push('seam.oreDensZ0', oreDensZ[0]); push('seam.oreDensZ15', oreDensZ[15]); push('seam.oreDensMaxDevZ', Math.max(...oreDensZ.map((d) => Math.abs(d - innerZ))));
		ex('T6.ceilingViolationsAmp', ceilBadAmp); push('T6.ceilingCheckedAmp', ceilNAmp);
	}
	// T9 trees: bases, completeness
	{ let trees = 0, baseBad = 0, incomplete = 0, missingLogs = 0, missingLeaves = 0; const perChunk: number[] = [];
		for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) {
			const list = treesOf(seed, cx, cz); const cc = column(seed, cx * 16 + 8, cz * 16 + 8); if (cc.biome === BIOME.forest) perChunk.push(list.length); if (cc.biome === BIOME.desert || cc.biome === BIOME.badlands) ex('T9.treesInDesertBadlands', list.length);
			for (const t of list) { trees++;
				const below = get(t.x, t.h, t.z); if (![B.dirt, B.grass, B.podzol, B.coarse, B.snow].includes(below)) baseBad++;
				let bad = false; for (const [x, y, z, id] of treeTemplate(t)) { const v = get(x, y, z); if (LOGS.has(id)) { if (v !== id) { missingLogs++; bad = true; } } else if (LEAVES.has(id)) { if (v === 0) { missingLeaves++; bad = true; } } }
				if (bad) incomplete++;
			}
		}
		// canopy shapes, hand-written per species: logs == trunk height; leaves count; bounding box
		let shapeBad = 0; const shapeSeen = new Set<string>();
		for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) for (const t of treesOf(seed, cx, cz)) { const tpl = treeTemplate(t); const logs = tpl.filter(([, , , id]) => LOGS.has(id)); const leaves = tpl.filter(([, , , id]) => LEAVES.has(id)); const top = t.h + t.hh;
			const bx = Math.max(...leaves.map(([x]) => Math.abs(x - t.x))), bz = Math.max(...leaves.map(([, , z]) => Math.abs(z - t.z))), ymin = Math.min(...leaves.map(([, y]) => y)), ymax = Math.max(...leaves.map(([, y]) => y));
			let exp: [number, number, number, number, number] | null = null; // [leafMin, leafMax, maxXZ, yMin, yMax]
			if (t.sp.name === 'oak' || t.sp.name === 'birch') exp = [53, 61, 2, top - 3, top + 1];
			else if (t.sp.name === 'spruce') { const L = t.hh - 2; exp = [8 * Math.ceil(L / 2) + 20 * Math.floor(L / 2) + 1, 8 * Math.ceil(L / 2) + 20 * Math.floor(L / 2) + 1, 2, t.h + 3, top + 1]; }
			else if (t.sp.name === 'acacia') exp = [25, 25, 3, top, top + 1];
			else if (t.sp.name === 'cherry') exp = [93, 93, 3, top - 1, top + 2];
			const logsOk = logs.length === t.hh && (t.sp.name === 'acacia' ? logs.filter(([x, , z]) => x !== t.x || z !== t.z).length === 2 : logs.every(([x, , z]) => x === t.x && z === t.z));
			const ok = exp !== null && logsOk && leaves.length >= exp[0] && leaves.length <= exp[1] && Math.max(bx, bz) <= exp[2] && ymin === exp[3] && ymax === exp[4];
			if (!ok) { shapeBad++; const k = `${t.sp.name}${t.hh}`; if (!shapeSeen.has(k)) { shapeSeen.add(k); console.error('shape', t.sp.name, 'hh', t.hh, 'logs', logs.length, 'leaves', leaves.length, 'bbox', bx, bz, ymin - top, ymax - top, 'exp', exp); } } }
		ex('T9.canopyShapeBad', shapeBad);
		push('trees.total', trees); ex('T9.baseNotGround', baseBad); ex('T9.incompleteTrees', incomplete); ex('T9.missingLogs', missingLogs); ex('T9.missingLeaves', missingLeaves); push('trees.forestChunkMean', perChunk.reduce((a, b) => a + b, 0) / Math.max(1, perChunk.length)); push('trees.forestChunkMax', q(perChunk, 1));
	}
	// shared lattice nodes: chunk A's ix=4 plane equals east neighbour's ix=0 plane; A's iz=4 equals south neighbour's iz=0 (S, Dch, Dtn, entrance flag)
	{ let mism = 0, checked = 0; const rng = P.mulberry32(seed * 7919 + 1);
		const latC = (cx: number, cz: number) => { generateChunkV3(new Uint16Array(16 * H * 16), seed, cx, cz); return { L: (globalThis as any).LAST_LATTICE, C: (globalThis as any).LAST_CEIL as Float32Array, PW: (globalThis as any).LAST_PW as number, PAD: (globalThis as any).LAST_PAD as number }; };
		const pairs: [number, number][] = [[30, 30], [30, 5], [5, 30]]; for (let n = 0; n < 9; n++) pairs.push([rng() * 30 | 0, rng() * 30 | 0]);
		for (const [cx, cz] of pairs) { const a = latC(cx, cz), e = latC(cx + 1, cz), s = latC(cx, cz + 1); const A = a.L, E = e.L, S2 = s.L; const NY = Math.min(A.NY, E.NY, S2.NY);
			for (let j = 0; j < 16; j++) { checked += 2; const ai = (j + a.PAD) * a.PW + 16 + a.PAD, ei = (j + e.PAD) * e.PW + 0 + e.PAD; if (a.C[ai] !== e.C[ei]) mism++; const aj = (16 + a.PAD) * a.PW + j + a.PAD, sj = (0 + s.PAD) * s.PW + j + s.PAD; if (a.C[aj] !== s.C[sj]) mism++; } // shared column caveCeil
			for (let iy = 0; iy < NY; iy++) for (let j = 0; j < 5; j++) { for (const key of ['S', 'Dch', 'Dtn']) { const a = A[key][(iy * 5 + j) * 5 + 4], e = E[key][(iy * 5 + j) * 5 + 0]; checked++; if (!(a === e || (Number.isNaN(a) && Number.isNaN(e)))) mism++; const a2 = A[key][(iy * 5 + 4) * 5 + j], s2 = S2[key][(iy * 5 + 0) * 5 + j]; checked++; if (!(a2 === s2 || (Number.isNaN(a2) && Number.isNaN(s2)))) mism++; } }
			for (let j = 0; j < 5; j++) { checked += 2; if (A.entFlag[j * 5 + 4] !== E.entFlag[j * 5 + 0]) mism++; if (A.entFlag[4 * 5 + j] !== S2.entFlag[0 * 5 + j]) mism++; } }
		ex('T2.sharedNodeMismatch', mism); push('T2.sharedNodesChecked', checked); }
	// T10 surface rules on unbreached land columns (terrain top == column h, not beach, not river bank)
	{ let snowyBad = 0, desertBad = 0, snowLineBad = 0, beachBad = 0, seaFloorBad = 0, n = 0, badTerraIdx = 0;
		for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { const i = z * 512 + x; const c = cols[i]; const t = get(x, terr[i], z);
			if (c.h > SEA && terr[i] === c.h && c.ravW === 0) { n++;
				if (isBeach(c)) { if (t !== B.sand && t !== B.gravel) beachBad++; continue; }
				if (c.river > 0.6) continue;
				if (c.h >= snowLine(c) || c.land === BIOME.snowy) { if (t !== B.snow) { snowLineBad++; if (snowLineBad <= 4) console.error('snow viol seed', seed, x, z, 'h', c.h, 'top', NAME[t], 'amp', c.amp, 'above', NAME[get(x, terr[i] + 1, z)]); } if (c.land === BIOME.snowy && t !== B.snow) snowyBad++; continue; }
				if (c.amp > 8) continue;
				if (c.land === BIOME.desert && t !== B.sand) desertBad++;
			}
			if (c.h < SEA && terr[i] === c.h && c.biome === 0) { if (![B.sand, B.gravel, B.clay].includes(t)) seaFloorBad++; }
			for (let y = 100; y < 256; y++) { const v = get(x, y, z); if (TERRA.has(v)) { const idx = [32, 33, 32, 34, 32, 35, 36, 32, 37, 33, 32, 38, 32, 36, 33, 32][y & 15]; if (v !== idx) badTerraIdx++; } }
		}
		ex('T10.snowyTopBad', snowyBad); ex('T10.desertTopBad', desertBad); ex('T10.snowLineTopBad', snowLineBad); ex('T10.beachTopBad', beachBad); ex('T10.seaFloorBad', seaFloorBad); ex('T10.terracottaIndexBad', badTerraIdx); push('T10.columnsChecked', n);
	}
	// ravines: columns in ravine core; depth rim-to-floor; floor solid 4
	{ let ravCols = 0; const depths: number[] = []; let floorBad = 0;
		for (let z = 1; z < 511; z++) for (let x = 1; x < 511; x++) { const c = cols[z * 512 + x]; if (c.ravW <= 0) continue; const f = P.fields(seed); const rav = Math.abs(f.RAV(x / 230, z / 230)); if (rav >= c.ravW * 0.4 || entCWater[z * 512 + x] === 1) continue; ravCols++;
			const floor = terr[z * 512 + x]; depths.push(c.h - floor); const bottom = Math.round(c.h - c.ravDepth); if (floor < bottom - 1) floorBad++; }
		push('ravine.cols', ravCols); if (depths.length) { push('ravine.depth.p50', q(depths, 0.5)); push('ravine.depth.max', q(depths, 1)); } ex('ravine.floorBelowBottom', floorBad);
	}
	// pools
	{ let pools = 0; for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) for (const p of P.poolsOf(seed, cx, cz)) { for (let yy = p.y; yy > p.y - 9; yy--) if (get(p.x, yy, p.z) === p.liquid) { pools++; break; } } push('pools.perMap', pools); }
	// geodes count
	{ let g = 0; for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) g += P.geodesOf(seed, cx, cz).length; push('geodes.perMap', g); }
	console.error(`seed ${seed} done`);
	if (process.env.JSONL) { console.log(JSON.stringify({ seed, exact: seedExact, stats: Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, v[v.length - 1]])) })); for (const k in seedExact) delete seedExact[k]; }
}
if (process.env.JSONL) process.exit(0);
console.log('== EXACT (must be 0) ==');
for (const [k, v] of Object.entries(exact).sort()) console.log(`${v === 0 ? 'ok ' : 'RED'} ${k} = ${v}`);
console.log(`== STATS over ${seeds.length} seeds (min / p50 / max) ==`);
for (const [k, v] of Object.entries(agg).sort()) console.log(`${k.padEnd(28)} ${q(v, 0).toFixed(2)} / ${q(v, 0.5).toFixed(2)} / ${q(v, 1).toFixed(2)}`);
void POOLS_PLACED; void oresOf; void isEntrance;
