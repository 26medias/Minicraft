import * as THREE from 'three';
import { SUN_DIR_RAW } from '../world/shadows';
import { SUN_COLOR } from '../world/mesher';
import { SKY_GLSL, gradeFragment } from './sky';

/** Blocks per cloud cell (Minecraft's clouds are 12-block cells too). */
export const CLOUD_CELL = 12;
/** Cloud thickness in blocks: the thin rim of a cloud, and its puffed-up middle. */
export const CLOUD_THIN = 5;
export const CLOUD_THICK = 10;
/** The pattern repeats every PATTERN_N cells (1152 blocks). */
export const PATTERN_N = 96;
/** Share of cells that hold cloud. */
const COVERAGE = 0.3;
/** Drift toward +x, in blocks per second. */
export const DRIFT_SPEED = 0.6;
/** Clouds are built out to this many cells from the camera (about 290 blocks), and fade out before it. */
const VIEW_CELLS = 24;
/** How much of the direct sun a cloud takes away (clouds are not quite opaque). */
const SHADOW_STRENGTH = 0.85;

/**
 * Cloud base height. In a 256-high world the tallest peaks poke through (they do in Minecraft too; a
 * higher layer reads as far-off slabs from the ground); a 64-high world's clouds sit well above it.
 */
export function cloudAltitude(worldHeight: number): number {
	return worldHeight >= 256 ? 176 : 100;
}

/** mulberry32: a small seeded PRNG, so every client draws the same clouds. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Periodic value noise over an N×N grid with nodes every `step` cells (step divides N). */
function periodicNoise(rand: () => number, n: number, step: number): Float32Array {
	const m = n / step;
	const nodes = Float32Array.from({ length: m * m }, rand);
	const out = new Float32Array(n * n);
	const s = (t: number) => t * t * (3 - 2 * t);
	for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
		const x = i / step, z = j / step;
		const x0 = Math.floor(x), z0 = Math.floor(z);
		const fx = s(x - x0), fz = s(z - z0);
		const at = (a: number, b: number) => nodes[((b % m) * m) + (a % m)];
		const top = at(x0, z0) * (1 - fx) + at(x0 + 1, z0) * fx;
		const bot = at(x0, z0 + 1) * (1 - fx) + at(x0 + 1, z0 + 1) * fx;
		out[j * n + i] = top * (1 - fz) + bot * fz;
	}
	return out;
}

/**
 * The cloud pattern: PATTERN_N × PATTERN_N cells, 0 = clear, 1 = thin cloud, 2 = thick cloud (the
 * middle of a clump). Two octaves of periodic noise plus a little per-cell jitter give clumps with
 * ragged edges; the threshold keeps COVERAGE of the cells, a higher one marks the thick middles,
 * and lone specks are cleared.
 * Fixed seed: the same sky in every world and on every client.
 */
export function cloudPattern(): Uint8Array {
	const n = PATTERN_N;
	const rand = prng(0xc10d5);
	const a = periodicNoise(rand, n, 4), b = periodicNoise(rand, n, 2);
	const v = new Float32Array(n * n);
	for (let k = 0; k < n * n; k++) v[k] = a[k] + 0.5 * b[k] + 0.25 * rand();
	const sorted = Float32Array.from(v).sort();
	const thin = sorted[Math.floor(n * n * (1 - COVERAGE))], thick = sorted[Math.floor(n * n * (1 - COVERAGE * 0.45))];
	const out = new Uint8Array(n * n);
	for (let k = 0; k < n * n; k++) out[k] = v[k] >= thick ? 2 : v[k] >= thin ? 1 : 0;
	// No lone single-cell specks: a cell with no cloud on any of its four sides is cleared.
	const at = (i: number, j: number) => out[(((j + n) % n) * n) + ((i + n) % n)];
	const specks: number[] = [];
	for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
		if (at(i, j) && !at(i + 1, j) && !at(i - 1, j) && !at(i, j + 1) && !at(i, j - 1)) specks.push(j * n + i);
	}
	for (const k of specks) out[k] = 0;
	return out;
}

const PATTERN = cloudPattern();
const wrap = (i: number) => ((i % PATTERN_N) + PATTERN_N) % PATTERN_N;
/** Height in blocks of the cloud in cell (i, j), 0 when clear. */
const cloudTop = (i: number, j: number) => [0, CLOUD_THIN, CLOUD_THICK][PATTERN[wrap(j) * PATTERN_N + wrap(i)]];

function patternTexture(): THREE.DataTexture {
	const data = new Uint8Array(PATTERN.length);
	for (let k = 0; k < PATTERN.length; k++) data[k] = PATTERN[k] > 0 ? 255 : 0;
	const tex = new THREE.DataTexture(data, PATTERN_N, PATTERN_N, THREE.RedFormat, THREE.UnsignedByteType);
	tex.magFilter = THREE.NearestFilter;
	tex.minFilter = THREE.NearestFilter;
	tex.wrapS = THREE.RepeatWrapping;
	tex.wrapT = THREE.RepeatWrapping;
	tex.needsUpdate = true;
	return tex;
}

/** Shared by the cloud mesh and every chunk material, so one update per frame moves both. */
export const CLOUD_UNIFORMS = {
	cloudMap: { value: patternTexture() },
	/** World-space x, z of the pattern's origin: the drift. */
	cloudOffset: { value: new THREE.Vector2() },
	cloudY: { value: cloudAltitude(256) },
	/** 1 in play; the dev oracle sets 0 to diff a frame with and without cloud shadows. */
	cloudShadowScale: { value: 1 },
};

/** The drift at wall-clock time `ms`, wrapped to one pattern period (clients agree to within their clocks). */
export function driftAt(ms: number): number {
	const period = PATTERN_N * CLOUD_CELL;
	return ((ms / 1000) * DRIFT_SPEED) % period;
}

const sun = new THREE.Vector3(...SUN_DIR_RAW).normalize();
const f = (x: number) => x.toFixed(6);

/**
 * `cloudShadow(p)`: 0..SHADOW_STRENGTH, how much of the sun a cloud takes from world point p. It
 * follows the sun ray from p up to the middle of the cloud layer and reads the pattern cell there.
 */
const CLOUD_SHADOW_GLSL = /* glsl */ `
uniform sampler2D cloudMap;
uniform vec2 cloudOffset;
uniform float cloudY;
uniform float cloudShadowScale;
float cloudShadow( vec3 p ) {
	if ( p.y >= cloudY ) return 0.0;
	const vec3 L = vec3( ${f(sun.x)}, ${f(sun.y)}, ${f(sun.z)} );
	vec2 q = p.xz + L.xz * ( ( cloudY + ${f(CLOUD_THIN / 2)} - p.y ) / L.y ) - cloudOffset;
	vec2 cell = floor( q / ${f(CLOUD_CELL)} );
	return texture2D( cloudMap, ( cell + 0.5 ) / ${f(PATTERN_N)} ).r * ${f(SHADOW_STRENGTH)} * cloudShadowScale;
}
`;

/**
 * The chunk materials' shader patch: vertex light is min(colour − SUN_COLOR × sun × cloudShadow, 1) × ao
 * (see ChunkMesh.shade), then the colour grade, then fog. With no cloud overhead it is exactly the
 * mesher's clamp(colour) × ao.
 */
export function applyChunkShading(material: THREE.Material): void {
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, CLOUD_UNIFORMS);
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nattribute vec2 shade;\nvarying vec2 vShade;\nvarying vec3 vCloudPos;')
			.replace('#include <project_vertex>', '#include <project_vertex>\n\tvShade = shade;\n\tvCloudPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
		shader.fragmentShader = gradeFragment(shader.fragmentShader
			.replace('#include <common>', `#include <common>\nvarying vec2 vShade;\nvarying vec3 vCloudPos;\n${CLOUD_SHADOW_GLSL}`)
			.replace('#include <color_fragment>', `diffuseColor.rgb *= min( vColor - vec3( ${SUN_COLOR.map(f).join(', ')} ) * ( vShade.x * cloudShadow( vCloudPos ) ), vec3( 1.0 ) ) * vShade.y;`));
	};
}

// Cloud face tints (sRGB, drawn as-is like the sky): white on top, cool underneath, sides by the sun.
const TOP = [1.0, 0.99, 0.97];
const BOTTOM = [0.74, 0.79, 0.88];
const SIDE_SUN = [0.96, 0.94, 0.92];
const SIDE_AWAY = [0.84, 0.87, 0.93];

/** Box faces as [normal, 4 corners (unit cube, CCW from outside)]. */
const FACES: [number[], number[][]][] = [
	[[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
	[[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
	[[1, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
	[[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
	[[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
	[[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
];

function faceTint(n: number[]): number[] {
	if (n[1] > 0) return TOP;
	if (n[1] < 0) return BOTTOM;
	const t = Math.max(0, n[0] * sun.x + n[2] * sun.z) / Math.hypot(sun.x, sun.z);
	return SIDE_AWAY.map((a, k) => a + (SIDE_SUN[k] - a) * t);
}

/**
 * Geometry for the cloud cells within VIEW_CELLS of cloud-space cell (ci, cj): one box per cloudy
 * cell, as tall as cloudTop. A side is drawn only above the neighbour's top, so the faces between two
 * cloud cells are left out and a thick middle shows a step over a thin rim. Coordinates are cloud
 * space (the mesh is moved by the drift); y runs up from 0 (the mesh is lifted to the altitude).
 */
export function buildCloudGeometry(ci: number, cj: number): { positions: Float32Array; tints: Float32Array; indices: Uint32Array } {
	const pos: number[] = [], tint: number[] = [], idx: number[] = [];
	for (let dj = -VIEW_CELLS; dj <= VIEW_CELLS; dj++) for (let di = -VIEW_CELLS; di <= VIEW_CELLS; di++) {
		if (di * di + dj * dj > VIEW_CELLS * VIEW_CELLS) continue;
		const i = ci + di, j = cj + dj;
		const top = cloudTop(i, j);
		if (top === 0) continue;
		for (const [n, corners] of FACES) {
			const floor = n[1] === 0 ? cloudTop(i + n[0], j + n[2]) : 0;
			if (floor >= top) continue;
			const v = pos.length / 3;
			const c = faceTint(n);
			for (const [x, y, z] of corners) {
				pos.push((i + x) * CLOUD_CELL, n[1] === 0 ? (y ? top : floor) : y * top, (j + z) * CLOUD_CELL);
				tint.push(c[0], c[1], c[2]);
			}
			idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
		}
	}
	return { positions: new Float32Array(pos), tints: new Float32Array(tint), indices: new Uint32Array(idx) };
}

/**
 * Blocky clouds drifting slowly toward +x. The mesh holds the cells around the camera and is rebuilt
 * when the camera's cloud-space cell changes (drift or travel); in between, only its position moves.
 * Clouds are opaque (a see-through box shows its own back faces); they fade out toward the edge of
 * that disc and take on some sky colour with distance.
 */
export class Clouds {
	readonly mesh: THREE.Mesh;
	private cell: [number, number] | null = null;
	private material: THREE.ShaderMaterial;

	constructor(scene: THREE.Scene) {
		this.material = new THREE.ShaderMaterial({
			uniforms: { cloudFadeEnd: { value: VIEW_CELLS * CLOUD_CELL } },
			vertexShader: /* glsl */ `
				attribute vec3 tint;
				varying vec3 vTint;
				varying vec3 vWorld;
				void main() {
					vTint = tint;
					vec4 w = modelMatrix * vec4( position, 1.0 );
					vWorld = w.xyz;
					gl_Position = projectionMatrix * viewMatrix * w;
				}`,
			fragmentShader: /* glsl */ `
				uniform float cloudFadeEnd;
				varying vec3 vTint;
				varying vec3 vWorld;
				${SKY_GLSL}
				void main() {
					float d = length( vWorld.xz - cameraPosition.xz );
					vec3 col = mix( vTint, skyColor( normalize( vWorld - cameraPosition ) ), 0.45 * smoothstep( 40.0, cloudFadeEnd, d ) );
					float a = 1.0 - smoothstep( cloudFadeEnd * 0.6, cloudFadeEnd * 0.95, d );
					gl_FragColor = vec4( col, a );
				}`,
			transparent: true,
			depthWrite: true,
			side: THREE.FrontSide,
			fog: false,
		});
		this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
		this.mesh.frustumCulled = false;
		scene.add(this.mesh);
	}

	/** Set the cloud layer's height for the world being played (cloudAltitude). */
	setAltitude(y: number): void {
		CLOUD_UNIFORMS.cloudY.value = y;
	}

	/** Move the clouds to wall-clock time `ms` and keep the disc of cells centred on the camera. */
	update(camera: THREE.Camera, ms: number): void {
		const drift = driftAt(ms);
		CLOUD_UNIFORMS.cloudOffset.value.set(drift, 0);
		this.mesh.position.set(drift, CLOUD_UNIFORMS.cloudY.value, 0);
		const ci = Math.floor((camera.position.x - drift) / CLOUD_CELL);
		const cj = Math.floor(camera.position.z / CLOUD_CELL);
		if (this.cell && this.cell[0] === ci && this.cell[1] === cj) return;
		this.cell = [ci, cj];
		const g = buildCloudGeometry(ci, cj);
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
		geo.setAttribute('tint', new THREE.BufferAttribute(g.tints, 3));
		geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
		this.mesh.geometry.dispose();
		this.mesh.geometry = geo;
	}
}
