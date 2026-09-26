/**
 * Writes src/assets/blocks/*.png, SOURCES.json, CREDITS.md and public/CREDITS.txt from
 * src/data/texture-sources.data.ts (texture replacement spec §4.2). Run by hand:
 *   npm run import-textures [-- --packs-dir <dir>] [--sheet <name...> [--out <png>]]
 * Without --packs-dir each pack is fetched at its pinned commit into a temp dir. Nothing is written until every row renders.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import sharp from 'sharp';
import { TILE } from '../src/data/texture-import';
import { decodePng, encodePng } from '../src/data/texture-png';
import { renderAll } from '../src/data/texture-render';
import { PACKS, type Pack } from '../src/data/texture-sources';
import { TEXTURE_SOURCES } from '../src/data/texture-sources.data';
import { creditsText } from '../src/data/texture-credits';

const ASSETS = 'src/assets/blocks';
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function fetchPack(pack: Pack, into: string): string {
	const dir = join(into, pack);
	const { repo, commit } = PACKS[pack];
	try {
		execFileSync('git', ['init', '-q', dir]);
		execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', repo, commit]);
		execFileSync('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
	} catch (e) {
		throw new Error(`Could not fetch ${pack} (${repo} @ ${commit}): ${(e as Error).message}`);
	}
	return dir;
}

function checkCommit(pack: Pack, dir: string): void {
	const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
	if (head !== PACKS[pack].commit) throw new Error(`${pack} checkout at ${dir} is ${head}, pinned ${PACKS[pack].commit}`);
}

/** Minecraft block-texture name → Luanti texture names, from Mineclonia's tools/Conversion_Table.csv. */
function loadNameMap(mineclonia: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	const csv = join(mineclonia, 'tools/Conversion_Table.csv');
	if (!existsSync(csv)) return map;
	for (const line of readFileSync(csv, 'utf8').split('\n')) {
		const f = line.split(',');
		if (f.length < 4 || !f[0].includes('/block') || !f[1].endsWith('.png') || !f[3].endsWith('.png')) continue;
		const mc = f[1].slice(0, -4), lu = f[3].slice(0, -4);
		map.set(mc, [...(map.get(mc) ?? []), lu]);
	}
	return map;
}
let nameMap = new Map<string, string[]>();

/** --sheet: current tile and pack candidates for the named textures, 8× nearest. Never inside the repo. */
async function writeSheet(names: string[], roots: Record<Pack, string>): Promise<void> {
	const out = resolve(arg('--out') ?? join(tmpdir(), `texture-sheet-${Date.now()}.png`));
	if (out.startsWith(resolve('.') + '/')) throw new Error(`--out must be outside the repo (got ${out})`);
	const Z = 8, cell = TILE * Z + 8;
	const rows = names.map((n) => {
		const c = [{ label: 'current', path: join(ASSETS, `${n}.png`) }];
		// Fill packs use Luanti names: map the Minecraft name through Mineclonia's Conversion_Table.csv.
		const wanted = new Set([n, ...(nameMap.get(n) ?? [])]);
		for (const p of Object.keys(roots) as Pack[]) {
			const all = execFileSync('find', [roots[p], '-name', '*.png']).toString().split('\n').filter(Boolean);
			for (const h of all) if (wanted.has(h.slice(h.lastIndexOf('/') + 1, -4))) c.push({ label: `${p}:${h.slice(roots[p].length + 1)}`, path: h });
		}
		return c;
	});
	const layers: sharp.OverlayOptions[] = [];
	for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
		if (!existsSync(rows[r][c].path)) continue;
		const big = await sharp(Buffer.from(await decodePng(rows[r][c].path)), { raw: { width: TILE, height: TILE, channels: 4 } })
			.resize(TILE * Z, TILE * Z, { kernel: 'nearest' }).png().toBuffer();
		layers.push({ input: big, left: c * cell, top: r * cell });
		console.log(`${names[r]} [${c}] ${rows[r][c].label}`);
	}
	const width = Math.max(1, ...rows.map((c) => c.length)) * cell;
	await sharp({ create: { width, height: Math.max(1, rows.length) * cell, channels: 4, background: { r: 40, g: 40, b: 44, alpha: 1 } } })
		.composite(layers).png().toFile(out);
	console.log(`Sheet: ${out}`);
}

async function main() {
	const packsDir = arg('--packs-dir');
	const tmp = packsDir ? null : mkdtempSync(join(tmpdir(), 'minicraft-packs-'));
	try {
		const roots = {} as Record<Pack, string>;
		for (const p of Object.keys(PACKS) as Pack[]) {
			// realpath: --packs-dir may hold symlinks, which `find` would not descend.
			roots[p] = realpathSync(packsDir ? resolve(packsDir, p) : fetchPack(p, tmp!));
			checkCommit(p, roots[p]);
		}
		const sheetAt = argv.indexOf('--sheet');
		if (sheetAt >= 0) {
			nameMap = loadNameMap(roots.mineclonia);
			const outPath = arg('--out');
			await writeSheet(argv.slice(sheetAt + 1).filter((a) => !a.startsWith('--') && a !== outPath), roots);
			return;
		}
		// renderAll is synchronous: decode every pack file first.
		const decoded = new Map<string, Uint8Array>();
		for (const r of Object.values(TEXTURE_SOURCES)) if ('pack' in r) {
			const key = `${r.pack}\u0000${r.file}`;
			if (!decoded.has(key)) decoded.set(key, await decodePng(join(roots[r.pack], r.file)));
		}
		const tiles = renderAll(TEXTURE_SOURCES, (p, f) => decoded.get(`${p}\u0000${f}`)!); // throws before any write
		const sources: Record<string, unknown> = {};
		for (const [name, tile] of [...tiles].sort(([a], [b]) => a.localeCompare(b))) {
			const png = await encodePng(tile);
			writeFileSync(join(ASSETS, `${name}.png`), png);
			const r = TEXTURE_SOURCES[name];
			const sha256 = createHash('sha256').update(png).digest('hex');
			sources[name] = 'same' in r || 'flat' in r ? { ...r, sha256 } : { ...r, commit: PACKS[r.pack].commit, sha256 };
		}
		for (const f of readdirSync(ASSETS)) if (f.endsWith('.png') && !tiles.has(f.slice(0, -4))) unlinkSync(join(ASSETS, f));
		writeFileSync(join(ASSETS, 'SOURCES.json'), JSON.stringify(sources, null, '\t') + '\n');
		const credits = creditsText(TEXTURE_SOURCES);
		if (credits) {
			writeFileSync('CREDITS.md', credits);
			mkdirSync('public', { recursive: true });
			writeFileSync('public/CREDITS.txt', credits);
		}
		console.log(`Wrote ${tiles.size} textures to ${ASSETS}`);
	} finally {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	}
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); exit(1); });
