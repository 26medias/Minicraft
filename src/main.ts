import './ui/ui.css';
import { World } from './engine/world/world';
import { loadAtlas } from './engine/render/atlas';
import { Renderer } from './engine/render/renderer';
import { meshChunk } from './engine/world/mesher';
import { FpCamera } from './engine/render/camera';
import { setupPointerLock } from './engine/input/pointerLock';
import { Player, type Keys } from './game/player';
import { raycastVoxel } from './engine/input/raycast';
import { mineBlock, placeBlock } from './game/actions';
import { BLOCK_BY_NAME } from './data/blocks.data';
import { Hud } from './ui/hud';

async function main() {
	const app = document.getElementById('app')!;
	const atlas = await loadAtlas();
	const renderer = new Renderer(app, atlas);
	const hud = new Hud(app);
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

	player.hotbar = [
		BLOCK_BY_NAME['grass_block'].id,
		BLOCK_BY_NAME['dirt'].id,
		BLOCK_BY_NAME['stone'].id,
		BLOCK_BY_NAME['cobblestone'].id,
		BLOCK_BY_NAME['oak_planks'].id,
		BLOCK_BY_NAME['oak_log'].id,
		BLOCK_BY_NAME['glass'].id,
		BLOCK_BY_NAME['red_wool'].id,
		BLOCK_BY_NAME['blue_wool'].id,
	];
	hud.setHotbar(player.hotbar, player.selected);

	const REACH = 6;

	window.addEventListener('mousedown', (e) => {
		if (document.pointerLockElement !== renderer.gl.domElement) return;
		const eye = player.eyePosition();
		const dir = cam.getLookDir();
		const hit = raycastVoxel(world, eye, [dir.x, dir.y, dir.z], REACH);
		if (!hit) return;

		let changed = false;
		if (e.button === 0) {
			changed = !!mineBlock(world, hit);
		} else if (e.button === 2) {
			const id = player.hotbar[player.selected];
			if (id !== undefined) {
				changed = placeBlock(world, hit, id, {
					position: player.position,
					size: [0.6, 1.8, 0.6],
				});
			}
		}
		if (!changed) return;
		reMesh(hit.x, hit.y, hit.z);
	});

	window.addEventListener('contextmenu', (e) => e.preventDefault());

	window.addEventListener('keydown', (e) => {
		const n = Number(e.key);
		if (Number.isInteger(n) && n >= 1 && n <= 9) {
			player.selected = n - 1;
			hud.setHotbar(player.hotbar, player.selected);
		}
	});

	function reMesh(wx: number, _wy: number, wz: number) {
		const cx = Math.floor(wx / 16);
		const cz = Math.floor(wz / 16);
		const chunks = new Set<string>([`${cx},${cz}`]);
		const lx = wx - cx * 16,
			lz = wz - cz * 16;
		if (lx === 0) chunks.add(`${cx - 1},${cz}`);
		if (lx === 15) chunks.add(`${cx + 1},${cz}`);
		if (lz === 0) chunks.add(`${cx},${cz - 1}`);
		if (lz === 15) chunks.add(`${cx},${cz + 1}`);
		for (const k of chunks) {
			const [ccx, ccz] = k.split(',').map(Number);
			if (!world.chunkInWorld(ccx, ccz)) continue;
			const c = world.ensureChunk(ccx, ccz);
			renderer.mountChunkMesh(c, meshChunk(c, world.neighbors(c), atlas.uvFor));
		}
	}
}

main();
