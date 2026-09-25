// Spec §9.3: typechecks against dist/index.d.ts the way a bot repo would (nodenext, strict, no skipLibCheck).
import { BotClient, BotWorld, BlockedError, OutdatedClientError, WALK_SPEED, EYE_HEIGHT, POS_EVERY_MS, CLIENT_VERSION, blockNames, generateChunkBlocks, raycastVoxel, type WalkResult, type BotPlayer, type Pose } from 'minicraft-bot';

async function main(): Promise<void> {
	const bot = new BotClient({ url: 'http://127.0.0.1:18080', token: 'e2e', editGapMs: 150, statePath: './robo.json' });
	try {
		const { world, players } = await bot.connect({ world: 'uuid', name: 'Robo', skin: 'enderman' });
		const w: BotWorld = world;
		const kids: BotPlayer[] = players.filter((p) => !p.bot && p.hasPos);
		const me: Pose = bot.pose();
		const y: number | null = w.groundY(me.x, me.z, me.y);
		const off: () => void = w.onBlockChange((x, yy, z, oldId, newId, by) => console.log(x, yy, z, oldId ?? -1, newId, by));
		off();
		const r: WalkResult = await bot.walkTo({ x: me.x + WALK_SPEED, z: me.z });
		bot.lookAt(me.x, me.y + EYE_HEIGHT, me.z + 1);
		const placed: boolean = await bot.place(me.x, (y ?? me.y) + 3, me.z, blockNames()[1]);
		const hit = raycastVoxel(w, [me.x, me.y + EYE_HEIGHT, me.z], [0, -1, 0], 8);
		const blocks: Uint16Array = generateChunkBlocks(12345, 3, 0, 0);
		const n: number = await bot.revert(Date.now() - 60_000);
		console.log(kids.length, r, placed, hit?.face, blocks.length, n, POS_EVERY_MS, CLIENT_VERSION);
		bot.on('close', (code: number) => console.log('closed', code));
	} catch (err) {
		if (err instanceof OutdatedClientError) console.log('rebuild the SDK', err.min, err.ver);
		else if (err instanceof BlockedError) console.log(err.reason, err.at.x);
		else throw err;
	} finally {
		bot.close();
	}
}

void main();
