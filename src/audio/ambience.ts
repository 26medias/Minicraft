// Water and wind levels around the listener (sound spec §5, §6). Pure: reads cells through a
// sampler that answers only for loaded chunks, so it is tested on a fake world.

export type WaterCell = 'none' | 'source' | 'flow';

export type Sampler = {
	/** What water is at a cell; 'none' for anything else, including unloaded cells. */
	water(x: number, y: number, z: number): WaterCell;
	/** True when the cell is not solid and not water: open air above a lake surface. */
	open(x: number, y: number, z: number): boolean;
	/** True when the cell is air: a waterfall needs air beside it (a pond's walls are not). */
	air(x: number, y: number, z: number): boolean;
};

export type WaterLevels = { lake: number; stream: number; waterfall: number };

export const SCAN_H = 12;
export const SCAN_DOWN = 8;
export const SCAN_UP = 8;
export const FALLOFF = 13;
/** The summed weight that reads as full volume (engine review: median Σw is 35 on a shore, 0.9 at 8 blocks). */
export const SUM_FULL = 20;

const SIDES: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Every water cell in the box around the eye, weighted by distance w = (1 − d/13)².
 * Waterfall: a flow cell with water above it and air on a side (a falling column seen from outside).
 * Stream: any other flow cell. Lake: a source cell with open air above (the surface only).
 * A class's level is the larger of its nearest weight and its summed weight / 20, capped at 1:
 * one cell next to you reads clearly, and a big lake is louder than a puddle without jumping to
 * full volume the moment it is in range. Generated worlds hold only source water (rivers too), so
 * stream and waterfall come from water the player pours.
 */
export function waterLevels(s: Sampler, ex: number, ey: number, ez: number): WaterLevels {
	const bx = Math.floor(ex), by = Math.floor(ey), bz = Math.floor(ez);
	const best = { lake: 0, stream: 0, waterfall: 0 };
	const sum = { lake: 0, stream: 0, waterfall: 0 };
	for (let y = by - SCAN_DOWN; y <= by + SCAN_UP; y++) {
		for (let x = bx - SCAN_H; x <= bx + SCAN_H; x++) {
			for (let z = bz - SCAN_H; z <= bz + SCAN_H; z++) {
				const w = s.water(x, y, z);
				if (w === 'none') continue;
				const dx = x + 0.5 - ex, dy = y + 0.5 - ey, dz = z + 0.5 - ez;
				const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
				if (d >= FALLOFF) continue;
				let kind: keyof WaterLevels;
				if (w === 'source') {
					if (!s.open(x, y + 1, z)) continue;
					kind = 'lake';
				} else if (s.water(x, y + 1, z) !== 'none' && SIDES.some(([sx, sz]) => s.air(x + sx, y, z + sz))) {
					kind = 'waterfall';
				} else {
					kind = 'stream';
				}
				const weight = (1 - d / FALLOFF) ** 2;
				if (weight > best[kind]) best[kind] = weight;
				sum[kind] += weight;
			}
		}
	}
	const level = (k: keyof WaterLevels) => Math.min(1, Math.max(best[k], sum[k] / SUM_FULL));
	return { lake: level('lake'), stream: level('stream'), waterfall: level('waterfall') };
}

export type WindLevels = { light: number; strong: number };

export const ramp = (x: number, a: number, b: number): number => Math.min(1, Math.max(0, (x - a) / (b - a)));

/**
 * Wind from height above the sea (spec §6), only under the open sky. `span` is the world's height
 * above the sea (136 on 256-high worlds).
 */
export function windLevels(eyeY: number, sea: number, worldHeight: number, underSky: boolean): WindLevels {
	if (!underSky) return { light: 0, strong: 0 };
	const h = eyeY - sea;
	const span = worldHeight - sea;
	const strong = ramp(h, 0.3 * span, 0.75 * span);
	const light = ramp(h, 0.12 * span, 0.35 * span) * (1 - 0.6 * strong);
	return { light, strong };
}
