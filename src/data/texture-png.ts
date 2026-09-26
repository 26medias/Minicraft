/** PNG decode/encode for the texture importer and guard tests (texture replacement spec §4.2). */
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { TILE } from './texture-import';

/** Frame 0 of a PNG as 16×16 RGBA (animated strips are taller than wide; other sizes nearest-resized). */
export async function decodePng(path: string): Promise<Uint8Array> {
	if (!existsSync(path)) throw new Error(`Missing file ${path}`);
	const meta = await sharp(path).metadata();
	const w = meta.width ?? TILE;
	let img = sharp(path);
	if ((meta.height ?? w) > w) img = img.extract({ left: 0, top: 0, width: w, height: w });
	const { data, info } = await img.resize(TILE, TILE, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	if (info.width !== TILE || info.height !== TILE || info.channels !== 4) throw new Error(`Bad decode of ${path}`);
	return new Uint8Array(data);
}

/** Deterministic PNG bytes for a tile (Review Focus 2): fixed settings, no metadata. */
export async function encodePng(tile: Uint8Array, size = TILE): Promise<Buffer> {
	return sharp(Buffer.from(tile), { raw: { width: size, height: size, channels: 4 } })
		.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
}
