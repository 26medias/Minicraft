// §11 map instrument: every exact counter and statistic of spec §11.2–11.10, 11.13–11.16 over one whole map (1024 chunks).
// Port of docs/superpowers/reference/worldgen-v3-prototype/check.ts onto the engine modules; returns numbers instead of printing.
// The checker scans EVERY voxel (the coalshift margin is a handful of voxels out of ~380 000 ore voxels; any sampling would hide it).
import { Chunk } from '../chunk';
import { generateChunkV3, W, type Capture } from './generate';
import { column, type Col, BIOME, BIOME_NAME, SEA, ENT_T, DEEPSLATE_Y, DEEP_BLEND, isBeach, snowLine, flatCell, waterNear, inRavineChannel } from './columns';
import { oresOf, blobsOf, pocketsOf, geodesOf, poolsOf, T7_ORE_BAD } from './features';
import { treesOf, treeTemplate } from './trees';
import { spawnV3 } from './spawn';
import { fields } from './fields';
import { mulberry32 } from './prng';
import { V3, TERRA, ORE_IDS, ORE_DEEPSLATE, LOG_IDS, LEAF_IDS, isLiquidId } from './blocks';

export type MapCheck = { exact: Record<string, number>; stats: Record<string, number> };
/** `mutate` is consumed ONLY by the checker's own hand band table (the §11.7 coalshift proof); it never touches the generator. */
export type Mutate = { bandShift?: Partial<Record<string, number>> };

const BANDS: [number, number, string][] = [[1, 24, '1-23'], [24, 48, '24-47'], [48, 80, '48-79'], [80, 120, '80-119'], [120, 256, '120+']];
const FAMILIES = ['coal', 'iron', 'copper', 'gold', 'lapis', 'redstone', 'diamond', 'emerald'] as const;
/** §7 band table transcribed BY HAND (never imported from the generator): [y0, y1] per row of each family. */
const BANDS_HAND: Record<string, [number, number][]> = { coal: [[60, 200]], iron: [[16, 112], [140, 230]], copper: [[50, 130]], gold: [[6, 70], [40, 120]], lapis: [[12, 76]], redstone: [[4, 40]], diamond: [[4, 36], [4, 30]], emerald: [[100, 220]] };
/** ore id → family name, both plain and deepslate variants. */
const FAMILY = new Map<number, string>();
for (const fam of FAMILIES) { const plain = V3[`${fam}_ore`]; FAMILY.set(plain, fam); FAMILY.set(ORE_DEEPSLATE.get(plain)!, fam); }
const DEEPSLATE_ORES = new Set(ORE_DEEPSLATE.values());
const TERRA_SET = new Set(TERRA);
/** Hand-listed tree base voxels (§11.9), not imported from trees.ts. */
const GROUND = [V3.dirt, V3.grass_block, V3.podzol, V3.coarse_dirt, V3.snow_block];
/** Names reported as `pct.<name>` — prototype names → catalog ids. */
const PCT: [string, number][] = [['granite', V3.granite], ['diorite', V3.diorite], ['andesite', V3.andesite], ['tuff', V3.tuff], ['calcite', V3.calcite], ['gravel', V3.gravel], ['clay', V3.clay], ['dirt', V3.dirt], ['sand', V3.sand], ['sandstone', V3.sandstone], ['moss', V3.moss_block], ['dripstone', V3.dripstone_block], ['amethyst', V3.amethyst_block], ['budding', V3.budding_amethyst], ['smooth_basalt', V3.smooth_basalt], ['lava', V3.lava], ['water', V3.water], ['snow', V3.snow_block], ['ice', V3.ice], ['podzol', V3.podzol], ['coarse', V3.coarse_dirt], ['red_sand', V3.red_sand], ['terracotta', V3.terracotta], ['deepslate', V3.deepslate], ['stone', V3.stone]];
/** Every exact key, initialised to 0 so a counter that never fires still reports (an empty object must not pass). */
const EXACT_KEYS = ['T2.sharedNodeMismatch', 'T3.bedrockBad', 'T3.blocksAbove252', 'T5.waterOrLavaAirSide', 'T5.waterOrLavaAirBelow', 'T5.waterAboveSea', 'T5.iceBad', 'T6.caveAirAtOrBelow10', 'T6.ceilingViolations', 'T6.ceilingViolationsAmp', 'T7.oreOutsideBand', 'T7.deepslateOreAbove52', 'T7.plainOreBelow44', 'T7.oreBad', 'T8.tuffAtOrAbove66', 'T8.buddingOrphan', 'T9.baseNotGround', 'T9.incompleteTrees', 'T9.missingLogs', 'T9.missingLeaves', 'T9.canopyShapeBad', 'T9.treesInDesertBadlands', 'T10.snowyTopBad', 'T10.desertTopBad', 'T10.snowLineTopBad', 'T10.beachTopBad', 'T10.seaFloorBad', 'T10.terracottaIndexBad', 'T10.terracottaOutsideBadlands', 'T13.replaysNot46', 'T13.nodesOver1600', 'T14.poolVoxelBad', 'ravine.floorBelowBottom'];

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const isSolid = (v: number) => v > 0 && !isLiquidId(v);

export function checkMap(seed: number, mutate?: Mutate): MapCheck {
	const exact: Record<string, number> = {}; for (const k of EXACT_KEYS) exact[k] = 0;
	const stats: Record<string, number> = {};
	const ex = (k: string, v: number) => { exact[k] = (exact[k] ?? 0) + v; };
	const push = (k: string, v: number) => { stats[k] = v; };
	const bands: Record<string, [number, number][]> = {};
	for (const [fam, rows] of Object.entries(BANDS_HAND)) { const d = mutate?.bandShift?.[fam] ?? 0; bands[fam] = rows.map(([a, b]) => [a + d, b + d]); }

	// ---- generate the map, capturing kinds and pool writes; work counters at the point of evaluation
	const world = new Map<number, Uint16Array>(); const kinds = new Map<number, Uint8Array>(); const poolWrites: [number, number, number][] = [];
	let wNodes = 0, replayBad = 0, instMax = 0, instSum = 0;
	T7_ORE_BAD.count = 0;
	for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) {
		const c = new Chunk(cx, cz, 256); const log: number[] = []; const cap: Capture = { poolLog: log }; generateChunkV3(c, seed, cap);
		world.set(cz * 32 + cx, c.blocks); kinds.set(cz * 32 + cx, cap.kind!);
		for (const i of log) poolWrites.push([cx * 16 + (i & 15), (i / 256) | 0, cz * 16 + ((i >> 4) & 15)]);
		wNodes = Math.max(wNodes, W.nodes); if (cx > 0 && cz > 0 && cx < 31 && cz < 31 && W.replays !== 46) replayBad++;
		instMax = Math.max(instMax, W.instances); instSum += W.instances;
	}
	ex('T7.oreBad', T7_ORE_BAD.count);
	ex('T13.replaysNot46', replayBad); push('T13.nodesMax', wNodes); push('T13.instancesMax', instMax); push('T13.instancesMean', instSum / 1024); ex('T13.nodesOver1600', wNodes > 1600 ? 1 : 0);
	const get = (x: number, y: number, z: number) => { if (x < 0 || z < 0 || x > 511 || z > 511 || y < 0 || y > 255) return -1; return world.get((z >> 4) * 32 + (x >> 4))![y * 256 + (z & 15) * 16 + (x & 15)]; };
	const getKind = (x: number, y: number, z: number) => kinds.get((z >> 4) * 32 + (x >> 4))![y * 256 + (z & 15) * 16 + (x & 15)];
	// ---- columns: column stack, top (first non-air non-tree), terrain top (skip liquid/ice)
	const cols: Col[] = new Array(512 * 512); const top = new Int16Array(512 * 512), terr = new Int16Array(512 * 512);
	for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { cols[z * 512 + x] = column(seed, x, z);
		let y = 255; while (y > 0) { const v = get(x, y, z); if (v !== 0 && !LOG_IDS.has(v) && !LEAF_IDS.has(v)) break; y--; } top[z * 512 + x] = y;
		let ys = y; while (ys > 0) { const v = get(x, ys, z); if (!isLiquidId(v) && v !== V3.ice) break; ys--; } terr[z * 512 + x] = ys; }
	const flatC = new Uint8Array(512 * 512); for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) flatC[z * 512 + x] = flatCell(seed, x, z) ? 1 : 0;
	const entCWater = new Uint8Array(512 * 512); for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) entCWater[z * 512 + x] = waterNear(seed, x, z) ? 1 : 0;
	const entC = new Uint8Array(512 * 512); for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) entC[z * 512 + x] = cols[z * 512 + x].ent > ENT_T && entCWater[z * 512 + x] === 0 ? 1 : 0;
	const flat9 = new Uint8Array(512 * 512); for (let z = 1; z < 511; z++) for (let x = 1; x < 511; x++) { let ok = 1; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!flatC[(z + dz) * 512 + x + dx]) ok = 0; flat9[z * 512 + x] = ok; }
	// channel columns (inRavineChannel; only ravine-zone columns can be one)
	const chan = new Uint8Array(512 * 512); for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) chan[z * 512 + x] = cols[z * 512 + x].ravW > 0 && inRavineChannel(seed, x, z) ? 1 : 0;
	// ---- T3 bedrock
	{ let bad = 0, high = 0; for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { if (get(x, 0, z) !== V3.bedrock) bad++; for (let y = 1; y < 256; y++) if (get(x, y, z) === V3.bedrock) bad++; for (let y = 253; y < 256; y++) if (get(x, y, z) !== 0) high++; } ex('T3.bedrockBad', bad); ex('T3.blocksAbove252', high); }
	// ---- T4 heights, biomes; open-sky pit depth on land columns outside ravine channels
	{ const hs: number[] = []; let water = 0, land = 0, flat = 0, river = 0, pitMax = 0, pitOver24 = 0, pitOver30 = 0; const bio = new Map<number, number>();
		for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { const i = z * 512 + x; hs.push(terr[i]); const t = get(x, top[i], z); if (isLiquidId(t) || t === V3.ice) water++; const c = cols[i]; bio.set(c.biome, (bio.get(c.biome) ?? 0) + 1); if (c.river > 0.6) river++;
			if (c.h > SEA && chan[i] === 0) { const d = c.h - terr[i]; pitMax = Math.max(pitMax, d); if (d > 24) pitOver24++; if (d > 30) pitOver30++; } }
		for (let z = 2; z < 510; z++) for (let x = 2; x < 510; x++) { const h = terr[z * 512 + x]; if (h <= SEA) continue; land++; const d = Math.max(Math.abs(terr[z * 512 + x + 2] - h), Math.abs(terr[z * 512 + x - 2] - h), Math.abs(terr[(z + 2) * 512 + x] - h), Math.abs(terr[(z - 2) * 512 + x] - h)); if (d <= 2) flat++; }
		push('h.min', q(hs, 0)); push('h.p10', q(hs, 0.1)); push('h.median', q(hs, 0.5)); push('h.p90', q(hs, 0.9)); push('h.max', q(hs, 1)); push('water.pct', 100 * water / 262144); push('flat.pct', 100 * flat / Math.max(1, land)); push('river.pct', 100 * river / 262144);
		push('pit.maxDepth', pitMax); push('pit.over24', pitOver24); ex('pit.over30', pitOver30); // §6 rule 5 / §11.15: open-sky pit cap
		push('biomes.distinct', [...bio.keys()].filter((k) => k !== 0).length);
		for (const [k, v] of bio) push('biome.' + BIOME_NAME[k], 100 * v / 262144);
		let changes = 0, prev = -1, shortRuns = 0, run = 0; const sz = spawnV3(seed).z;
		for (let x = 0; x < 512; x++) { const b = cols[sz * 512 + x].biome; if (b !== prev) { if (prev >= 0) { changes++; if (run < 6) shortRuns++; } prev = b; run = 0; } run++; }
		push('biome.changesRow', changes); push('biome.shortRunsRow', shortRuns);
	}
	// ---- T5 water, T6 caves, T7 ores, T8 blobs, decoration, floaters, seam density
	{ let badSide = 0, badBelow = 0, aboveSea = 0, iceBad = 0; const caveAir = BANDS.map(() => 0), rock = BANDS.map(() => 0);
		const ore: Record<string, number[]> = {}; for (const k of FAMILIES) ore[k] = BANDS.map(() => 0); let oreOut = 0, dsAbove = 0, plainBelow = 0;
		const cnt = new Map<number, number>(); let nonAir = 0, budOrphan = 0, tuffHigh = 0, floaters = 0, caveLowAir = 0;
		const oreByX = new Array<number>(16).fill(0), oreByZ = new Array<number>(16).fill(0), solidByX = new Array<number>(16).fill(0), solidByZ = new Array<number>(16).fill(0);
		let contBorder = 0, contBorderN = 0, contInner = 0, contInnerN = 0, terraBad = 0, ceilBad = 0, ceilN = 0, contBorderZ = 0, contBorderZN = 0, contInnerZ = 0, contInnerZN = 0, ceilBadAmp = 0, ceilNAmp = 0;
		const bandOf = (y: number) => BANDS.findIndex(([a, b]) => y >= a && y < b);
		const sides = (x: number, y: number, z: number) => [get(x + 1, y, z), get(x - 1, y, z), get(x, y, z + 1), get(x, y, z - 1)];
		// ceiling clause: every non-entrance non-ravine column of the 3 × 3 has its terrain top ≥ 6 above y
		const ceilOk = (x: number, y: number, z: number) => { for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, zz = z + dz; if (xx < 0 || zz < 0 || xx > 511 || zz > 511) continue; const cn = cols[zz * 512 + xx]; if (cn.ravW > 0 || entC[zz * 512 + xx] === 1) continue; if (terr[zz * 512 + xx] - y < 6) return false; } return true; };
		for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) {
			const i = z * 512 + x; const c = cols[i]; const h = terr[i]; const ent = entC[i] === 1;
			for (let y = 1; y < 256; y++) {
				const v = get(x, y, z); if (v === 0) continue; nonAir++; cnt.set(v, (cnt.get(v) ?? 0) + 1);
				if (v === V3.water || v === V3.ice) { if (y > SEA) aboveSea++; if (v === V3.ice && (y !== SEA || c.land !== BIOME.snowy)) iceBad++; if (sides(x, y, z).includes(0)) badSide++; if (get(x, y - 1, z) === 0) badBelow++; }
				if (v === V3.lava) { if (sides(x, y, z).includes(0)) badSide++; if (get(x, y - 1, z) === 0) badBelow++; }
				if (v === V3.tuff && y >= 66) tuffHigh++;
				if (v === V3.budding_amethyst) { const nb = [...sides(x, y, z), get(x, y + 1, z), get(x, y - 1, z)]; if (!nb.some((w) => w === V3.amethyst_block || w === V3.calcite || w === V3.smooth_basalt)) budOrphan++; }
				if (TERRA_SET.has(v) && c.land !== BIOME.badlands) terraBad++;
				if (ORE_IDS.has(v)) {
					const name = FAMILY.get(v)!; ore[name][bandOf(y)]++;
					if (!bands[name].some(([a, b]) => y >= a && y <= b)) oreOut++;
					const ds = DEEPSLATE_ORES.has(v); if (ds && y >= DEEPSLATE_Y + DEEP_BLEND) dsAbove++; if (!ds && y < DEEPSLATE_Y - DEEP_BLEND) plainBelow++;
					oreByX[x & 15]++; oreByZ[z & 15]++;
					const e = get(x + 1, y, z); if (e === v) { if ((x & 15) === 15) contBorder++; else if ((x & 15) === 7) contInner++; }
					if ((x & 15) === 15) contBorderN++; else if ((x & 15) === 7) contInnerN++;
					const ez = get(x, y, z + 1); if (ez === v) { if ((z & 15) === 15) contBorderZ++; else if ((z & 15) === 7) contInnerZ++; }
					if ((z & 15) === 15) contBorderZN++; else if ((z & 15) === 7) contInnerZN++;
				}
				if (isSolid(v)) { solidByX[x & 15]++; solidByZ[z & 15]++; }
			}
			for (let y = 1; y < h; y++) { const v = get(x, y, z); const bi = bandOf(y); rock[bi]++; if (v === 0 || v === V3.lava || v === V3.moss_block || v === V3.dripstone_block) caveAir[bi]++; if (v === 0 && y <= 10) caveLowAir++;
				if (getKind(x, y, z) === 2 && !ent && c.ravW === 0 && !flat9[i]) { ceilNAmp++; if (!ceilOk(x, y, z)) ceilBadAmp++; }
				if (v === 0 && !ent && c.ravW === 0 && flat9[i]) { ceilN++; if (!ceilOk(x, y, z)) ceilBad++; }
			}
			// floaters: solid non-leaf voxel with 6 air neighbours
			for (let y = 3; y < 250; y++) { const v = get(x, y, z); if (isSolid(v) && !LEAF_IDS.has(v) && get(x, y - 1, z) === 0 && get(x, y + 1, z) === 0 && get(x + 1, y, z) === 0 && get(x - 1, y, z) === 0 && get(x, y, z + 1) === 0 && get(x, y, z - 1) === 0) floaters++; }
		}
		ex('T5.waterOrLavaAirSide', badSide); ex('T5.waterOrLavaAirBelow', badBelow); ex('T5.waterAboveSea', aboveSea); ex('T5.iceBad', iceBad); ex('T6.caveAirAtOrBelow10', caveLowAir); ex('T6.ceilingViolations', ceilBad); push('T6.ceilingChecked', ceilN);
		ex('T6.ceilingViolationsAmp', ceilBadAmp); push('T6.ceilingCheckedAmp', ceilNAmp);
		for (let b = 0; b < 5; b++) push('cave.' + BANDS[b][2], 100 * caveAir[b] / Math.max(1, rock[b]));
		for (const k of FAMILIES) { const t = ore[k].reduce((a, b) => a + b); push('ore.' + k, t / 1024); for (let b = 0; b < 5; b++) push(`oreband.${k}.${BANDS[b][2]}`, ore[k][b] / 1024); }
		ex('T7.oreOutsideBand', oreOut); ex('T7.deepslateOreAbove52', dsAbove); ex('T7.plainOreBelow44', plainBelow);
		const pct = (id: number) => 100 * (cnt.get(id) ?? 0) / Math.max(1, nonAir);
		for (const [n, id] of PCT) push('pct.' + n, pct(id));
		push('count.amethyst', cnt.get(V3.amethyst_block) ?? 0); push('count.moss', cnt.get(V3.moss_block) ?? 0); push('count.dripstone', cnt.get(V3.dripstone_block) ?? 0); push('count.lava', cnt.get(V3.lava) ?? 0); push('count.floaters', floaters);
		ex('T8.tuffAtOrAbove66', tuffHigh); ex('T8.buddingOrphan', budOrphan); ex('T10.terracottaOutsideBadlands', terraBad);
		const oreDensX = oreByX.map((o, k) => 100 * o / Math.max(1, solidByX[k])); const inner = (oreDensX[7] + oreDensX[8]) / 2;
		push('seam.oreDensX0', oreDensX[0]); push('seam.oreDensX15', oreDensX[15]); push('seam.oreDensInner', inner); push('seam.oreDensMaxDev', Math.max(...oreDensX.map((d) => Math.abs(d - inner))));
		push('seam.contBorder', 100 * contBorder / Math.max(1, contBorderN)); push('seam.contInner', 100 * contInner / Math.max(1, contInnerN));
		push('seam.contBorderZ', 100 * contBorderZ / Math.max(1, contBorderZN)); push('seam.contInnerZ', 100 * contInnerZ / Math.max(1, contInnerZN));
		const oreDensZ = oreByZ.map((o, k) => 100 * o / Math.max(1, solidByZ[k])); const innerZ = (oreDensZ[7] + oreDensZ[8]) / 2; push('seam.oreDensZ0', oreDensZ[0]); push('seam.oreDensZ15', oreDensZ[15]); push('seam.oreDensMaxDevZ', Math.max(...oreDensZ.map((d) => Math.abs(d - innerZ))));
	}
	// ---- T9 trees: bases, completeness, canopy shape (hand numbers per species)
	{ let trees = 0, baseBad = 0, incomplete = 0, missingLogs = 0, missingLeaves = 0, shapeBad = 0, desertTrees = 0; const perChunk: number[] = [];
		for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) {
			const list = treesOf(seed, cx, cz); const cc = column(seed, cx * 16 + 8, cz * 16 + 8); if (cc.biome === BIOME.forest) perChunk.push(list.length); if (cc.biome === BIOME.desert || cc.biome === BIOME.badlands) desertTrees += list.length;
			for (const t of list) { trees++;
				const below = get(t.x, t.h, t.z); if (!GROUND.includes(below)) baseBad++;
				const tpl = treeTemplate(t); let bad = false;
				for (const [x, y, z, id] of tpl) { const v = get(x, y, z); if (LOG_IDS.has(id)) { if (v !== id) { missingLogs++; bad = true; } } else if (LEAF_IDS.has(id)) { if (v === 0) { missingLeaves++; bad = true; } } }
				if (bad) incomplete++;
				const logs = tpl.filter(([, , , id]) => LOG_IDS.has(id)); const leaves = tpl.filter(([, , , id]) => LEAF_IDS.has(id)); const tp = t.h + t.hh;
				const bx = Math.max(...leaves.map(([x]) => Math.abs(x - t.x))), bz = Math.max(...leaves.map(([, , z]) => Math.abs(z - t.z))), ymin = Math.min(...leaves.map(([, y]) => y)), ymax = Math.max(...leaves.map(([, y]) => y));
				let exp: [number, number, number, number, number] | null = null; // [leafMin, leafMax, maxXZ, yMin, yMax]
				if (t.sp.name === 'oak' || t.sp.name === 'birch') exp = [53, 61, 2, tp - 3, tp + 1];
				else if (t.sp.name === 'spruce') { const L = t.hh - 2; const n = 8 * Math.ceil(L / 2) + 20 * Math.floor(L / 2) + 1; exp = [n, n, 2, t.h + 3, tp + 1]; }
				else if (t.sp.name === 'acacia') exp = [25, 25, 3, tp, tp + 1];
				else if (t.sp.name === 'cherry') exp = [93, 93, 3, tp - 1, tp + 2];
				const logsOk = logs.length === t.hh && (t.sp.name === 'acacia' ? logs.filter(([x, , z]) => x !== t.x || z !== t.z).length === 2 : logs.every(([x, , z]) => x === t.x && z === t.z));
				const ok = exp !== null && logsOk && leaves.length >= exp[0] && leaves.length <= exp[1] && Math.max(bx, bz) <= exp[2] && ymin === exp[3] && ymax === exp[4];
				if (!ok) shapeBad++;
			}
		}
		ex('T9.canopyShapeBad', shapeBad); ex('T9.treesInDesertBadlands', desertTrees);
		push('trees.total', trees); ex('T9.baseNotGround', baseBad); ex('T9.incompleteTrees', incomplete); ex('T9.missingLogs', missingLogs); ex('T9.missingLeaves', missingLeaves); push('trees.forestChunkMean', perChunk.reduce((a, b) => a + b, 0) / Math.max(1, perChunk.length)); push('trees.forestChunkMax', perChunk.length ? q(perChunk, 1) : 0);
	}
	// ---- T2 shared lattice nodes: A's ix=4 plane equals the east neighbour's ix=0 plane; A's iz=4 equals the south neighbour's iz=0 (S, Dch, Dtn, entrance flag, caveCeil)
	{ let mism = 0, checked = 0; const rng = mulberry32(seed * 7919 + 1);
		const latC = (cx: number, cz: number) => { const cap: Capture = {}; generateChunkV3(new Chunk(cx, cz, 256), seed, cap); return { L: cap, C: cap.caveCeil!, PW: cap.PW!, PAD: cap.PAD! }; };
		const pairs: [number, number][] = [[30, 30], [30, 5], [5, 30]]; for (let n = 0; n < 9; n++) pairs.push([rng() * 31 | 0, rng() * 31 | 0]); // 0..30 so chunk 31 planes can be the A side
		for (const [cx, cz] of pairs) { const a = latC(cx, cz), e = latC(cx + 1, cz), s = latC(cx, cz + 1); const A = a.L, E = e.L, S2 = s.L; const NY = Math.min(A.NY!, E.NY!, S2.NY!);
			for (let j = 0; j < 16; j++) { checked += 2; const ai = (j + a.PAD) * a.PW + 16 + a.PAD, ei = (j + e.PAD) * e.PW + 0 + e.PAD; if (a.C[ai] !== e.C[ei]) mism++; const aj = (16 + a.PAD) * a.PW + j + a.PAD, sj = (0 + s.PAD) * s.PW + j + s.PAD; if (a.C[aj] !== s.C[sj]) mism++; }
			for (let iy = 0; iy < NY; iy++) for (let j = 0; j < 5; j++) for (const key of ['S', 'Dch', 'Dtn'] as const) {
				const av = A[key]![(iy * 5 + j) * 5 + 4], ev = E[key]![(iy * 5 + j) * 5 + 0]; checked++; if (!(av === ev || (Number.isNaN(av) && Number.isNaN(ev)))) mism++;
				const a2 = A[key]![(iy * 5 + 4) * 5 + j], s2 = S2[key]![(iy * 5 + 0) * 5 + j]; checked++; if (!(a2 === s2 || (Number.isNaN(a2) && Number.isNaN(s2)))) mism++;
			}
			for (let j = 0; j < 5; j++) { checked += 2; if (A.entFlag![j * 5 + 4] !== E.entFlag![j * 5 + 0]) mism++; if (A.entFlag![4 * 5 + j] !== S2.entFlag![0 * 5 + j]) mism++; } }
		ex('T2.sharedNodeMismatch', mism); push('T2.sharedNodesChecked', checked); }
	// ---- T10 surface rules on unbreached land columns (terrain top == column h, not beach, not river bank)
	{ let snowyBad = 0, desertBad = 0, snowLineBad = 0, beachBad = 0, seaFloorBad = 0, n = 0, badTerraIdx = 0;
		for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { const i = z * 512 + x; const c = cols[i]; const t = get(x, terr[i], z);
			if (c.h > SEA && terr[i] === c.h && c.ravW === 0) { n++;
				if (isBeach(c)) { if (t !== V3.sand && t !== V3.gravel) beachBad++; }
				else if (c.river > 0.6) { /* bank */ }
				else if (c.h >= snowLine(c) || c.land === BIOME.snowy) { if (t !== V3.snow_block) { snowLineBad++; if (c.land === BIOME.snowy) snowyBad++; } }
				else if (c.amp > 8) { /* stony peak */ }
				else if (c.land === BIOME.desert && t !== V3.sand) desertBad++;
			}
			if (c.h < SEA && terr[i] === c.h && c.biome === BIOME.ocean) { if (t !== V3.sand && t !== V3.gravel && t !== V3.clay) seaFloorBad++; }
			for (let y = 100; y < 256; y++) { const v = get(x, y, z); if (TERRA_SET.has(v) && v !== TERRA[y & 15]) badTerraIdx++; }
		}
		ex('T10.snowyTopBad', snowyBad); ex('T10.desertTopBad', desertBad); ex('T10.snowLineTopBad', snowLineBad); ex('T10.beachTopBad', beachBad); ex('T10.seaFloorBad', seaFloorBad); ex('T10.terracottaIndexBad', badTerraIdx); push('T10.columnsChecked', n);
	}
	// ---- ravines: core columns' depth rim-to-floor, floor ≥ bottom − 1; big ravines = 8-connected channel components with ≥ 40 columns
	{ let ravCols = 0; const depths: number[] = []; let floorBad = 0; const f = fields(seed);
		for (let z = 1; z < 511; z++) for (let x = 1; x < 511; x++) { const c = cols[z * 512 + x]; if (c.ravW <= 0) continue; const rav = Math.abs(f.RAV(x / 230, z / 230)); if (rav >= c.ravW * 0.4 || entCWater[z * 512 + x] === 1) continue; ravCols++;
			const floor = terr[z * 512 + x]; depths.push(c.h - floor); const bottom = Math.round(c.h - c.ravDepth); if (floor < bottom - 1) floorBad++; }
		push('ravine.cols', ravCols); push('ravine.depth.p50', depths.length ? q(depths, 0.5) : 0); push('ravine.depth.max', depths.length ? q(depths, 1) : 0); ex('ravine.floorBelowBottom', floorBad);
		const seen = new Uint8Array(512 * 512); let big = 0, largest = 0; const stack: number[] = [];
		for (let s0 = 0; s0 < 512 * 512; s0++) { if (chan[s0] === 0 || seen[s0]) continue; let size = 0; seen[s0] = 1; stack.push(s0);
			while (stack.length) { const k = stack.pop()!; size++; const x = k & 511, z = k >> 9; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, zz = z + dz; if ((dx === 0 && dz === 0) || xx < 0 || zz < 0 || xx > 511 || zz > 511) continue; const kk = zz * 512 + xx; if (chan[kk] === 1 && !seen[kk]) { seen[kk] = 1; stack.push(kk); } } }
			if (size >= 40) big++; largest = Math.max(largest, size); }
		push('ravine.big', big); push('ravine.largest', largest); push('ravine.channelCols', chan.reduce((a, b) => a + b, 0));
	}
	// ---- T14 pools: every voxel pool() WROTE has 4 solid-or-liquid sides and a solid below; pools placed per map
	{ let bad = 0; for (const [x, y, z] of poolWrites) { const v = get(x, y, z); if (!isLiquidId(v)) { bad++; continue; }
			const s4 = [get(x + 1, y, z), get(x - 1, y, z), get(x, y, z + 1), get(x, y, z - 1)]; if (s4.some((w) => w <= 0)) bad++; const b = get(x, y - 1, z); if (!isSolid(b)) bad++; }
		ex('T14.poolVoxelBad', bad); push('T14.poolVoxelsChecked', poolWrites.length);
		let pools = 0; for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) for (const p of poolsOf(seed, cx, cz)) { for (let yy = p.y; yy > p.y - 9; yy--) if (get(p.x, yy, p.z) === p.liquid) { pools++; break; } } push('pools.perMap', pools); }
	// ---- geodes, instance-list sizes (informational)
	{ let g = 0, o = 0, b = 0, p = 0; for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) { g += geodesOf(seed, cx, cz).length; o += oresOf(seed, cx, cz).length; b += blobsOf(seed, cx, cz).length; p += pocketsOf(seed, cx, cz).length; } push('geodes.perMap', g); push('ores.instances', o); push('blobs.instances', b); push('pockets.instances', p); }
	return { exact, stats };
}
