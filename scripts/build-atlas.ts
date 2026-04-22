import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exit } from 'node:process';
import sharp from 'sharp';
import { BLOCKS } from '../src/data/blocks.data.js';

const ATLAS_SIZE = 512;
const TILE = 16;
const PADDING = 2;
const CELL = TILE + PADDING * 2; // 20
const TILES_PER_ROW = Math.floor(ATLAS_SIZE / CELL); // 25

const ASSETS_DIR = 'src/assets/blocks';
const OUT_PNG = 'public/atlas.png';
const OUT_JSON = 'public/atlas.json';

// Textures shipped by Mojang as grayscale masks that the game tints at runtime.
// We have no biomes, so the tint is baked in at build time.
const TEXTURE_TINTS: Record<string, [number, number, number]> = {
	grass_block_top: [0x79, 0xc0, 0x5a], // plains-biome grass green
	water_still: [0x3f, 0x76, 0xe4], // Minecraft plains-biome water blue
};

function applyTint(raw: Uint8Array, tint: [number, number, number]): Uint8Array {
	const [tr, tg, tb] = tint;
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 4) {
		out[i + 0] = Math.round((raw[i + 0] * tr) / 255);
		out[i + 1] = Math.round((raw[i + 1] * tg) / 255);
		out[i + 2] = Math.round((raw[i + 2] * tb) / 255);
		out[i + 3] = raw[i + 3];
	}
	return out;
}

async function main() {
	const names = new Set<string>();
	for (const b of BLOCKS) {
		if (!b.textures) continue;
		const t = b.textures;
		if (t.kind === 'uniform') names.add(t.all);
		else if (t.kind === 'top-bottom-side') {
			names.add(t.top);
			names.add(t.bottom);
			names.add(t.side);
		} else if (t.kind === 'columnar') {
			names.add(t.top);
			names.add(t.bottom);
			names.add(t.sides);
		} else if (t.kind === 'six') {
			names.add(t.px);
			names.add(t.nx);
			names.add(t.py);
			names.add(t.ny);
			names.add(t.pz);
			names.add(t.nz);
		} else {
			throw new Error(`Unknown texture kind: ${(t as { kind: string }).kind}`);
		}
	}

	const sorted = [...names].sort();
	if (sorted.length > TILES_PER_ROW * TILES_PER_ROW) {
		throw new Error(`Atlas too small: ${sorted.length} tiles > ${TILES_PER_ROW ** 2} capacity`);
	}

	const canvas = sharp({
		create: {
			width: ATLAS_SIZE,
			height: ATLAS_SIZE,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	});

	const composites: sharp.OverlayOptions[] = [];
	const tiles: Record<string, { u: number; v: number; w: number; h: number }> = {};

	for (let i = 0; i < sorted.length; i++) {
		const name = sorted[i];
		const col = i % TILES_PER_ROW;
		const row = Math.floor(i / TILES_PER_ROW);
		const x = col * CELL;
		const y = row * CELL;

		const tilePath = join(ASSETS_DIR, `${name}.png`);
		// ensureAlpha() forces 4-channel RGBA regardless of the source PNG's channel count — Mojang's
		// Phase 1 assets mix RGB and RGBA, and padEdgeReplicate's stride math assumes 4 channels.
		const img = sharp(tilePath).resize(TILE, TILE, { kernel: 'nearest' }).ensureAlpha();
		const raw = await img.raw().toBuffer({ resolveWithObject: true });
		if (raw.info.width !== TILE || raw.info.height !== TILE) {
			throw new Error(
				`Unexpected tile size for ${name}: ${raw.info.width}x${raw.info.height}`,
			);
		}
		if (raw.info.channels !== 4) {
			throw new Error(`Expected 4-channel RGBA for ${name}, got ${raw.info.channels}`);
		}

		const tint = TEXTURE_TINTS[name];
		const pixels = tint ? applyTint(raw.data, tint) : raw.data;

		const padded = padEdgeReplicate(pixels, TILE, PADDING);
		composites.push({
			input: padded,
			left: x,
			top: y,
			raw: { width: CELL, height: CELL, channels: 4 },
		});
		tiles[name] = { u: x + PADDING, v: y + PADDING, w: TILE, h: TILE };
	}

	await mkdir(dirname(OUT_PNG), { recursive: true });
	await canvas.composite(composites).png({ compressionLevel: 9 }).toFile(OUT_PNG);
	await writeFile(
		OUT_JSON,
		JSON.stringify({ size: ATLAS_SIZE, tileSize: TILE, tiles }, null, '\t'),
	);

	console.log(`Wrote ${sorted.length} tiles to ${OUT_PNG} (${ATLAS_SIZE}x${ATLAS_SIZE})`);
}

function padEdgeReplicate(src: Uint8Array, size: number, pad: number): Buffer {
	const cell = size + pad * 2;
	const out = Buffer.alloc(cell * cell * 4);
	const read = (x: number, y: number) => {
		const cx = Math.max(0, Math.min(size - 1, x));
		const cy = Math.max(0, Math.min(size - 1, y));
		return (cy * size + cx) * 4;
	};
	for (let y = 0; y < cell; y++) {
		for (let x = 0; x < cell; x++) {
			const srcIdx = read(x - pad, y - pad);
			const dstIdx = (y * cell + x) * 4;
			out[dstIdx + 0] = src[srcIdx + 0];
			out[dstIdx + 1] = src[srcIdx + 1];
			out[dstIdx + 2] = src[srcIdx + 2];
			out[dstIdx + 3] = src[srcIdx + 3];
		}
	}
	return out;
}

main().catch((err) => {
	console.error(err);
	exit(1);
});
