/**
 * The brain2 e2e legs (plan Task 17b, spec §9.1): runBrain2 with code engines only, over `realPort`, against our
 * own `mcserver` on the `local` target's port (so the real CLI's `revert` reaches it), each leg on a fresh world.
 *
 * - `brain2-help`: a kid lays 4 oak_planks in a line in front of the bot; within 30 s the bot places the next
 *   cell, as oak_planks, free.
 * - `brain2-alone`: a kid-made dirt pillar, then no kid for 3 minutes: ≥ 2 behaviours, and every `plan` event's
 *   site or pillar is ≥ 12 from the pillar (criterion 7, plan-time rule).
 * - `brain2-mine`: a stocked brain file, and Mine favoured by a held poke (confidence up): an episode runs to
 *   120 s, ends `paused`, resumes from `stepsDone`; the staircase is air and its floors solid. Also reports how the
 *   real walkTo takes a step that has a shallower step 8 above it in the same column (step i + 8 under step i).
 * - `brain2-revert` (after `brain2-mine`): the real CLI `revert`: the staircase is back to its generated blocks,
 *   and the brain file's inventory is lower by what the revert took back.
 * - `brain2-follow-watch`: a kid walks 20 blocks and stops: `follow` then `watch`, or `follow` held, within 60 s,
 *   and the bot ends within 6 blocks of him.
 * - `brain2-productive`: the real CLI on a free port (`cli-at.ts`), alone for up to 15 min: ≥ 8 mined, a Build done.
 * - `brain2-cli`: the real CLI, `--brain v2 --personality pip`: joins, logs to `.state/logs`, writes its brain
 *   file, and exits by itself within 5 s of SIGTERM (then SIGINT on a second run), the brain file flushed.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BotClient, blockId, blockName } from 'minicraft-bot';
import type { EditOut, WalkResult } from 'minicraft-bot';
import { main as cliMain } from '../src/cli.js';
import { seededRng } from '../src/bots/companion.js';
import { runBrain2, type Brain2Handle } from '../src/brain2/brain.js';
import { PERSONALITIES } from '../src/brain2/data/personalities.data.js';
import { parseLog, type LogLine } from '../src/brain2/log.js';
import { brainFilePath, type BrainFile } from '../src/brain2/persist.js';
import { spiralStep } from '../src/brain2/behaviours/spiral.js';
import type { Build, Dig } from '../src/brain2/types.js';
import { generatedLookup, realPort, type Body } from '../src/port.js';
import type { Vec3 } from '../src/types.js';
import { Kid } from './kid-client.js';
import { TOKEN, type McServer } from './mcserver.js';

export interface Brain2Ctx {
	server: McServer;
	/** The CLI's state root for these legs (a scratch dir): its `revert` must find the bot's journal and brain file. */
	stateRoot: string;
	botsDir: string;
	want(id: string): boolean;
	leg(id: string, title: string, body: () => Promise<void>): Promise<void>;
	check(ok: boolean, what: string): boolean;
	info(what: string): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hd = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const cellStr = (c: Vec3) => `${c.x},${c.y},${c.z}`;
type Select = Extract<LogLine, { k: 'select' }>;
type Ev = Extract<LogLine, { k: 'event' }>;

interface Bot2 {
	name: string; world: string; client: BotClient; handle: Brain2Handle; lines: LogLine[]; logPath: string; brainPath: string;
	walks: Array<{ to: { x: number; z: number }; from: Vec3; r: WalkResult | 'error'; after: Vec3; err?: string }>;
	selects(): Select[]; events(kind?: string): Ev[];
	stop(): Promise<void>;
}

/** Connects a bot and runs brain2 on it, with the CLI's paths under `stateRoot` (target `local`). */
async function startBot2(c: Brain2Ctx, o: { world: string; name: string; personality?: string; brainFile?: (path: string) => BrainFile }): Promise<Bot2> {
	const statePath = join(c.stateRoot, 'local', o.world, `${o.name}.json`);
	const brainPath = brainFilePath(c.stateRoot, 'local', o.world, o.name);
	mkdirSync(dirname(statePath), { recursive: true });
	if (o.brainFile) {
		mkdirSync(dirname(brainPath), { recursive: true });
		writeFileSync(brainPath, JSON.stringify(o.brainFile(brainPath)));
	}
	const client = new BotClient({ url: c.server.url, token: TOKEN, statePath });
	const listing = (await client.listWorlds()).find((w) => w.uuid === o.world)!;
	await client.connect({ world: o.world, name: o.name, skin: 'enderman' });
	const port = realPort(client, listing);
	// walkTo, recorded: the i + 8 spiral step question.
	const walks: Bot2['walks'] = [];
	const body: Body = Object.create(port.body);
	body.walkTo = async (to, opts) => {
		const from = client.pose();
		try {
			const r = await port.body.walkTo(to, opts);
			walks.push({ to, from, r, after: client.pose() });
			return r;
		} catch (err) {
			walks.push({ to, from, r: 'error', after: client.pose(), err: (err as Error).message });
			throw err;
		}
	};
	const logDir = join(c.stateRoot, 'logs', 'local', o.world);
	mkdirSync(logDir, { recursive: true });
	const logPath = join(logDir, `${o.name}-e2e.jsonl`);
	const lines: LogLine[] = [];
	const handle = runBrain2({
		port: { body, world: port.world }, clock: () => Date.now(), wall: () => Date.now(), rng: seededRng(7), seed: 7,
		personality: PERSONALITIES[o.personality ?? 'pip'], statePaths: { brainFile: brainPath, logDir },
		meta: { worldUuid: o.world, bot: o.name, target: 'local', live: false }, world: { seed: client.world.seed, gen: client.world.gen },
		engines: () => ({ laya: null, llm: null }), noEdits: false,
		logWrite: (line) => {
			appendFileSync(logPath, `${line}\n`);
			lines.push(parseLog(line)[0]);
		},
		status: (s) => c.info(`status: ${s}`),
	});
	return {
		name: o.name, world: o.world, client, handle, lines, logPath, brainPath, walks,
		selects: () => lines.filter((l): l is Select => l.k === 'select'),
		events: (kind) => lines.filter((l): l is Ev => l.k === 'event' && (kind === undefined || l.kind === kind)),
		async stop() {
			await handle.stop();
			client.close();
		},
	};
}

const started = (ss: Select[]) => ss.filter((s) => s.winner !== null && s.winner !== s.inputs.current);
const stockedFile = (world: string, bot: string, inventory: Record<string, number>): BrainFile => ({
	schemaVersion: 1, worldUuid: world, bot, lastAlive: Date.now(), relations: {}, inventory, builds: [], digs: [], owned: {}, explored: [],
});

/** A kid next to the bot: the first `n + 1` air cells in a straight line on his ground, 2 blocks out, any of 4 ways. */
function lineNear(kid: Kid, n: number): Vec3[] {
	const p = kid.pose();
	const w = kid.world;
	for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
		const x0 = Math.floor(p.x) + 2 * dx - dz, z0 = Math.floor(p.z) + 2 * dz + dx;
		const y = w.groundY(x0 + 0.5, z0 + 0.5, p.y);
		if (y === null) continue;
		const cells = Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + i * dx, y, z: z0 + i * dz }));
		if (cells.every((c) => w.getBlock(c.x, c.y, c.z) === 0)) return cells;
	}
	throw new Error('no free line next to the kid');
}

export async function brain2Legs(c: Brain2Ctx): Promise<void> {
	const { check, info } = c;

	if (c.want('brain2-help')) {
		await c.leg('brain2-help', 'a kid lays a line; the bot places the next cell, free', async () => {
			const world = await c.server.createWorld('e2e-brain2-help');
			const bot = await startBot2(c, { world, name: 'Pip' });
			const kid = await Kid.connect({ url: c.server.url, token: TOKEN, world, name: 'Noah', skin: 'jj' });
			try {
				await sleep(3000);
				const bp = bot.client.pose();
				await kid.walkTo({ x: bp.x + 3, z: bp.z + 0.5 });
				await sleep(2000);
				const cells = lineNear(kid, 4);
				const next = cells[4];
				let placedAt = 0;
				kid.client.on('edit', (msg: EditOut) => {
					const author = kid.client.players().find((p) => p.id === msg.by);
					if (author?.name === 'Pip' && msg.ops.some(([x, y, z, v]) => x === next.x && y === next.y && z === next.z && v === blockId('oak_planks'))) placedAt = Date.now();
				});
				const inv0 = bot.handle.store.state.inventory.oak_planks ?? 0;
				for (const cell of cells.slice(0, 4)) {
					check(await kid.place(cell, 'oak_planks'), `the kid placed ${cellStr(cell)}`);
					await sleep(700);
				}
				const t0 = Date.now();
				while (placedAt === 0 && Date.now() - t0 < 30_000) await sleep(200);
				const ss = bot.selects();
				check(placedAt !== 0, `the bot placed oak_planks at N ${cellStr(next)} ${placedAt ? `${((placedAt - t0) / 1000).toFixed(1)} s` : 'never'} after the 4th block (≤ 30 s); selects: ${ss.map((s) => `${s.trigger}→${s.winner}`).join(', ')}`);
				check((bot.handle.store.state.inventory.oak_planks ?? 0) === inv0, `free: the bot's oak_planks stayed ${inv0} (${bot.handle.store.state.inventory.oak_planks ?? 0})`);
			} finally {
				kid.close();
				await bot.stop();
			}
		});
	}

	if (c.want('brain2-alone')) {
		await c.leg('brain2-alone', 'no kid for 3 minutes, a kid-made pillar: plans keep ≥ 12 from it', async () => {
			const world = await c.server.createWorld('e2e-brain2-alone');
			const kid = await Kid.connect({ url: c.server.url, token: TOKEN, world, name: 'Noah', skin: 'jj' });
			const sp = kid.pose();
			// The pillar where a lone Build would look first: 20 blocks from spawn (sites are ≥ 16 from spawn, within 32).
			let pillar: Vec3 | null = null;
			for (const [dx, dz] of [[20, 0], [0, 20], [-20, 0], [0, -20]]) {
				const x = Math.floor(sp.x) + dx, z = Math.floor(sp.z) + dz;
				const top = kid.world.surfaceY(x, z);
				if (top > 0 && !kid.world.isLiquid(kid.world.getBlock(x, top, z))) {
					pillar = { x, y: top + 1, z };
					break;
				}
			}
			if (!pillar) throw new Error('no dry column for the pillar');
			await kid.walkTo({ x: pillar.x + 2.5, z: pillar.z + 0.5 });
			for (let h = 0; h < 3; h++) check(await kid.place({ x: pillar.x, y: pillar.y + h, z: pillar.z }, 'dirt'), `kid pillar block ${h + 1} at ${pillar.x},${pillar.y + h},${pillar.z}`);
			await sleep(500);
			kid.close();
			await sleep(1000);
			const bot = await startBot2(c, { world, name: 'Pip' });
			try {
				await sleep(180_000);
			} finally {
				await bot.stop();
			}
			const kinds = new Set(started(bot.selects()).map((s) => s.winner));
			check(kinds.size >= 2, `≥ 2 behaviours ran: ${[...kinds].join(', ')}`);
			const plans = bot.events('plan');
			const far = plans.map((p) => {
				const d = p.data as { behaviour: string; box?: { min: Vec3; max: Vec3 } | null; pillar?: Vec3 };
				if (d.behaviour === 'mine' && d.pillar) return { what: `mine pillar ${d.pillar.x},${d.pillar.z}`, dist: hd(d.pillar, pillar!) };
				if (d.box) {
					const dx = Math.max(d.box.min.x - pillar!.x, 0, pillar!.x - d.box.max.x), dz = Math.max(d.box.min.z - pillar!.z, 0, pillar!.z - d.box.max.z);
					return { what: `build ${cellStr(d.box.min)}..${cellStr(d.box.max)}`, dist: Math.hypot(dx, dz) };
				}
				return { what: 'build (no cells)', dist: Infinity };
			});
			check(far.every((f) => f.dist >= 12), `every plan is ≥ 12 from the kid's pillar: ${far.map((f) => `${f.what} @ ${f.dist.toFixed(1)}`).join('; ') || 'no plan events'}`);
			info(`plans: ${plans.length}; outcomes: ${bot.events().filter((e) => e.kind === 'reject').length} rejects`);
		});
	}

	let mined: { world: string; bot: string; dig: Dig; before: BrainFile; journal: ReturnType<BotClient['journal']> } | null = null;
	if (c.want('brain2-mine') || c.want('brain2-revert')) {
		await c.leg('brain2-mine', 'Mine runs 120 s, pauses, resumes from stepsDone', async () => {
			const world = await c.server.createWorld('e2e-brain2-mine');
			const name = 'Pip';
			const bot = await startBot2(c, { world, name, brainFile: () => stockedFile(world, name, { stone: 20, dirt: 20 }) });
			// Mine over Explore and Build: confident, not very curious, a little stimulated (re-applied against decay).
			const poke = () => bot.handle.store.apply([
				{ path: ['emotions', 'confidence', 'value'], value: 1 }, { path: ['emotions', 'curiosity', 'value'], value: 0.2 },
				{ path: ['emotions', 'stimulation', 'value'], value: 0.3 },
			], { kind: 'poke', by: 'e2e' });
			poke();
			// A deep target, so the episode runs its full 120 s: the bot "needs" iron ore (paramsMine takes a salient need).
			const st0 = bot.handle.store.state;
			bot.handle.store.apply([{ path: ['events'], value: [...st0.events, { id: bot.handle.store.nextEventId(), kind: 'need', t: Date.now(), block: 'iron_ore', detail: 'iron_ore', salient: true }] }], { kind: 'poke', by: 'e2e' });
			const poker = setInterval(poke, 5000);
			const pausedAt: Array<{ t: number; steps: number; y: number }> = [];
			const resumed: Array<{ t: number; steps: number }> = [];
			let prev: Dig['status'] | null = null;
			const unsub = bot.handle.store.subscribe(() => {
				const d = bot.handle.store.state.digs[0];
				if (!d) return;
				if (d.status === 'paused' && prev !== 'paused') pausedAt.push({ t: Date.now(), steps: d.stepsDone, y: bot.client.pose().y });
				if (d.status === 'active' && prev === 'paused') resumed.push({ t: Date.now(), steps: d.stepsDone });
				prev = d.status;
			});
			const t0 = Date.now();
			try {
				while (Date.now() - t0 < 360_000) {
					await sleep(1000);
					const d = bot.handle.store.state.digs[0];
					if (resumed.length > 0 && d && d.stepsDone > resumed[0].steps + 1) break;
				}
			} finally {
				clearInterval(poker);
				unsub();
			}
			const journal = bot.client.journal();
			await bot.stop();
			const mines = started(bot.selects()).filter((s) => s.winner === 'mine');
			const d = bot.handle.store.state.digs[0];
			check(d !== undefined, `a dig: ${d ? `${d.block} target ${cellStr(d.target)}, ${d.stepsDone} steps, ${d.status}` : 'none'}`);
			if (!d) return;
			const past = bot.handle.store.state.memory.past.filter((p) => p.behaviour === 'mine');
			const episode = [...past].reverse().find((p) => p.outcome === 'paused' && p.why === 'paused');
			check(episode !== undefined && episode.lastedMs >= 120_000 && pausedAt.length > 0,
				`an episode ran to its 120 s and ended paused itself: ${past.map((p) => `${p.outcome}(${p.why}) ${(p.lastedMs / 1000).toFixed(0)} s`).join(', ') || 'no mine ended'}; ${mines.length} mine starts; paused at step ${pausedAt[0]?.steps ?? '-'}`);
			// Ruling R17: the episode climbs back out before it ends paused (the bot is at the surface, not in its hole).
			check(pausedAt.length > 0 && pausedAt[0].y >= d.spiral.y0 - 0.01, `paused at the surface: feet y ${pausedAt[0]?.y.toFixed(1) ?? '-'} (y0 ${d.spiral.y0})`);
			const climbFails = bot.walks.filter((w) => w.r === 'error').length;
			info(`walks: ${bot.walks.length}, blocked/errored: ${climbFails}; mine outcomes: ${past.map((p) => p.why).join(', ')}`);
			check(!past.some((p) => p.why === 'stuck (climb)' || p.why === 'same action failed 3 times'), 'no Mine ended stuck (climb) or on a thrice-failed action');
			check(resumed.length > 0 && resumed[0].steps === pausedAt[0]?.steps && d.stepsDone > resumed[0].steps, `resumed from stepsDone ${resumed[0]?.steps ?? '-'} (paused at ${pausedAt[0]?.steps ?? '-'}), now ${d.stepsDone}`);
			// The world, read by a fresh observer (a bot: not a kid to anyone).
			const obs = new BotClient({ url: c.server.url, token: TOKEN });
			await obs.connect({ world, name: 'Obs', skin: 'chip' });
			try {
				await sleep(500);
				const badAir: string[] = [], badFloor: string[] = [];
				for (let i = 0; i < d.stepsDone; i++) {
					const st = spiralStep(d.spiral, i);
					for (const cc of st.clear) if (obs.world.getBlock(cc.x, cc.y, cc.z) !== 0) badAir.push(cellStr(cc));
					const f = obs.world.getBlock(st.floor.x, st.floor.y, st.floor.z);
					if (!obs.world.isSolid(f)) badFloor.push(`${cellStr(st.floor)}=${blockName(f)}`);
				}
				check(badAir.length === 0, `the staircase's ${d.stepsDone} steps are air (${badAir.length} not${badAir.length ? `: ${badAir.slice(0, 6).join(' ')}` : ''})`);
				check(badFloor.length === 0, `their floors are solid (${badFloor.length} not${badFloor.length ? `: ${badFloor.slice(0, 6).join(' ')}` : ''})`);
			} finally {
				obs.close();
			}
			// The i + 8 question (batch D): a walk down to step i ≥ 8, whose column holds step i − 8 higher up.
			const deep = [];
			for (let i = 8; i < d.stepsDone; i++) {
				const st = spiralStep(d.spiral, i);
				const ws = bot.walks.filter((w) => Math.floor(w.to.x) === st.feet.x && Math.floor(w.to.z) === st.feet.z);
				deep.push(`step ${i} (feet y ${st.feet.y}, step ${i - 8} at y ${st.feet.y + 8}): ${ws.map((w) => `${w.r} → y ${w.after.y.toFixed(1)}${w.err ? ` (${w.err})` : ''}`).join(', ') || 'no walk'}`);
			}
			info(`i+8: ${deep.join(' | ') || `the dig never passed step 8 (${d.stepsDone} steps)`}`);
			const before: BrainFile = JSON.parse(readFileSync(bot.brainPath, 'utf8'));
			mined = { world, bot: name, dig: d, before, journal };
		});
	}

	if (c.want('brain2-revert')) {
		await c.leg('brain2-revert', 'the CLI revert: staircase back, brain file reconciled', async () => {
			if (!mined) throw new Error('needs brain2-mine');
			const m = mined;
			const printed: string[] = [];
			await cliMain(['revert', '--target', 'local', '--world', m.world, '--name', m.bot], {
				makeClient: (o) => new BotClient(o), stateRoot: c.stateRoot, env: {}, readFile: () => null, print: (l) => void printed.push(l),
			});
			info(`revert printed: ${printed.join(' | ')}`);
			const after: BrainFile = JSON.parse(readFileSync(brainFilePath(c.stateRoot, 'local', m.world, m.bot), 'utf8'));
			const obs = new BotClient({ url: c.server.url, token: TOKEN });
			const joined = await obs.connect({ world: m.world, name: 'Obs', skin: 'chip' });
			try {
				await sleep(500);
				const gen = generatedLookup(joined.world.seed, joined.world.gen);
				const cells = [...new Set(m.journal.map((e) => `${e.x},${e.y},${e.z}`))];
				const off = cells.filter((k) => {
					const [x, y, z] = k.split(',').map(Number);
					return obs.world.getBlock(x, y, z) !== gen(x, y, z);
				});
				check(cells.length > 0 && off.length === 0, `the ${cells.length} cells the bot edited are back to their generated blocks (${off.length} not${off.length ? `: ${off.slice(0, 6).join(' ')}` : ''})`);
			} finally {
				obs.close();
			}
			// Expected: every mined block leaves the inventory, every placed block comes back (spec §4.6).
			const want: Record<string, number> = { ...m.before.inventory };
			let minedN = 0, placedN = 0;
			for (const e of m.journal) {
				if (e.newId === 0 && e.oldId !== 0) {
					const n = blockName(e.oldId)!;
					want[n] = Math.max(0, (want[n] ?? 0) - 1);
					minedN++;
				} else if (e.newId !== 0) {
					const n = blockName(e.newId)!;
					want[n] = (want[n] ?? 0) + 1;
					placedN++;
				}
			}
			const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
			check(JSON.stringify(Object.entries(after.inventory).filter(([, v]) => v > 0).sort()) === JSON.stringify(Object.entries(want).filter(([, v]) => v > 0).sort()),
				`inventory ${JSON.stringify(m.before.inventory)} → ${JSON.stringify(after.inventory)}: lower by ${sum(m.before.inventory) - sum(after.inventory)} = ${minedN} mined − ${placedN} placed back (expected ${JSON.stringify(want)})`);
			check(Object.keys(after.owned).length === 0 && after.digs.every((d) => d.status === 'reverted'), `owned emptied (${Object.keys(after.owned).length} left); digs ${after.digs.map((d) => d.status).join(',')}`);
		});
	}

	if (c.want('brain2-follow-watch')) {
		await c.leg('brain2-follow-watch', 'a kid walks 20 blocks and stops: follow, then watch or follow held', async () => {
			const world = await c.server.createWorld('e2e-brain2-follow');
			const bot = await startBot2(c, { world, name: 'Pip' });
			const kid = await Kid.connect({ url: c.server.url, token: TOKEN, world, name: 'Noah', skin: 'jj' });
			try {
				await sleep(3000);
				const p0 = kid.pose();
				let to: { x: number; z: number } | null = null;
				for (const [dx, dz] of [[20, 0], [0, 20], [-20, 0], [0, -20]]) {
					const x = p0.x + dx, z = p0.z + dz;
					const top = kid.world.surfaceY(x, z);
					if (top > 0 && !kid.world.isLiquid(kid.world.getBlock(Math.floor(x), top, Math.floor(z)))) {
						to = { x, z };
						break;
					}
				}
				if (!to) throw new Error('no dry spot 20 blocks away');
				const tWalk = Date.now();
				const how = await kid.walkTo(to);
				info(`kid ${how} to ${to.x.toFixed(1)},${to.z.toFixed(1)} in ${((Date.now() - tWalk) / 1000).toFixed(1)} s`);
				const t0 = Date.now();
				// Up to 60 s: done once the bot has been within 6 blocks of him for 10 s in a row, at least 10 s after he stopped.
				let nearSince: number | null = null;
				while (Date.now() - t0 < 60_000) {
					await sleep(500);
					if (hd(kid.pose(), bot.client.pose()) <= 6) nearSince ??= Date.now();
					else nearSince = null;
					if (nearSince !== null && Date.now() - nearSince >= 10_000 && Date.now() - t0 >= 10_000) break;
				}
				const k = kid.pose(), b = bot.client.pose();
				const seq = bot.selects().filter((s) => s.t >= tWalk - 3000).map((s) => `${s.trigger}:${s.inputs.current ?? '-'}→${s.winner}`);
				const cur = bot.handle.store.state.behaviour;
				const kinds = [bot.handle.store.state.memory.past.find((p) => p.endedT >= tWalk)?.behaviour, cur?.kind].filter(Boolean);
				const followThenWatch = started(bot.selects()).some((s) => s.t >= tWalk && s.winner === 'watch' && s.inputs.current === 'follow');
				const followHeld = cur?.kind === 'follow' && cur.params.kid === 'Noah';
				check(followThenWatch || followHeld, `follow then watch (${followThenWatch}), or follow held (${followHeld}); now ${cur?.kind ?? 'idle'}; selects ${seq.join(', ')}; ${kinds.join(',')}`);
				check(hd(k, b) <= 6, `the bot ends ${hd(k, b).toFixed(1)} blocks from the kid (≤ 6)`);
			} finally {
				kid.close();
				await bot.stop();
			}
		});
	}
}

/**
 * The real CLI with `--brain v2`: its own process on the `local` target (the server must be on that port), run for
 * `runMs`, then `signal`: it must exit by itself within 5 s, with its log in `.state/logs` and its brain file written.
 */
export async function brain2CliLeg(c: Brain2Ctx, signal: 'SIGTERM' | 'SIGINT', runMs = 40_000): Promise<void> {
	const { check, info } = c;
	const world = await c.server.createWorld(`e2e-brain2-cli-${signal}`);
	const name = `Cli${signal === 'SIGTERM' ? 'Term' : 'Int'}`;
	const stateDir = join(c.botsDir, '.state');
	const brainPath = brainFilePath(stateDir, 'local', world, name);
	const logDir = join(stateDir, 'logs', 'local', world);
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = spawn('npx', ['tsx', 'src/cli.ts', 'companion', '--target', 'local', '--world', world, '--name', name, '--brain', 'v2', '--personality', 'pip'], {
			cwd: c.botsDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
		child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
		const exited = new Promise<string>((r) => child!.once('exit', (code, sig) => r(`${code}/${sig}`)));
		await sleep(runMs);
		const running = child.exitCode === null && child.signalCode === null;
		check(running && /brain v2 \(pip, code engines\)/.test(out), `the CLI is still running after ${runMs / 1000} s with brain v2 (pip): ${running}`);
		const t0 = Date.now();
		process.kill(-child.pid!, signal);
		const code = await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)]);
		check(code !== 'timeout', `after ${signal} it exited by itself in ${code === 'timeout' ? '> 5000' : Date.now() - t0} ms (≤ 5000): ${code}`);
		const logs = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.jsonl')) : [];
		const lines = logs.length ? parseLog(readFileSync(join(logDir, logs[0]), 'utf8')) : [];
		const selects = lines.filter((l) => l.k === 'select').length;
		check(logs.length === 1 && lines[0]?.k === 'meta' && selects > 0 && lines.at(-1)?.k === 'event', `its log in .state/logs/local/<world>/: ${logs[0] ?? 'none'} (${lines.length} lines, ${selects} selects, last: ${lines.at(-1)?.k === 'event' ? (lines.at(-1) as Ev).kind : lines.at(-1)?.k})`);
		const stopped = lines.some((l) => l.k === 'event' && l.kind === 'stop');
		let alive = 0;
		try {
			alive = (JSON.parse(readFileSync(brainPath, 'utf8')) as BrainFile).lastAlive;
		} catch {
			// missing
		}
		check(stopped && alive >= t0 - 100, `brain file flushed on the way out (stop event: ${stopped}; lastAlive ${alive ? `${t0 - alive} ms before the signal` : 'missing'})`);
		info(`CLI output: ${out.trim().split('\n').map((l) => l.slice(0, 200)).join(' | ')}`);
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {
				// gone
			}
		}
		rmSync(join(stateDir, 'local', world), { recursive: true, force: true });
		rmSync(logDir, { recursive: true, force: true });
		rmSync(join(stateDir, 'brain', 'local', world), { recursive: true, force: true });
		for (const d of [['local'], ['logs', 'local'], ['logs'], ['brain', 'local'], ['brain'], []]) {
			try {
				rmdirSync(join(stateDir, ...d));
			} catch {
				// not empty, or not there
			}
		}
	}
}

/**
 * `brain2-productive`: the real CLI (`companion --brain v2 --personality pip`, via `cli-at.ts` on our free port), no
 * kid online (a kid-made dirt pillar, then he leaves), for up to BOTS_E2E_PRODUCTIVE_MIN minutes (default 15; it
 * stops early once both goals are met, unless BOTS_E2E_PRODUCTIVE_FULL=1). Asserts it is productive alone: ≥ 8
 * blocks mined into its inventory (the log's inventory increments), a Build that reached `done` (a finished build:
 * "≥ 10 cells placed" alone passed on the old code with a 10/64 tower abandoned), and no edit on a kid cell. The
 * seed is BOTS_E2E_SEED (default 12345), gen 3.
 */
export async function brain2ProductiveLeg(c: Brain2Ctx): Promise<void> {
	const { check, info } = c;
	const seed = Number(process.env.BOTS_E2E_SEED ?? 12345);
	const minutes = Number(process.env.BOTS_E2E_PRODUCTIVE_MIN ?? 15);
	const full = process.env.BOTS_E2E_PRODUCTIVE_FULL === '1';     // run all the minutes (no early stop), to watch it longer
	const world = await c.server.createWorld(`e2e-brain2-productive-${seed}`, seed, 3);
	const name = 'Pip';
	// The kid's pillar, 20 blocks from spawn, then he leaves.
	const kid = await Kid.connect({ url: c.server.url, token: TOKEN, world, name: 'Noah', skin: 'jj' });
	const sp = kid.pose();
	const kidCells: Vec3[] = [];
	for (const [dx, dz] of [[20, 0], [0, 20], [-20, 0], [0, -20]]) {
		const x = Math.floor(sp.x) + dx, z = Math.floor(sp.z) + dz;
		const top = kid.world.surfaceY(x, z);
		if (top > 0 && !kid.world.isLiquid(kid.world.getBlock(x, top, z))) {
			await kid.walkTo({ x: x + 2.5, z: z + 0.5 });
			for (let h = 1; h <= 3; h++) if (await kid.place({ x, y: top + h, z }, 'dirt')) kidCells.push({ x, y: top + h, z });
			break;
		}
	}
	check(kidCells.length === 3, `the kid's pillar: ${kidCells.map(cellStr).join(' ')}`);
	await sleep(500);
	kid.close();
	// A fresh observer (a bot: not a kid to anyone) records every edit the bot sends.
	const obs = new BotClient({ url: c.server.url, token: TOKEN });
	await obs.connect({ world, name: 'Obs', skin: 'chip' });
	const ops: Array<{ cell: Vec3; v: number; t: number }> = [];
	obs.on('edit', (msg: EditOut) => {
		const author = obs.players().find((p) => p.id === msg.by);
		if (author?.name === name) for (const [x, y, z, v] of msg.ops) ops.push({ cell: { x, y, z }, v, t: Date.now() });
	});
	const stateRoot = join(c.stateRoot, 'productive');
	const logDir = join(stateRoot, 'logs', 'local', world);
	const brainPath = brainFilePath(stateRoot, 'local', world, name);
	/** From the log so far: blocks mined into the inventory (every per-block increase of `inventory`), and the builds
	 * (the newest `builds` value) with how many of their cells the bot placed (the observer's ops). */
	const progress = () => {
		const logs = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort() : [];
		const lines = logs.flatMap((f) => parseLog(readFileSync(join(logDir, f), 'utf8')));
		let minedIn = 0;
		let builds: Build[] = [];
		for (const l of lines) {
			if (l.k !== 'change') continue;
			if (l.path === 'builds') builds = l.new as Build[];
			if (l.path !== 'inventory') continue;
			const o = (l.old ?? {}) as Record<string, number>, n = (l.new ?? {}) as Record<string, number>;
			for (const [b, v] of Object.entries(n)) minedIn += Math.max(0, v - (o[b] ?? 0));
		}
		const placedAt = new Set(ops.filter((o) => o.v !== 0).map((o) => cellStr(o.cell)));
		const counted = builds.map((b) => ({ b, placed: b.cells.filter((c) => placedAt.has(cellStr(c.cell))).length }));
		// A finished build: "≥ 10 cells placed" alone passed on the old code with a 10/64 tower left abandoned (seed 2026).
		const good = counted.find((x) => x.b.status === 'done');
		const buildsText = counted.map((x) => `${x.b.template}/${x.b.variant} ${x.b.status} ${x.placed}/${x.b.cells.length}`).join(', ') || 'none';
		return { lines, minedIn, good, buildsText };
	};
	let child: ReturnType<typeof spawn> | null = null;
	let out = '';
	const t0 = Date.now();
	try {
		child = spawn('npx', ['tsx', 'test/cli-at.ts', 'companion', '--target', 'local', '--world', world, '--name', name, '--brain', 'v2', '--personality', 'pip'], {
			cwd: c.botsDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, BOTS_E2E_URL: c.server.url, BOTS_E2E_STATE: stateRoot },
		});
		child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
		child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
		const exited = new Promise<string>((r) => child!.once('exit', (code, sig) => r(`${code}/${sig}`)));
		let lastReport = t0;
		while (Date.now() - t0 < minutes * 60_000 && child.exitCode === null) {
			await sleep(10_000);
			const p = progress();
			if (Date.now() - lastReport >= 60_000) {
				lastReport = Date.now();
				info(`${((Date.now() - t0) / 60_000).toFixed(1)} min: ${p.minedIn} mined in, ${ops.filter((o) => o.v !== 0).length} placed; builds ${p.buildsText}`);
			}
			if (p.minedIn >= 8 && p.good && !full) break;          // both goals met (re-checked after the stop)
		}
		check(child.exitCode === null, `the CLI ran for ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
		process.kill(-child.pid!, 'SIGTERM');
		const code = await Promise.race([exited, sleep(8000).then(() => 'timeout' as const)]);
		check(code !== 'timeout', `it stopped on SIGTERM: ${code}`);
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {
				// gone
			}
		}
		obs.close();
	}
	const p = progress();
	const lines = p.lines;
	const file: BrainFile | null = existsSync(brainPath) ? JSON.parse(readFileSync(brainPath, 'utf8')) : null;
	const { minedIn, good } = p;
	const kidKeys = new Set(kidCells.map(cellStr));
	const onKid = ops.filter((o) => kidKeys.has(cellStr(o.cell)));
	const ends: Record<string, number> = {};
	for (const l of lines) {
		if (l.k !== 'change' || l.path !== 'memory.past') continue;
		const e = (l.new as Array<{ behaviour: string; outcome: string; why: string }>)[0];
		if (e) ends[`${e.behaviour}:${e.outcome}(${e.why})`] = (ends[`${e.behaviour}:${e.outcome}(${e.why})`] ?? 0) + 1;
	}
	const acts: Record<string, number> = {};
	for (const l of lines) {
		if (l.k !== 'event' || l.kind !== 'act') continue;
		const d = l.data as { kind: string; ok: boolean; err?: string };
		const k = `${d.kind}:${d.ok ? 'ok' : `fail${d.err ? ` ${d.err.replace(/ at .*$/, '')}` : ''}`}`;
		acts[k] = (acts[k] ?? 0) + 1;
	}
	info(`seed ${seed}: ${lines.length} log lines; ends ${JSON.stringify(ends)}`);
	info(`acts ${JSON.stringify(acts)}`);
	info(`inventory at the end ${JSON.stringify(file?.inventory ?? null)}; builds ${p.buildsText}; digs ${(file?.digs ?? []).map((d) => `${d.block} ${d.stepsDone} steps ${d.status}`).join(', ') || 'none'}`);
	check(minedIn >= 8, `≥ 8 blocks mined into the inventory: ${minedIn} (the bot broke ${ops.filter((o) => o.v === 0).length} cells)`);
	check(good !== undefined, `a Build reached done: ${good ? `${good.b.template}/${good.b.variant}, ${good.placed}/${good.b.cells.length} cells placed by the bot` : 'none'}; builds ${p.buildsText}`);
	check(onKid.length === 0, `no edit on a kid cell (${onKid.length}${onKid.length ? `: ${onKid.map((o) => cellStr(o.cell)).join(' ')}` : ''})`);
	info(`CLI output (last lines): ${out.trim().split('\n').slice(-6).map((l) => l.slice(0, 200)).join(' | ')}`);
}
