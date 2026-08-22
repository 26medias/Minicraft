/**
 * crypto.randomUUID is only defined in a secure context. A tablet reaching the LAN
 * dev server over plain http://192.168.x.x is exactly that case, and new-world
 * creation would throw there.
 */
export function newWorldId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	const b = new Uint8Array(16);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(b);
	} else {
		for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
	}
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
	return [
		h.slice(0, 4).join(''),
		h.slice(4, 6).join(''),
		h.slice(6, 8).join(''),
		h.slice(8, 10).join(''),
		h.slice(10, 16).join(''),
	].join('-');
}

const LEGACY_PREFIX = 'legacy:';

export function legacyId(seed: number): string {
	return `${LEGACY_PREFIX}${seed}`;
}

export function isLegacyId(id: string): boolean {
	return id.startsWith(LEGACY_PREFIX);
}

export function seedFromLegacyId(id: string): number {
	return Number(id.slice(LEGACY_PREFIX.length));
}
