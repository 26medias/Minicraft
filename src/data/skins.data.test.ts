import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKINS, skinOf, skinColor } from './skins.data';

const DIR = join(__dirname, '../assets/skins');

function pngSize(path: string): [number, number] {
	const b = readFileSync(path);
	expect(b.subarray(1, 4).toString('ascii')).toBe('PNG');
	return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function rgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lightness([r, g, b]: [number, number, number]): number {
	return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
}

describe('skin catalog', () => {
	it('lists the six characters, Milo first', () => {
		expect(SKINS.map((s) => s.id)).toEqual(['milo', 'chip', 'crazy-fan-girl', 'jj', 'mikey', 'enderman']);
		expect(SKINS.filter((s) => s.slim).map((s) => s.id)).toEqual(['milo', 'chip']);
	});

	it('every file exists and is 64×64 (the Enderman is legacy 64×32)', () => {
		for (const s of SKINS) {
			const p = join(DIR, s.file);
			expect(existsSync(p), s.file).toBe(true);
			expect(pngSize(p), s.file).toEqual(s.id === 'enderman' ? [64, 32] : [64, 64]);
		}
	});

	it('ids are unique and fit the 32-byte wire limit', () => {
		expect(new Set(SKINS.map((s) => s.id)).size).toBe(SKINS.length);
		for (const s of SKINS) expect(new TextEncoder().encode(s.id).length).toBeLessThanOrEqual(32);
	});

	it('unknown, empty and old colour ids resolve to Milo', () => {
		expect(skinOf('red')).toBe(SKINS[0]);
		expect(skinOf('')).toBe(SKINS[0]);
		expect(skinOf('plaid')).toBe(SKINS[0]);
		expect(skinColor('red')).toBe(SKINS[0].color);
		expect(skinOf('jj').id).toBe('jj');
	});

	it('colours are bright and far apart (minimap dots, label borders)', () => {
		for (const s of SKINS) {
			const l = lightness(rgb(s.color));
			expect(l, s.id).toBeGreaterThanOrEqual(0.3);
			expect(l, s.id).toBeLessThanOrEqual(0.75);
		}
		for (let i = 0; i < SKINS.length; i++) for (let j = i + 1; j < SKINS.length; j++) {
			const [a, b] = [rgb(SKINS[i].color), rgb(SKINS[j].color)];
			const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
			expect(d, `${SKINS[i].id}/${SKINS[j].id}`).toBeGreaterThanOrEqual(80);
		}
	});
});
