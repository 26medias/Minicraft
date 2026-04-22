import type { PersistenceAdapter, RawChunk, WorldSave, WorldSummary } from './adapter';
import { decodeChunk, encodeChunk } from './codec';

type EncodedChunk = { cx: number; cz: number; data: string };

const NS = 'minicraft:v1';
const metaKey = (seed: number) => `${NS}:world:${seed}:meta`;
const chunkKey = (seed: number, cx: number, cz: number) => `${NS}:world:${seed}:chunk:${cx}:${cz}`;
const chunkPrefix = (seed: number) => `${NS}:world:${seed}:chunk:`;

export class LocalStorageAdapter implements PersistenceAdapter {
	constructor(private storage: Storage = localStorage) {}

	async loadWorld(seed: number): Promise<WorldSave | null> {
		const metaRaw = this.storage.getItem(metaKey(seed));
		if (!metaRaw) return null;
		const meta = JSON.parse(metaRaw) as Omit<WorldSave, 'chunks'>;

		const chunks: RawChunk[] = [];
		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (!k || !k.startsWith(chunkPrefix(seed))) continue;
			const suffix = k.slice(chunkPrefix(seed).length);
			const [cxStr, czStr] = suffix.split(':');
			const data = this.storage.getItem(k);
			if (!data) continue;
			chunks.push({ cx: Number(cxStr), cz: Number(czStr), blocks: decodeChunk(data) });
		}
		return { ...meta, chunks };
	}

	async saveWorld(save: WorldSave): Promise<void> {
		const metaPayload = {
			version: save.version,
			seed: save.seed,
			name: save.name,
			createdAt: save.createdAt,
			updatedAt: save.updatedAt,
			player: save.player,
			lights: save.lights,
		};

		const encoded: EncodedChunk[] = save.chunks.map((c) => ({
			cx: c.cx,
			cz: c.cz,
			data: encodeChunk(c.blocks),
		}));

		try {
			this.storage.setItem(metaKey(save.seed), JSON.stringify(metaPayload));
			const keep = new Set(encoded.map((c) => chunkKey(save.seed, c.cx, c.cz)));
			const toDelete: string[] = [];
			for (let i = 0; i < this.storage.length; i++) {
				const k = this.storage.key(i);
				if (k && k.startsWith(chunkPrefix(save.seed)) && !keep.has(k)) toDelete.push(k);
			}
			toDelete.forEach((k) => this.storage.removeItem(k));
			for (const c of encoded) this.storage.setItem(chunkKey(save.seed, c.cx, c.cz), c.data);
		} catch (err) {
			if (err instanceof DOMException && err.name === 'QuotaExceededError') {
				throw new Error('QUOTA_EXCEEDED');
			}
			throw err;
		}
	}

	async listWorlds(): Promise<WorldSummary[]> {
		const out: WorldSummary[] = [];
		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (!k || !k.startsWith(`${NS}:world:`) || !k.endsWith(':meta')) continue;
			const raw = this.storage.getItem(k);
			if (!raw) continue;
			const m = JSON.parse(raw) as WorldSummary;
			out.push({
				seed: m.seed,
				name: m.name,
				createdAt: m.createdAt,
				updatedAt: m.updatedAt,
			});
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async deleteWorld(seed: number): Promise<void> {
		this.storage.removeItem(metaKey(seed));
		const toDelete: string[] = [];
		for (let i = 0; i < this.storage.length; i++) {
			const k = this.storage.key(i);
			if (k && k.startsWith(chunkPrefix(seed))) toDelete.push(k);
		}
		toDelete.forEach((k) => this.storage.removeItem(k));
	}
}
