import type {
	EncodedChunk,
	PersistenceAdapter,
	RawChunk,
	SaveResult,
	WorldSave,
	WorldSummary,
} from './adapter';
import { blocksPerChunk, isWorldHeight, LEGACY_HEIGHT, type WorldHeight } from '../engine/world/coords';
import { decodeChunk, decodeFluidMeta, encodeChunk, encodeFluidMeta } from './codec';
import { SaveCorrupt } from './errors';

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
	version: 2 | 3;
	/** v3 only. */
	height?: number;
	/** v3 only. */
	genVersion?: number;
	id: string;
	seed: number;
	name: string;
	createdAt: number;
	updatedAt: number;
	player: WorldSave['player'];
	chunks: EncodedChunk[];
	lights?: WorldSave['lights'];
	/** Absent on a save from before crafting. */
	mustMine?: boolean;
	generation?: string;
};

type ListRow = WorldSummary & { generation?: string; height?: number; genVersion?: number };

/** Tall worlds live under their own routes; the old ones are never touched. */
const prefixFor = (version: 2 | 3) => (version === 3 ? '/v3/worlds' : '/worlds');

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
		const len = blocksPerChunk(save.height);
		return save.chunks.map((c) => {
			const out: EncodedChunk = { cx: c.cx, cz: c.cz, blocks: encodeChunk(c.blocks, len) };
			if (c.fluidMeta && c.fluidMeta.size > 0) out.fluidMeta = encodeFluidMeta(c.fluidMeta);
			return out;
		});
	}

	private static decode(wire: Wire): WorldSave {
		// The body's own version is what sizes the chunks. A v2 body has no height
		// field and is 64 by definition; a v3 body must say, or it is refused.
		let height: WorldHeight = LEGACY_HEIGHT;
		let genVersion = 1;
		if (wire.version === 3) {
			if (!isWorldHeight(wire.height) || !Number.isInteger(wire.genVersion) || (wire.genVersion as number) < 1) {
				throw new SaveCorrupt(`cloud v3 world ${wire.id} has no valid height/genVersion`);
			}
			height = wire.height;
			genVersion = wire.genVersion as number;
		}
		const len = blocksPerChunk(height);
		let chunks: RawChunk[];
		try {
			chunks = wire.chunks.map((c) => ({
				cx: c.cx,
				cz: c.cz,
				blocks: decodeChunk(c.blocks, len),
				fluidMeta: c.fluidMeta ? decodeFluidMeta(c.fluidMeta) : undefined,
			}));
		} catch (err) {
			throw new SaveCorrupt(`cloud world ${wire.id}: ${(err as Error).message}`);
		}
		return {
			version: wire.version === 3 ? 3 : 2,
			height,
			genVersion,
			id: wire.id,
			seed: wire.seed,
			name: wire.name,
			createdAt: wire.createdAt,
			updatedAt: wire.updatedAt,
			player: wire.player,
			chunks,
			lights: wire.lights,
			// Passed through as stored; resolvePlayerExtras applies the default.
			...(typeof wire.mustMine === 'boolean' ? { mustMine: wire.mustMine } : {}),
			lastSyncedGeneration: wire.generation ?? null,
		};
	}

	async loadWorld(id: string): Promise<WorldSave | null> {
		for (const version of [3, 2] as const) {
			const res = await this.request(`${prefixFor(version)}/${id}`);
			if (res.status === 404) continue;
			if (!res.ok) throw new CloudError(CloudAdapter.classify(res.status));
			const wire = (await res.json()) as Wire;
			// The body's version wins, never the namespace that answered. Overriding
			// it with the probed route would reinterpret a v2 body as v3 and reject
			// it; decode() sizes the chunks from what the body says it is.
			const gen = res.headers?.get?.('X-Generation') ?? wire.generation;
			if (gen) {
				this.generations.set(id, gen);
				this.unsynced.delete(id);
			}
			return CloudAdapter.decode(wire);
		}
		return null;
	}

	async saveWorld(save: WorldSave, pre?: EncodedChunk[]): Promise<SaveResult> {
		const prefix = prefixFor(save.version);
		const body: Wire = {
			version: save.version,
			...(save.version === 3 ? { height: save.height, genVersion: save.genVersion } : {}),
			id: save.id,
			seed: save.seed,
			name: save.name,
			createdAt: save.createdAt,
			updatedAt: save.updatedAt,
			player: save.player,
			chunks: pre ?? this.encode(save),
			lights: save.lights,
			// Always sent: omitting it would let the API's old-client guard keep a
			// stored value this save meant to replace.
			mustMine: save.mustMine === true,
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

		const res = await this.request(`${prefix}/${save.id}`, {
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
			const check = await this.request(`${prefix}/${save.id}`);
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
		// Issued in this order on purpose: v3 first, then v2. Tests stub the
		// responses positionally.
		const [tall, old] = await Promise.all([this.request('/v3/worlds'), this.request('/worlds')]);
		if (!tall.ok) throw new CloudError(CloudAdapter.classify(tall.status));
		if (!old.ok) throw new CloudError(CloudAdapter.classify(old.status));
		const tallRows = (await tall.json()) as ListRow[];
		const oldRows = (await old.json()) as ListRow[];
		return [
			...tallRows.map((r) => ({
				...r,
				origin: 'cloud' as const,
				version: 3 as const,
				height: isWorldHeight(r.height) ? r.height : undefined,
			})),
			...oldRows.map((r) => ({ ...r, origin: 'cloud' as const, version: 2 as const, height: LEGACY_HEIGHT })),
		];
	}

	async deleteWorld(id: string): Promise<void> {
		for (const version of [3, 2] as const) {
			const res = await this.request(`${prefixFor(version)}/${id}`, { method: 'DELETE' });
			if (res.status !== 204 && res.status !== 404) throw new CloudError(CloudAdapter.classify(res.status));
		}
		this.generations.delete(id);
	}
}
