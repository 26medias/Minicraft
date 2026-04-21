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

export type EncodedChunk = { cx: number; cz: number; data: string };
export type RawChunk = { cx: number; cz: number; blocks: Uint8Array };

export type WorldSave = {
	version: 1;
	seed: number;
	name: string;
	createdAt: number;
	updatedAt: number;
	player: PlayerSave;
	modifiedChunks: EncodedChunk[]; // on disk
	rawChunks?: RawChunk[]; // runtime convenience; the adapter encodes/decodes
};

export interface PersistenceAdapter {
	loadWorld(seed: number): Promise<WorldSave | null>;
	saveWorld(save: WorldSave): Promise<void>;
	listWorlds(): Promise<WorldSummary[]>;
	deleteWorld(seed: number): Promise<void>;
}
