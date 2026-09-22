import { readFileSync } from 'node:fs';
const rows = process.argv.slice(2).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)));
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ex: Record<string, number> = {}, exSeeds: Record<string, number[]> = {}; const st: Record<string, number[]> = {};
for (const r of rows) { for (const [k, v] of Object.entries(r.exact)) { ex[k] = (ex[k] ?? 0) + (v as number); if (v) (exSeeds[k] ??= []).push(r.seed); } for (const [k, v] of Object.entries(r.stats)) (st[k] ??= []).push(v as number); }
console.log(`seeds: ${rows.length} (${rows.map((r) => r.seed).sort((a, b) => a - b).join(',')})`);
console.log('== EXACT (sum over seeds; must be 0) ==');
for (const [k, v] of Object.entries(ex).sort()) console.log(`${v === 0 ? 'ok ' : 'RED'} ${k} = ${v}${v ? ' seeds ' + exSeeds[k].join(',') : ''}`);
console.log('== STATS min / p10 / p50 / p90 / max ==');
for (const [k, v] of Object.entries(st).sort()) console.log(`${k.padEnd(28)} ${[0, 0.1, 0.5, 0.9, 1].map((p) => q(v, p).toFixed(2)).join(' / ')}`);
