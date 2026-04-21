import { World } from './engine/world/world';
import { loadAtlas } from './engine/render/atlas';
import { Renderer } from './engine/render/renderer';
import { meshChunk } from './engine/world/mesher';

async function main() {
	const app = document.getElementById('app')!;
	const atlas = await loadAtlas();
	const renderer = new Renderer(app, atlas);

	const world = new World(42);
	const chunk = world.ensureChunk(0, 0);
	const mesh = meshChunk(chunk, world.neighbors(chunk), atlas.uvFor);
	renderer.mountChunkMesh(chunk, mesh);
}

main();
