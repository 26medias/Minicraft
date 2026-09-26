import { BLOCKS, WATER, type BlockId } from '../data/blocks.data';
import { worldToChunk } from '../engine/world/coords';
import { SEA_LEVEL } from '../engine/world/generation';
import { SEA_LEVEL_V2 } from '../engine/world/generation.v2';
import type { World } from '../engine/world/world';
import type { Player } from '../game/player';
import { blockSound } from './block-sounds';
import { waterLevels, windLevels, type Sampler } from './ambience';
import { audioContext, loadSounds, setDuck, soundsReady, startLoop, playSound, type LoopHandle } from './engine';
import { MusicPlayer } from './music';
import { distanceGain, hitsDue, makeBoomGate, makeSplashDetector, makeThrottle, PICKUP_EVERY_MS } from './rules';
import { breakSound, hitSound, placeSound, type SoundName } from './sounds.data';

type MiningNow = { x: number; y: number; z: number; blockId: BlockId; elapsedMs: number; durationMs: number } | null;

const SCAN_EVERY_MS = 250;
const REMOTE_EVERY_MS = 150;
/** Edits that arrive while joining are the world catching up, not a friend at work (kid-lens (c)). */
const REMOTE_QUIET_MS = 3000;

/**
 * Everything the game sounds like (sound spec): one per world, fed by main.ts from the loop's
 * hooks and the per-frame callback. The local player's own sounds are not positioned; everyone
 * else's fade with distance.
 */
export class GameAudio {
	private readonly music = new MusicPlayer();
	private readonly sea: number;
	private readonly sampler: Sampler;
	private loops: Record<'lake' | 'stream' | 'waterfall' | 'light' | 'strong', LoopHandle> | null = null;
	private lastScan = -Infinity;
	private mineKey = '';
	private hitsPlayed = 0;
	private readonly pickupGate = makeThrottle(PICKUP_EVERY_MS);
	private readonly boomGate = makeBoomGate();
	private readonly splash = makeSplashDetector();
	private readonly remoteGate = makeThrottle(REMOTE_EVERY_MS);
	private remotePending: { sound: SoundName; d: number } | null = null;
	private lastVy = 0;
	private readonly startedAt = performance.now();
	private silenced = false;
	/** The last scan's targets, for the dev oracle (sound-smoke). */
	private last = { lake: 0, stream: 0, waterfall: 0, light: 0, strong: 0 };

	constructor(private readonly world: World, private readonly player: Player) {
		this.sea = world.genVersion === 1 ? SEA_LEVEL : SEA_LEVEL_V2;
		this.sampler = {
			water: (x, y, z) => {
				if (y < 0 || y >= world.height) return 'none';
				const { cx, cz, lx, lz } = worldToChunk(x, z);
				const c = world.getChunk(cx, cz);
				if (!c || c.get(lx, y, lz) !== WATER) return 'none';
				return c.isFlow(lx, y, lz) ? 'flow' : 'source';
			},
			open: (x, y, z) => {
				if (y >= world.height) return true;
				if (y < 0) return false;
				const { cx, cz, lx, lz } = worldToChunk(x, z);
				const c = world.getChunk(cx, cz);
				if (!c) return false;
				const id = c.get(lx, y, lz);
				return id !== WATER && !BLOCKS[id]?.solid;
			},
			air: (x, y, z) => {
				if (y >= world.height) return true;
				if (y < 0) return false;
				const { cx, cz, lx, lz } = worldToChunk(x, z);
				const c = world.getChunk(cx, cz);
				return !!c && c.get(lx, y, lz) === 0;
			},
		};
	}

	/** The first click or key of the world: decode the files, start the music clock. */
	begin(): void {
		void loadSounds();
		this.music.start();
	}

	/** Pause menu, inventory: the world keeps sounding at half volume (spec §3). */
	setPaused(paused: boolean): void {
		setDuck(paused ? 0.5 : 1);
	}

	/** Quit or the play-time lock: everything fades out, and stays out. */
	silence(): void {
		this.silenced = true;
		this.music.stop();
		if (this.loops) for (const l of Object.values(this.loops)) l.stop();
		this.loops = null;
	}

	private material(id: BlockId) {
		const def = BLOCKS[id];
		return def ? blockSound(def) : 'stone';
	}

	private dist(x: number, y: number, z: number): number {
		const [ex, ey, ez] = this.player.eyePosition();
		return Math.hypot(x + 0.5 - ex, y + 0.5 - ey, z + 0.5 - ez);
	}

	// --- The local player ---------------------------------------------------------------------

	/** Every frame, with the loop's mining info and whether the world is paused. */
	frame(now: number, mi: MiningNow, paused: boolean): void {
		if (this.silenced) return;
		if (!paused) {
			this.mining(mi);
			this.water(now);
		}
		this.flushRemote(now);
		if (now - this.lastScan >= SCAN_EVERY_MS) {
			this.lastScan = now;
			this.ambience();
		}
	}

	private mining(mi: MiningNow): void {
		if (!mi) {
			this.mineKey = '';
			return;
		}
		const key = `${mi.x},${mi.y},${mi.z},${mi.durationMs}`;
		if (key !== this.mineKey) {
			this.mineKey = key;
			this.hitsPlayed = 0;
		}
		const due = hitsDue(mi.elapsedMs, mi.durationMs);
		if (due > this.hitsPlayed) {
			this.hitsPlayed = due;
			playSound(hitSound(this.material(mi.blockId)));
		}
	}

	/** A mined block broke (one, or an area: one sound for the aimed block's material). */
	broke(aimedId: BlockId): void {
		if (this.silenced) return;
		playSound(breakSound(this.material(aimedId)));
		this.pickup();
	}

	/** Blocks went into the inventory (a break, an area break, a blast). */
	pickup(): void {
		if (this.pickupGate(performance.now())) playSound('pickup', 1, 0.06);
	}

	placed(id: BlockId): void {
		if (this.silenced) return;
		playSound(placeSound(this.material(id)));
	}

	/** Any TNT blast, ours or a friend's (fireworks have no boom). */
	boom(x: number, y: number, z: number): void {
		if (this.silenced) return;
		const g = distanceGain(this.dist(x, y, z), 64);
		if (g > 0 && this.boomGate(performance.now())) playSound('tnt', g);
	}

	private water(now: number): void {
		const [px, py, pz] = this.player.position;
		const feetInWater = this.sampler.water(Math.floor(px), Math.floor(py), Math.floor(pz)) !== 'none';
		if (this.splash(now, feetInWater, this.lastVy)) playSound('splash');
		this.lastVy = this.player.vy;
	}

	// --- Other players --------------------------------------------------------------------------

	/**
	 * A friend's hand edit (main.ts checks isHandEdit, so blasts and water flow never get here), BEFORE
	 * it is applied: `blockAt` still sees the old blocks. One sound per message, the nearest cell,
	 * and at most one every 150 ms (kid-lens #1).
	 */
	remoteEdit(ops: readonly (readonly number[])[], blockAt: (x: number, y: number, z: number) => number): void {
		if (this.silenced) return;
		const solid = (id: number) => id > 0 && (BLOCKS[id]?.liquid ?? 'none') === 'none';
		for (const [x, y, z, id] of ops) {
			const old = blockAt(x, y, z);
			let sound: SoundName;
			if (solid(id)) sound = placeSound(this.material(id));
			else if (id === 0 && solid(old)) sound = breakSound(this.material(old));
			else continue;
			const d = this.dist(x, y, z);
			if (!this.remotePending || d < this.remotePending.d) this.remotePending = { sound, d };
		}
	}

	/** A friend's pickaxe hit, at the puff rate. */
	remoteHit(blockId: BlockId, x: number, y: number, z: number): void {
		if (this.silenced) return;
		playSound(hitSound(this.material(blockId)), distanceGain(this.dist(x, y, z)));
	}

	private flushRemote(now: number): void {
		const p = this.remotePending;
		if (!p) return;
		if (now - this.startedAt < REMOTE_QUIET_MS) {
			this.remotePending = null;
			return;
		}
		if (!this.remoteGate(now)) return; // keep the nearest until the gate opens
		this.remotePending = null;
		playSound(p.sound, distanceGain(p.d));
	}

	// --- Nature ---------------------------------------------------------------------------------

	private ambience(): void {
		if (!this.loops) {
			if (!soundsReady()) return;
			const make = (n: SoundName) => startLoop(n);
			const l = { lake: make('amb_lake'), stream: make('amb_stream'), waterfall: make('amb_waterfall'), light: make('amb_wind_light'), strong: make('amb_wind_strong') };
			if (Object.values(l).some((h) => !h)) return;
			this.loops = l as NonNullable<GameAudio['loops']>;
		}
		const [ex, ey, ez] = this.player.eyePosition();
		const under = this.player.swimming;
		const w = waterLevels(this.sampler, ex, ey, ez);
		const k = under ? 0.3 : 1;
		this.loops.lake.setLevel(w.lake * k, 0.4);
		this.loops.stream.setLevel(w.stream * k, 0.4);
		this.loops.waterfall.setLevel(w.waterfall * k, 0.4);
		const wind = under ? { light: 0, strong: 0 } : windLevels(ey, this.sea, this.world.height, this.underSky(ex, ey, ez));
		this.loops.light.setLevel(wind.light, 1);
		this.loops.strong.setLevel(wind.strong, 1);
		this.last = { lake: w.lake * k, stream: w.stream * k, waterfall: w.waterfall * k, light: wind.light, strong: wind.strong };
	}

	/** Dev oracle: is sound running, are the files decoded, what the scan asked for. */
	debug(): { state: string; ready: boolean; loops: boolean; levels: GameAudio['last'] } {
		return { state: audioContext()?.state ?? 'none', ready: soundsReady(), loops: this.loops !== null, levels: { ...this.last } };
	}

	private underSky(ex: number, ey: number, ez: number): boolean {
		const x = Math.floor(ex), y = Math.floor(ey), z = Math.floor(ez);
		if (y >= this.world.height) return true;
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.world.getChunk(cx, cz);
		return !!c && y >= 0 && c.getSky(lx, y, lz) === 15;
	}
}
