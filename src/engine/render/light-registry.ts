import * as THREE from 'three';

const INTENSITY = 1.5;
const DISTANCE = 12;
const DECAY = 1.5;

function key(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

type Entry = { light: THREE.PointLight; color: string };

export class LightRegistry {
	private entries_ = new Map<string, Entry>();

	constructor(private scene: THREE.Scene) {}

	add(x: number, y: number, z: number, colorHex: string): void {
		const k = key(x, y, z);
		if (this.entries_.has(k)) return;
		const light = new THREE.PointLight(new THREE.Color(colorHex), INTENSITY, DISTANCE, DECAY);
		light.position.set(x + 0.5, y + 0.5, z + 0.5);
		this.scene.add(light);
		this.entries_.set(k, { light, color: colorHex });
	}

	remove(x: number, y: number, z: number): void {
		const k = key(x, y, z);
		const entry = this.entries_.get(k);
		if (!entry) return;
		this.scene.remove(entry.light);
		this.entries_.delete(k);
	}

	setColor(x: number, y: number, z: number, colorHex: string): void {
		const entry = this.entries_.get(key(x, y, z));
		if (!entry) return;
		entry.light.color.set(colorHex);
		entry.color = colorHex;
	}

	getColor(x: number, y: number, z: number): string | null {
		return this.entries_.get(key(x, y, z))?.color ?? null;
	}

	*entries(): Iterable<{ x: number; y: number; z: number; color: string }> {
		for (const [k, entry] of this.entries_) {
			const [xs, ys, zs] = k.split(',');
			yield { x: Number(xs), y: Number(ys), z: Number(zs), color: entry.color };
		}
	}
}
