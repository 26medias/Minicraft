import alea from 'alea';

export interface Prng {
	float(): number;
	intBetween(min: number, max: number): number;
}

export function createPrng(seed: number | string): Prng {
	const rng = alea(String(seed));
	return {
		float: () => rng(),
		intBetween: (min, max) => Math.floor(rng() * (max - min + 1)) + min,
	};
}
