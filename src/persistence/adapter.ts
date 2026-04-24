import type { BlockId } from '../data/blocks.data';

export type PlayerSave = {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	hotbar: BlockId[];
	selected: number;
};

export type WorldSummary = {
	seed: number;
	name: string;
	createdAt: number;
	updatedAt: number;
};

export type RawChunk = {
	cx: number;
	cz: number;
	blocks: Uint8Array;
	/** Optional sparse fluid metadata (flow voxels only). Absent on legacy saves. */
	fluidMeta?: Map<number, number>;
};

export type LightSave = { x: number; y: number; z: number; color: string };

// Callers always see decoded RawChunk[]. Encoding is handled internally by the adapter.
export type WorldSave = {
	version: 1;
	seed: number;
	name: string;
	createdAt: number;
	updatedAt: number;
	player: PlayerSave;
	chunks: RawChunk[]; // decoded on load, encoded by the adapter on save
	lights?: LightSave[];
};

export interface PersistenceAdapter {
	loadWorld(seed: number): Promise<WorldSave | null>;
	saveWorld(save: WorldSave): Promise<void>;
	listWorlds(): Promise<WorldSummary[]>;
	deleteWorld(seed: number): Promise<void>;
}
