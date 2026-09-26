/**
 * Pre-merge provenance audit (texture replacement spec §6.1). Reads the local Minecraft jar; never commits Mojang pixels.
 * Prints, per shipped tile, the trace score against Mojang's same-name tile, and exits 1 if any tile is ≥ 95% identical.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env, exit } from 'node:process';
import sharp from 'sharp';

const JAR = env.MINECRAFT_JAR ?? join(env.HOME ?? '', '.minecraft/versions/1.21.6/1.21.6.jar');
async function rgba(p: string): Promise<Float64Array> {
	const m = await sharp(p).metadata(); const w = m.width ?? 16;
	let img = sharp(p); if ((m.height ?? w) > w) img = img.extract({ left: 0, top: 0, width: w, height: w });
	const { data } = await img.resize(16, 16, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return Float64Array.from(data);
}
function trace(a: Float64Array, b: Float64Array): number {
	const la: number[] = [], lb: number[] = [];
	for (let i = 0; i < a.length; i += 4) {
		la.push(((a[i] + a[i + 1] + a[i + 2]) / 3) * (a[i + 3] / 255));
		lb.push(((b[i] + b[i + 1] + b[i + 2]) / 3) * (b[i + 3] / 255));
	}
	const ma = la.reduce((s, x) => s + x, 0) / la.length, mb = lb.reduce((s, x) => s + x, 0) / lb.length;
	let n = 0, da = 0, db = 0;
	for (let i = 0; i < la.length; i++) { n += (la[i] - ma) * (lb[i] - mb); da += (la[i] - ma) ** 2; db += (lb[i] - mb) ** 2; }
	return n / Math.sqrt(da * db + 1e-9);
}
function identical(a: Float64Array, b: Float64Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) < 8) s++;
	return s / (a.length / 4);
}
async function main() {
	if (!existsSync(JAR)) { console.error(`Minecraft jar not found at ${JAR}. Set MINECRAFT_JAR.`); exit(2); }
	const tmp = mkdtempSync(join(tmpdir(), 'minicraft-audit-'));
	try {
		execFileSync('unzip', ['-oq', JAR, 'assets/minecraft/textures/block/*', '-d', tmp]);
		const dir = join(tmp, 'assets/minecraft/textures/block');
		let bad = 0; const flagged: string[] = [];
		for (const f of readdirSync('src/assets/blocks').filter((f) => f.endsWith('.png')).sort()) {
			const m = join(dir, f);
			if (!existsSync(m)) continue;
			const a = await rgba(join('src/assets/blocks', f)), b = await rgba(m);
			const t = trace(a, b), id = identical(a, b);
			if (id >= 0.95) bad++;
			if (t > 0.8 || id >= 0.95) flagged.push(`${f.slice(0, -4)}\ttrace ${t.toFixed(2)}\tidentical ${(id * 100).toFixed(0)}%`);
		}
		console.log(flagged.length ? flagged.join('\n') : 'No tile scores above 0.8.');
		console.log(`${bad} tiles ≥ 95% identical to Mojang.`);
		exit(bad > 0 ? 1 : 0);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
}
main().catch((e) => { console.error(e); exit(1); });
