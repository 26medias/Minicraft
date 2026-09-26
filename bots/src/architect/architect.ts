/**
 * The architect bot (experiment E6): never mines, unlimited blocks. It designs its own structures instead of using
 * fixed templates. Loop: the model picks an idea (a castle gate, a lighthouse, a pyramid...) and a colour theme → a
 * parametric generator makes three sizes and three styles of it, each validated (bounds, real blocks, every cell
 * supported by a chain to the ground) → the model picks a size and a style (with --llm-params, Ollama proposes the
 * numbers first; clamped and validated, else the choices) → brain2's SiteSearch near the nearest kid or spawn →
 * the builder's move loop (constructBuild: checkPlace = judgeSafety allowFree, kid cells and body buffers, StopSignal,
 * Tripwire; supported-first order) → a firework → rest → again. Builds persist in the builder's state directory (so
 * the decorator and the other bots see them) and every placed cell goes to the shared bot-cell registry.
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { StopSignal } from '../body/stop-signal.js';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { Ownership } from '../brain2/ownership.js';
import { Tripwire, type KidPos } from '../brain2/safety.js';
import { LIMITS } from '../brain2/data/limits.data.js';
import { SiteSearch, groundTop } from '../brain2/behaviours/site-search.js';
import { constructBuild, loadBuilderFile, makeAsk, saveBuilderFile, type BuilderBuild, type BuilderFile } from '../builder/builder.js';
import type { ChoiceEngine } from '../builder/engines.js';
import { cellKey } from '../builder/moves.js';
import { readBuilderRecords } from '../decorator/decor.js';
import type { SharedCells } from '../shared/bot-cells.js';
import { clampParams, IDEAS, makeDesign, presetParams, THEMES, themeSlug, type Design, type DRole, type Idea, type Theme } from './designs.js';
import type { ParamProposer } from './llm-params.js';

export interface ArchitectBuild extends BuilderBuild { idea: string; theme: string; size: string; style: string; params: Record<string, number>; by: Record<string, string> }
export interface ArchitectFile extends BuilderFile { builds: ArchitectBuild[] }

export interface ArchitectOpts {
	name: string; body: Body; world: WorldView; spawn: Vec3;
	primary: ChoiceEngine | null; secondary?: ChoiceEngine | null;
	/** --llm-params: proposes the numbers before the size/style choices. */
	proposer?: ParamProposer | null;
	noEdits: boolean; statePath: string;
	/** The builder bots' records of this world (the architect's own file lives there too): their builds are avoided. */
	builderDir?: string;
	log: (o: Record<string, unknown>) => void; status?: (line: string) => void;
	rng: () => number; clock?: () => number; paceMs?: number; statusEveryMs?: number; restMs?: number;
	known: ReadonlySet<string>;
	shared?: SharedCells | null;
}
export interface ArchitectStats { placed: number; refused: number; failed: number; buildsDone: number; buildsAbandoned: number; asks: number; fallbacks: number; current: string }
export interface ArchitectHandle { stop(): Promise<void>; stats: ArchitectStats; file: ArchitectFile; done: Promise<void> }

const ACCENT: ReadonlySet<DRole> = new Set(['accent', 'light', 'glass', 'dark']);

/** A design at an origin as the builder's build record (layer = support depth: constructBuild places supported-first). */
export function designBuild(id: string, d: Design, origin: Vec3, by: Record<string, string>, t: number): ArchitectBuild {
	return {
		id, template: d.idea, variant: d.size === 'small' ? 'small' : 'medium', palette: d.theme, origin, w: d.w, d: d.d, h: d.h,
		cells: d.cells.map((c) => ({ cell: { x: origin.x + c.cell.x, y: origin.y + c.cell.y, z: origin.z + c.cell.z }, block: c.block, role: ACCENT.has(c.role) ? 'accent' : 'wall', layer: c.depth })),
		placed: [], skipped: [], status: 'building', t,
		idea: d.idea, theme: d.theme, size: d.size, style: d.style, params: d.params, by,
	};
}

export function runArchitect(o: ArchitectOpts): ArchitectHandle {
	const clock = o.clock ?? (() => Date.now());
	const pace = o.paceMs ?? 800;
	const file = loadBuilderFile(o.statePath) as ArchitectFile;
	const own = new Ownership(o.world, () => file.owned, o.shared ? () => o.shared!.cells() : undefined);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const trip = new Tripwire();
	const stats: ArchitectStats = { placed: 0, refused: 0, failed: 0, buildsDone: 0, buildsAbandoned: 0, asks: 0, fallbacks: 0, current: 'starting' };
	const edits = { lastEditT: null as number | null, lastRefusal: '' };
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
	const themes = THEMES.filter((t) => Object.values(t.blocks).every((b) => o.known.has(b)));
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(o.rng() * xs.length) % xs.length];

	const unsubs = [
		o.body.onEdit((e) => {
			const who = stop.onEdit(e, o.body.journal(), clock());
			if (who) o.log({ k: 'stop-signal', kid: who, t: clock() });
			for (const op of own.onEdit(e, o.body.you)) if (op.value === undefined) delete file.owned[op.path[1] as string];
		}),
		o.body.onReconnect(() => own.reset()),
	];
	const kidsNow = (): KidPos[] => o.body.players().filter((p) => !p.bot && p.hasPos).map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z }));
	function nearestKid(): KidPos | null {
		const p = o.body.pose();
		let best: KidPos | null = null;
		for (const k of kidsNow()) if (!best || Math.hypot(k.x - p.x, k.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z)) best = k;
		return best;
	}
	const avoidBoxes = () => {
		const mine = file.builds.map((b) => ({ build: b as BuilderBuild }));
		const others = o.builderDir ? readBuilderRecords(o.builderDir).builds : [];
		return [...mine, ...others].map(({ build: b }) => ({ min: b.origin, max: { x: b.origin.x + b.w - 1, y: b.origin.y + b.h - 1, z: b.origin.z + b.d - 1 } }));
	};

	/** Designs the next build: idea → theme → (LLM numbers or) size + style → a validated design. */
	async function design(state: string): Promise<{ d: Design; by: Record<string, string> } | null> {
		const recent = file.builds.filter((b) => b.status === 'done').slice(-2).map((b) => b.idea);
		const pool = IDEAS.filter((i) => !recent.includes(i.name));
		const ideaPick = await ask('idea', state, 'What should the architect robot design and build next, so a 7-year-old is delighted to find it?', Object.fromEntries(pool.map((i) => [i.name, i.nice])));
		const idea: Idea = pool.find((i) => i.name === ideaPick) ?? pick(pool);
		const themePick = await ask('theme', `${state} I will build ${idea.nice}.`, `Which colours would look best on ${idea.nice}?`, Object.fromEntries(themes.map((t) => [themeSlug(t), `${t.name}: ${t.description}`])));
		const theme: Theme = themes.find((t) => themeSlug(t) === themePick) ?? pick(themes);
		const by: Record<string, string> = { idea: ideaPick === idea.name ? 'model' : 'fallback', theme: themePick === themeSlug(theme) ? 'model' : 'fallback' };
		const s2 = `${state} I will build ${idea.nice} in ${theme.name} colours.`;
		if (o.proposer) {
			try {
				const raw = await o.proposer.propose(idea, s2);
				const params = clampParams(idea, raw, presetParams(idea, idea.sizes[0], idea.styles[0]));
				const r = makeDesign(idea, theme, 'llm', 'llm', params, o.known);
				o.log({ k: 'llm-params', t: clock(), engine: o.proposer.name, idea: idea.name, raw, params, ok: r.ok, errors: r.errors });
				if (r.ok) return { d: r.design!, by: { ...by, params: 'llm' } };
			} catch (err) {
				o.log({ k: 'llm-params', t: clock(), engine: o.proposer.name, idea: idea.name, ok: false, err: err instanceof Error ? err.message : String(err) });
			}
		}
		// Size, then style: each among the 3 presets that validate, with their real dimensions stated.
		const describe = (d: Design) => `${d.w} wide, ${d.d} deep, ${d.h} high, ${d.cells.length} blocks`;
		const sizes = idea.sizes.map((s) => ({ s, r: makeDesign(idea, theme, s.key, idea.styles[0].key, presetParams(idea, s, idea.styles[0]), o.known) })).filter((x) => x.r.ok);
		if (sizes.length === 0) return null;
		const sizePick = await ask('size', s2, `How big should ${idea.nice} be?`, Object.fromEntries(sizes.map(({ s, r }) => [s.key, `${s.label}: ${describe(r.design!)}`])));
		const size = sizes.find((x) => x.s.key === sizePick)?.s ?? sizes[0].s; // fallback: the smallest
		const styles = idea.styles.map((st) => ({ st, r: makeDesign(idea, theme, size.key, st.key, presetParams(idea, size, st), o.known) })).filter((x) => x.r.ok);
		if (styles.length === 0) return null;
		const stylePick = await ask('style', `${s2} It will be ${size.label}.`, `Which style of ${idea.nice} would a 7-year-old like most?`, Object.fromEntries(styles.map(({ st }) => [st.key, st.label])));
		const style = styles.find((x) => x.st.key === stylePick) ?? pick(styles);
		return { d: style.r.design!, by: { ...by, size: sizePick === size.key ? 'model' : 'fallback', style: stylePick === style.st.key ? 'model' : 'fallback' } };
	}

	async function pickProject(): Promise<ArchitectBuild | null> {
		if (themes.length === 0) throw new Error('no architect theme has only known blocks');
		const kid = nearestKid();
		const p = o.body.pose();
		const last = file.builds.filter((b) => b.status === 'done').at(-1);
		const state = [
			`I am ${o.name}, an architect robot in a block world where a 7-year-old plays. I design my own buildings.`,
			kid ? `${kid.name} is ${Math.round(Math.hypot(kid.x - p.x, kid.z - p.z))} blocks away.` : 'No kid is online right now.',
			last ? `Last I built ${IDEAS.find((i) => i.name === last.idea)?.nice ?? last.idea}.` : 'I have not built anything yet.',
		].join(' ');
		stats.current = 'designing';
		const r = await design(state);
		if (!r) return null;
		const { d, by } = r;
		const anchor = kid ? { x: kid.x, y: kid.y, z: kid.z } : o.spawn;
		stats.current = `searching a site for the ${d.size} ${d.idea} (${d.w}×${d.d}, ${d.h} high)`;
		const search = new SiteSearch({ w: d.w, d: d.d, h: d.h, anchor, avoid: avoidBoxes() }, { world: o.world, own, spawn: o.spawn, kids: kidsNow() });
		for (;;) {
			if (stopped) return null;
			const s = search.step();
			if (s === 'none') {
				o.log({ k: 'search-failed', t: clock(), idea: d.idea, size: d.size, anchor, rejections: search.rejections });
				return null;
			}
			if (s) {
				const b = designBuild(clock().toString(36), d, s.origin, by, clock());
				file.builds.push(b);
				save();
				o.log({ k: 'project', t: clock(), id: b.id, idea: d.idea, theme: d.theme, size: d.size, style: d.style, params: d.params, dims: [d.w, d.d, d.h], cells: d.cells.length, origin: s.origin, anchor, by, radius: search.radius });
				return b;
			}
			await new Promise((res) => setImmediate(res));
		}
	}

	async function restNear(b: BuilderBuild, ms: number): Promise<void> {
		const until = clock() + ms;
		const cx = b.origin.x + b.w / 2, cz = b.origin.z + b.d / 2;
		while (!stopped && clock() < until) {
			const left = until - clock();
			if (o.rng() < 0.5) o.body.lookAt(b.origin.x + o.rng() * b.w, b.origin.y + o.rng() * b.h, b.origin.z + o.rng() * b.d);
			else {
				const a = o.rng() * Math.PI * 2;
				const rad = Math.max(b.w, b.d) / 2 + 1.5 + o.rng() * 2;
				const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
				const y = groundTop(o.world, Math.floor(x), Math.floor(z)) + 1;
				if (y > 0) await Promise.race([o.body.flyTo({ x, y, z }).catch(() => undefined), sleep(Math.min(left, 4000))]);
				if (stopped) return;
				o.body.lookAt(cx, b.origin.y + b.h / 2, cz);
			}
			await sleep(Math.min(until - clock(), 2500 + o.rng() * 2500));
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
				b ??= await pickProject();
				if (!b) {
					stats.current = 'no design or site; waiting';
					await sleep(10_000);
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
				if (b.status === 'building') continue; // stopped or halted: resume later
				if (b.status === 'done') {
					stats.buildsDone++;
					stats.current = `resting after the ${b.size} ${b.idea}`;
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
			const paused = stop.active(clock()).map((s) => ` | paused near ${s.name} ${Math.ceil(s.remainingMs / 60_000)}m`).join('');
			o.status!(`${o.name}: ${stats.current} | builds ${stats.buildsDone} done, ${stats.buildsAbandoned} abandoned | placed ${stats.placed} | engine ${o.primary?.name ?? 'none'}${o.proposer ? ` + ${o.proposer.name}` : ''} (fallbacks ${stats.fallbacks}/${stats.asks})${paused}${trip.halted ? ' | EDITS HALTED' : ''}`);
		}, o.statusEveryMs ?? 30_000)
		: null;

	o.log({ k: 'start', t: clock(), bot: 'architect', name: o.name, primary: o.primary?.name ?? null, secondary: o.secondary?.name ?? null, proposer: o.proposer?.name ?? null, noEdits: o.noEdits, builds: file.builds.length });
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
