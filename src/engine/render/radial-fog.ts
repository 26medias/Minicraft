import * as THREE from 'three';

/**
 * Make three's fog use the distance to the camera instead of the depth along the view axis.
 * With depth fog a mountain off to the side is clear and fades as you turn to face it, because
 * turning raises its depth while its distance stays the same. Patches the shared shader chunk, so
 * call it before the first material compiles (renderer.ts does, at import).
 */
export function installRadialFog(): void {
	THREE.ShaderChunk.fog_vertex = THREE.ShaderChunk.fog_vertex.replace('vFogDepth = - mvPosition.z;', 'vFogDepth = length( mvPosition.xyz );');
}
