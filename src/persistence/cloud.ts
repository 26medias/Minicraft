import type {
	EncodedChunk,
	PersistenceAdapter,
	RawChunk,
	SaveResult,
	WorldSave,
	WorldSummary,
} from './adapter';
import { decodeChunk, decodeFluidMeta, encodeChunk, encodeFluidMeta } from './codec';

export type CloudErrorCode = 'NETWORK' | 'CONFLICT' | 'TOO_LARGE' | 'SERVER' | 'NOT_FOUND' | 'BAD';

export class CloudError extends Error {
	constructor(
		public code: CloudErrorCode,
		message: string = code,
	) {
		super(message);
		this.name = 'CloudError';
	}
}

type Wire = {
	version: 2;
	id: string;
	seed: number;
	name: string;
	createdAt: number;
	updatedAt: number;
	player: WorldSave['player'];
	chunks: EncodedChunk[];
	lights?: WorldSave['lights'];
	generation?: string;
};

export class CloudAdapter implements PersistenceAdapter {
	/** Generation each world was LOADED from. Never refreshed by a comparison fetch. */
	private generations = new Map<string, string>();
	/** Worlds loaded without adopting a cloud copy — their first PUT must not guess. */
	private unsynced = new Set<string>();

	constructor(private baseUrl: string) {}

	generationFor(id: string): string | undefined {
		return this.generations.get(id);
	}

	markUnsynced(id: string): void {
		this.unsynced.add(id);
	}

	private url(path: string): string {
		return `${this.baseUrl.replace(/\/$/, '')}${path}`;
	}

	private async request(path: string, init?: RequestInit): Promise<Response> {
		try {
			return await fetch(this.url(path), init);
		} catch (err) {
			throw new CloudError('NETWORK', (err as Error).message);
		}
	}

	private static classify(status: number): CloudErrorCode {
		if (status === 404) return 'NOT_FOUND';
		if (status === 409) return 'CONFLICT';
		if (status === 413) return 'TOO_LARGE';
		if (status >= 500) return 'SERVER';
		return 'BAD';
	}

	encode(save: WorldSave): EncodedChunk[] {
		return save.chunks.map((c) => {
			const out: EncodedChunk = { cx: c.cx, cz: c.cz, blocks: encodeChunk(c.blocks) };
			if (c.fluidMeta && c.fluidMeta.size > 0) out.fluidMeta = encodeFluidMeta(c.fluidMeta);
			return out;
		});
	}

	private static decode(wire: Wire): WorldSave {
		const chunks: RawChunk[] = wire.chunks.map((c) => ({
			cx: c.cx,
			cz: c.cz,
			blocks: decodeChunk(c.blocks),
			fluidMeta: c.fluidMeta ? decodeFluidMeta(c.fluidMeta) : undefined,
		}));
		return {
			version: 2,
			id: wire.id,
			seed: wire.seed,
			name: wire.name,
			createdAt: wire.createdAt,
			updatedAt: wire.updatedAt,
			player: wire.player,
			chunks,
			lights: wire.lights,
			lastSyncedGeneration: wire.generation ?? null,
		};
	}

	async loadWorld(id: string): Promise<WorldSave | null> {
		const res = await this.request(`/worlds/${id}`);
		if (res.status === 404) return null;
		if (!res.ok) throw new CloudError(CloudAdapter.classify(res.status));
		const wire = (await res.json()) as Wire;
		const gen = res.headers?.get?.('X-Generation') ?? wire.generation;
		if (gen) {
			this.generations.set(id, gen);
			this.unsynced.delete(id);
		}
		return CloudAdapter.decode(wire);
	}

	async saveWorld(save: WorldSave, pre?: EncodedChunk[]): Promise<SaveResult> {
		const body: Wire = {
			version: 2,
			id: save.id,
			seed: save.seed,
			name: save.name,
			createdAt: save.createdAt,
			updatedAt: save.updatedAt,
			player: save.player,
			chunks: pre ?? this.encode(save),
			lights: save.lights,
		};

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		const known = this.generations.get(save.id);
		if (known && !this.unsynced.has(save.id)) {
			headers['If-Match'] = known;
		} else {
			// A world loaded offline never adopted a cloud generation. Fetching the
			// current one here would match whatever another device just wrote and
			// overwrite it silently, which is the failure the precondition exists for.
			headers['If-None-Match'] = '*';
		}

		const res = await this.request(`/worlds/${save.id}`, {
			method: 'PUT',
			headers,
			body: JSON.stringify(body),
		});

		if (res.ok) {
			const out = (await res.json()) as { generation?: string };
			if (out.generation) this.generations.set(save.id, out.generation);
			this.unsynced.delete(save.id);
			return { local: 'ok', cloud: 'ok' };
		}

		if (res.status === 409) {
			// A committed write whose response was lost looks exactly like a conflict
			// on retry. Re-read before believing it: same updatedAt means it was ours.
			const check = await this.request(`/worlds/${save.id}`);
			if (check.ok) {
				const stored = (await check.json()) as Wire;
				const gen = check.headers?.get?.('X-Generation') ?? stored.generation;
				if (stored.updatedAt === save.updatedAt) {
					if (gen) this.generations.set(save.id, gen);
					this.unsynced.delete(save.id);
					return { local: 'ok', cloud: 'ok' };
				}
			}
			throw new CloudError('CONFLICT');
		}

		throw new CloudError(CloudAdapter.classify(res.status));
	}

	async listWorlds(): Promise<WorldSummary[]> {
		const res = await this.request('/worlds');
		if (!res.ok) throw new CloudError(CloudAdapter.classify(res.status));
		const rows = (await res.json()) as (WorldSummary & { generation?: string })[];
		return rows.map((r) => ({ ...r, origin: 'cloud' as const }));
	}

	async deleteWorld(id: string): Promise<void> {
		const res = await this.request(`/worlds/${id}`, { method: 'DELETE' });
		if (res.status === 204 || res.status === 404) {
			this.generations.delete(id);
			return;
		}
		throw new CloudError(CloudAdapter.classify(res.status));
	}
}
