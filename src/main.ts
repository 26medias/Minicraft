import { World } from './engine/world/world';
import { loadAtlas } from './engine/render/atlas';
import { Renderer } from './engine/render/renderer';
import { meshChunk } from './engine/world/mesher';
import { FpCamera } from './engine/render/camera';
import { setupPointerLock } from './engine/input/pointerLock';
import { Player, type Keys } from './game/player';

async function main() {
	const app = document.getElementById('app')!;
	const atlas = await loadAtlas();
	const renderer = new Renderer(app, atlas);
	const cam = new FpCamera();

	setupPointerLock(renderer.gl.domElement, (dx, dy) => cam.applyMouseDelta(dx, dy));

	const world = new World(42);
	for (let cx = 14; cx <= 17; cx++) {
		for (let cz = 14; cz <= 17; cz++) {
			world.ensureChunk(cx, cz);
		}
	}
	for (let cx = 14; cx <= 17; cx++) {
		for (let cz = 14; cz <= 17; cz++) {
			const c = world.ensureChunk(cx, cz);
			renderer.mountChunkMesh(c, meshChunk(c, world.neighbors(c), atlas.uvFor));
		}
	}

	const player = new Player([256, 60, 256]);

	const keys: Keys = { forward: false, back: false, left: false, right: false, jump: false };
	window.addEventListener('keydown', (e) => {
		if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.forward = true;
		if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.back = true;
		if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = true;
		if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = true;
		if (e.code === 'Space') keys.jump = true;
	});
	window.addEventListener('keyup', (e) => {
		if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.forward = false;
		if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.back = false;
		if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = false;
		if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = false;
		if (e.code === 'Space') keys.jump = false;
	});

	renderer.onTick((dt) => {
		player.update(dt, world, keys, cam.getForward(), cam.getRight());
		const eye = player.eyePosition();
		cam.position.set(eye[0], eye[1], eye[2]);
		cam.sync(renderer.camera);
	});
}

main();
