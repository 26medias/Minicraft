import { NEWEST_GEN_VERSION } from '../engine/world/generation';
import type { WorldListing } from './protocol';

/** One row of `GET /worlds` (spec §5 HTTP). */
export type MpWorldRow = WorldListing;

/**
 * The multiplayer server's HTTP API (spec §5): list, create and delete worlds.
 * Every call sends `Authorization: Bearer <token>` and gives up after
 * `timeoutMs`: a sleeping server (the VM is off) must read as "sleeping" within
 * 4 s, not hang the menu.
 */
export class MpApi {
	private base: string;

	constructor(base: string, private token: string) {
		this.base = base.replace(/\/+$/, '');
	}

	async listWorlds(timeoutMs = 4000): Promise<MpWorldRow[]> {
		const res = await this.call('GET', '/worlds', undefined, timeoutMs);
		if (!res.ok) throw new Error(`GET /worlds: ${res.status}`);
		const rows: unknown = await res.json();
		if (!Array.isArray(rows)) throw new Error('GET /worlds: not a list');
		return rows as MpWorldRow[];
	}

	async createWorld(name: string, seed: number, mustMine: boolean, timeoutMs = 8000): Promise<MpWorldRow> {
		const res = await this.call('POST', '/worlds', { name, seed, mustMine, gen: NEWEST_GEN_VERSION }, timeoutMs);
		if (!res.ok) throw new Error(`POST /worlds: ${res.status}`);
		return (await res.json()) as MpWorldRow;
	}

	/** `'occupied'` is the server's 409: someone is online in that world. */
	async deleteWorld(uuid: string, timeoutMs = 8000): Promise<'ok' | 'occupied'> {
		const res = await this.call('DELETE', `/worlds/${encodeURIComponent(uuid)}`, undefined, timeoutMs);
		if (res.status === 409) return 'occupied';
		if (!res.ok) throw new Error(`DELETE /worlds: ${res.status}`);
		return 'ok';
	}

	/**
	 * One request, bounded by its own timer. The race does not rely on fetch
	 * honouring the abort: a stalled tunnel must still time out.
	 */
	private call(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
		const ctl = new AbortController();
		const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				ctl.abort();
				reject(new Error(`${method} ${path}: timed out after ${timeoutMs} ms`));
			}, timeoutMs);
		});
		const req = fetch(`${this.base}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: ctl.signal,
		});
		return Promise.race([req, timeout]).finally(() => clearTimeout(timer));
	}
}

/** The site's multiplayer server, from the build variables; null when `VITE_MINICRAFT_MP_URL` is unset (spec §3). */
export function mpApiFromEnv(): MpApi | null {
	const url = import.meta.env.VITE_MINICRAFT_MP_URL as string | undefined;
	if (!url) return null;
	const token = (import.meta.env.VITE_MINICRAFT_MP_TOKEN as string | undefined) ?? '';
	return new MpApi(url, token);
}
