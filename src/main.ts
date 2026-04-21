import './ui/ui.css';
import { World } from './engine/world/world';
import { loadAtlas } from './engine/render/atlas';
import { Renderer } from './engine/render/renderer';
import { FpCamera } from './engine/render/camera';
import { setupPointerLock } from './engine/input/pointerLock';
import { Player, type Keys } from './game/player';
import { GameLoop } from './game/loop';
import { raycastVoxel } from './engine/input/raycast';
import { mineBlock, placeBlock } from './game/actions';
import { Hud } from './ui/hud';
import { MainMenu } from './ui/menu';
import { OptionsMenu } from './ui/options';
import { LocalStorageAdapter } from './persistence/localStorage';
import { AutoSave } from './persistence/autosave';
import { decodeChunk } from './persistence/codec';
import { BLOCKS } from './data/blocks.data';
import { loadOptions } from './data/keybindings.data';
import type { Action } from './data/keybindings.data';
import { worldToChunk } from './engine/world/coords';

const REACH = 6;

async function main() {
	const app = document.getElementById('app')!;
	const atlas = await loadAtlas();
	const renderer = new Renderer(app, atlas);
	const cam = new FpCamera();
	const hud = new Hud(app);
	const adapter = new LocalStorageAdapter();
	const menu = new MainMenu(app, adapter);
	const options = new OptionsMenu(app);

	setupPointerLock(renderer.gl.domElement, (dx, dy) => cam.applyMouseDelta(dx, dy));

	function showMenu() {
		menu.show((action) => {
			if (action.type === 'options') {
				options.show(() => showMenu());
				return;
			}
			if (action.type === 'new') startGame(action.seed, action.name, null);
			else startGame(action.seed, '', 'continue');
		});
	}

	showMenu();

	async function startGame(seed: number, name: string, mode: null | 'continue') {
		menu.hide();
		const world = new World(seed);
		let createdAt = Date.now();
		let worldName = name;

		const player = new Player([256, 60, 256]);

		if (mode === 'continue') {
			const save = await adapter.loadWorld(seed);
			if (!save) {
				console.warn('No save for seed', seed);
			} else {
				worldName = save.name;
				createdAt = save.createdAt;
				for (const enc of save.modifiedChunks) {
					const c = world.ensureChunk(enc.cx, enc.cz);
					const blocks = decodeChunk(enc.data);
					c.blocks.set(blocks);
					c.modified = true;
					c.dirty = true;
				}
				player.position = [save.player.x, save.player.y, save.player.z];
				cam.yaw = save.player.yaw;
				cam.pitch = save.player.pitch;
				player.hotbar = save.player.hotbar;
				player.selected = save.player.selected;
			}
		}

		if (player.hotbar.length === 0) {
			const opts = loadOptions();
			const pool = BLOCKS.filter((b) => b.id !== 0 && (opts.kidMode ? b.kidMode : true));
			player.hotbar = pool.slice(0, 9).map((b) => b.id);
		}
		hud.setHotbar(player.hotbar, player.selected);

		const keys: Keys = { forward: false, back: false, left: false, right: false, jump: false };
		const opts = loadOptions();
		const keyToAction: Record<string, Action> = {};
		for (const [action, code] of Object.entries(opts.keybindings))
			keyToAction[code] = action as Action;

		const onKey = (down: boolean) => (e: KeyboardEvent) => {
			const a = keyToAction[e.code];
			if (!a) return;
			switch (a) {
				case 'forward':
					keys.forward = down;
					break;
				case 'back':
					keys.back = down;
					break;
				case 'left':
					keys.left = down;
					break;
				case 'right':
					keys.right = down;
					break;
				case 'jump':
					keys.jump = down;
					break;
				default: {
					if (down && a.startsWith('slot')) {
						const n = Number(a.slice(4)) - 1;
						if (n >= 0 && n < player.hotbar.length) {
							player.selected = n;
							hud.setHotbar(player.hotbar, player.selected);
						}
					}
				}
			}
		};
		window.addEventListener('keydown', onKey(true));
		window.addEventListener('keyup', onKey(false));

		const autosave = new AutoSave(
			adapter,
			world,
			() => ({
				x: player.position[0],
				y: player.position[1],
				z: player.position[2],
				yaw: cam.yaw,
				pitch: cam.pitch,
				hotbar: player.hotbar,
				selected: player.selected,
			}),
			{ name: worldName, createdAt },
			() => alert('Save storage full. Auto-save disabled for this session.'),
		);

		const loop = new GameLoop(world, renderer, cam, player, keys, atlas.uvFor);
		loop.start();

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
			const { cx, cz } = worldToChunk(hit.x, hit.z);
			loop.markChunkDirty(cx, cz);
			const lx = hit.x - cx * 16,
				lz = hit.z - cz * 16;
			if (lx === 0) loop.markChunkDirty(cx - 1, cz);
			if (lx === 15) loop.markChunkDirty(cx + 1, cz);
			if (lz === 0) loop.markChunkDirty(cx, cz - 1);
			if (lz === 15) loop.markChunkDirty(cx, cz + 1);
			autosave.markDirty();
		});

		window.addEventListener('contextmenu', (e) => e.preventDefault());
	}
}

main();
