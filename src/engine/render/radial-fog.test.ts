import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { installRadialFog } from './radial-fog';

describe('radial fog', () => {
	it('fog uses the true distance to the camera, not the depth along the view axis', () => {
		// Depth fog (three's default, `-mvPosition.z`) clears a mountain seen from the side and fogs it
		// when you turn to face it; the distance is the same, so the fog must be too.
		installRadialFog();
		expect(THREE.ShaderChunk.fog_vertex).toContain('length( mvPosition.xyz )');
		expect(THREE.ShaderChunk.fog_vertex).not.toContain('- mvPosition.z');
		installRadialFog(); // idempotent
		expect(THREE.ShaderChunk.fog_vertex.match(/length\( mvPosition\.xyz \)/g)).toHaveLength(1);
	});
});
