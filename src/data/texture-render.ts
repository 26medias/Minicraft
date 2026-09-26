/** Row → 16×16 RGBA tile (texture replacement spec §4.2, §5). Pure; the caller supplies pack-file pixels. */
import { greyTint } from './atlas-derive';
import { alphaZeroFraction, composite, normaliseAlpha } from './texture-import';
import { alphaModeFor, resolveOrder, type Pack, type TextureSource } from './texture-sources';

export class ImportRefusal extends Error {}
const MAX_ALPHA_ZERO = 0.05;

export function renderAll(rows: Record<string, TextureSource>, readPack: (pack: Pack, file: string) => Uint8Array): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	for (const name of resolveOrder(rows)) {
		const row = rows[name];
		const mode = alphaModeFor(name);
		let tile: Uint8Array;
		if ('same' in row) {
			tile = new Uint8Array(out.get(row.same)!);
		} else if ('over' in row) {
			tile = composite(out.get(row.over)!, readPack(row.pack, row.file), row.overlayAlpha ?? 1);
		} else {
			const src = readPack(row.pack, row.file);
			if (mode === 'opaque' && alphaZeroFraction(src) > MAX_ALPHA_ZERO)
				throw new ImportRefusal(`${name}: ${row.pack}/${row.file} has ${(alphaZeroFraction(src) * 100).toFixed(1)}% fully transparent pixels on an opaque block; make it an \`over\` row`);
			tile = 'derive' in row ? greyTint(src, row.tint, row.targetLum) : src;
		}
		out.set(name, normaliseAlpha(tile, 'same' in row ? 'keep' : mode));
	}
	return out;
}
