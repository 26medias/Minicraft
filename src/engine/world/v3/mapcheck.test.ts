import { describe, it, expect } from 'vitest';
import { checkMap } from './mapcheck';

/** Per-commit instrument: seeds 1 and 2 only (≈ 25 s). The 8 CI seeds: `npm run worldgen:check` (exit criterion). Bounds are the §11 values (100-seed derivation + margin rule); mutants named in §11 turn each red; `coalshift` is executed below. */
const between = (v: number, a: number, b: number, k: string) => { expect(v, `${k} ≥ ${a}`).toBeGreaterThanOrEqual(a); expect(v, `${k} ≤ ${b}`).toBeLessThanOrEqual(b); };

// Hand-typed key set: `for (k of Object.entries(exact))` passes on an EMPTY object (gate 2), so the set itself is asserted.
const EXACT_KEYS = ['T2.sharedNodeMismatch', 'T3.bedrockBad', 'T3.blocksAbove252', 'T5.waterOrLavaAirSide', 'T5.waterOrLavaAirBelow', 'T5.waterAboveSea', 'T5.iceBad', 'T6.caveAirAtOrBelow10', 'T6.ceilingViolations', 'T6.ceilingViolationsAmp', 'T7.oreOutsideBand', 'T7.deepslateOreAbove52', 'T7.plainOreBelow44', 'T7.oreBad', 'T8.tuffAtOrAbove66', 'T8.buddingOrphan', 'T9.baseNotGround', 'T9.incompleteTrees', 'T9.missingLogs', 'T9.missingLeaves', 'T9.canopyShapeBad', 'T9.treesInDesertBadlands', 'T10.snowyTopBad', 'T10.desertTopBad', 'T10.snowLineTopBad', 'T10.beachTopBad', 'T10.seaFloorBad', 'T10.terracottaIndexBad', 'T10.terracottaOutsideBadlands', 'T13.replaysNot46', 'T13.nodesOver1600', 'T14.poolVoxelBad', 'ravine.floorBelowBottom', 'pit.over30'] as const;

describe('worldgen v3 map instrument (§11)', () => {
	for (const seed of [1, 2]) it(`seed ${seed}: all exact counters 0 and every statistical bound holds`, () => {
		const { exact, stats: s } = checkMap(seed);
		expect(Object.keys(exact).sort()).toEqual([...EXACT_KEYS].sort());
		for (const k of EXACT_KEYS) expect(exact[k], k).toBe(0);
		// non-vacuity witnesses: the exact counters above only mean something if these scanned something
		between(s['T2.sharedNodesChecked'], 15000, 19000, 'sharedNodesChecked'); between(s['T6.ceilingChecked'], 1e6, 4e6, 'ceilingChecked'); between(s['T6.ceilingCheckedAmp'], 1e5, 2e6, 'ceilingCheckedAmp');
		between(s['pit.maxDepth'], 0, 24, 'open-sky pit depth (land, non-ravine) — §6 rule 5 / §11.15');
		between(s['h.min'], 55, 100, 'h.min'); between(s['h.median'], 115, 139, 'h.median'); between(s['h.p90'], 132, 202, 'h.p90'); between(s['h.max'], 210, 250, 'h.max');
		between(s['water.pct'], 8, 60, 'water'); between(s['flat.pct'], 35, 100, 'flat'); between(s['river.pct'], 2, 12.5, 'river');
		between(s['biomes.distinct'], 7, 8, 'biomes'); between(s['biome.changesRow'], 4, 27, 'changesRow'); between(s['biome.shortRunsRow'], 0, 8, 'shortRuns');
		between(s['cave.1-23'], 12, 22, 'cave1'); between(s['cave.24-47'], 11, 19, 'cave2'); between(s['cave.48-79'], 6.9, 12.5, 'cave3'); between(s['cave.80-119'], 2.9, 5.8, 'cave4'); between(s['cave.120+'], 0, 4, 'cave5');
		between(s['ore.coal'], 78, 158, 'coal'); between(s['ore.iron'], 71, 104, 'iron'); between(s['ore.copper'], 67, 77, 'copper'); between(s['ore.gold'], 25, 34.5, 'gold'); between(s['ore.lapis'], 18.6, 20.5, 'lapis'); between(s['ore.redstone'], 40, 46.5, 'redstone'); between(s['ore.diamond'], 13.1, 15.2, 'diamond'); between(s['ore.emerald'], 0, 12, 'emerald');
		// §11.7 per-band (hand-typed): [family, band, lo, hi]
		for (const [f, b, lo, hi] of [['coal', '48-79', 8.2, 10.6], ['coal', '80-119', 59.5, 81.5], ['coal', '120+', 5.9, 69.5], ['iron', '1-23', 0.6, 1.3], ['iron', '24-47', 14.7, 17.7], ['iron', '48-79', 41.2, 45.7], ['iron', '80-119', 15.5, 18.7], ['iron', '120+', 0, 25.7], ['copper', '48-79', 18, 21], ['copper', '80-119', 46.9, 55.3], ['copper', '120+', 0.5, 2.4], ['gold', '1-23', 4.6, 6.2], ['gold', '24-47', 15.7, 18.2], ['gold', '48-79', 4.3, 8.7], ['gold', '80-119', 0, 3.0], ['gold', '120+', 0, 0.05], ['lapis', '1-23', 0.9, 1.8], ['lapis', '24-47', 9.9, 12.0], ['lapis', '48-79', 6.6, 7.9], ['redstone', '1-23', 28.6, 34.3], ['redstone', '24-47', 10.6, 13.2], ['diamond', '1-23', 10.6, 12.8], ['diamond', '24-47', 2.0, 2.9], ['emerald', '80-119', 0, 0.9], ['emerald', '120+', 0, 11]] as [string, string, number, number][]) between(s[`oreband.${f}.${b}`], lo, hi, `oreband.${f}.${b}`);
		for (const [f, b] of [['coal', '1-23'], ['coal', '24-47'], ['copper', '1-23'], ['copper', '24-47'], ['lapis', '80-119'], ['lapis', '120+'], ['redstone', '48-79'], ['redstone', '80-119'], ['redstone', '120+'], ['diamond', '48-79'], ['diamond', '80-119'], ['diamond', '120+'], ['emerald', '1-23'], ['emerald', '24-47'], ['emerald', '48-79']]) expect(s[`oreband.${f}.${b}`], `disjoint cell ${f} ${b}`).toBe(0);
		between(s['seam.oreDensMaxDev'], 0, 0.15, 'seamX'); between(s['seam.oreDensMaxDevZ'], 0, 0.15, 'seamZ'); expect(Math.abs(s['seam.contBorder'] - s['seam.contInner'])).toBeLessThanOrEqual(3); expect(Math.abs(s['seam.contBorderZ'] - s['seam.contInnerZ'])).toBeLessThanOrEqual(3);
		between(s['pct.granite'], 1.7, 2.1, 'granite'); between(s['pct.diorite'], 1.7, 2.05, 'diorite'); between(s['pct.andesite'], 1.7, 2.0, 'andesite'); between(s['pct.tuff'], 4.1, 5.05, 'tuff'); between(s['pct.calcite'], 0.34, 0.44, 'calcite'); between(s['pct.gravel'], 1.3, 1.96, 'gravel'); between(s['pct.clay'], 0.07, 0.18, 'clay'); between(s['pct.dirt'], 2.2, 3.25, 'dirt');
		between(s['count.amethyst'], 1750, 9150, 'amethyst'); between(s['geodes.perMap'], 16, 69, 'geodes'); between(s['pools.perMap'], 224, 383, 'pools');
		between(s['count.floaters'], 0, 60, 'floaters'); between(s['ravine.depth.max'], 0, 70, 'ravineDepth'); between(s['ravine.big'], 1, 40, 'ravine ≥ 40 columns');
		between(s['count.moss'], 16400, 29400, 'moss'); between(s['count.dripstone'], 13600, 21100, 'dripstone'); between(s['count.lava'], 200000, 499000, 'lava');
		between(s['T13.instancesMax'], 0, 580, 'instances'); between(s['trees.forestChunkMean'], 0.4, 15, 'forest trees');
	}, 180_000);
	it('the hand-transcribed band table goes RED on the coal-shift mutant (§11.7 proof, seed 1)', () => {
		// The mutant shifts the checker's idea of the coal band by +8 while the generator is untouched: the
		// hand table then disagrees with ≈ 1 800 coal voxels at y 60–67 on seed 1 (gate 2 closure measured 1 800, not 11). An imported table would stay green.
		const { exact } = checkMap(1, { bandShift: { coal: 8 } });
		expect(exact['T7.oreOutsideBand']).toBeGreaterThan(0);
	}, 180_000);
});
