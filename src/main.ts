import './ui/ui.css';
import { World } from './engine/world/world';
import { loadAtlas } from './engine/render/atlas';
import { Renderer } from './engine/render/renderer';
import { FpCamera } from './engine/render/camera';
import { setupPointerLock } from './engine/input/pointerLock';
import { Player, findSafeSpawn, type Keys } from './game/player';
import { GameLoop } from './game/loop';
import { ChunkJobs, type WorkerLike } from './engine/world/chunk-jobs';
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
import { FaceHighlight } from './engine/render/face-highlight';
import { AIR, BLOCKS, BLOCK_BY_NAME, type BlockId } from './data/blocks.data';
import { loadOptions, saveOptions } from './persistence/options';
import { LightRegistry } from './engine/render/light-registry';
import { ColorPicker } from './ui/color-picker';
import { LIGHT_PALETTE } from './data/light-palette.data';
import type { Action } from './data/keybindings.data';
import { worldFromSave, applySave } from './game/apply-save';
import { spawnV3 } from './engine/world/v3/spawn';
import { resolveContinue, type LoadOutcome } from './game/continue-policy';
import type { WorldSave } from './persistence/adapter';
import { PlaytimeController, resolveSession } from './game/playtime-controller';
import { loadSession, saveSession } from './persistence/playtime';
import { loadSchedule } from './persistence/schedule';
import { activeLimits, canStartNow, formatStartTime } from './game/schedule';
import { PlaytimeOverlay } from './ui/playtime-overlay';
import { TICK_MS } from './data/playtime.data';
import { Inventory } from './ui/inventory';
import { resolveHotbar } from './game/hotbar';
import { shouldHandleKey } from './game/input-gate';

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

	function showMenu(notice?: string) {
		menu.show((action) => {
			if (action.type === 'options') {
				menu.hide();   // stops the card's refresh interval while Options is up
				options.show(() => showMenu());
				return;
			}
			// Belt and braces under the menu model: never enter startGame (which
			// hides the menu and registers listeners) when the schedule says no.
			// Applies to 'new' too, so a re-added New World button cannot bypass it.
			if (!canStartNow(loadSchedule(), loadSession(), Date.now())) {
				showMenu();
				return;
			}
			if (action.type === 'new') startGame(action.id, action.seed, action.name, null);
			else startGame(action.id, action.seed, action.name, 'continue');
		}, notice);
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

		// Load BEFORE building anything. A failed load used to console.warn and start
		// a fresh world, whose first autosave pruned the local copy to zero chunks.
		let save: WorldSave | null = null;
		if (mode === 'continue') {
			let outcome: LoadOutcome;
			try {
				outcome = { save: await adapter.loadWorld(worldId) };
			} catch (err) {
				console.error('loadWorld failed', err);
				outcome = { error: err };
			}
			const decision = resolveContinue(outcome, name || 'this world');
			if (!decision.ok) {
				showMenu(decision.notice);
				return;
			}
			save = decision.save;
		}

		// A legacy (v1) world is adopted under a fresh uuid the first time it is played.
		// Writing v2 records under its `legacy:` id would make both namespaces yield the
		// same id next launch: the v1 copy would win the load and the prune sweep would
		// then delete this session's chunks. Adoption runs only AFTER a successful load,
		// so a legacy world that refuses to open really has had nothing changed.
		let activeId = worldId;
		if (isLegacyId(worldId)) {
			const seedOfLegacy = seedFromLegacyId(worldId);
			activeId = localAdapter.adoptedId(seedOfLegacy) ?? newWorldId();
			localAdapter.adoptLegacy(seedOfLegacy, activeId);
		}

		// The World comes from the record (its stored height is authoritative) or,
		// for a new world, from the newest generator's profile.
		const world = save ? worldFromSave(save) : World.create(seed);
		// New v3 worlds: the spawn column is searched once, in memory (spec §9). Show the
		// message and yield TWO frames: the first rAF callback runs before style/layout/paint,
		// so a single yield lets the synchronous search start before the text is on screen.
		let v3Spawn: [number, number, number] | null = null;
		if (!save && world.genVersion >= 3) {
			menu.showBuilding('Building your world…');
			const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
			await nextFrame(); await nextFrame();
			const s = spawnV3(seed);
			v3Spawn = [s.x + 0.5, world.height - 1, s.z + 0.5];
			menu.hide();
		}
		let createdAt = Date.now();
		let worldName = name;
		const player = new Player([256.5, world.height - 1, 256.5], world.height);

		let savedSpawn: [number, number, number] | null = null;
		let savedHotbar: BlockId[] | undefined;
		let savedSelected = 0;
		if (save) {
			worldName = save.name;
			createdAt = save.createdAt;
			try {
				applySave(world, save);
			} catch (err) {
				console.error('applySave failed', err);
				const d = resolveContinue({ error: err }, save.name);
				showMenu(d.ok ? 'Nothing was changed.' : d.notice);
				return;
			}
			// Repairs a save written while the player was outside the world: one
			// world came back at y = -193917, which loads as an empty sky. Set
			// after the chunks are applied so there is terrain to stand on.
			savedSpawn = [save.player.x, save.player.y, save.player.z];
			cam.yaw = save.player.yaw;
			cam.pitch = save.player.pitch;
			savedHotbar = save.player.hotbar;
			savedSelected = save.player.selected;
			if (save.lights) {
				for (const l of save.lights) lights.add(l.x, l.y, l.z, l.color);
			}
		}

		// Ground the player only once every saved chunk is in the world, so there is
		// something to stand on. New worlds spawn on the generated surface (v2: ~120),
		// saved ones near where they left off.
		player.position = findSafeSpawn(world, savedSpawn ?? v3Spawn ?? [256.5, world.height - 1, 256.5]);

		// Nine slots, saved per world. Saves from before the inventory hold the
		// whole block pool and get the default bar (see resolveHotbar).
		const opts = loadOptions();
		const resolved = resolveHotbar(savedHotbar, savedSelected, BLOCKS);
		player.hotbar = resolved.hotbar;
		player.selected = resolved.selected;
		hud.setHotbar(player.hotbar, player.selected);

		const keys: Keys = {
			forward: false,
			back: false,
			left: false,
			right: false,
			jump: false,
		};
		// One `paused` with two owners. `loop` is declared below; these closures
		// run only after it exists (same pattern as the ignite handler).
		let frozen = false;
		let inventoryOpen = false;
		const updatePaused = () => {
			loop.paused = frozen || inventoryOpen;
		};
		const resetKeys = () => {
			keys.forward = keys.back = keys.left = keys.right = keys.jump = false;
		};
		const inventory = new Inventory(app, atlas, BLOCKS);
		const syncHotbar = () => {
			hud.setHotbar(player.hotbar, player.selected);
			inventory.setHotbar(player.hotbar, player.selected);
		};
		const openInventory = () => {
			if (inventoryOpen || frozen || colorPicker.isOpen) return;
			inventoryOpen = true;
			updatePaused();
			loop.setLeftMouseDown(false);
			hud.setMiningProgress(0);
			if (document.pointerLockElement) document.exitPointerLock();
			syncHotbar();
			inventory.open();
		};
		const closeInventory = () => {
			if (!inventoryOpen) return;
			inventory.close();
			inventoryOpen = false;
			updatePaused();
			resetKeys();
		};
		inventory.onClose = closeInventory;
		inventory.onPick = (id) => {
			player.hotbar[player.selected] = id;
			hud.setHotbar(player.hotbar, player.selected);
			inventory.setHotbar(player.hotbar, player.selected, player.selected);
			autosave.markDirty();
		};
		inventory.onSelectSlot = (slot) => {
			player.selected = slot;
			syncHotbar();
		};
		const keyToAction: Record<string, Action> = {};
		for (const [action, code] of Object.entries(opts.keybindings))
			keyToAction[code] = action as Action;

		const onKey = (down: boolean) => (e: KeyboardEvent) => {
			const a = keyToAction[e.code];
			if (!a) return;
			if (!shouldHandleKey(down, a, { frozen, inventoryOpen, pickerOpen: colorPicker.isOpen })) return;
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
				case 'inventory':
					if (down && !e.repeat) {
						if (inventoryOpen) closeInventory();
						else openInventory();
					}
					break;
				default: {
					if (down && a.startsWith('slot')) {
						const n = Number(a.slice(4)) - 1;
						if (n >= 0 && n < player.hotbar.length) {
							player.selected = n;
							syncHotbar();
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
			if (frozen) return;
			e.preventDefault();
			if (player.hotbar.length === 0) return;
			const delta = e.shiftKey ? -1 : 1;
			player.selected =
				(player.selected + delta + player.hotbar.length) % player.hotbar.length;
			syncHotbar();
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
		const highlight = new FaceHighlight(renderer.scene);
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
			highlight,
			// Shadows + meshing off the main thread (spec §3.D); the URL is relative to src/main.ts. The
			// cast: ChunkJobs only assigns `onmessage` with a `{ data }` handler, which the DOM Worker's
			// MessageEvent satisfies, but strictFunctionTypes rejects the property assignment.
			new ChunkJobs(
				() => new Worker(new URL('./engine/world/chunk.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
				atlas.uvTable,
			),
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
		const loadedSchedule = loadSchedule();
		const schedule = loadedSchedule.kind === 'armed' ? loadedSchedule.schedule : null;
		const limits = activeLimits(schedule, opts);
		if (limits.limitMin !== null) {
			const session = resolveSession(loadSession(), limits.limitMin, limits.breakMin, Date.now(), schedule);
			saveSession(session);
			const playtime = new PlaytimeController(session, {
				overlay: new PlaytimeOverlay(app),
				lockedText: schedule ? `PLAY AGAIN AT ${formatStartTime(schedule.startMin, Date.now()).toUpperCase()} TOMORROW` : undefined,
				freeze: () => {
					closeInventory();
					loop.setLeftMouseDown(false);
					frozen = true;
					updatePaused();
					resetKeys();
					hud.setMiningProgress(0);
					if (document.pointerLockElement) document.exitPointerLock();
					void autosave.flush();
				},
				resume: () => {
					resetKeys();
					frozen = false;
					updatePaused();
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
		if (import.meta.env.DEV) {
			// Debug oracle for manual checks at localhost only; tree-shaken from the build.
			(window as unknown as { __mc: unknown }).__mc = { world, player, loop };
		}

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
				if (id === undefined || id === AIR) return;
				if (e.shiftKey) {
					// Replace the aimed block instead of building next to it. All the
					// shared guards above (paused, pointer lock, hit, non-empty slot)
					// have already run; replaceBlock marks autosave dirty itself.
					loop.replaceBlock(hit, id, opts.currentLightColor);
					return;
				}
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
