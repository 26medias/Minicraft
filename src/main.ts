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
import { tryPlace, applyRemoved } from './game/place';
import { Hud } from './ui/hud';
import { PerfOverlay } from './ui/perf-overlay';
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
import { BLOCKS, BLOCK_BY_NAME, type BlockId } from './data/blocks.data';
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
import { RECIPES } from './data/recipes.data';
import { MpLink } from './game/mp-link';
import { applyCraft } from './game/craft-apply';
import { hotbarBadges, keycapLabel } from './ui/craft-model';
import { playCraft, playNope } from './ui/sfx';
import { resolveHotbar } from './game/hotbar';
import { playerSave, resolvePlayerExtras } from './game/player-extras';
import { shouldHandleKey, buildKeyToAction, sneakKeyChange } from './game/input-gate';
import { nextOwnedTier } from './game/tools';
import type { MenuAction } from './ui/menu';
import { clampDuration } from './game/session-policy';
import { beginSolo, boot, clearAutojoin, failRejoin, setAutojoin, type AutojoinArgs } from './game/boot';
import { onFatalClose, type FatalDeps } from './game/mp-exit';
import { Reconnector } from './game/mp-reconnect';
import { LeavingCountdown, leavingText } from './game/leaving';
import { resolveMpSpawn } from './game/mp-spawn';
import { tntKey } from './game/tnt';
import { MpClient } from './net/mp-client';
import { MpSync } from './net/mp-sync';
import { mpApiFromEnv } from './net/mp-api';
import { decodeSnapshot } from './net/snapshot';
import { intToColor, PROTO, welcomePose, type ExtrasData, type FxKind, type FxMsg, type Hello, type Welcome } from './net/protocol';
import { catalogBlocks, catalogHotbar, catalogRecipes } from './net/catalog-filter';
import { ChunkOverlay } from './engine/world/overlay';
import { WORLD_CHUNKS_X, WORLD_CHUNKS_Z, type WorldHeight } from './engine/world/coords';
import { NEWEST_GEN_VERSION } from './engine/world/generation';
import { RemotePlayers } from './engine/render/remote-players';
import { colorTableFromAtlas } from './engine/render/block-colors';
import { Minimap } from './ui/minimap';
import { MpOverlays } from './ui/mp-overlays';
import { loadMpPrefs } from './persistence/mp-prefs';
import { skinColor } from './data/skins.data';
import type { PlayerSave } from './persistence/adapter';
import { overlayCells, refReplay, worldHash, type RefAction, type RefReplayOpts } from './dev/mp-oracle';
import type { ServerMsg } from './net/protocol';

const REACH = 6;
/** Gate-2 K1: no `welcome` (plus its snapshot) within this long → the Multiplayer screen, sleeping. */
const JOIN_TIMEOUT_MS = 6_000;
/** Spec §5: `pos` at most 10 times a second. */
const POS_EVERY_MS = 100;
const LAMP_ID = BLOCK_BY_NAME['lamp'].id;
const TNT_ID = BLOCK_BY_NAME['tnt'].id;

/** What startGame needs to run a multiplayer session (spec §7.1). Undefined in solo. */
type MpSession = {
	client: MpClient;
	welcome: Welcome;
	overlay: ChunkOverlay;
	args: AutojoinArgs;
	link: MpLink;
	ui: MpOverlays;
};

async function main() {
	// Multiplayer (plan I1): the boot decision comes FIRST, before anything reads the stored play
	// session. It applies the refresh rule (spec §8.1) and says whether this load is a reconnect.
	const mpUrl = (import.meta.env.VITE_MINICRAFT_MP_URL as string | undefined) || null;
	const mpToken = (import.meta.env.VITE_MINICRAFT_MP_TOKEN as string | undefined) ?? '';
	const booted = boot({ mpUrl, storage: sessionStorage });
	const mpApi = mpApiFromEnv();

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

	const menu = new MainMenu(app, adapter, mpApi);
	const options = new OptionsMenu(app);
	const lights = new LightRegistry(renderer.scene);
	const colorPicker = new ColorPicker(app, LIGHT_PALETTE);

	setupPointerLock(renderer.gl.domElement, (dx, dy) => cam.applyMouseDelta(dx, dy));

	function onMenuAction(action: MenuAction) {
		if (action.type === 'options') {
			menu.hide();   // stops the card's refresh interval while Options is up
			options.show(() => showMenu());
			return;
		}
		// Belt and braces under the menu model: never enter startGame (which
		// hides the menu and registers listeners) when the schedule says no.
		// Applies to 'new' too, so a re-added New World button cannot bypass it.
		// Multiplayer too: a frozen timer that survives blocks rejoining (spec §7.4).
		if (!canStartNow(loadSchedule(), loadSession(), Date.now())) {
			showMenu();
			return;
		}
		if (action.type === 'mp') {
			if (!mpUrl || !mpApi) {
				showMenu();
				return;
			}
			const args: AutojoinArgs = { world: action.world, name: action.name, skin: action.skin, duration: action.duration };
			// Every exit from multiplayer is a reload; while this is set, the reload rejoins (spec §7.5).
			setAutojoin(sessionStorage, args);
			startMultiplayer(args, false);
			return;
		}
		if (action.type === 'new') startGame(action.id, action.seed, action.name, null, action.mustMine, action.duration);
		else if (action.type === 'continue') startGame(action.id, action.seed, action.name, 'continue', false, action.duration);
	}

	function showMenu(notice?: string) {
		menu.show(onMenuAction, notice);
	}

	let mpUi: MpOverlays | null = null;
	if (booted.kind === 'autojoin' && canStartNow(loadSchedule(), loadSession(), Date.now())) {
		startMultiplayer(booted.args, true);
	} else {
		if (booted.kind === 'autojoin') clearAutojoin(sessionStorage);
		showMenu();
	}

	/**
	 * Spec §7.1: join a multiplayer world. Shows "Joining…", opens the socket, and on `welcome`
	 * plus the snapshot hands a synthetic session to startGame. No `welcome` within 6 s (or the
	 * socket fails first) → the Multiplayer screen in its sleeping state, the world preselected
	 * (gate-2 K1, re-gate I1). A fatal close goes through onFatalClose (flag cleared first, K2).
	 */
	function startMultiplayer(args: AutojoinArgs, resume: boolean): void {
		menu.showBuilding('Joining…');
		// One set of overlays per page, even when a failed join is retried from the menu.
		const ui = (mpUi ??= new MpOverlays(app));
		const hello: Hello = {
			t: 'hello',
			world: args.world,
			name: args.name,
			skin: args.skin,
			bid: loadMpPrefs().bid,
			proto: PROTO,
			gen: NEWEST_GEN_VERSION,
			resume,
		};
		const link = new MpLink();
		const fatalDeps: FatalDeps = {
			storage: sessionStorage,
			reload: () => location.reload(),
			showScreen: (kind) => {
				menu.hide();
				ui.showFatal(kind, () => location.reload());
			},
		};
		let welcome: Welcome | null = null;
		let settled = false;
		const failJoin = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.close();
			failRejoin(sessionStorage, args);
			menu.showMultiplayer(onMenuAction);
		};
		const timer = setTimeout(failJoin, JOIN_TIMEOUT_MS);
		const client: MpClient = new MpClient(mpUrl!, mpToken, hello, {
			onWelcome: (w) => {
				welcome = w;
			},
			onSnapshot: (buf) => {
				if (settled || !welcome) return;
				let cells: Int32Array;
				try {
					cells = decodeSnapshot(buf).cells;
				} catch (err) {
					console.error('snapshot', err);
					failJoin();
					return;
				}
				settled = true;
				clearTimeout(timer);
				const overlay = new ChunkOverlay();
				overlay.loadSnapshot(cells);
				const w: Welcome = welcome;
				void startGame(w.world.uuid, w.world.seed, w.world.name, null, w.world.mustMine, args.duration, { client, welcome: w, overlay, args, link, ui });
			},
			onMessage: (m) => {
				link.deliver(m);
			},
			onState: (state, code) => {
				if (state === 'fatal') {
					settled = true;
					clearTimeout(timer);
					link.fatal();
					onFatalClose(code, fatalDeps);
				} else if (state === 'lost') {
					if (!settled) failJoin();
					else link.lost();
				}
			},
		});
	}

	async function startGame(
		worldId: string,
		seed: number,
		name: string,
		mode: null | 'continue',
		newMustMine = false,
		duration: number | null = null,
		mp?: MpSession,
	) {
		// Multiplayer keeps "Joining…" up until the spawn is found.
		if (!mp) menu.hide();
		// Starting any solo game clears the multiplayer autojoin flag (re-gate I1).
		if (!mp) beginSolo(sessionStorage);
		// Clear any lights from a prior session of startGame (returning from main menu to a new world).
		for (const entry of [...lights.entries()]) lights.remove(entry.x, entry.y, entry.z);
		// Multiplayer session start (gate-2 C3/I1): every coloured lamp in the overlay joins the registry.
		if (mp) {
			for (let cx = 0; cx < WORLD_CHUNKS_X; cx++) {
				for (let cz = 0; cz < WORLD_CHUNKS_Z; cz++) {
					for (const c of mp.overlay.colorsIn(cx, cz)) {
						const hex = intToColor(c.color);
						if (hex && mp.overlay.get(c.x, c.y, c.z)?.[0] === LAMP_ID) lights.add(c.x, c.y, c.z, hex);
					}
				}
			}
		}

		// Load BEFORE building anything. A failed load used to console.warn and start
		// a fresh world, whose first autosave pruned the local copy to zero chunks.
		let save: WorldSave | null = null;
		let localWon = false;
		if (mode === 'continue') {
			let outcome: LoadOutcome;
			try {
				const loaded = await adapter.loadWorld(worldId);
				// The newer local copy beat an older cloud copy with the same chunks; the
				// cloud has not seen it yet (crafting spec §10).
				localWon = loaded?.localWon === true;
				outcome = { save: loaded };
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
		if (!mp && isLegacyId(worldId)) {
			const seedOfLegacy = seedFromLegacyId(worldId);
			activeId = localAdapter.adoptedId(seedOfLegacy) ?? newWorldId();
			localAdapter.adoptLegacy(seedOfLegacy, activeId);
		}

		// The World comes from the record (its stored height is authoritative) or,
		// for a new world, from the newest generator's profile.
		// Multiplayer: seed plus the server's overlay, never a saved record (spec §7.1). A modified chunk
		// is evictable there: generation plus the overlay rebuild it (spec §6).
		let world: World;
		if (mp) {
			const info = mp.welcome.world;
			world = new World(seed, { height: info.height as WorldHeight, genVersion: info.gen, saveVersion: 3 });
			world.overlay = mp.overlay;
			world.modifiedPins = false;
		} else {
			world = save ? worldFromSave(save) : World.create(seed);
		}
		// New v3 worlds: the spawn column is searched once, in memory (spec §9). Show the
		// message and yield TWO frames: the first rAF callback runs before style/layout/paint,
		// so a single yield lets the synchronous search start before the text is on screen.
		let v3Spawn: [number, number, number] | null = null;
		if (!save && !mp && world.genVersion >= 3) {
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

		// Multiplayer: the extras the player comes back with. The stash from before a reconnect
		// reload may be newer than `welcome.extras` (C4 handoff), so it wins.
		const stashTag = mp ? `${mp.welcome.world.uuid}:${mp.args.name}` : '';
		const mpExtras: ExtrasData | null = mp ? (MpSync.readStash(sessionStorage, stashTag) ?? mp.welcome.extras ?? {}) : null;
		if (mp) {
			savedHotbar = mpExtras?.hotbar;
			savedSelected = mpExtras?.selected ?? 0;
			// Spec §7.2: the server picks the mode, the client the spot. A first join searches the
			// v3 spawn: show the message and yield two frames first, as a new solo world does.
			if (mp.welcome.spawn.mode === 'first') {
				menu.showBuilding('Building your world…');
				const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
				await nextFrame(); await nextFrame();
			}
			const spawn = resolveMpSpawn(world, seed, mp.welcome.spawn);
			player.position = spawn.pos;
			cam.yaw = spawn.yaw;
			cam.pitch = spawn.pitch;
			menu.hide();
		} else {
			// Ground the player only once every saved chunk is in the world, so there is
			// something to stand on. New worlds spawn on the generated surface (v2: ~120),
			// saved ones near where they left off.
			player.position = findSafeSpawn(world, savedSpawn ?? v3Spawn ?? [256.5, world.height - 1, 256.5]);
		}
		// Streaming starts here: everything before (spawn search behind "Building your world…") is a one-time cost.
		performance.mark('minicraft:world-ready');

		// Nine slots, saved per world. Saves from before the inventory hold the
		// whole block pool and get the default bar (see resolveHotbar).
		const opts = loadOptions();
		// Multiplayer: ids above the server's catalog are hidden for this session (spec §5 catalogMax).
		const blocks = mp ? catalogBlocks(BLOCKS, mp.welcome.catalogMax) : BLOCKS;
		const resolved = resolveHotbar(mp ? catalogHotbar(savedHotbar, mp.welcome.catalogMax) : savedHotbar, savedSelected, blocks);
		player.hotbar = resolved.hotbar;
		player.selected = resolved.selected;
		// Counts, pickaxes and the world mode (crafting spec §10). A save from before
		// crafting has none of them and gets the defaults; a new world takes the New
		// World screen's choice. The mode is fixed for the life of the world.
		const extras = mp
			? resolvePlayerExtras(mpExtras as PlayerSave, mp.welcome.world.mustMine)
			: resolvePlayerExtras(save?.player, save ? save.mustMine : newMustMine);
		player.inventory = extras.inventory;
		player.tools = extras.tools;
		const mustMine = extras.mustMine;
		// First paint of the bar, now that counts and the mode are known (the badges need both).
		hud.setHotbar(player.hotbar, player.selected, hotbarBadges(player.hotbar, player.inventory, mustMine));
		// The HUD pickaxe shows the cyclePickaxe key; an unbound action ('') hides the keycap.
		const pickaxeKeycap = keycapLabel(opts.keybindings.cyclePickaxe);
		hud.setPickaxe(player.tools.equipped, pickaxeKeycap);

		const keys: Keys = {
			forward: false,
			back: false,
			left: false,
			right: false,
			jump: false,
			sneak: false,
		};
		// One `paused` with two owners. `loop` is declared below; these closures
		// run only after it exists (same pattern as the ignite handler).
		let frozen = false;
		let inventoryOpen = false;
		const updatePaused = () => {
			loop.paused = frozen || inventoryOpen;
		};
		const resetKeys = () => {
			keys.forward = keys.back = keys.left = keys.right = keys.jump = keys.sneak = false;
		};
		// Multiplayer: no recipe for a block the server would reject (spec §5 catalogMax).
		const recipes = mp ? catalogRecipes(RECIPES, mp.welcome.catalogMax) : RECIPES;
		const inventory = new Inventory(app, atlas, blocks, recipes);
		/** Every HUD + I-screen view of hotbar, counts and tools. Call after ANY change to them. */
		const syncHotbar = (flashSlot?: number) => {
			const badges = hotbarBadges(player.hotbar, player.inventory, mustMine);
			hud.setHotbar(player.hotbar, player.selected, badges);
			hud.setPickaxe(player.tools.equipped, pickaxeKeycap);
			inventory.setHotbar(player.hotbar, player.selected, flashSlot, badges);
			inventory.setState({ inv: player.inventory, tools: player.tools, mustMine });
		};
		syncHotbar();
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
			syncHotbar(player.selected);
			autosave.markDirty();
		};
		// The Craft button (spec §9). applyCraft owns the rules and the markDirty; here: sound, refresh.
		inventory.onCraft = (recipeId) => {
			const recipe = recipes.find((r) => r.id === recipeId);
			if (!recipe) return false;
			const out = applyCraft(player, recipe, mustMine, () => autosave.markDirty());
			if (!out.ok) return false;
			if (out.kind === 'pickaxe') loop.onPickaxeChanged(); // a crafted pickaxe is equipped: re-arm the floor
			playCraft();
			syncHotbar(out.kind === 'block' ? out.slot : undefined);
			return true;
		};
		hud.onPickaxeClick = () => openInventory();
		inventory.onSelectSlot = (slot) => {
			player.selected = slot;
			syncHotbar();
		};
		const keyToAction: Record<string, Action> = buildKeyToAction(opts.keybindings);
		/** Multiplayer: sends one cosmetic `fx` (set below once the session is wired). null in solo. */
		let mpFx: ((kind: FxKind, x: number, y: number, z: number, tier: number) => void) | null = null;
		/**
		 * Spec §5: the one equip path (P here; the I screen's pickaxe row in Phase D). An owned tier
		 * other than the equipped one: equip it, re-arm the mining floor and restart any mine in
		 * progress, mark the save dirty. `loop` and `autosave` are declared below; this runs only
		 * from input handlers, after both exist (same pattern as the ignite handler).
		 */
		const equipPickaxe = (tier: number) => {
			if (tier === player.tools.equipped || !player.tools.owned.includes(tier)) return;
			player.tools = { owned: player.tools.owned, equipped: tier };
			loop.onPickaxeChanged();
			syncHotbar(); // HUD pickaxe icon + the framed pickaxe in the I screen's row
			autosave.markDirty();
		};
		inventory.onEquip = equipPickaxe; // the pickaxe row goes through the one equip path (C10)

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
						if (hit && loop.ignite(hit, cam.yaw)) mpFx?.('prime', hit.x, hit.y, hit.z, world.getBlock(hit.x, hit.y, hit.z));
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
								// Multiplayer (re-gate I1): a colour-only change is an edit too.
								mpSync?.record(target.x, target.y, target.z);
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
				case 'cyclePickaxe':
					// Spec §5: next owned tier, wrapping. shouldHandleKey already dropped it behind any modal.
					if (down && !e.repeat) equipPickaxe(nextOwnedTier(player.tools));
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
		// Toys spec §4: Shift is sneak (it stops pads). Its own listener, because onKey returns early for a key
		// with no action. Shift-replace reads e.shiftKey on the click and Shift+Tab reads it on Tab: no clash.
		const onSneak = (down: boolean) => (e: KeyboardEvent) => {
			const v = sneakKeyChange(e.code, down, { frozen, inventoryOpen, pickerOpen: colorPicker.isOpen });
			if (v !== null) keys.sneak = v;
		};
		window.addEventListener('keydown', onSneak(true));
		window.addEventListener('keyup', onSneak(false));

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

		// F3 toggles the performance overlay (spec §3.F). Gated more strictly than Tab on purpose:
		// nothing while frozen, with the inventory or colour picker open, or with an <input> (the PIN
		// field) focused. Only the key handler lives here; `loop.onFrame` is assigned after the loop
		// is constructed below, since `loop` is in its temporal dead zone at this point.
		const perfOverlay = new PerfOverlay(app);
		window.addEventListener('keydown', (e) => {
			if (e.code !== 'F3') return;
			if (frozen || inventoryOpen || colorPicker.isOpen) return;
			if ((document.activeElement as HTMLElement | null)?.tagName === 'INPUT') return;
			e.preventDefault();
			perfOverlay.toggle();
		});

		// Multiplayer: MpSync stands in for autosave (spec §7.1). It is AutoSave-shaped, so every
		// markDirty/flush below works unchanged; nothing is saved to this device or the cloud.
		let autosave: { markDirty(): void; flush(): Promise<void> };
		let mpSync: MpSync | null = null;
		if (mp) {
			const extrasNow = (): ExtrasData => ({
				inventory: { ...player.inventory },
				tools: { owned: [...player.tools.owned], equipped: player.tools.equipped },
				hotbar: [...player.hotbar],
				selected: player.selected,
			});
			mpSync = new MpSync(world, lights, (m) => void mp.client.send(m), extrasNow, sessionStorage, (ops) => loop.enqueueRemote(ops), stashTag);
			world.onLocalWrite = mpSync.record;
			autosave = mpSync;
			saveStatus.style.display = 'none';
		} else {
			const soloSave = new AutoSave(
				adapter,
				world,
				() => playerSave(player, cam.yaw, cam.pitch),
				{ id: activeId, name: worldName, createdAt, mustMine },
				() => {
					saveStatus.textContent = 'Storage on this device is full';
				},
				() => [...lights.entries()],
			);
			// Upload the kept local copy even if he only looks around and closes the tab.
			if (localWon) soloSave.markDirty();
			soloSave.onStatus = (status) => {
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
			autosave = soloSave;
		}

		const particles = new ParticleSystem(renderer.scene, renderer.material, atlas);
		const overlay = new PrimedOverlay(renderer.scene);
		overlay.warm();
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
		/** Multiplayer per-frame work (flush, avatars, minimap, pos); null in solo. */
		let mpFrame: ((now: number) => void) | null = null;
		loop.onFrame = (_dt, tickMs, frameMs) => {
			const now = performance.now();
			mpFrame?.(now);
			perfOverlay.tick(now, { t: now, frameMs, tickMs }, () => {
				const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
				return {
					...loop.stats,
					...renderer.info(),
					heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : 'n/a',
				};
			});
		};
		// Spec §2: every block the player's actions remove counts +1; in must-mine worlds a block
		// that just became available joins the hotbar (§3). Every count change marks the save dirty.
		const countRemoved = (ids: BlockId[]) => {
			applyRemoved(player, ids, mustMine);
			syncHotbar(); // unconditional: the badges change with every count, not only when the bar does
			autosave.markDirty();
		};
		loop.onBlockBroken = (ev) => countRemoved([ev.blockId]);
		loop.onBlocksRemoved = (removed) => countRemoved(removed.map((r) => r.blockId));
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
		// Plan I1: the chosen duration (fitted to the parent's maximum) starts a new session unless
		// one is already in force (P1's rule); a schedule's own duration wins over both.
		const limits = activeLimits(schedule, clampDuration(duration, opts.maxDurationMin));
		const session = resolveSession(loadSession(), limits.limitMin, Date.now(), schedule);
		// Multiplayer: the leaver's countdown messages (spec §7.4).
		const leaving = mp ? new LeavingCountdown((secondsLeft) => void mp.client.send({ t: 'leaving', secondsLeft })) : null;
		let playtime: PlaytimeController | null = null;
		if (session !== null) {
			saveSession(session);
			playtime = new PlaytimeController(session, {
				overlay: new PlaytimeOverlay(app),
				lockedText: schedule ? `PLAY AGAIN AT ${formatStartTime(schedule.startMin, Date.now()).toUpperCase()} TOMORROW` : undefined,
				freeze: () => {
					closeInventory();
					loop.setLeftMouseDown(false);
					frozen = true;
					loop.frozenByTimer = true;
					updatePaused();
					resetKeys();
					hud.setMiningProgress(0);
					if (document.pointerLockElement) document.exitPointerLock();
					if (mp) {
						// Spec §7.4 at 0: "went home" for the others, then the extras, then a normal close.
						// The flag goes first: nothing may rejoin a finished session.
						clearAutojoin(sessionStorage);
						leaving?.update(0);
						mp.ui.countdown(0);
						mpSync?.flushFrame();
						void autosave.flush();
						mp.client.close(1000);
						return;
					}
					void autosave.flush();
				},
				resume: () => {
					resetKeys();
					frozen = false;
					loop.frozenByTimer = false;
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
			const pt = playtime;
			// Multiplayer: the timer is paused while disconnected (spec §7.5); the countdown messages
			// follow every tick (spec §7.4). The big 10…1 is drawn per frame (mpFrame).
			const tickPlaytime = () => {
				if (loop.mpDisconnected) return;
				pt.tick();
				if (mp && !loop.frozenByTimer) leaving?.update(pt.remainingMs());
			};
			tickPlaytime();
			setInterval(tickPlaytime, TICK_MS);
			document.addEventListener('visibilitychange', tickPlaytime);
		}
		/** DEV oracle (plan I2): the session's parts, and every server message but `tick`, in arrival order. */
		let mpDebug: { sync: MpSync; client: MpClient; remote: RemotePlayers; overlay: ChunkOverlay; log: ServerMsg[]; overlayCells: () => number[] } | null = null;
		if (mp && mpSync) wireMultiplayer(mp, mpSync);

		/**
		 * Spec §7.1–§7.5: everything a multiplayer session adds on top of the shared wiring. Runs
		 * after the loop, the save stand-in and the timer exist; drains the messages buffered
		 * since `welcome`.
		 */
		function wireMultiplayer(mp: MpSession, sync: MpSync): void {
			const { client, welcome, link, ui } = mp;
			const you = welcome.you;
			loop.mp = { overlay: mp.overlay };
			const remote = new RemotePlayers(renderer.scene);
			const minimap = new Minimap(app, colorTableFromAtlas(atlas));
			const who = new Map<number, { name: string; skin: string }>();
			const addPlayer = (id: number, name: string, skin: string) => {
				if (id === you) return;
				who.set(id, { name, skin });
				remote.upsert(id, name, skin);
			};
			for (const p of welcome.players) {
				addPlayer(p.id, p.name, p.skin);
				const pose = welcomePose(p);
				if (p.id !== you && pose) remote.pushPose(p.id, performance.now(), pose);
			}
			// Extras mined just before a reconnect reload (C4 handoff).
			sync.resendStashed();

			// Cosmetic TNT effects (spec §6): a remote fuse shows until fuse + 2 s, in case the igniter leaves.
			const remotePrimes = new Map<string, ReturnType<typeof setTimeout>>();
			const clearRemotePrime = (x: number, y: number, z: number) => {
				const k = tntKey(x, y, z);
				const t = remotePrimes.get(k);
				if (t === undefined) return;
				clearTimeout(t);
				remotePrimes.delete(k);
				overlay.remove(x, y, z);
			};
			const onFx = (m: FxMsg) => {
				if (m.kind === 'prime') {
					clearRemotePrime(m.x, m.y, m.z);
					const fuse = (m.tier !== undefined ? BLOCKS[m.tier]?.tnt?.fuse : undefined) ?? BLOCKS[TNT_ID].tnt!.fuse;
					overlay.add(m.x, m.y, m.z);
					remotePrimes.set(tntKey(m.x, m.y, m.z), setTimeout(() => clearRemotePrime(m.x, m.y, m.z), (fuse + 2) * 1000));
					return;
				}
				clearRemotePrime(m.x, m.y, m.z);
				if (m.kind === 'firework') particles.spawnFirework(m.x + 0.5, m.y + 0.5, m.z + 0.5, true);
				else particles.spawnBreak(m.x, m.y, m.z, m.tier !== undefined && BLOCKS[m.tier] ? m.tier : TNT_ID);
			};
			mpFx = (kind, x, y, z, tier) => void client.send({ t: 'fx', kind, x, y, z, tier });
			loop.onDetonate = (x, y, z, effect, blockId) => mpFx?.(effect === 'firework' ? 'firework' : 'boom', x, y, z, blockId);

			const debugLog: ServerMsg[] = [];
			link.setRoute((m) => {
				if (import.meta.env.DEV && m.t !== 'tick') debugLog.push(m);
				switch (m.t) {
					case 'edit':
						sync.onEdit(m, you);
						break;
					case 'tick': {
						const now = performance.now();
						for (const [id, x, y, z, yaw, pitch] of m.poses) remote.pushPose(id, now, { x, y, z, yaw, pitch });
						break;
					}
					case 'join':
						addPlayer(m.id, m.name, m.skin);
						break;
					case 'left':
						// Re-gate I1: a plain `left` shows no toast; "went home" comes only from `leaving 0`.
						who.delete(m.id);
						remote.remove(m.id);
						break;
					case 'fx':
						onFx(m);
						break;
					case 'leaving': {
						const p = m.by !== undefined ? who.get(m.by) : undefined;
						if (p) ui.toast(leavingText(p.name, m.secondsLeft), skinColor(p.skin));
						break;
					}
				}
			});

			let lastPosAt = -Infinity;
			let lastPos = '';
			mpFrame = (now) => {
				sync.flushFrame();
				// Spec §7.4, the leaver's big 10…1: drawn every frame from the time left between ticks, so a
				// late 1 s interval never skips a number (plan I2, E5). The freeze hides it (countdown(0)).
				if (playtime && !loop.mpDisconnected && !loop.frozenByTimer && document.visibilityState === 'visible') {
					ui.countdown(Math.ceil(playtime.remainingAt(Date.now()) / 1000));
				}
				remote.update(now, renderer.camera);
				minimap.update(now, world, player, cam.yaw, remote.positions());
				if (now - lastPosAt < POS_EVERY_MS) return;
				const [x, y, z] = player.position;
				const key = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)},${cam.yaw.toFixed(3)},${cam.pitch.toFixed(3)}`;
				if (key === lastPos) return;
				if (client.send({ t: 'pos', x, y, z, yaw: cam.yaw, pitch: cam.pitch })) {
					lastPos = key;
					lastPosAt = now;
				}
			};

			/** Connection lost or fatal: input, the simulation and the timer freeze (spec §7.5). */
			const freezeForNetwork = () => {
				if (loop.mpDisconnected) return;
				loop.mpDisconnected = true;
				closeInventory();
				loop.setLeftMouseDown(false);
				frozen = true;
				updatePaused();
				resetKeys();
				hud.setMiningProgress(0);
				if (document.pointerLockElement) document.exitPointerLock();
			};
			// Replays a loss or fatal close that arrived before this point (review of I1).
			link.wire(() => {
				if (loop.mpDisconnected) return;
				freezeForNetwork();
				ui.showReconnecting();
				new Reconnector({
					probe: () => (mpApi ? mpApi.listWorlds() : Promise.reject(new Error('no server'))),
					// The autojoin flag is still set: the reload rejoins with `resume` (spec §7.5).
					onSuccess: () => location.reload(),
					onGiveUp: () => ui.showGiveUp(
						() => location.reload(),
						() => {
							clearAutojoin(sessionStorage);
							location.reload();
						},
					),
				}).start();
			}, freezeForNetwork);

			if (import.meta.env.DEV) mpDebug = { sync, client, remote, overlay: mp.overlay, log: debugLog, overlayCells: () => overlayCells(mp.overlay) };
		}
		// ----------------------------------------------------------------------
		loop.start();
		if (import.meta.env.DEV) {
			// Debug oracle for manual checks at localhost only; tree-shaken from the build.
			// `apiUrl` lets the bench log which save API the page is wired to (never production).
			// `playtime.setRemaining(ms)` (plan I1, E5) sets the live session's time left; no fast clock.
			// `worldHash` and `refReplay` are the two-client suite's oracles (plan I2, scripts/mp-e2e.ts).
			(window as unknown as { __mc: unknown }).__mc = {
				world, player, loop, apiUrl, cam, highlight, mustMine, syncHotbar, keys,
				playtime, mp: mpDebug,
				worldHash: (chunks: Array<[number, number]>) => worldHash(world, chunks),
				refReplay: (actions: RefAction[], o: Omit<RefReplayOpts, 'seed' | 'height' | 'gen'>) =>
					refReplay(actions, { ...o, seed: world.seed, height: world.height, gen: world.genVersion }),
			};
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
				// Shift replaces the aimed block instead of building next to it. tryPlace owns the
				// count refusal, the world write and the count update; the loop's placeBlock /
				// replaceBlock fire onWorldMutated, which marks the save dirty.
				const placed = tryPlace({ loop, world, player, hit, shift: e.shiftKey, mustMine, lampColor: opts.currentLightColor });
				if (placed.ok) syncHotbar(); // a place that needed a count spent one; markDirty comes from onWorldMutated
				else if (placed.reason === 'no-count') playNope(); // spec §3's soft "nope"
			}
		});

		window.addEventListener('mouseup', (e) => {
			if (e.button === 0) loop.setLeftMouseDown(false);
		});

		window.addEventListener('contextmenu', (e) => e.preventDefault());
	}
}

main();
