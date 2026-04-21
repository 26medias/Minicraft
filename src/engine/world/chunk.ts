import type { BlockId } from '../../data/blocks.data';
import { BLOCKS_PER_CHUNK, indexOf } from './coords';

export class Chunk {
	readonly cx: number;
	readonly cz: number;
	readonly blocks: Uint8Array;
	dirty = true;
	modified = false;

	constructor(cx: number, cz: number) {
		this.cx = cx;
		this.cz = cz;
		this.blocks = new Uint8Array(BLOCKS_PER_CHUNK);
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
}
