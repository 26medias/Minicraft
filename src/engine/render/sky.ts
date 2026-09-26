import * as THREE from 'three';
import { SUN_DIR_RAW } from '../world/shadows';

const hex = (h: number) => `vec3(${((h >> 16) & 255) / 255}, ${((h >> 8) & 255) / 255}, ${(h & 255) / 255})`;
const sun = new THREE.Vector3(...SUN_DIR_RAW).normalize();
const sunFlat = new THREE.Vector2(sun.x, sun.z).normalize();

/** Sky colours, sRGB: deep blue overhead, paler at the horizon, warm toward the sun. */
export const SKY_ZENITH = 0x3a7fd5;
export const SKY_HORIZON = 0xa6cdee;
/** Pale gold for the horizon haze (a darker orange mixed into the blue reads as grey); deeper gold for the glow. */
export const SKY_SUN_HAZE = 0xfff0d2;
export const SKY_SUN_GLOW = 0xffc47a;

/**
 * `skyColor(dir)`: the sky's colour looking along the world-space unit vector `dir`, in output (sRGB)
 * space. The sky dome draws it, and fog fades terrain to it along the same direction, so a distant hill
 * melts into the sky behind it instead of into a flat colour: warm and hazy toward the sun, blue away.
 */
export const SKY_GLSL = /* glsl */ `
vec3 skyColor( vec3 dir ) {
	const vec3 SKY_SUN = vec3( ${sun.x}, ${sun.y}, ${sun.z} );
	const vec2 SKY_SUN_FLAT = vec2( ${sunFlat.x}, ${sunFlat.y} );
	float up = clamp( dir.y, 0.0, 1.0 );
	vec3 col = mix( ${hex(SKY_HORIZON)}, ${hex(SKY_ZENITH)}, pow( up, 0.6 ) );
	// Warm haze low in the sky on the sun's side of the horizon.
	float side = max( dot( normalize( dir.xz + vec2( 1e-5 ) ), SKY_SUN_FLAT ), 0.0 );
	col = mix( col, ${hex(SKY_SUN_HAZE)}, 0.5 * pow( side, 3.0 ) * pow( 1.0 - up, 2.5 ) );
	// Broad glow around the sun itself (the Sun quad draws the disc).
	float toSun = max( dot( dir, SKY_SUN ), 0.0 );
	col += ${hex(SKY_SUN_GLOW)} * ( 0.35 * pow( toSun, 12.0 ) );
	return min( col, vec3( 1.0 ) );
}
`;

/**
 * Fog fades to `skyColor` along the view ray instead of to one flat colour. Patches the shared shader
 * chunks (after installRadialFog), so call it before the first material compiles. Idempotent.
 */
export function installSkyFog(): void {
	const C = THREE.ShaderChunk;
	if (C.fog_fragment.includes('skyColor')) return;
	C.fog_pars_vertex += '\n#ifdef USE_FOG\n\tvarying vec3 vFogDir;\n#endif\n';
	// World-space view ray: rotate the view-space position back by the view matrix's transpose.
	C.fog_vertex += '\n#ifdef USE_FOG\n\tvFogDir = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;\n#endif\n';
	C.fog_pars_fragment += `\n#ifdef USE_FOG\n\tvarying vec3 vFogDir;\n${SKY_GLSL}\n#endif\n`;
	C.fog_fragment = C.fog_fragment.replace('mix( gl_FragColor.rgb, fogColor, fogFactor )', 'mix( gl_FragColor.rgb, skyColor( normalize( vFogDir ) ), fogFactor )');
}

/** Inside the camera's 500 far plane and beyond the Sun quad (300), which draws over it. */
const DOME_RADIUS = 400;

/**
 * The sky: a sphere around the camera painted with `skyColor`, drawn first and behind everything
 * (no depth test or write), in place of a flat `scene.background`.
 */
export class SkyDome {
	readonly mesh: THREE.Mesh;

	constructor(scene: THREE.Scene) {
		const material = new THREE.ShaderMaterial({
			vertexShader: /* glsl */ `
				varying vec3 vDir;
				void main() {
					vDir = position;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,
			fragmentShader: /* glsl */ `
				varying vec3 vDir;
				${SKY_GLSL}
				void main() {
					gl_FragColor = vec4( skyColor( normalize( vDir ) ), 1.0 );
				}`,
			side: THREE.BackSide,
			depthTest: false,
			depthWrite: false,
			fog: false,
		});
		this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 16), material);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = -1;
		scene.add(this.mesh);
	}

	/** Keep the dome centred on the camera. Call once per frame before rendering. */
	update(camera: THREE.Camera): void {
		this.mesh.position.copy(camera.position);
	}
}

/**
 * A light colour grade for the world's materials, applied before fog so the fog still meets the sky
 * exactly: a little more saturation and a gentle S-curve. Works in output (sRGB) space.
 */
const GRADE_GLSL = /* glsl */ `
	{
		vec3 c = gl_FragColor.rgb;
		float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
		c = mix( vec3( l ), c, 1.18 );
		c = clamp( c, 0.0, 1.0 );
		c = mix( c, c * c * ( 3.0 - 2.0 * c ), 0.18 );
		gl_FragColor.rgb = c;
	}
	#include <fog_fragment>`;

/** Insert GRADE_GLSL just before fog in a built-in fragment shader. */
export function gradeFragment(fragmentShader: string): string {
	return fragmentShader.replace('#include <fog_fragment>', GRADE_GLSL);
}

/** Install GRADE_GLSL on a built-in material (one whose fragment shader includes fog_fragment). */
export function applyGrade(material: THREE.Material): void {
	material.onBeforeCompile = (shader) => {
		shader.fragmentShader = gradeFragment(shader.fragmentShader);
	};
}
