/**
 * The scripted kid of the brain2 session tests (criterion 7's script, spec §9): per 100 ms tick, a pose for
 * `body.list` and his edits. A 9-minute cycle: wander 3 min, lay 2 lines of 6 (1 min), watch the bot 3 min,
 * fly 2 min, repeat. Each cycle's lines are laid 4 blocks further along z, so the kid's cells accumulate.
 */
import type { BotPlayer } from 'minicraft-bot';
import type { FakeBody, FakeWorld } from '../fake-port.js';
import { id, player } from '../fake-port.js';
import type { Vec3 } from '../../src/types.js';

const WANDER_MS = 180_000;
const LINES_MS = 60_000;
const WATCH_MS = 180_000;
const FLY_MS = 120_000;
export const CYCLE_MS = WANDER_MS + LINES_MS + WATCH_MS + FLY_MS;
/** One block every 1.5 s: quick enough for line-started (≤ 4 s apart). */
const PLACE_EVERY_MS = 1_500;
const LINE_LEN = 6;

export interface KidScriptOptions {
	world: FakeWorld; body: FakeBody;
	/** The column the kid wanders around. */
	home: { x: number; z: number };
	name?: string; id?: number; block?: string;
	/** Which phases run (tests may want only lines); default all. */
	phases?: Array<'wander' | 'lines' | 'watch' | 'fly'>;
}

export class KidScript {
	readonly me: BotPlayer;
	/** Every cell the kid placed, in order. */
	readonly placed: Vec3[] = [];
	private readonly block: string;
	private lastPlace = -Infinity;
	private lineCells: Vec3[] | null = null;
	private lineCycle = -1;

	constructor(private readonly o: KidScriptOptions) {
		this.block = o.block ?? 'oak_planks';
		this.me = player({ id: o.id ?? 7, name: o.name ?? 'Noah' });
		o.body.list = [this.me];
	}

	private ground(x: number, z: number): number {
		return this.o.world.surfaceY(Math.floor(x), Math.floor(z)) + 1;
	}

	private setPose(x: number, y: number, z: number, yaw: number, pitch = 0): void {
		Object.assign(this.me, { x, y, z, yaw, pitch, hasPos: true });
		this.o.body.list = [{ ...this.me }];
	}

	/** The two lines of a cycle: along +x, 2 blocks apart in z, floating at the highest ground of their columns. */
	private lines(cycle: number): Vec3[] {
		const x0 = Math.floor(this.o.home.x) + 3, z0 = Math.floor(this.o.home.z) - 8 + 4 * (cycle % 5);
		const out: Vec3[] = [];
		for (const dz of [0, 2]) {
			let y = 0;
			for (let i = 0; i < LINE_LEN; i++) y = Math.max(y, this.ground(x0 + i, z0 + dz));
			for (let i = 0; i < LINE_LEN; i++) out.push({ x: x0 + i, y, z: z0 + dz });
		}
		return out;
	}

	/** Advances the kid to script time `t` (ms since the script started). */
	tick(t: number): void {
		const cycle = Math.floor(t / CYCLE_MS);
		let u = t % CYCLE_MS;
		const h = this.o.home;
		const phases = this.o.phases ?? ['wander', 'lines', 'watch', 'fly'];
		const on = (p: 'wander' | 'lines' | 'watch' | 'fly') => phases.includes(p);
		if (u < WANDER_MS) {
			if (!on('wander')) return;
			const a = u / 6000;                                      // ≈ 1 block/s on a radius-6 circle
			const x = h.x + 6 * Math.cos(a), z = h.z + 6 * Math.sin(a);
			return this.setPose(x, this.ground(x, z), z, -a);
		}
		u -= WANDER_MS;
		if (u < LINES_MS) {
			if (!on('lines')) return;
			if (this.lineCycle !== cycle) {
				this.lineCycle = cycle;
				this.lineCells = this.lines(cycle);
			}
			const cells = this.lineCells!;
			const i = Math.min(cells.length - 1, Math.floor(u / PLACE_EVERY_MS));
			const c = cells[i];
			// Stand 2 blocks beside the cell, facing it.
			this.setPose(c.x + 0.5, this.ground(c.x, c.z - 2), c.z - 2 + 0.5, Math.PI, -0.3);
			if (u / PLACE_EVERY_MS < cells.length && t - this.lastPlace >= PLACE_EVERY_MS && this.o.world.getBlock(c.x, c.y, c.z) === 0) {
				this.lastPlace = t;
				this.o.body.kidEdit(this.o.world, this.me, c, id(this.block));
				this.placed.push(c);
			}
			return;
		}
		u -= LINES_MS;
		if (u < WATCH_MS) {
			if (!on('watch')) return;
			const b = this.o.body.current;
			return this.setPose(h.x, this.ground(h.x, h.z), h.z, Math.atan2(-(b.x - h.x), -(b.z - h.z)));
		}
		u -= WATCH_MS;
		if (!on('fly')) return;
		const a = u / 8000;
		const x = h.x + 10 * Math.cos(a), z = h.z + 10 * Math.sin(a);
		this.setPose(x, this.ground(x, z) + 8, z, -a);
	}
}
