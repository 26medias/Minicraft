// COLD timing: fresh memo, spawnV3 first, then the 81 chunks around spawn. Run alone.
import { generateChunkV3, spawnInfo, clearMemo } from './proto.ts';
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const seed of (process.argv[2] ?? '1,3,7,12,21,34,55,89').split(',').map(Number)) {
	clearMemo(); const si = spawnInfo(seed); const t: number[] = [];
	for (let cz = (si.z >> 4) - 4; cz <= (si.z >> 4) + 4; cz++) for (let cx = (si.x >> 4) - 4; cx <= (si.x >> 4) + 4; cx++) if (cx >= 0 && cz >= 0 && cx < 32 && cz < 32) t.push(generateChunkV3(new Uint16Array(65536), seed, cx, cz).ms);
	console.log(`seed ${seed}: spawn ${si.ms.toFixed(0)} ms (work ${si.work} columns) | 81 cold: mean ${(t.reduce((a, b) => a + b) / t.length).toFixed(2)} p95 ${q(t, 0.95).toFixed(2)} max ${q(t, 1).toFixed(2)}`);
}
