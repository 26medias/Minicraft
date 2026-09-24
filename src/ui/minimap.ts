// The round, rotating multiplayer minimap (spec §7.6). Geometry and colouring live in minimap-model.ts.
import { skinColor } from '../data/skins.data';
import {
	ColumnCache,
	MAP_CELLS,
	MAP_RADIUS_BLOCKS,
	MAX_REBUILDS_PER_FRAME,
	fillMap,
	heightArrow,
	mapRotation,
	toMap,
	type MapWorld,
} from './minimap-model';

/** On-screen diameter, CSS px. */
const SIZE = 160;
const RADIUS = SIZE / 2;
/** A clamped dot sits this far inside the rim so it stays whole. */
const RIM_INSET = 7;
const DOT_RADIUS = 5;
const REDRAW_MS = 100;

export type MinimapPlayer = { position: readonly [number, number, number] };
export type MinimapOther = { x: number; y: number; z: number; skin: string };

export class Minimap {
	readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D | null;
	private readonly terrain: HTMLCanvasElement;
	private readonly terrainCtx: CanvasRenderingContext2D | null;
	private readonly image: ImageData | null;
	private readonly cache = new ColumnCache();
	private readonly dpr: number;
	private lastDraw = -Infinity;

	constructor(app: HTMLElement, private readonly colorTable: Uint8Array) {
		this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
		this.canvas = document.createElement('canvas');
		this.canvas.id = 'minimap';
		this.canvas.width = Math.round(SIZE * this.dpr);
		this.canvas.height = Math.round(SIZE * this.dpr);
		this.ctx = this.canvas.getContext('2d');
		this.terrain = document.createElement('canvas');
		this.terrain.width = MAP_CELLS;
		this.terrain.height = MAP_CELLS;
		this.terrainCtx = this.terrain.getContext('2d');
		this.image = this.terrainCtx ? this.terrainCtx.createImageData(MAP_CELLS, MAP_CELLS) : null;
		app.appendChild(this.canvas);
	}

	/** Call every frame; redraws at 10 Hz. `yaw` is the camera's. */
	update(now: number, world: MapWorld, player: MinimapPlayer, yaw: number, others: readonly MinimapOther[]): void {
		if (now - this.lastDraw < REDRAW_MS) return;
		this.lastDraw = now;
		const ctx = this.ctx;
		if (!ctx || !this.terrainCtx || !this.image) return;
		const [px, py, pz] = player.position;

		fillMap(this.image.data, world, px, pz, this.cache, this.colorTable, MAX_REBUILDS_PER_FRAME);
		this.terrainCtx.putImageData(this.image, 0, 0);

		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.clearRect(0, 0, SIZE, SIZE);
		ctx.save();
		ctx.beginPath();
		ctx.arc(RADIUS, RADIUS, RADIUS, 0, Math.PI * 2);
		ctx.clip();
		ctx.translate(RADIUS, RADIUS);
		ctx.rotate(mapRotation(yaw));
		ctx.imageSmoothingEnabled = false;
		// The player's point inside the image: its centre cell plus the fraction within the block.
		const cell = RADIUS / MAP_RADIUS_BLOCKS;
		const fx = px - Math.floor(px);
		const fz = pz - Math.floor(pz);
		ctx.drawImage(
			this.terrain,
			-(MAP_RADIUS_BLOCKS + fx) * cell,
			-(MAP_RADIUS_BLOCKS + fz) * cell,
			MAP_CELLS * cell,
			MAP_CELLS * cell,
		);
		ctx.restore();

		ctx.save();
		ctx.translate(RADIUS, RADIUS);
		for (const o of others) this.drawDot(ctx, px, py, pz, yaw, o);
		this.drawSelf(ctx);
		ctx.restore();
	}

	remove(): void {
		this.canvas.remove();
	}

	private drawDot(
		ctx: CanvasRenderingContext2D,
		px: number,
		py: number,
		pz: number,
		yaw: number,
		o: MinimapOther,
	): void {
		const p = toMap(px, pz, yaw, o.x, o.z, MAP_RADIUS_BLOCKS, RADIUS);
		let { x, y } = p;
		if (p.clamped) {
			const k = (RADIUS - RIM_INSET) / RADIUS;
			x *= k;
			y *= k;
		}
		ctx.beginPath();
		ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
		ctx.fillStyle = skinColor(o.skin);
		ctx.fill();
		ctx.lineWidth = 2;
		ctx.strokeStyle = '#FFFFFF';
		ctx.stroke();
		const arrow = heightArrow(o.y - py);
		if (arrow) {
			ctx.font = 'bold 10px sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			// Beside the dot, toward the centre, so a rim dot's arrow stays on the map.
			const side = x > 0 ? -1 : 1;
			ctx.lineWidth = 3;
			ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
			ctx.strokeText(arrow, x + side * (DOT_RADIUS + 6), y);
			ctx.fillStyle = '#FFFFFF';
			ctx.fillText(arrow, x + side * (DOT_RADIUS + 6), y);
		}
	}

	/** A white arrow at the centre, pointing up: the map is forward-up. */
	private drawSelf(ctx: CanvasRenderingContext2D): void {
		ctx.beginPath();
		ctx.moveTo(0, -8);
		ctx.lineTo(6, 6);
		ctx.lineTo(0, 3);
		ctx.lineTo(-6, 6);
		ctx.closePath();
		ctx.fillStyle = '#FFFFFF';
		ctx.fill();
		ctx.lineWidth = 1.5;
		ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
		ctx.stroke();
	}
}
