# minicraft-bot

Write bots that join a Minicraft multiplayer world. A bot is a TypeScript program on Node. It shows up
in the world as **🤖 name**, walks, looks around, mines and places blocks, and sees what the kids do.

The SDK is built from the game's own code: the same world generator, snapshot codec, echo rule and
socket client. A bot's world matches what the kids see, block for block. The bundle is
`dist/index.js` (ESM, Node 22). Its types are one file, `dist/index.d.ts`.

## Quick start

### 1. Requirements

- **Node ≥ 22.** Node 22 has a built-in `WebSocket`, which the SDK needs.
- To run `.ts` files, use `tsx` (`npx tsx bot.ts`), or Node ≥ 22.18, which runs `.ts` directly.
- Add `@types/node` to the bot repo for the editor.

### 2. Build the SDK

In the Minicraft repo:

```bash
npm run build:bot
```

This writes `packages/minicraft-bot/dist/`. Rebuild after pulling Minicraft changes. A server that
needs a newer client refuses an old build with `OutdatedClientError` ("rebuild the SDK").

### 3. Make the bot repo

```bash
mkdir ../robo && cd ../robo
npm init -y
npm install --save-dev tsx @types/node
```

In `package.json`, add the dependency and `"type": "module"`:

```json
{
	"type": "module",
	"dependencies": { "minicraft-bot": "file:../Minicraft/packages/minicraft-bot" }
}
```

Then run `npm install`. Keep `"type": "module"`: the example uses top-level `await`. Without it, tsx
fails with "Top-level await is currently not supported with the cjs output format".

### 4. The server and its token

- **The real server:** use the same static token the site uses. It is in `~/minicraft-mp/token` on
  the machine that runs the server.
- **A local test server** (recommended while writing a bot). This runs on port 18080 with a temp
  database, so the kids' worlds are never touched. See [`server/README.md`](../../server/README.md).

  ```bash
  cd ~/Projects/Minicraft/server
  DB=$(mktemp -d)
  ~/.local/go/bin/go run ./cmd/mcserver -db "$DB/mc.sqlite" -addr 127.0.0.1:18080 -token e2e -gcs-bucket ''
  ```

  Create a world on it (in another terminal):

  ```bash
  curl -X POST -H 'Authorization: Bearer e2e' -H 'Content-Type: application/json' \
  	-d '{"name":"Bot test","seed":12345,"mustMine":false,"gen":3}' http://127.0.0.1:18080/worlds
  ```

  To play in it yourself, run the site with `VITE_MINICRAFT_MP_URL=http://localhost:18080
  VITE_MINICRAFT_MP_TOKEN=e2e npm run dev`. Pass these on the command line. Never put them in
  `.env.local`.

### 5. Find the world's uuid

`connect` takes the world's **uuid**, not its name:

```ts
const worlds = await bot.listWorlds(); // [{ uuid, name, mustMine, createdAt, online }]
const uuid = worlds.find((w) => w.name === 'Bot test')!.uuid;
```

### 6. A companion bot (`bot.ts`)

```ts
import { BotClient, BlockedError, EYE_HEIGHT } from 'minicraft-bot';

const bot = new BotClient({ url: 'http://127.0.0.1:18080', token: 'e2e', statePath: './robo-state.json' });
const uuid = (await bot.listWorlds())[0].uuid;
const { world } = await bot.connect({ world: uuid, name: 'Robo', skin: 'enderman' });
bot.on('close', (code) => { console.log('closed', code); process.exit(0); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let n = 0; ; n++) {
	try {
		const me = bot.pose();
		const kids = bot.players().filter((p) => !p.bot && p.hasPos);
		const dist = (p: { x: number; z: number }) => Math.hypot(p.x - me.x, p.z - me.z);
		const kid = kids.sort((a, b) => dist(a) - dist(b))[0];
		if (kid && dist(kid) > 3) {
			// Walk to 2 blocks short of the kid.
			const d = dist(kid), tx = kid.x - ((kid.x - me.x) / d) * 2, tz = kid.z - ((kid.z - me.z) / d) * 2;
			try {
				await bot.walkTo({ x: tx, z: tz });
			} catch (err) {
				if (!(err instanceof BlockedError)) throw err;
				const y = world.groundY(tx, tz, kid.y); // blocked: hop next to the kid (rare, and visible)
				if (y !== null) bot.move({ x: tx, y, z: tz });
			}
		}
		if (kid) bot.lookAt(kid.x, kid.y + EYE_HEIGHT, kid.z);
		if (n % 30 === 29) await bot.place(me.x + 1, me.y, me.z, 'oak_planks'); // false if refused
	} catch (err) {
		console.error(err);
	}
	await sleep(1000);
}
```

Run it with `npx tsx bot.ts`. Stop it with Ctrl-C: the server sees the bot leave within seconds.

## Conventions

- **Pose:** `{x, y, z, yaw, pitch}`. `y` is the **feet**; the eye is `y + EYE_HEIGHT` (1.6).
- **`yaw`** is in radians. Forward is `(−sin yaw, 0, −cos yaw)`, so facing a target takes
  `yaw = Math.atan2(−dx, −dz)`. `lookAt` does this for you.
- **`pitch`** is in radians. Positive looks up; it is clamped to ±π/2.
- Coordinates are world blocks. Every `BotWorld` method floors x, y and z, so `getBlock(10.7, 64.2, 3.9)`
  reads cell (10, 64, 3). The world is 512 × 512 blocks and 256 high.
- `WALK_SPEED` is 5 blocks/s, the same as a kid walking. `POS_EVERY_MS` is 100: the bot's pose is sent at
  most 10 times a second.

## `BotClient`

```ts
new BotClient({ url, token, bid?, statePath?, editGapMs? })
```

- `url` is the server's HTTP base (`http://…` or `https://…`).
- `bid` is the browser id. By default it is the one saved in `statePath`, or else `bot-<hash of name>`.
  It stays the same across restarts, so a bot that crashed and restarts isn't refused as "name taken".
- `statePath` is a JSON file holding `{bid, world, journal}`. Set it: then `revert()` still works after a
  restart. The journal belongs to one world; connecting to another world starts a new journal (with a
  warning), so one world's edits are never reverted in another.
- `editGapMs` (default **150**) is the minimum time between two edits, so a bot can't build faster than
  a kid can watch. `0` turns it off.

| Call | What it does |
|---|---|
| `connect({ world, name, skin })` | Joins. Resolves `{ you, spawn, players, world }` once the world is loaded **and** the bot's first pose is sent (before that, kids can't see it). |
| `listWorlds()` | `GET /worlds`. Bots are never listed in `online`. |
| `pose()` | The bot's own pose. |
| `players()` | Everyone else (never the bot itself): `{ id, name, skin, bot, x, y, z, yaw, pitch, hasPos }`. `hasPos: false` means they haven't sent a pose yet. |
| `move(pose)` | Sets the pose (a teleport). It is sent within 100 ms. A jump over 8 blocks snaps on the kids' screens. It cancels a walk. |
| `walkTo({ x, z })` | Walks there in a straight line (see below). Resolves `'arrived'` or `'cancelled'`. |
| `lookAt(x, y, z)` | Turns the head toward a point. It only rotates. |
| `place(x, y, z, name, color?)` | Places a block (`color` `#RRGGBB` for a `lamp`). Resolves `true` when sent. |
| `break(x, y, z)` | Breaks a block instantly (to air). |
| `mine(x, y, z, ms?)` | Mines like a kid with bare hands: faces the block, the kids see cracks, waits, then breaks it. Resolves `true` when broken. |
| `fx({ kind, x, y, z, … })` | Sends a raw effect, e.g. `{ kind: 'firework', x, y, z }`. |
| `journal()` | The bot's own edits, oldest first: `{ x, y, z, oldId, newId, t }`. |
| `revert(sinceMs?)` | Undoes the bot's own edits (see below). |
| `on(event, cb)` | Events: `join`, `left`, `pose`, `edit`, `fx`, `leaving`, `close(code)`, `reconnect`. Returns an unsubscribe function. |
| `close()` | Leaves. Emits `close(1000)`. |
| `world` | The `BotWorld`. It stays the same object across reconnects. |

### Refusals resolve `false`; they never reject

`place`, `break` and `mine` **resolve `false`** when refused. They never reject for a refusal, so a
fire-and-forget call can't crash the bot with an unhandled rejection. Only programming errors throw:
`NotConnectedError` (called before `connect()` resolved, or after `close()`), a malformed colour, and a
NaN or infinite coordinate given to `move`, `walkTo` or `lookAt` (`RangeError`).
Still wrap the main loop in `try/catch` and log, as the example does.

`place` refuses:
- an unknown name, `air`, and the `retired_*` ids;
- `bedrock`, because kids can't break it;
- blocks newer than the server's catalog;
- a cell outside the world;
- **a cell inside a kid's body.** A kid takes up x ± 0.3, z ± 0.3, from the feet to 1.8 above.
  Bots and players with no pose yet don't count.

`break` refuses bedrock and air. `mine` refuses anything a kid couldn't mine: air, water, lava and
bedrock. A new `mine`, a lost connection or `close()` cancels a mine in progress. The kids' cracks then
stop (`mine-stop`), and the mine resolves `false`. `walkTo` and `lookAt` don't cancel a mine.

While the bot is reconnecting, `place`, `break` and `mine` resolve `false`, and `walkTo` resolves
`'cancelled'`.

### `walkTo` and its limits

- It walks a straight line at `WALK_SPEED`, one pose every 100 ms. The feet follow `world.groundY` at
  each step, and the bot faces the way it goes.
- It steps up at most 1 block. It drops at most 2 blocks per step; a deeper drop continues over the next
  steps before it moves on.
- It **rejects with `BlockedError { at, reason }`**: `'wall'` when the ground ahead rises more than 1
  block, or when the body can't fit into the next column; `'noGround'` when there is nothing to stand on
  within 64 blocks below (or the world edge). `at` is where it stopped.
- **It is not pathfinding.** It checks only the centre column, so it can clip wall corners. A wall
  higher than 1 block stops it. So does the shore of deep water, where `groundY` finds the bed far below.
- A new `walkTo`, a `move`, a lost connection or `close()` resolves it `'cancelled'`. That is a
  resolve, never a rejection. `lookAt` and `mine` don't cancel it.

### The safety net: journal and `revert`

Every edit the bot makes is journaled `{ x, y, z, oldId, newId, t }`, in memory and in `statePath`. The
journal keeps the latest 10,000 edits.

`await bot.revert()` undoes them all, **newest first**. `await bot.revert(Date.now() - 5 * 60_000)`
undoes only the last 5 minutes (`sinceMs` is a `Date.now()` timestamp). The rules:
- A cell is restored only while it still holds what the bot put there, so **a kid's later change is
  never overwritten**.
- A solid block is not restored into a kid's body. That entry stays in the journal for a later
  `revert`.
- Revert's own writes are not journaled. They skip the edit gap.
- It resolves the number of cells restored.

### Reconnects

On a transient disconnect (the server restarting, a network blip), the bot probes `GET /worlds` at 1,
2, 4, 8 and 15 s, then rejoins. Then `world` is reset in place, the pose is re-sent, and `reconnect`
fires. After 30 s with no server it emits `close` and stops. Fatal codes (see `connect`) stop at once.

### `connect` errors

- `OutdatedClientError { ver, min }`: the server needs a newer client. Run `npm run build:bot`.
- `ReplacedError` (4001): the same name and bid joined from somewhere else.
- `ServerRefusedError { code, message }`: 4004 (protocol), 4005 (generator), 4006 (unknown world),
  4007 (bad token), 4008 (bad name: 1–16 letters, numbers and spaces), 4009 (the name is online from
  another bid). A connection lost before the welcome also rejects with this error.

## `BotWorld`

| Call | What it does |
|---|---|
| `getBlock(x, y, z)` | The block id. The chunk is generated on first read. Outside the world it is `0` (air). |
| `blockName(id)`, `blockId(name)` | Converts between id and name. `blockId` returns `null` for an unknown name. |
| `isSolid(id)`, `isLiquid(id)` | Every block is a full cube. Only air is neither. |
| `groundY(x, z, nearY)` | The feet y of the first standable cell at or below `nearY + 2`: solid below, two free cells above. It scans at most 64 down, or returns `null`. It ignores a leaf canopy or a roof above a kid. In a lake it finds the **bed**. |
| `surfaceY(x, z)` | The topmost block that is not air or liquid, or −1. |
| `region(min, max)` | The ids of a box, bounds inclusive, as a `Uint16Array` indexed `(y−y0)·dx·dz + (z−z0)·dx + (x−x0)`. At most 32 per side (it throws beyond). A compact view for an AI. |
| `findNearest(name, from, radius)` | The nearest cell holding that block, or `null`. The radius is capped at 32. It generates every chunk in range first, so the answer doesn't depend on what was read before. |
| `onBlockChange(cb)` | `cb(x, y, z, oldId, newId, by)`. Returns the unsubscribe function. |
| `raycastVoxel(world, origin, dir, max)` | (a function) The first solid cell along a ray, as the game aims. |

`onBlockChange` fires for:
- every remote edit that changed the world, with `by` = the author's player id;
- the bot's own writes, with `by === bot.you`.

The server echoes the bot's own writes back. The echo doesn't fire again. The exception is a kid's
write that landed on the same cell in between: the echo then puts the bot's block back, and it fires
once more. That is correct, since the cell really changed. `oldId` is `null` when the chunk wasn't
generated yet.

`blockNames()` lists every block name. Other exports: `generateChunkBlocks(seed, gen, cx, cz)` (a
chunk's generated ids), `CLIENT_VERSION`, `EYE_HEIGHT`, `WALK_SPEED` and `POS_EVERY_MS`.

## Costs

- A chunk (16 × 16 × 256) takes about **29 ms and 0.35 MB** to generate. The whole world (1,024
  chunks) is about 6.5 s and 350 MB. A bot only generates what it reads.
- Generation is synchronous. A scan over more than about 150 new chunks at once blocks longer than the
  server's 6 s silence limit, and the bot gets dropped (it then reconnects). `region` and `findNearest`
  are bounded well below that: `findNearest` generates at most 25 chunks (measured: about 0.2 s the first time).
- The bot runs no liquid or TNT simulation. The kids' games do that, and the bot sees the results as
  edits.

## Developing the SDK (Minicraft repo)

- `npm run build:bot`: the Vite build (with the import guard and env isolation), then the `.d.ts`
  rollup (`dts-bundle-generator`).
- `npm run test:bot`: the build, then the package tests (`packages/minicraft-bot/test`), then the
  consumer typecheck (`test/consumer`, nodenext and strict against `dist/index.d.ts`).
- The build fails with `GUARD: …` if the bundle would pull in `three`, an asset, `import.meta.glob`,
  or any module outside the allow-list in `src/guard-plugin.ts`. It never reads `.env*` files, and it
  never inlines `VITE_*` variables, so a token can't leak into the bundle.
