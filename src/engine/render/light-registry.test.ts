import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LightRegistry } from './light-registry';

describe('LightRegistry', () => {
	it('add creates a PointLight attached to the scene', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#FFFFFF');
		const lights = scene.children.filter((c) => c instanceof THREE.PointLight);
		expect(lights.length).toBe(1);
		const l = lights[0] as THREE.PointLight;
		expect(l.position.x).toBeCloseTo(10.5);
		expect(l.position.y).toBeCloseTo(20.5);
		expect(l.position.z).toBeCloseTo(30.5);
	});

	it('remove detaches the light from the scene', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#FFFFFF');
		r.remove(10, 20, 30);
		expect(scene.children.filter((c) => c instanceof THREE.PointLight).length).toBe(0);
	});

	it('add on an already-added coord is idempotent', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#FFFFFF');
		r.add(10, 20, 30, '#FF0000');
		expect(scene.children.filter((c) => c instanceof THREE.PointLight).length).toBe(1);
	});

	it('setColor updates the existing light in place', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#FFFFFF');
		r.setColor(10, 20, 30, '#FF0000');
		const l = scene.children.find((c) => c instanceof THREE.PointLight) as THREE.PointLight;
		expect(l.color.getHexString().toLowerCase()).toBe('ff0000');
		expect(r.getColor(10, 20, 30)?.toLowerCase()).toBe('#ff0000');
	});

	it('setColor on an unregistered coord is a no-op (does not throw)', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		expect(() => r.setColor(99, 99, 99, '#FF0000')).not.toThrow();
	});

	it('getColor returns the stored color for a registered coord', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#AABBCC');
		expect(r.getColor(10, 20, 30)?.toLowerCase()).toBe('#aabbcc');
	});

	it('getColor returns null for an unregistered coord', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		expect(r.getColor(99, 99, 99)).toBeNull();
	});

	it('entries yields each registered light as {x,y,z,color}', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(1, 2, 3, '#FF0000');
		r.add(4, 5, 6, '#00FF00');
		const got = [...r.entries()].sort((a, b) => a.x - b.x);
		expect(got).toEqual([
			{ x: 1, y: 2, z: 3, color: '#FF0000' },
			{ x: 4, y: 5, z: 6, color: '#00FF00' },
		]);
	});

	it('remove then add at same coord creates a fresh light', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(1, 2, 3, '#FFFFFF');
		r.remove(1, 2, 3);
		r.add(1, 2, 3, '#FF0000');
		expect(r.getColor(1, 2, 3)?.toLowerCase()).toBe('#ff0000');
		expect(scene.children.filter((c) => c instanceof THREE.PointLight).length).toBe(1);
	});

	it('remove on an unregistered coord is a no-op (does not throw)', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		expect(() => r.remove(99, 99, 99)).not.toThrow();
	});

	it('idempotent add preserves the original color', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#FFFFFF');
		r.add(10, 20, 30, '#FF0000');
		expect(r.getColor(10, 20, 30)?.toLowerCase()).toBe('#ffffff');
	});
});
