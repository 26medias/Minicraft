import * as THREE from 'three';

const MAX_PITCH = Math.PI / 2 - 0.01;
const MOUSE_SENS = 0.0025;

export class FpCamera {
	yaw = 0;
	pitch = 0;
	readonly position = new THREE.Vector3(256, 70, 256); // start at world center

	applyMouseDelta(dx: number, dy: number) {
		this.yaw -= dx * MOUSE_SENS;
		this.pitch -= dy * MOUSE_SENS;
		if (this.pitch > MAX_PITCH) this.pitch = MAX_PITCH;
		if (this.pitch < -MAX_PITCH) this.pitch = -MAX_PITCH;
	}

	sync(camera: THREE.PerspectiveCamera) {
		camera.position.copy(this.position);
		const q = new THREE.Quaternion().setFromEuler(
			new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'),
		);
		camera.quaternion.copy(q);
	}

	getForward(): THREE.Vector3 {
		return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
	}

	getRight(): THREE.Vector3 {
		return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
	}

	getLookDir(): THREE.Vector3 {
		const cp = Math.cos(this.pitch);
		return new THREE.Vector3(
			-Math.sin(this.yaw) * cp,
			Math.sin(this.pitch),
			-Math.cos(this.yaw) * cp,
		);
	}
}
