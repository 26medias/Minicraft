import './ui/ui.css';
import { World } from './engine/world/world';
import { loadAtlas } from './engine/render/atlas';
import { Renderer } from './engine/render/renderer';
import { FpCamera } from './engine/render/camera';
import { setupPointerLock } from './engine/input/pointerLock';
import { Player, findSafeSpawn, type Keys } from './game/player';
import { GameLoop } from './game/loop';
import { raycastVoxel } from './engine/input/raycast';
import { placeBlock } from './game/actions';
import { Hud } from './ui/hud';
import { MainMenu } from './ui/menu';
import { OptionsMenu } from './ui/options';
import { LocalStorageAdapter } from './persistence/localStorage';
import { CloudAdapter } from './persistence/cloud';
import { DualAdapter } from './persistence/dual';
import { isLegacyId, newWorldId, seedFromLegacyId } from './persistence/uuid';
import { AutoSave } from './persistence/autosave';
import { ParticleSystem } from './engine/render/particles';
import { PrimedOverlay } from './engine/render/primed-overlay';
import { BLOCKS, BLOCK_BY_NAME, type BlockId } from './data/blocks.data';
import { loadOptions, saveOptions } from './persistence/options';
import { LightRegistry } from './engine/render/light-registry';
import { ColorPicker } from './ui/color-picker';
import { LIGHT_PALETTE } from './data/light-palette.data';
import type { Action } from './data/keybindings.data';
import { fillChunkLights } from './engine/world/lighting';
import { PlaytimeController, resolveSession } from './game/playtime-controller';
import { loadSession, saveSession } from './persistence/playtime';
import { PlaytimeOverlay } from './ui/playtime-overlay';
import { TICK_MS } from './data/playtime.data';

const REACH = 6;

async function main() {
	const app = document.getElementById('app')!;
	const atlas = await loadAtlas();
	const renderer = new Renderer(app, atlas);
	const cam = new FpCamera();
	const hud = new Hud(app, atlas);
	const localAdapter = new LocalStorageAdapter();
	// Absent env var -> local-only. A missing URL must degrade, not throw.
	const apiUrl = import.meta.env.VITE_MINICRAFT_API_URL as string | undefined;
	const cloudAdapter = apiUrl ? new CloudAdapter(apiUrl) : null;
	const adapter = new DualAdapter(localAdapter, cloudAdapter);

	const saveStatus = document.createElement('div');
	saveStatus.id = 'save-status';
	saveStatus.className = 'saved';
	saveStatus.textContent = cloudAdapter ? 'Saved' : 'Saved on this device';
	app.appendChild(saveStatus);

	const menu = new MainMenu(app, adapter);
	const options = new OptionsMenu(app);
	const lights = new LightRegistry(renderer.scene);
	const colorPicker = new ColorPicker(app, LIGHT_PALETTE);

	setupPointerLock(renderer.gl.domElement, (dx, dy) => cam.applyMouseDelta(dx, dy));

	function showMenu() {
		menu.show((action) => {
			if (action.type === 'options') {
				options.show(() => showMenu());
				return;
			}
			if (action.type === 'new') startGame(action.id, action.seed, action.name, null);
			else startGame(action.id, action.seed, '', 'continue');
		});
	}

	showMenu();

	async function startGame(
		worldId: string,
		seed: number,
		name: string,
		mode: null | 'continue',
	) {
		menu.hide();
		// Clear any lights from a prior session of startGame (returning from main menu to a new world).
		for (const entry of [...lights.entries()]) lights.remove(entry.x, entry.y, entry.z);
		const world = new World(seed);
		let createdAt = Date.now();
		let worldName = name;

		const player = new Player([256, 60, 256]);

		// A legacy (v1) world is adopted under a fresh uuid the first time it is played.
		// Writing v2 records under its `legacy:` id would make both namespaces yield the
		// same id next launch: the v1 copy would win the load and the prune sweep would
		// then delete this session's chunks.
		let activeId = worldId;
		if (isLegacyId(worldId)) {
			const seedOfLegacy = seedFromLegacyId(worldId);
			activeId = localAdapter.adoptedId(seedOfLegacy) ?? newWorldId();
			localAdapter.adoptLegacy(seedOfLegacy, activeId);
		}

		let savedSpawn: [number, number, number] | null = null;
		let savedSelectedBlockId: BlockId | null = null;
		if (mode === 'continue') {
			const save = await adapter.loadWorld(worldId);
			if (!save) {
				console.warn('No save for world', worldId);
			} else {
				worldName = save.name;
				createdAt = save.createdAt;
				for (const rc of save.chunks) {
					const c = world.ensureChunk(rc.cx, rc.cz);
					c.blocks.set(rc.blocks);
					c.fluidMeta.clear();
					if (rc.fluidMeta) {
						for (const [idx, packed] of rc.fluidMeta) c.fluidMeta.set(idx, packed);
					}
					c.modified = true;
					c.dirty = true;
				}
				// Lights were computed during ensureChunk using the freshly-generated blocks, then
				// overwritten by saved blocks. Recompute now that all saved blocks are in place so
				// cross-chunk BFS sees the correct final state.
				for (const rc of save.chunks) {
					const c = world.getChunk(rc.cx, rc.cz);
					if (c) fillChunkLights(world, c);
				}
				// Repairs a save written while the player was outside the world: one
				// world came back at y = -193917, which loads as an empty sky. Set
				// after the chunks are applied so there is terrain to stand on.
				savedSpawn = [save.player.x, save.player.y, save.player.z];
				cam.yaw = save.player.yaw;
				cam.pitch = save.player.pitch;
				savedSelectedBlockId = save.player.hotbar[save.player.selected] ?? null;
				if (save?.lights) {
					for (const l of save.lights) lights.add(l.x, l.y, l.z, l.color);
				}
			}
		}

		// Ground the player only once every saved chunk is in the world, so there is
		// something to stand on.
		if (savedSpawn) player.position = findSafeSpawn(world, savedSpawn);

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
		};
		const keyToAction: Record<string, Action> = {};
		for (const [action, code] of Object.entries(opts.keybindings))
			keyToAction[code] = action as Action;

		const onKey = (down: boolean) => (e: KeyboardEvent) => {
			// While frozen, no keydown reaches the player, hotbar, TNT, or colour
			// picker. Keyup still runs so `keys` stays truthful.
			if (down && loop.paused) return;
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
				case 'toggleFly':
					if (down && !e.repeat) player.toggleFly();
					break;
				case 'flySpeedUp':
					if (down && !e.repeat) player.adjustFlySpeed(+1);
					break;
				case 'flySpeedDown':
					if (down && !e.repeat) player.adjustFlySpeed(-1);
					break;
				case 'ignite':
					if (down && !e.repeat) {
						const eye = player.eyePosition();
						const dir = cam.getLookDir();
						const hit = raycastVoxel(world, eye, [dir.x, dir.y, dir.z], REACH);
						if (hit) loop.ignite(hit);
					}
					break;
				case 'pickLightColor':
					if (down && !e.repeat) {
						const eye = player.eyePosition();
						const dir = cam.getLookDir();
						const hit = raycastVoxel(world, eye, [dir.x, dir.y, dir.z], REACH);
						const target =
							hit && world.getBlock(hit.x, hit.y, hit.z) === BLOCK_BY_NAME['lamp'].id
								? hit
								: null;
						colorPicker.onPick = (color) => {
							if (target) {
								lights.setColor(target.x, target.y, target.z, color);
								autosave.markDirty();
							}
							opts.currentLightColor = color;
							saveOptions(opts);
						};
						colorPicker.show();
					}
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
			if (loop.paused) return;
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
			{ id: activeId, name: worldName, createdAt },
			() => {
				saveStatus.textContent = 'Storage on this device is full';
			},
			() => [...lights.entries()],
		);
		autosave.onStatus = (status) => {
			saveStatus.className = status;
			saveStatus.textContent =
				status === 'saving'
					? 'Saving…'
					: status === 'local-only'
						? 'Saved on this device only'
						: status === 'error'
							? 'Save failed'
							: 'Saved';
		};

		const particles = new ParticleSystem(renderer.scene, renderer.material, atlas);
		const overlay = new PrimedOverlay(renderer.scene);
		const loop = new GameLoop(
			world,
			renderer,
			cam,
			player,
			keys,
			atlas.uvFor,
			particles,
			overlay,
			lights,
		);
		loop.onBlockBroken = () => autosave.markDirty();
		loop.onWorldMutated = () => autosave.markDirty();
		loop.onMiningProgress = (p) => hud.setMiningProgress(p);
		loop.onFlyStateChange = (tier) => hud.setFlySpeed(tier);
		// --- Play-time limit -------------------------------------------------
		// startGame runs at most once per page load (the menu is only reachable
		// at boot and from Options before a game starts; unlock is by reload),
		// so the interval and listener below need no owner, like the window
		// listeners above. The first tick runs before loop.start() on purpose:
		// a session already in its break must freeze before the first frame.
		if (opts.playLimitMin !== null) {
			const resetKeys = () => {
				keys.forward = keys.back = keys.left = keys.right = keys.jump = false;
			};
			const session = resolveSession(loadSession(), opts.playLimitMin, opts.playBreakMin, Date.now());
			saveSession(session);
			const playtime = new PlaytimeController(session, {
				overlay: new PlaytimeOverlay(app),
				freeze: () => {
					loop.setLeftMouseDown(false);
					loop.paused = true;
					resetKeys();
					hud.setMiningProgress(0);
					if (document.pointerLockElement) document.exitPointerLock();
					void autosave.flush();
				},
				resume: () => {
					resetKeys();
					loop.paused = false;
					// Called from the PLAY AGAIN click, a user gesture, so the kid
					// does not need a second click on the canvas. Chrome returns a
					// promise that can reject; that is not an error worth surfacing.
					const p = renderer.gl.domElement.requestPointerLock() as unknown;
					if (p instanceof Promise) p.catch(() => {});
				},
				save: saveSession,
				now: () => Date.now(),
				visible: () => document.visibilityState === 'visible',
			});
			playtime.tick();
			setInterval(() => playtime.tick(), TICK_MS);
			document.addEventListener('visibilitychange', () => playtime.tick());
		}
		// ----------------------------------------------------------------------
		loop.start();

		window.addEventListener('mousedown', (e) => {
			if (loop.paused) return;
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
				const FACE_OFFSET: Record<string, [number, number, number]> = {
					px: [1, 0, 0],
					nx: [-1, 0, 0],
					py: [0, 1, 0],
					ny: [0, -1, 0],
					pz: [0, 0, 1],
					nz: [0, 0, -1],
				};
				const [dx, dy, dz] = FACE_OFFSET[hit.face];
				const placedX = hit.x + dx,
					placedY = hit.y + dy,
					placedZ = hit.z + dz;
				if (id === BLOCK_BY_NAME['lamp'].id) {
					lights.add(placedX, placedY, placedZ, opts.currentLightColor);
				}
				loop.markChunkDirtyAround(hit.x, hit.z);
				loop.applyLightUpdate(placedX, placedY, placedZ);
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
