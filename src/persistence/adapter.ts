import type { BlockId } from '../data/blocks.data';
import type { WorldHeight } from '../engine/world/coords';

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
	id: string;
	seed: number;
	name: string;
	createdAt: number;
	updatedAt: number;
	origin: 'cloud' | 'local';
	sizeBytes?: number;
	/** Cloud object whose metadata could not be read. Listed anyway — never skipped. */
	degraded?: boolean;
	/** Save format the record lives in. */
	version: 2 | 3;
	/** Absent on a degraded cloud row, and on a v3 row whose stored height is not 64|256. */
	height?: WorldHeight;
};

export type RawChunk = {
	cx: number;
	cz: number;
	blocks: Uint16Array;
	/** Optional sparse fluid metadata (flow voxels only). Absent on legacy saves. */
	fluidMeta?: Map<number, number>;
};

export type LightSave = { x: number; y: number; z: number; color: string };

/** Chunks already in wire form, so a composing adapter encodes once for both legs. */
export type EncodedChunk = { cx: number; cz: number; blocks: string; fluidMeta?: string };

export type SaveResult = {
	local: 'ok' | 'quota' | 'error';
	cloud: 'ok' | 'failed' | 'skipped';
};

// Callers always see decoded RawChunk[]. Encoding is handled internally by the adapter.
export type WorldSave = {
	/** Fixed for the life of a world. 2 = legacy 64-high namespace, 3 = tall. */
	version: 2 | 3;
	/** Authoritative for every array size. A v2 record is normalised to 64 on load. */
	height: WorldHeight;
	genVersion: number;
	/** Immutable identity. The seed is worldgen input only — two worlds may share one. */
	id: string;
	seed: number;
	name: string;
	createdAt: number;
	updatedAt: number;
	player: PlayerSave;
	chunks: RawChunk[]; // decoded on load, encoded by the adapter on save
	lights?: LightSave[];
	/** GCS generation this copy was derived from; null when never synced. */
	lastSyncedGeneration?: string | null;
};

export interface PersistenceAdapter {
	loadWorld(id: string): Promise<WorldSave | null>;
	saveWorld(save: WorldSave, pre?: EncodedChunk[]): Promise<SaveResult>;
	listWorlds(): Promise<WorldSummary[]>;
	deleteWorld(id: string): Promise<void>;
}
