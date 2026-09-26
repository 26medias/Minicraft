import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { installRadialFog } from './radial-fog';
import { SkyDome, applyGrade, installSkyFog } from './sky';

describe('sky fog', () => {
	it('fog fades to the sky colour along the view ray, not to the flat fog colour', () => {
		installRadialFog();
		installSkyFog();
		const C = THREE.ShaderChunk;
		expect(C.fog_fragment).toContain('skyColor( normalize( vFogDir ) )');
		expect(C.fog_fragment).not.toContain('fogColor, fogFactor');
		expect(C.fog_pars_fragment).toContain('vec3 skyColor( vec3 dir )');
		expect(C.fog_vertex).toContain('vFogDir = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz');
		expect(C.fog_vertex).toContain('length( mvPosition.xyz )'); // radial fog still in place
		installSkyFog(); // idempotent
		expect(C.fog_pars_fragment.match(/vec3 skyColor/g)).toHaveLength(1);
		expect(C.fog_vertex.match(/vFogDir =/g)).toHaveLength(1);
	});

	it('the dome paints the same skyColor, behind everything, around the camera', () => {
		const scene = new THREE.Scene();
		const dome = new SkyDome(scene);
		const m = dome.mesh.material as THREE.ShaderMaterial;
		expect(m.fragmentShader).toContain('skyColor( normalize( vDir ) )');
		expect(m.depthTest).toBe(false);
		expect(m.depthWrite).toBe(false);
		expect(m.side).toBe(THREE.BackSide);
		expect(dome.mesh.renderOrder).toBeLessThan(0);
		const cam = new THREE.PerspectiveCamera();
		cam.position.set(10, 80, -3);
		dome.update(cam);
		expect(dome.mesh.position.toArray()).toEqual([10, 80, -3]);
	});

	it('the grade runs before fog, so fogged terrain still meets the sky exactly', () => {
		const m = new THREE.MeshBasicMaterial();
		applyGrade(m);
		const shader = { fragmentShader: THREE.ShaderLib.basic.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
		m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
		const src = shader.fragmentShader;
		expect(src.indexOf('mix( vec3( l ), c, 1.18 )')).toBeGreaterThan(-1);
		expect(src.indexOf('mix( vec3( l ), c, 1.18 )')).toBeLessThan(src.indexOf('#include <fog_fragment>'));
	});
});
