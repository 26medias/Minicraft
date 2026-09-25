import { skinOf } from '../../data/skins.data';

/** Skin PNG URLs by file name (Vite inlines these tiny files as data: URIs). */
const URLS = import.meta.glob('../../assets/skins/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** The PNG URL for a skin id; unknown ids get the default skin's. */
export function skinUrl(id: string): string {
	const file = skinOf(id).file;
	const url = URLS[`../../assets/skins/${file}`];
	if (!url) throw new Error(`skin file missing: ${file}`);
	return url;
}
