import { World } from '../engine/world/world';
import { blocksPerChunk, WORLD_CHUNKS_X, WORLD_CHUNKS_Z } from '../engine/world/coords';
import { fillChunkLights } from '../engine/world/lighting';
import { anyLiquid } from '../engine/world/generation';
import type { WorldSave } from '../persistence/adapter';
import { SaveCorrupt } from '../persistence/errors';

/** The World is built from the record itself; a summary row never sizes anything (spec §4, §6). */
export function worldFromSave(save: WorldSave): World {
	return new World(save.seed, { height: save.height, genVersion: save.genVersion, saveVersion: save.version });
}

/** All-or-nothing: a record that does not fit the world is never half-applied (and therefore never autosaved). */
export function applySave(world: World, save: WorldSave): void {
	const len = blocksPerChunk(world.height);
	for (const rc of save.chunks) {
		// localStorage builds cx/cz with Number() from the key; a malformed key gives NaN,
		// ensureChunk(NaN, NaN) makes a phantom chunk and the next save writes ":chunk:NaN:NaN".
		if (!Number.isInteger(rc.cx) || !Number.isInteger(rc.cz) || rc.cx < 0 || rc.cx >= WORLD_CHUNKS_X || rc.cz < 0 || rc.cz >= WORLD_CHUNKS_Z) {
			throw new SaveCorrupt(`chunk ${String(rc.cx)},${String(rc.cz)} is outside the world`);
		}
		if (rc.blocks.length !== len) throw new SaveCorrupt(`chunk ${rc.cx},${rc.cz} has ${rc.blocks.length} blocks, world height ${world.height} needs ${len}`);
	}
	for (const rc of save.chunks) {
		const c = world.ensureChunk(rc.cx, rc.cz);
		c.blocks.set(rc.blocks);
		c.fluidMeta.clear();
		if (rc.fluidMeta) for (const [idx, packed] of rc.fluidMeta) c.fluidMeta.set(idx, packed);
		c.modified = true;
		c.dirty = true;
		// A naturally dry chunk the kid poured water into is loaded, not generated: recompute (spec §3.E R-N4).
		c.hasLiquid = anyLiquid(c.blocks);
	}
	// Lights were computed at ensureChunk from generated blocks; recompute on the saved ones.
	for (const rc of save.chunks) {
		const c = world.getChunk(rc.cx, rc.cz);
		if (c) fillChunkLights(world, c);
	}
}
