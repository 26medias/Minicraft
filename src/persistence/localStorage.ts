import type {
	EncodedChunk,
	PersistenceAdapter,
	RawChunk,
	SaveResult,
	WorldSave,
	WorldSummary,
} from './adapter';
import { blocksPerChunk, isWorldHeight, LEGACY_HEIGHT } from '../engine/world/coords';
import { decodeChunk, decodeFluidMeta, encodeChunk, encodeFluidMeta } from './codec';
import { SaveCorrupt } from './errors';
import { isLegacyId, legacyId, seedFromLegacyId } from './uuid';

type ChunkPayload = { blocks: string; fluidMeta?: string };

const NS = 'minicraft:v1';
const V2 = 'minicraft:v2';
const V3 = 'minicraft:v3';

/** Every v1/v2 record is a 64-high column; the height is implied, never stored. */
const LEGACY_LEN = blocksPerChunk(LEGACY_HEIGHT);

const metaKey = (seed: number) => `${NS}:world:${seed}:meta`;
const chunkPrefix = (seed: number) => `${NS}:world:${seed}:chunk:`;

const v2MetaKey = (id: string) => `${V2}:world:${id}:meta`;
const v2ChunkKey = (id: string, cx: number, cz: number) => `${V2}:world:${id}:chunk:${cx}:${cz}`;
const v2ChunkPrefix = (id: string) => `${V2}:world:${id}:chunk:`;

const v3MetaKey = (id: string) => `${V3}:world:${id}:meta`;
const v3ChunkKey = (id: string, cx: number, cz: number) => `${V3}:world:${id}:chunk:${cx}:${cz}`;
const v3ChunkPrefix = (id: string) => `${V3}:world:${id}:chunk:`;

type Namespace = {
	meta: (id: string) => string;
	chunk: (id: string, cx: number, cz: number) => string;
	prefix: (id: string) => string;
};
const V2_NS: Namespace = { meta: v2MetaKey, chunk: v2ChunkKey, prefix: v2ChunkPrefix };
const V3_NS: Namespace = { meta: v3MetaKey, chunk: v3ChunkKey, prefix: v3ChunkPrefix };

/** Maps a legacy seed to the uuid minted for it, so a legacy world is adopted once. */
const legacyMapKey = (seed: number) => `${V2}:legacy-map:${seed}`;

/** The one on-disk chunk shape, shared by the write loop and the shrink guard. */
function payloadOf(c: EncodedChunk): ChunkPayload {
	return c.fluidMeta === undefined ? { blocks: c.blocks } : { blocks: c.blocks, fluidMeta: c.fluidMeta };
}

export class LocalStorageAdapter implements PersistenceAdapter {
	constructor(private storage: Storage = localStorage) {}

	/**
	 * The uuid a legacy world has been adopted under, if any. Playing a legacy world
	 * must not write v2 records under its `legacy:` id: on the next launch both
	 * namespaces would yield the same id, the v1 copy would win the load, and the
	 * prune sweep would then delete the newer session's chunks.
	 */
	adoptedId(seed: number): string | null {
		return this.storage.getItem(legacyMapKey(seed));
	}

	adoptLegacy(seed: number, id: string): void {
		this.storage.setItem(legacyMapKey(seed), id);
	}

	async loadWorld(id: string): Promise<WorldSave | null> {
		if (isLegacyId(id)) {
			const seed = seedFromLegacyId(id);
			const adopted = this.adoptedId(seed);
			// Adoption is recorded before the first load, so the v2 record may not
			// exist yet. Falling back to v1 is what makes that first play work.
			if (adopted) return this.loadV2(adopted) ?? this.loadV1(seed, adopted);
			return this.loadV1(seed, id);
		}
		return this.loadV3(id) ?? this.loadV2(id);
	}

	private loadV1(seed: number, id: string): WorldSave | null {
		const metaRaw = this.storage.getItem(metaKey(seed));
		if (!metaRaw) return null;
		const meta = JSON.parse(metaRaw) as Partial<WorldSave>;
		const chunks = this.readChunks(chunkPrefix(seed), LEGACY_LEN);
		// A stored v1 meta has no id and version 1. The cast in the old implementation
		// hid that from the compiler, so normalize explicitly here.
		return { ...(meta as WorldSave), version: 2, height: LEGACY_HEIGHT, genVersion: 1, id, seed, chunks };
	}

	private loadV2(id: string): WorldSave | null {
		const metaRaw = this.storage.getItem(v2MetaKey(id));
		if (!metaRaw) return null;
		const meta = JSON.parse(metaRaw) as Partial<WorldSave>;
		const chunks = this.readChunks(v2ChunkPrefix(id), LEGACY_LEN);
		return { ...(meta as WorldSave), version: 2, height: LEGACY_HEIGHT, genVersion: 1, id, chunks };
	}

	private loadV3(id: string): WorldSave | null {
		const metaRaw = this.storage.getItem(v3MetaKey(id));
		if (!metaRaw) return null;
		const meta = JSON.parse(metaRaw) as Partial<WorldSave>;
		// The stored height is authoritative (spec §4); without a valid one there is
		// no length to decode at, so the record is refused rather than guessed.
		if (!isWorldHeight(meta.height) || !Number.isInteger(meta.genVersion) || (meta.genVersion as number) < 1) {
			throw new SaveCorrupt(`v3 world ${id} has no valid height/genVersion`);
		}
		const chunks = this.readChunks(v3ChunkPrefix(id), blocksPerChunk(meta.height));
		return {
			...(meta as WorldSave),
			version: 3,
			id,
			height: meta.height,
			genVersion: meta.genVersion as number,
			chunks,
		};
	}

	/** Every chunk under `prefix`, decoded at `len`. One bad chunk refuses the whole record. */
	private readChunks(prefix: string, len: number): RawChunk[] {
		const chunks: RawChunk[] = [];
		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (!k || !k.startsWith(prefix)) continue;
			const [cxStr, czStr] = k.slice(prefix.length).split(':');
			const data = this.storage.getItem(k);
			if (!data) continue;
			try {
				chunks.push(parseChunkPayload(Number(cxStr), Number(czStr), data, len));
			} catch (err) {
				throw new SaveCorrupt(`chunk ${k}: ${(err as Error).message}`);
			}
		}
		return chunks;
	}

	encode(save: WorldSave): EncodedChunk[] {
		const len = blocksPerChunk(save.height);
		return save.chunks.map((c) => {
			const out: EncodedChunk = { cx: c.cx, cz: c.cz, blocks: encodeChunk(c.blocks, len) };
			if (c.fluidMeta && c.fluidMeta.size > 0) out.fluidMeta = encodeFluidMeta(c.fluidMeta);
			return out;
		});
	}

	async saveWorld(save: WorldSave, pre?: EncodedChunk[]): Promise<SaveResult> {
		try {
			this.saveLocalSync(save, pre);
			return { local: 'ok', cloud: 'skipped' };
		} catch (err) {
			if ((err as Error).message === 'SUSPICIOUS_SHRINK') return { local: 'error', cloud: 'skipped' };
			throw err;
		}
	}

	/**
	 * Synchronous so the pagehide handler can complete before teardown; an awaited
	 * write there is a dropped continuation and the edits are gone.
	 */
	saveLocalSync(save: WorldSave, pre?: EncodedChunk[]): void {
		if (isLegacyId(save.id)) {
			throw new Error('LEGACY_ID_NOT_WRITABLE');
		}
		const ns = save.version === 3 ? V3_NS : V2_NS;
		// The v2 payload is byte-identical to what shipped before v3 existed: a
		// 64-high world never learns the new fields.
		const metaPayload: Record<string, unknown> = {
			version: save.version,
			id: save.id,
			seed: save.seed,
			name: save.name,
			createdAt: save.createdAt,
			updatedAt: save.updatedAt,
			player: save.player,
			lights: save.lights,
			lastSyncedGeneration: save.lastSyncedGeneration ?? null,
		};
		if (save.version === 3) {
			metaPayload.height = save.height;
			metaPayload.genVersion = save.genVersion;
		}

		const encoded = pre ?? this.encode(save);

		try {
			const prefix = ns.prefix(save.id);
			const existing: string[] = [];
			for (let i = 0; i < this.storage.length; i++) {
				const k = this.storage.key(i);
				if (k && k.startsWith(prefix)) existing.push(k);
			}
			// Mirror of the API's shrink guard. Chunk.modified is sticky, so a real
			// save never shrinks; a snapshot that does is a bug upstream and must not prune.
			if (existing.length > 4 && encoded.length < existing.length * 0.5) {
				for (const c of encoded) this.storage.setItem(ns.chunk(save.id, c.cx, c.cz), JSON.stringify(payloadOf(c)));
				throw new Error('SUSPICIOUS_SHRINK');
			}

			// Meta is written LAST, on purpose. A save interrupted by a quota error
			// leaves a mix of old and new chunks; if the new meta were already in
			// place that mixture would advertise itself as the newer save and win
			// any comparison against a good copy. Written last, the torn state keeps
			// the previous updatedAt and loses.
			const keep = new Set(encoded.map((c) => ns.chunk(save.id, c.cx, c.cz)));
			const toDelete = existing.filter((k) => !keep.has(k));
			toDelete.forEach((k) => this.storage.removeItem(k));
			for (const c of encoded) {
				this.storage.setItem(ns.chunk(save.id, c.cx, c.cz), JSON.stringify(payloadOf(c)));
			}
			this.storage.setItem(ns.meta(save.id), JSON.stringify(metaPayload));
		} catch (err) {
			if (err instanceof DOMException && err.name === 'QuotaExceededError') {
				throw new Error('QUOTA_EXCEEDED');
			}
			throw err;
		}
	}

	/**
	 * Records the cloud generation this local copy now matches. Without it, every
	 * load after a successful save looks like a divergence and forks a duplicate.
	 */
	setSyncedGeneration(id: string, generation: string): void {
		const key = this.storage.getItem(v3MetaKey(id)) !== null ? v3MetaKey(id) : v2MetaKey(id);
		const raw = this.storage.getItem(key);
		if (!raw) return;
		const meta = JSON.parse(raw) as Record<string, unknown>;
		meta.lastSyncedGeneration = generation;
		this.storage.setItem(key, JSON.stringify(meta));
	}

	async listWorlds(): Promise<WorldSummary[]> {
		const out: WorldSummary[] = [];

		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (!k || !k.startsWith(`${V3}:world:`) || !k.endsWith(':meta')) continue;
			const raw = this.storage.getItem(k);
			if (!raw) continue;
			const m = JSON.parse(raw) as WorldSummary;
			// Listing never throws: a v3 meta with a bad height stays visible in the
			// menu (height undefined) and is refused on open by loadV3.
			out.push({
				id: m.id,
				seed: m.seed,
				name: m.name,
				createdAt: m.createdAt,
				updatedAt: m.updatedAt,
				origin: 'local',
				version: 3,
				height: isWorldHeight(m.height) ? m.height : undefined,
			});
		}

		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (!k || !k.startsWith(`${V2}:world:`) || !k.endsWith(':meta')) continue;
			const raw = this.storage.getItem(k);
			if (!raw) continue;
			const m = JSON.parse(raw) as WorldSummary;
			out.push({
				id: m.id,
				seed: m.seed,
				name: m.name,
				createdAt: m.createdAt,
				updatedAt: m.updatedAt,
				origin: 'local',
				version: 2,
				height: LEGACY_HEIGHT,
			});
		}

		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (!k || !k.startsWith(`${NS}:world:`) || !k.endsWith(':meta')) continue;
			const raw = this.storage.getItem(k);
			if (!raw) continue;
			const m = JSON.parse(raw) as WorldSummary;
			// A legacy world that has been adopted is already listed under its uuid.
			if (this.adoptedId(m.seed)) continue;
			out.push({
				id: legacyId(m.seed),
				seed: m.seed,
				name: m.name,
				createdAt: m.createdAt,
				updatedAt: m.updatedAt,
				origin: 'local',
				version: 2,
				height: LEGACY_HEIGHT,
			});
		}

		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async deleteWorld(id: string): Promise<void> {
		// v1 keys are read-only, permanently. Deleting a legacy world removes only the
		// v2 copy it was adopted into; the original stays as a cold backup.
		if (isLegacyId(id)) return;
		for (const ns of [V3_NS, V2_NS]) {
			this.storage.removeItem(ns.meta(id));
			const toDelete: string[] = [];
			const prefix = ns.prefix(id);
			for (let i = 0; i < this.storage.length; i++) {
				const k = this.storage.key(i);
				if (k && k.startsWith(prefix)) toDelete.push(k);
			}
			toDelete.forEach((k) => this.storage.removeItem(k));
		}
	}
}

function parseChunkPayload(cx: number, cz: number, data: string, len: number): RawChunk {
	let parsed: ChunkPayload | null = null;
	try {
		parsed = JSON.parse(data) as ChunkPayload;
	} catch {
		parsed = null;
	}
	// Pre-Task-6 saves stored the bare base64 blocks blob with no JSON envelope.
	// Only that case falls back; a decode failure inside a JSON payload must
	// surface as itself, not as atob choking on the envelope.
	if (!parsed) return { cx, cz, blocks: decodeChunk(data, len) };
	const blocks = decodeChunk(parsed.blocks, len);
	const fluidMeta = parsed.fluidMeta ? decodeFluidMeta(parsed.fluidMeta) : undefined;
	return { cx, cz, blocks, fluidMeta };
}
