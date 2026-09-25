/**
 * A scripted "kid" for the e2e: a real `BotClient` whose WebSocket strips `bot` from its `hello`, so
 * the server (and the companion) see a plain player (`bot: false`). The SDK still supplies `proto`,
 * `gen`, `bid`, poses and edits exactly as a client does.
 */
import { BlockedError, BotClient } from 'minicraft-bot';
import type { BotWorld, WalkResult } from 'minicraft-bot';
import type { Vec3 } from '../src/types.js';

/** The global WebSocket, with `send` rewriting the `hello` (deletes `bot`). */
class KidWebSocket extends WebSocket {
	override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (typeof data === 'string') {
			try {
				const msg = JSON.parse(data) as Record<string, unknown>;
				if (msg.t === 'hello') {
					delete msg.bot;
					super.send(JSON.stringify(msg));
					return;
				}
			} catch {
				// not JSON: pass through
			}
		}
		super.send(data);
	}
}

export interface KidOptions {
	url: string;
	token: string;
	world: string;
	name?: string;
	skin?: string;
}

export class Kid {
	readonly client: BotClient;
	world!: BotWorld;
	readonly name: string;

	private constructor(client: BotClient, name: string) {
		this.client = client;
		this.name = name;
	}

	static async connect(o: KidOptions): Promise<Kid> {
		const name = o.name ?? 'Kid';
		const client = new BotClient({ url: o.url, token: o.token, WebSocket: KidWebSocket, bid: `kid-${name.toLowerCase()}-${Date.now()}` });
		const kid = new Kid(client, name);
		const joined = await client.connect({ world: o.world, name, skin: o.skin ?? 'jj' });
		kid.world = joined.world;
		// A `first` spawn may come back as 0,0,0: stand on the kid's own ground.
		const p = client.pose();
		if (p.y <= 0) {
			const x = p.x === 0 && p.z === 0 ? 256.5 : p.x;
			const z = p.x === 0 && p.z === 0 ? 256.5 : p.z;
			const g = kid.world.groundY(x, z, 250);
			if (g !== null) client.move({ x, y: g, z, yaw: 0, pitch: 0 });
		}
		return kid;
	}

	pose() {
		return this.client.pose();
	}

	/** Walks there; a blocked walk becomes a flight (then a landing), and a failed flight a `move`. */
	async walkTo(t: { x: number; z: number }): Promise<'walked' | 'flew' | 'moved'> {
		try {
			const r: WalkResult = await this.client.walkTo(t);
			if (r === 'arrived') return 'walked';
		} catch (err) {
			if (!(err instanceof BlockedError)) throw err;
		}
		const g = this.world.groundY(t.x, t.z, Math.max(this.pose().y, this.world.surfaceY(t.x, t.z) + 1));
		if (g !== null) {
			try {
				await this.client.flyTo({ x: t.x, y: g + 3, z: t.z });
				await this.client.flyTo({ x: t.x, y: g, z: t.z });
				return 'flew';
			} catch (err) {
				if (!(err instanceof BlockedError)) throw err;
			}
			this.client.move({ x: t.x, y: g, z: t.z });
		}
		return 'moved';
	}

	flyTo(t: Vec3): Promise<WalkResult> {
		return this.client.flyTo(t);
	}

	/** Faces a cell's centre. */
	face(c: Vec3): void {
		this.client.lookAt(c.x + 0.5, c.y + 0.5, c.z + 0.5);
	}

	lookAt(x: number, y: number, z: number): void {
		this.client.lookAt(x, y, z);
	}

	async place(c: Vec3, name: string, facing = true): Promise<boolean> {
		if (facing) this.face(c);
		return this.client.place(c.x, c.y, c.z, name);
	}

	async break(c: Vec3): Promise<boolean> {
		this.face(c);
		return this.client.break(c.x, c.y, c.z);
	}

	close(): void {
		this.client.close();
	}
}
