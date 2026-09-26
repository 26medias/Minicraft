/** CREDITS.md / public/CREDITS.txt text (texture replacement spec §4.4). Pure. */
import { PACKS, type Pack, type TextureSource } from './texture-sources';

export function creditsText(rows: Record<string, TextureSource>): string {
	const used = new Set<Pack>();
	for (const r of Object.values(rows)) if ('pack' in r) used.add(r.pack);
	const derived = Object.entries(rows).filter(([, r]) => 'derive' in r || 'over' in r).map(([n, r]) =>
		'derive' in r ? `- ${n}: ${r.pack} ${r.file}, greyscaled and tinted` : `- ${n}: ${(r as { pack: Pack; file: string }).pack} ${(r as { file: string }).file}, composited over ${(r as { over: string }).over}`);
	const packs = (Object.keys(PACKS) as Pack[]).filter((p) => used.has(p)).map((p) => {
		const x = PACKS[p];
		return [`## ${x.title}`, `- Authors: ${x.authors}`, `- Source: ${x.url} (${x.repo} @ ${x.commit})`, `- Licence: ${x.licence} — ${x.licenceUri}`].join('\n');
	});
	return [
		'# Minicraft texture credits',
		'',
		'The block textures in Minicraft (src/assets/blocks/, and public/atlas.png built from them) are adaptations of the',
		'following works, used under Creative Commons Attribution-ShareAlike licences.',
		'',
		...packs.flatMap((s) => [s, '']),
		'## Changes',
		'',
		'All tiles were modified: cropped to frame 0 of any animation, resized to 16×16 where needed, and their alpha',
		'normalised to the game\'s block flags (forced opaque, snapped to 0/255, or kept). Some tiles were greyscaled and',
		'tinted, and some were composited from two sources. Grass tops and some leaves are tinted when the atlas is built.',
		'Derived and composited tiles:',
		'',
		...derived,
		'',
		'## Licence scope',
		'',
		'These adapted textures are licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).',
		'public/atlas.png is a collection of these tiles; the share-alike licence applies to the tiles and does not extend to the game code.',
		'',
		'The works are provided as-is, without warranties of any kind; see the licence text.',
		'',
	].join('\n');
}
