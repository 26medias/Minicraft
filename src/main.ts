import './ui/ui.css';
import { World } from './engine/world/world';
import { loadAtlas } from './engine/render/atlas';
import { Renderer } from './engine/render/renderer';
import { FpCamera } from './engine/render/camera';
import { setupPointerLock } from './engine/input/pointerLock';
import { Player, type Keys } from './game/player';
import { GameLoop } from './game/loop';
import { raycastVoxel } from './engine/input/raycast';
import { placeBlock } from './game/actions';
import { Hud } from './ui/hud';
import { MainMenu } from './ui/menu';
import { OptionsMenu } from './ui/options';
import { LocalStorageAdapter } from './persistence/localStorage';
import { AutoSave } from './persistence/autosave';
import { ParticleSystem } from './engine/render/particles';
import { BLOCKS, type BlockId } from './data/blocks.data';
import { loadOptions } from './persistence/options';
import type { Action } from './data/keybindings.data';

const REACH = 6;

async function main() {
	const app = document.getElementById('app')!;
	const atlas = await loadAtlas();
	const renderer = new Renderer(app, atlas);
	const cam = new FpCamera();
	const hud = new Hud(app, atlas);
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

		let savedSelectedBlockId: BlockId | null = null;
		if (mode === 'continue') {
			const save = await adapter.loadWorld(seed);
			if (!save) {
				console.warn('No save for seed', seed);
			} else {
				worldName = save.name;
				createdAt = save.createdAt;
				for (const rc of save.chunks) {
					const c = world.ensureChunk(rc.cx, rc.cz);
					c.blocks.set(rc.blocks);
					c.modified = true;
					c.dirty = true;
				}
				player.position = [save.player.x, save.player.y, save.player.z];
				cam.yaw = save.player.yaw;
				cam.pitch = save.player.pitch;
				savedSelectedBlockId = save.player.hotbar[save.player.selected] ?? null;
			}
		}

		// Hotbar is always derived from the kid-mode / full block pool — not stored per save.
		// We preserve the previously-selected block if it's still in the pool; otherwise reset.
		const opts = loadOptions();
		const pool = BLOCKS.filter((b) => b.id !== 0 && (opts.kidMode ? b.kidMode : true));
		player.hotbar = pool.map((b) => b.id);
		if (savedSelectedBlockId !== null) {
			const idx = player.hotbar.indexOf(savedSelectedBlockId);
			player.selected = idx >= 0 ? idx : 0;
		} else {
			player.selected = 0;
		}
		hud.setHotbar(player.hotbar, player.selected);

		const keys: Keys = {
			forward: false,
			back: false,
			left: false,
			right: false,
			jump: false,
			flyUp: false,
			flyDown: false,
		};
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
					keys.flyUp = down;
					break;
				case 'flyUp':
					keys.jump = down;
					keys.flyUp = down;
					break;
				case 'flyDown':
					keys.flyDown = down;
					break;
				case 'toggleFly':
					if (down && !e.repeat) player.toggleFly();
					break;
				case 'flySpeedUp':
					if (down && !e.repeat) player.adjustFlySpeed(+1);
					break;
				case 'flySpeedDown':
					if (down && !e.repeat) player.adjustFlySpeed(-1);
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

		// Tab / Shift+Tab cycle through the hotbar. Not remappable via Options
		// because the keybinding system captures only e.code (no modifier combos).
		window.addEventListener('keydown', (e) => {
			if (e.code !== 'Tab') return;
			e.preventDefault();
			if (player.hotbar.length === 0) return;
			const delta = e.shiftKey ? -1 : 1;
			player.selected =
				(player.selected + delta + player.hotbar.length) % player.hotbar.length;
			hud.setHotbar(player.hotbar, player.selected);
		});

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

		const particles = new ParticleSystem(renderer.scene, renderer.material, atlas);
		const loop = new GameLoop(world, renderer, cam, player, keys, atlas.uvFor, particles);
		loop.onBlockBroken = () => autosave.markDirty();
		loop.onMiningProgress = (p) => hud.setMiningProgress(p);
		loop.start();

		window.addEventListener('mousedown', (e) => {
			if (document.pointerLockElement !== renderer.gl.domElement) return;
			if (e.button === 0) {
				loop.setLeftMouseDown(true);
				return;
			}
			if (e.button === 2) {
				const eye = player.eyePosition();
				const dir = cam.getLookDir();
				const hit = raycastVoxel(world, eye, [dir.x, dir.y, dir.z], REACH);
				if (!hit) return;
				const id = player.hotbar[player.selected];
				if (id === undefined) return;
				const placed = placeBlock(world, hit, id, {
					position: player.position,
					size: [0.6, 1.8, 0.6],
				});
				if (!placed) return;
				loop.markChunkDirtyAround(hit.x, hit.z);
				autosave.markDirty();
			}
		});

		window.addEventListener('mouseup', (e) => {
			if (e.button === 0) loop.setLeftMouseDown(false);
		});

		window.addEventListener('contextmenu', (e) => e.preventDefault());
	}
}

main();
