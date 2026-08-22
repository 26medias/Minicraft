import type {
	EncodedChunk,
	PersistenceAdapter,
	RawChunk,
	SaveResult,
	WorldSave,
	WorldSummary,
} from './adapter';
import { decodeChunk, decodeFluidMeta, encodeChunk, encodeFluidMeta } from './codec';
import { isLegacyId, legacyId, seedFromLegacyId } from './uuid';

type ChunkPayload = { blocks: string; fluidMeta?: string };

const NS = 'minicraft:v1';
const V2 = 'minicraft:v2';

const metaKey = (seed: number) => `${NS}:world:${seed}:meta`;
const chunkPrefix = (seed: number) => `${NS}:world:${seed}:chunk:`;

const v2MetaKey = (id: string) => `${V2}:world:${id}:meta`;
const v2ChunkKey = (id: string, cx: number, cz: number) => `${V2}:world:${id}:chunk:${cx}:${cz}`;
const v2ChunkPrefix = (id: string) => `${V2}:world:${id}:chunk:`;

/** Maps a legacy seed to the uuid minted for it, so a legacy world is adopted once. */
const legacyMapKey = (seed: number) => `${V2}:legacy-map:${seed}`;

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
		return this.loadV2(id);
	}

	private loadV1(seed: number, id: string): WorldSave | null {
		const metaRaw = this.storage.getItem(metaKey(seed));
		if (!metaRaw) return null;
		const meta = JSON.parse(metaRaw) as Partial<WorldSave>;

		const chunks: RawChunk[] = [];
		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (!k || !k.startsWith(chunkPrefix(seed))) continue;
			const suffix = k.slice(chunkPrefix(seed).length);
			const [cxStr, czStr] = suffix.split(':');
			const data = this.storage.getItem(k);
			if (!data) continue;
			chunks.push(parseChunkPayload(Number(cxStr), Number(czStr), data));
		}
		// A stored v1 meta has no id and version 1. The cast in the old implementation
		// hid that from the compiler, so normalize explicitly here.
		return { ...(meta as WorldSave), version: 2, id, seed, chunks };
	}

	private loadV2(id: string): WorldSave | null {
		const metaRaw = this.storage.getItem(v2MetaKey(id));
		if (!metaRaw) return null;
		const meta = JSON.parse(metaRaw) as Partial<WorldSave>;

		const chunks: RawChunk[] = [];
		const prefix = v2ChunkPrefix(id);
		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (!k || !k.startsWith(prefix)) continue;
			const [cxStr, czStr] = k.slice(prefix.length).split(':');
			const data = this.storage.getItem(k);
			if (!data) continue;
			chunks.push(parseChunkPayload(Number(cxStr), Number(czStr), data));
		}
		return { ...(meta as WorldSave), version: 2, id, chunks };
	}

	encode(save: WorldSave): EncodedChunk[] {
		return save.chunks.map((c) => {
			const out: EncodedChunk = { cx: c.cx, cz: c.cz, blocks: encodeChunk(c.blocks) };
			if (c.fluidMeta && c.fluidMeta.size > 0) out.fluidMeta = encodeFluidMeta(c.fluidMeta);
			return out;
		});
	}

	async saveWorld(save: WorldSave, pre?: EncodedChunk[]): Promise<SaveResult> {
		this.saveLocalSync(save, pre);
		return { local: 'ok', cloud: 'skipped' };
	}

	/**
	 * Synchronous so the pagehide handler can complete before teardown; an awaited
	 * write there is a dropped continuation and the edits are gone.
	 */
	saveLocalSync(save: WorldSave, pre?: EncodedChunk[]): void {
		if (isLegacyId(save.id)) {
			throw new Error('LEGACY_ID_NOT_WRITABLE');
		}
		const metaPayload = {
			version: 2,
			id: save.id,
			seed: save.seed,
			name: save.name,
			createdAt: save.createdAt,
			updatedAt: save.updatedAt,
			player: save.player,
			lights: save.lights,
			lastSyncedGeneration: save.lastSyncedGeneration ?? null,
		};

		const encoded = pre ?? this.encode(save);

		try {
			// Meta is written LAST, on purpose. A save interrupted by a quota error
			// leaves a mix of old and new chunks; if the new meta were already in
			// place that mixture would advertise itself as the newer save and win
			// any comparison against a good copy. Written last, the torn state keeps
			// the previous updatedAt and loses.
			const keep = new Set(encoded.map((c) => v2ChunkKey(save.id, c.cx, c.cz)));
			const toDelete: string[] = [];
			const prefix = v2ChunkPrefix(save.id);
			for (let i = 0; i < this.storage.length; i++) {
				const k = this.storage.key(i);
				if (k && k.startsWith(prefix) && !keep.has(k)) toDelete.push(k);
			}
			toDelete.forEach((k) => this.storage.removeItem(k));
			for (const c of encoded) {
				const payload: ChunkPayload = { blocks: c.blocks };
				if (c.fluidMeta) payload.fluidMeta = c.fluidMeta;
				this.storage.setItem(v2ChunkKey(save.id, c.cx, c.cz), JSON.stringify(payload));
			}
			this.storage.setItem(v2MetaKey(save.id), JSON.stringify(metaPayload));
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
		const raw = this.storage.getItem(v2MetaKey(id));
		if (!raw) return;
		const meta = JSON.parse(raw) as Record<string, unknown>;
		meta.lastSyncedGeneration = generation;
		this.storage.setItem(v2MetaKey(id), JSON.stringify(meta));
	}

	async listWorlds(): Promise<WorldSummary[]> {
		const out: WorldSummary[] = [];
		const adopted = new Set<string>();

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
			});
			adopted.add(m.id);
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
			});
		}

		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async deleteWorld(id: string): Promise<void> {
		// v1 keys are read-only, permanently. Deleting a legacy world removes only the
		// v2 copy it was adopted into; the original stays as a cold backup.
		if (isLegacyId(id)) return;
		this.storage.removeItem(v2MetaKey(id));
		const toDelete: string[] = [];
		const prefix = v2ChunkPrefix(id);
		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (k && k.startsWith(prefix)) toDelete.push(k);
		}
		toDelete.forEach((k) => this.storage.removeItem(k));
	}
}

function parseChunkPayload(cx: number, cz: number, data: string): RawChunk {
	try {
		const parsed = JSON.parse(data) as ChunkPayload;
		const blocks = decodeChunk(parsed.blocks);
		const fluidMeta = parsed.fluidMeta ? decodeFluidMeta(parsed.fluidMeta) : undefined;
		return { cx, cz, blocks, fluidMeta };
	} catch {
		// Pre-Task-6 saves stored the bare base64 blocks blob with no JSON envelope.
		return { cx, cz, blocks: decodeChunk(data) };
	}
}
