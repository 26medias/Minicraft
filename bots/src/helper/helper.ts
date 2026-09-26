/**
 * The helper bot (experiment E5): never mines, unlimited blocks. It watches the kids' placements; when a kid is
 * building (≥ 3 placements within 32 blocks of him in the last 60 s) it builds a SMALL matching structure beside his
 * build: his blocks (his palette, unlimited), a template the model picks ("a matching tower", "a wall", "a statue", "a
 * little house"), 4–8 blocks from his cells, facing him. Otherwise it idles near spawn, looking around. It builds with
 * the builder's move loop (constructBuild: every placement through checkPlace and a Tripwire), appends its cells to
 * the shared bot-cell registry, and logs its decisions like the builder.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blockName } from 'minicraft-bot';
import { StopSignal } from '../body/stop-signal.js';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { Ownership } from '../brain2/ownership.js';
import { Tripwire, type KidPos } from '../brain2/safety.js';
import { LIMITS } from '../brain2/data/limits.data.js';
import { groundTop } from '../brain2/behaviours/site-search.js';
import { constructBuild, loadBuilderFile, makeAsk, saveBuilderFile, type BuilderBuild, type BuilderFile } from '../builder/builder.js';
import type { ChoiceEngine } from '../builder/engines.js';
import { cellKey, planCells } from '../builder/moves.js';
import type { SharedCells } from '../shared/bot-cells.js';
import { HELP_CHOICES, helpTemplate, helperSite, kidBuilding, kidPalette, type KidPlacement } from './plan.js';

export interface HelperBuild extends BuilderBuild { kid: string; kidCells: Vec3[]; kidBlocks: string[]; minGap: number; rot: number }
export interface HelperFile extends BuilderFile { builds: HelperBuild[] }

export function helperStatePath(stateRoot: string, target: string, world: string, name: string): string {
	return join(stateRoot, 'helper', target, world, `${name}.json`);
}

export interface HelperOpts {
	name: string; body: Body; world: WorldView; spawn: Vec3;
	primary: ChoiceEngine | null; secondary?: ChoiceEngine | null;
	noEdits: boolean; statePath: string; log: (o: Record<string, unknown>) => void; status?: (line: string) => void;
	rng: () => number; clock?: () => number; paceMs?: number; statusEveryMs?: number; restMs?: number;
	known: ReadonlySet<string>;
	shared?: SharedCells | null;
}
export interface HelperStats { placed: number; refused: number; failed: number; buildsDone: number; buildsAbandoned: number; asks: number; fallbacks: number; current: string }
export interface HelperHandle { stop(): Promise<void>; stats: HelperStats; file: HelperFile; done: Promise<void> }

const IDLE_NEAR_SPAWN = 8;
/** Plan only once the kid's newest placement is this old. */
const SETTLE_MS = 5000;

export function runHelper(o: HelperOpts): HelperHandle {
	const clock = o.clock ?? (() => Date.now());
	const pace = o.paceMs ?? 800;
	const file = loadBuilderFile(o.statePath) as HelperFile;
	const own = new Ownership(o.world, () => file.owned, o.shared ? () => o.shared!.cells() : undefined);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const trip = new Tripwire();
	const stats: HelperStats = { placed: 0, refused: 0, failed: 0, buildsDone: 0, buildsAbandoned: 0, asks: 0, fallbacks: 0, current: 'starting' };
	const edits = { lastEditT: null as number | null, lastRefusal: '' };
	/** The kids' placements seen this session (oldest first, capped). */
	const placements: KidPlacement[] = [];
	/** Per kid: help again only for placements after the last helper build for him ended. */
	const helpedUntil = new Map<string, number>();
	let stopped = false;
	const wakers = new Set<() => void>();
	const sleep = (ms: number) => new Promise<void>((res) => {
		if (stopped) return res();
		const done = () => {
			clearTimeout(t);
			wakers.delete(done);
			res();
		};
		const t = setTimeout(done, Math.max(0, ms));
		wakers.add(done);
	});
	const save = () => saveBuilderFile(o.statePath, file);
	const ask = makeAsk({ primary: o.primary, secondary: o.secondary, clock, log: o.log, stats });
	const kidsNow = (): KidPos[] => o.body.players().filter((p) => !p.bot && p.hasPos).map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z }));

	const unsubs = [
		o.body.onEdit((e) => {
			const now = clock();
			const who = stop.onEdit(e, o.body.journal(), now);
			if (who) o.log({ k: 'stop-signal', kid: who, t: now });
			for (const op of own.onEdit(e, o.body.you)) if (op.value === undefined) delete file.owned[op.path[1] as string];
			if (e.byBot || e.by === o.body.you || !e.byName) return;
			for (const c of e.cells) {
				const name = c.newId !== 0 ? blockName(c.newId) : null;
				if (name) placements.push({ cell: { x: c.x, y: c.y, z: c.z }, block: name, kid: e.byName, t: now });
			}
			if (placements.length > 2000) placements.splice(0, placements.length - 2000);
		}),
		o.body.onReconnect(() => own.reset()),
	];

	const avoidBoxes = () => file.builds.map((b) => ({ min: b.origin, max: { x: b.origin.x + b.w - 1, y: b.origin.y + b.h - 1, z: b.origin.z + b.d - 1 } }));

	/** A help project for the kid who is building now, or null (nobody building, no copyable block, no site). */
	async function pickHelp(): Promise<HelperBuild | null> {
		const kids = kidsNow();
		let w: ReturnType<typeof kidBuilding> = null;
		for (const k of kids) {
			const r = kidBuilding(placements, [k], clock(), helpedUntil.get(k.name) ?? -Infinity);
			if (r) {
				w = r;
				break;
			}
		}
		if (!w) return null;
		// Wait for a pause in his placing: a site planned mid-line may end up beside the line's next blocks.
		const newest = placements.filter((p) => p.kid === w!.kid).at(-1)!;
		if (clock() - newest.t < SETTLE_MS) {
			stats.current = `${w.kid} is building; waiting for a pause`;
			return null;
		}
		// His cells: the ones still standing (he may have broken some back).
		const cells = w.cells.filter((p) => blockName(o.world.getBlock(p.cell.x, p.cell.y, p.cell.z)) === p.block);
		const palette = kidPalette(cells.map((p) => p.block).filter((b) => o.known.has(b)));
		if (!palette || cells.length === 0) {
			o.log({ k: 'help-skip', t: clock(), kid: w.kid, why: palette ? 'his blocks are gone' : 'no block of his can be copied', blocks: [...new Set(w.cells.map((p) => p.block))] });
			helpedUntil.set(w.kid, clock());
			return null;
		}
		const blocks = [...new Set(cells.map((p) => p.block))];
		const kid = kids.find((k) => k.name === w!.kid)!;
		const state = [
			`I am ${o.name}, a helper robot in a block world where a 7-year-old plays.`,
			`${w.kid} is building with ${blocks.map((b) => b.replace(/_/g, ' ')).join(', ')}: ${cells.length} blocks so far.`,
			'I want to build something small next to his build, with the same blocks, so it looks like we built together.',
		].join(' ');
		const picked = await ask('help', state, `Which small build would ${w.kid} most like to see next to his?`, HELP_CHOICES);
		const choice = picked && HELP_CHOICES[picked] ? picked : Object.keys(HELP_CHOICES)[Math.floor(o.rng() * 4) % 4];
		const t = helpTemplate(choice, o.rng);
		stats.current = `searching a spot next to ${w.kid}'s build for ${HELP_CHOICES[choice]}`;
		const site = helperSite({
			world: o.world, template: t, kidCells: cells.map((p) => p.cell), kidCellWithin: (x, z, r) => own.kidCellWithin(x, z, r),
			kids, avoid: avoidBoxes(),
		});
		if (!site) {
			o.log({ k: 'search-failed', t: clock(), kid: w.kid, choice, template: t.name, kidCells: cells.length });
			helpedUntil.set(w.kid, clock());
			return null;
		}
		const b: HelperBuild = {
			id: clock().toString(36), template: t.name, variant: t.variant, palette: palette.name, origin: site.origin,
			w: site.template.w, d: site.template.d, h: site.template.h, cells: planCells(site.template, site.origin, palette),
			placed: [], skipped: [], status: 'building', t: clock(),
			kid: w.kid, kidCells: cells.map((p) => p.cell), kidBlocks: blocks, minGap: Math.round(site.minGap * 10) / 10, rot: site.rot,
		};
		file.builds.push(b);
		save();
		o.log({
			k: 'project', t: clock(), id: b.id, kid: w.kid, choice, by: picked === choice ? 'model' : 'fallback', template: `${t.name}-${t.variant}`,
			palette: palette.blocks, origin: site.origin, rot: site.rot, minGap: b.minGap, kidAt: { x: kid.x, z: kid.z }, kidCells: cells.length,
		});
		return b;
	}

	/** A few seconds of idling near spawn: fly back when far, else a look around or a short hop. */
	async function idle(): Promise<void> {
		stats.current = 'idle near spawn, watching for a kid building';
		const p = o.body.pose();
		const home = o.spawn;
		const far = Math.hypot(p.x - home.x, p.z - home.z) > IDLE_NEAR_SPAWN * 2;
		if (far || o.rng() < 0.3) {
			const a = o.rng() * Math.PI * 2, r = far ? 3 : 2 + o.rng() * IDLE_NEAR_SPAWN;
			const x = home.x + 0.5 + Math.cos(a) * r, z = home.z + 0.5 + Math.sin(a) * r;
			const y = groundTop(o.world, Math.floor(x), Math.floor(z)) + 1;
			if (y > 0) await Promise.race([o.body.flyTo({ x, y, z }).catch(() => undefined), sleep(5000)]);
		} else {
			const a = o.rng() * Math.PI * 2;
			o.body.lookAt(p.x + Math.cos(a) * 8, p.y + 1 + o.rng() * 3, p.z + Math.sin(a) * 8);
		}
		await sleep(1500 + o.rng() * 1500);
	}

	async function restNear(b: HelperBuild, ms: number): Promise<void> {
		const until = clock() + ms;
		while (!stopped && clock() < until) {
			o.body.lookAt(b.origin.x + o.rng() * b.w, b.origin.y + o.rng() * b.h, b.origin.z + o.rng() * b.d);
			await sleep(Math.min(until - clock(), 2000 + o.rng() * 2000));
		}
	}

	async function loop(): Promise<void> {
		let resume = file.builds.find((b) => b.status === 'building') ?? null;
		let haltedLogged = false;
		while (!stopped) {
			if (trip.halted) {
				if (!haltedLogged) o.log({ k: 'EDITS-HALTED', t: clock(), why: trip.halted });
				haltedLogged = true;
				stats.current = `EDITS HALTED (${trip.halted})`;
				await sleep(5000);
				continue;
			}
			let b = resume;
			resume = null;
			try {
				b ??= await pickHelp();
				if (!b) {
					await idle();
					continue;
				}
				await constructBuild(b, {
					body: o.body, world: o.world, own, stop, trip, kidsNow, ask, log: o.log, save, sleep, clock, pace, noEdits: o.noEdits,
					stopped: () => stopped, stats, edits,
					onPlaced: (cell, id) => {
						file.owned[cellKey(cell)] = id;
						own.ownWrite(cell.x, cell.y, cell.z, id);
						o.shared?.append(cell, id);
					},
				});
				if (b.status === 'building') continue;
				helpedUntil.set(b.kid, clock());
				if (b.status === 'done') {
					stats.buildsDone++;
					stats.current = `resting after the ${b.template} beside ${b.kid}'s build`;
					await restNear(b, o.restMs ?? 30_000);
				} else stats.buildsAbandoned++;
			} catch (err) {
				o.log({ k: 'error', t: clock(), err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
				if (b && b.status === 'building') {
					b.status = 'abandoned';
					b.why = 'error';
					save();
				}
				await sleep(5000);
			}
		}
	}

	const statusTimer = o.status
		? setInterval(() => {
			o.status!(`${o.name}: ${stats.current} | helped ${stats.buildsDone}, abandoned ${stats.buildsAbandoned} | placed ${stats.placed} | engine ${o.primary?.name ?? 'none'} (fallbacks ${stats.fallbacks}/${stats.asks})${trip.halted ? ' | EDITS HALTED' : ''}`);
		}, o.statusEveryMs ?? 30_000)
		: null;

	o.log({ k: 'start', t: clock(), bot: 'helper', name: o.name, primary: o.primary?.name ?? null, secondary: o.secondary?.name ?? null, noEdits: o.noEdits, builds: file.builds.length });
	const done = loop();
	return {
		stats,
		file,
		done,
		async stop() {
			stopped = true;
			for (const w of [...wakers]) w();
			if (statusTimer) clearInterval(statusTimer);
			await done;
			for (const u of unsubs) u();
			if (existsSync(dirname(o.statePath)) || file.builds.length) save();
			o.log({ k: 'stop', t: clock(), stats });
		},
	};
}
