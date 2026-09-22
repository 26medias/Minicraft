// On-demand §11 instrument. Run: ./node_modules/.bin/tsx scripts/worldgen-check.ts 1,2,3,5,8,13,21,34   (JSONL=1 for one JSON line per seed)
// Exits 1 when any exact counter is non-zero on any seed (bounds on the stats are asserted by mapcheck.test.ts on seeds 1 and 2; this prints min/p50/max for the sweep).
import { checkMap } from '../src/engine/world/v3/mapcheck';
const seeds = (process.argv[2] ?? '1,2').split(',').map(Number);
const agg: Record<string, number[]> = {}; const exactSum: Record<string, number> = {};
for (const seed of seeds) {
	const t0 = performance.now(); const { exact, stats } = checkMap(seed);
	for (const [k, v] of Object.entries(exact)) exactSum[k] = (exactSum[k] ?? 0) + v; for (const [k, v] of Object.entries(stats)) (agg[k] ??= []).push(v);
	if (process.env.JSONL) console.log(JSON.stringify({ seed, exact, stats }));
	console.error(`seed ${seed} done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
let red = 0;
if (!process.env.JSONL) {
	const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
	console.log('== EXACT (must be 0) =='); for (const [k, v] of Object.entries(exactSum).sort()) { if (v !== 0) red++; console.log(`${v === 0 ? 'ok ' : 'RED'} ${k} = ${v}`); }
	console.log(`== STATS over ${seeds.length} seeds (min / p50 / max) ==`); for (const [k, v] of Object.entries(agg).sort()) console.log(`${k.padEnd(28)} ${q(v, 0).toFixed(2)} / ${q(v, 0.5).toFixed(2)} / ${q(v, 1).toFixed(2)}`);
} else red = Object.values(exactSum).filter((v) => v !== 0).length;
if (red) { console.error(`worldgen:check RED — ${red} exact counter(s) non-zero`); process.exit(1); }
