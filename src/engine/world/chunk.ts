import type { BlockId } from '../../data/blocks.data';
import { BLOCKS_PER_CHUNK, indexOf } from './coords';

export class Chunk {
	readonly cx: number;
	readonly cz: number;
	readonly blocks: Uint8Array;
	readonly lights: Uint16Array;
	readonly sunlit: Uint8Array;
	readonly liquidFrontier: Set<number> = new Set();
	dirty = true;
	modified = false;
	shadowsDirty = true;

	constructor(cx: number, cz: number) {
		this.cx = cx;
		this.cz = cz;
		this.blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		this.lights = new Uint16Array(BLOCKS_PER_CHUNK);
		this.sunlit = new Uint8Array(BLOCKS_PER_CHUNK);
	}

	get(x: number, y: number, z: number): BlockId {
		return this.blocks[indexOf(x, y, z)];
	}

	set(x: number, y: number, z: number, id: BlockId): void {
		const i = indexOf(x, y, z);
		if (this.blocks[i] === id) return;
		this.blocks[i] = id;
		this.dirty = true;
		this.modified = true;
	}

	getSky(x: number, y: number, z: number): number {
		return (this.lights[indexOf(x, y, z)] >> 12) & 0xf;
	}

	setSky(x: number, y: number, z: number, v: number): void {
		const i = indexOf(x, y, z);
		const masked = Math.min(15, Math.max(0, v)) & 0xf;
		this.lights[i] = (this.lights[i] & 0x0fff) | (masked << 12);
	}

	getBlockR(x: number, y: number, z: number): number {
		return (this.lights[indexOf(x, y, z)] >> 8) & 0xf;
	}

	getBlockG(x: number, y: number, z: number): number {
		return (this.lights[indexOf(x, y, z)] >> 4) & 0xf;
	}

	getBlockB(x: number, y: number, z: number): number {
		return this.lights[indexOf(x, y, z)] & 0xf;
	}

	setBlockRGB(x: number, y: number, z: number, r: number, g: number, b: number): void {
		const i = indexOf(x, y, z);
		const rm = Math.min(15, Math.max(0, r)) & 0xf;
		const gm = Math.min(15, Math.max(0, g)) & 0xf;
		const bm = Math.min(15, Math.max(0, b)) & 0xf;
		this.lights[i] = (this.lights[i] & 0xf000) | (rm << 8) | (gm << 4) | bm;
	}
}
