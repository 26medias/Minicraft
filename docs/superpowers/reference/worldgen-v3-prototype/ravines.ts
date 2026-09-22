// ravine components (8-connected channel columns) per map; reports the number of components with >= 40 columns
import { column, inRavineChannel, fields } from './proto.ts';
const seeds = (process.argv[2] ?? '1').split(',').map(Number);
for (const seed of seeds) {
	const ch = new Uint8Array(512 * 512); let n = 0;
	for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { const c = column(seed, x, z); if (c.ravW > 0 && Math.abs(fields(seed).RAV(x / 230, z / 230)) < c.ravW + 0.005 && inRavineChannel(seed, x, z)) { ch[z * 512 + x] = 1; n++; } }
	const seen = new Uint8Array(512 * 512); const sizes: number[] = [];
	for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { if (!ch[z * 512 + x] || seen[z * 512 + x]) continue; let size = 0; const st = [x, z]; seen[z * 512 + x] = 1; while (st.length) { const zz = st.pop()!, xx = st.pop()!; size++; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const nx = xx + dx, nz = zz + dz; if (nx < 0 || nz < 0 || nx > 511 || nz > 511) continue; const k = nz * 512 + nx; if (ch[k] && !seen[k]) { seen[k] = 1; st.push(nx, nz); } } } sizes.push(size); }
	sizes.sort((a, b) => b - a);
	console.log(`seed ${seed}: channel columns ${n}, components ${sizes.length}, >=40: ${sizes.filter((s) => s >= 40).length}, largest ${sizes.slice(0, 3).join('/')}`);
}
