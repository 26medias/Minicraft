import { World } from './engine/world/world';
import { loadAtlas } from './engine/render/atlas';
import { Renderer } from './engine/render/renderer';
import { meshChunk } from './engine/world/mesher';
import { FpCamera } from './engine/render/camera';
import { setupPointerLock } from './engine/input/pointerLock';

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

	renderer.onTick(() => {
		cam.sync(renderer.camera);
	});
}

main();
