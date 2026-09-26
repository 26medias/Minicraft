import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
	CLOUD_CELL, CLOUD_THICK, CLOUD_THIN, CLOUD_UNIFORMS, Clouds, DRIFT_SPEED, PATTERN_N,
	applyChunkShading, buildCloudGeometry, cloudAltitude, cloudPattern, driftAt,
} from './clouds';

describe('cloud pattern', () => {
	const p = cloudPattern();
	const at = (i: number, j: number) => p[(((j % PATTERN_N) + PATTERN_N) % PATTERN_N) * PATTERN_N + (((i % PATTERN_N) + PATTERN_N) % PATTERN_N)];

	it('is the same on every call (every client draws the same sky)', () => {
		expect(cloudPattern()).toEqual(p);
	});

	it('covers about 30% of the sky, with thick middles, and no lone single-cell specks', () => {
		let cloud = 0, thick = 0, specks = 0;
		for (let j = 0; j < PATTERN_N; j++) for (let i = 0; i < PATTERN_N; i++) {
			if (!at(i, j)) continue;
			cloud++;
			if (at(i, j) === 2) thick++;
			if (!at(i + 1, j) && !at(i - 1, j) && !at(i, j + 1) && !at(i, j - 1)) specks++;
		}
		const n = PATTERN_N * PATTERN_N;
		expect(cloud / n).toBeGreaterThan(0.22);
		expect(cloud / n).toBeLessThan(0.32);
		expect(thick / n).toBeGreaterThan(0.08);
		expect(specks).toBe(0);
	});

	it('wherever you stand, a cloud is within 8 cells (96 blocks; measured 7.2), well inside the ~290-block view, so the sky never looks empty', () => {
		let worst = 0;
		for (let j = 0; j < PATTERN_N; j++) for (let i = 0; i < PATTERN_N; i++) {
			let best = Infinity;
			for (let dj = -10; dj <= 10; dj++) for (let di = -10; di <= 10; di++) if (at(i + di, j + dj)) best = Math.min(best, Math.hypot(di, dj));
			worst = Math.max(worst, best);
		}
		expect(worst).toBeLessThanOrEqual(8);
	});
});

describe('cloud geometry', () => {
	const g = buildCloudGeometry(7, -3);
	const quads = g.indices.length / 6;
	const quad = (q: number) => {
		const v = g.indices[q * 6];
		return [0, 1, 2, 3].map((k) => new THREE.Vector3().fromArray(g.positions, (v + k) * 3));
	};

	it('every face is a CCW quad seen from outside its box (front faces point out)', () => {
		expect(quads).toBeGreaterThan(50);
		const centreBelow = new THREE.Vector3();
		for (let q = 0; q < quads; q++) {
			const [a, b, c] = quad(q);
			const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
			const mid = quad(q).reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(0.25);
			// Half a block behind the face (against its normal) lies inside the box it belongs to…
			centreBelow.copy(mid).addScaledVector(n, -0.5);
			const i = Math.floor(centreBelow.x / CLOUD_CELL), j = Math.floor(centreBelow.z / CLOUD_CELL);
			// …inside that cell's box: a cloud cell, and between its bottom and its top.
			const top = [0, CLOUD_THIN, CLOUD_THICK][cloudPattern()[(((j % PATTERN_N) + PATTERN_N) % PATTERN_N) * PATTERN_N + (((i % PATTERN_N) + PATTERN_N) % PATTERN_N)]];
			expect(top).toBeGreaterThan(0);
			expect(centreBelow.y).toBeGreaterThan(0);
			expect(centreBelow.y).toBeLessThan(top);
		}
	});

	it('draws no side between two cells of equal height, and a thick middle steps up over its thin rim', () => {
		let steps = 0;
		for (let q = 0; q < quads; q++) {
			const ys = quad(q).map((p) => p.y);
			const lo = Math.min(...ys), hi = Math.max(...ys);
			if (lo === hi) { expect([0, CLOUD_THIN, CLOUD_THICK]).toContain(lo); continue; } // top or bottom
			expect([[0, CLOUD_THIN], [0, CLOUD_THICK], [CLOUD_THIN, CLOUD_THICK]]).toContainEqual([lo, hi]);
			if (lo === CLOUD_THIN) steps++;
		}
		expect(steps).toBeGreaterThan(0);
	});
});

describe('drift', () => {
	it('moves DRIFT_SPEED blocks per second and wraps after exactly one pattern period (an invisible jump)', () => {
		const t = 1_790_000_000_000; // a 2026 wall clock
		expect(driftAt(t + 10_000) - driftAt(t)).toBeCloseTo(10 * DRIFT_SPEED, 6);
		const period = PATTERN_N * CLOUD_CELL;
		for (let k = 0; k < 50; k++) {
			const d = driftAt(t + k * 997_000);
			expect(d).toBeGreaterThanOrEqual(0);
			expect(d).toBeLessThan(period);
		}
	});

	it('Clouds.update moves the shared shadow offset with the mesh, at the world altitude', () => {
		const clouds = new Clouds(new THREE.Scene());
		clouds.setAltitude(cloudAltitude(256));
		const cam = new THREE.PerspectiveCamera();
		cam.position.set(300, 120, -40);
		clouds.update(cam, 1_790_000_000_000);
		expect(CLOUD_UNIFORMS.cloudOffset.value.x).toBe(clouds.mesh.position.x);
		expect(clouds.mesh.position.y).toBe(cloudAltitude(256));
		expect(CLOUD_UNIFORMS.cloudY.value).toBe(cloudAltitude(256));
		expect(clouds.mesh.geometry.getIndex()!.count).toBeGreaterThan(0);
	});

	it('the clouds sit above a 64-high world and below a 256-high world\'s tallest peaks', () => {
		expect(cloudAltitude(64)).toBeGreaterThan(64 + 20);
		expect(cloudAltitude(256) + CLOUD_THICK).toBeLessThan(256);
	});
});

describe('chunk shading patch', () => {
	it('reads the shade attribute, takes the sun away under a cloud, clamps, applies AO, then grades before fog', () => {
		const m = new THREE.MeshBasicMaterial({ vertexColors: true });
		applyChunkShading(m);
		const shader = {
			vertexShader: THREE.ShaderLib.basic.vertexShader,
			fragmentShader: THREE.ShaderLib.basic.fragmentShader,
			uniforms: {},
		} as unknown as THREE.WebGLProgramParametersWithUniforms;
		m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
		expect(shader.vertexShader).toContain('attribute vec2 shade;');
		expect(shader.vertexShader).toContain('vCloudPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
		const fs = shader.fragmentShader;
		expect(fs).not.toContain('#include <color_fragment>');
		expect(fs).toMatch(/diffuseColor\.rgb \*= min\( vColor - vec3\([^)]*\) \* \( vShade\.x \* cloudShadow\( vCloudPos \) \), vec3\( 1\.0 \) \) \* vShade\.y;/);
		expect(fs.indexOf('mix( vec3( l ), c, 1.18 )')).toBeLessThan(fs.indexOf('#include <fog_fragment>'));
		expect(shader.uniforms.cloudMap).toBe(CLOUD_UNIFORMS.cloudMap); // shared: one update moves every material
	});
});
