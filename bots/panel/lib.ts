/**
 * The bot control panel's pure logic: validation, unit-name whitelist, the systemd-run argv, and the
 * log summary. No I/O here (server.ts does that), so every rule is unit-tested in test/panel.test.ts.
 */
import { SKIN_IDS } from '../src/skins.js';
import { PERSONALITIES } from '../src/brain2/data/personalities.data.js';
import type { Personality } from '../src/brain2/types.js';

export { SKIN_IDS };

/** Units the panel must never touch, whatever the request says. */
export const PROTECTED_UNITS: readonly string[] = ['minicraft-server', 'minicraft-tunnel'];

/** A panel-owned instance: `mcbot-<slug>`. Nothing else may be started or stopped as a panel unit. */
const PANEL_UNIT_RE = /^mcbot-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A legacy hand-started bot unit (stop only). */
const LEGACY_UNIT_RE = /^minicraft-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isProtectedUnit(unit: string): boolean {
	const base = unit.replace(/\.service$/, '');
	return PROTECTED_UNITS.includes(base);
}

export function isPanelUnit(unit: unknown): unit is string {
	return typeof unit === 'string' && unit.length <= 64 && !isProtectedUnit(unit) && PANEL_UNIT_RE.test(unit);
}

export function isLegacyUnit(unit: unknown): unit is string {
	return typeof unit === 'string' && unit.length <= 64 && !isProtectedUnit(unit) && LEGACY_UNIT_RE.test(unit);
}

/** Stop is allowed on panel units and legacy bot units; never on the server or the tunnel. */
export function isStoppableUnit(unit: unknown): unit is string {
	return isPanelUnit(unit) || isLegacyUnit(unit);
}

/** The server's rule: letters, digits and spaces, 1–16 characters (no leading/trailing space here). */
export function isValidName(name: unknown): name is string {
	return typeof name === 'string' && /^[A-Za-z0-9 ]{1,16}$/.test(name) && name.trim() === name && name.trim().length > 0;
}

export function isValidSkin(skin: unknown): skin is string {
	return typeof skin === 'string' && (SKIN_IDS as readonly string[]).includes(skin);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isValidWorld(world: unknown): world is string {
	return typeof world === 'string' && UUID_RE.test(world);
}

export function slugOf(name: string): string {
	return name.toLowerCase().trim().split(/\s+/).join('-');
}

export function unitFor(name: string): string {
	return `mcbot-${slugOf(name)}`;
}

export type Family = 'companion' | 'builder' | 'foreman';
export interface BotType {
	id: string;
	family: Family;
	/** `--brain laya|jev` (+ `--compare`). */
	brain: boolean;
	/** The cap flag, if the type has one. */
	maxFlag?: '--max-builds' | '--max-decorations';
	joinPlan: boolean;
}

/** Every type the panel knows; server.ts hides the ones the CLI does not offer. */
export const BOT_TYPES: readonly BotType[] = [
	{ id: 'companion', family: 'companion', brain: false, joinPlan: false },
	{ id: 'builder', family: 'builder', brain: true, maxFlag: '--max-builds', joinPlan: true },
	{ id: 'decorator', family: 'builder', brain: true, maxFlag: '--max-decorations', joinPlan: false },
	{ id: 'village', family: 'builder', brain: true, joinPlan: false },
	{ id: 'helper', family: 'builder', brain: true, maxFlag: '--max-builds', joinPlan: false },
	{ id: 'architect', family: 'builder', brain: true, maxFlag: '--max-builds', joinPlan: true },
	{ id: 'foreman', family: 'foreman', brain: false, joinPlan: false },
	{ id: 'landscaper', family: 'builder', brain: true, joinPlan: false },
];

// ---- personality cards ---------------------------------------------------------------------------

/** One companion personality, formatted for the start form. Every number here comes from
 * `personalities.data.ts` at call time — nothing about Pip or Rex is hardcoded here. */
export interface PersonalityCard {
	id: string;
	name: string;
	summary: string;
	oneLiner: string;
	chips: string[];
	tendency: string;
}

function signed(v: number): string {
	const s = v.toFixed(1);
	return v >= 0 ? `+${s}` : s;
}

function confidenceLabel(v: number): string {
	return v <= -0.15 ? 'timid' : v >= 0.15 ? 'bold' : 'level-headed';
}

function curiosityLabel(v: number): string {
	return v >= 0.5 ? 'very curious' : v >= 0.15 ? 'curious' : v <= -0.15 ? 'incurious' : 'mildly curious';
}

function patienceLabel(v: number): string {
	return v < 0 ? 'impatient' : 'calm';
}

function distancePhrase(d: number): string {
	return d >= 3 ? `keeps ~${d} blocks from kids` : `comes close (~${d} blocks)`;
}

function prettyBlock(id: string): string {
	return id.replace(/_/g, ' ');
}

/** A short, generic guess at play style from the baselines — thresholds, not per-personality text. */
function tendencyPhrase(p: Personality): string {
	const c = p.baselines.confidence;
	const verbs = c <= -0.15 ? ['rest', 'watch'] : c >= 0.15 ? ['explore', 'mine'] : ['wander', 'tinker'];
	const pat = p.baselines.patience;
	const tail = pat < 0 ? 'gets bored of following sooner' : pat > 0 ? 'builds quietly and sticks with it' : null;
	return `Tends to ${(tail ? [...verbs, tail] : verbs).join(', ')}.`;
}

export function personalityCard(id: string, p: Personality): PersonalityCard {
	const { confidence, curiosity, patience } = p.baselines;
	const descriptors = [`${confidenceLabel(confidence)} (confidence ${signed(confidence)})`, curiosityLabel(curiosity), patienceLabel(patience)];
	const likes = [p.favouriteTemplate ? `${p.favouriteTemplate}s` : null, p.favouriteBlock ? prettyBlock(p.favouriteBlock) : null].filter((x): x is string => Boolean(x));
	const oneLiner = `${p.name} — ${p.summary}: ${descriptors.join(', ')}; ${distancePhrase(p.preferredDistance)}${likes.length ? `; likes ${likes.join(' & ')}` : ''}. ${tendencyPhrase(p)}`;
	const chips = [
		confidenceLabel(confidence), curiosityLabel(curiosity), patienceLabel(patience), `~${p.preferredDistance} blocks`,
		...(p.favouriteTemplate ? [p.favouriteTemplate] : []), ...(p.favouriteBlock ? [prettyBlock(p.favouriteBlock)] : []),
	];
	return { id, name: p.name, summary: p.summary, oneLiner, chips, tendency: tendencyPhrase(p) };
}

/** All companion personalities the CLI knows, for the start form. Reads `PERSONALITIES` fresh each call. */
export function personalityCards(): PersonalityCard[] {
	return Object.entries(PERSONALITIES).map(([id, p]) => personalityCard(id, p));
}

/** Parses the CLI's `unknown bot "x"; expected a, b, c or d` message into the command list. */
export function parseAvailableCommands(message: string): string[] {
	const m = /expected ([a-z, ]+?)(?: or ([a-z]+))?\s*$/m.exec(message);
	if (!m) return [];
	const list = m[1].split(',').map((s) => s.trim()).filter(Boolean);
	if (m[2]) list.push(m[2]);
	return list;
}

export interface StartSpec {
	type: string;
	name: string;
	skin: string;
	target: 'live' | 'local';
	world: string;
	brain?: 'laya' | 'jev';
	compare?: boolean;
	personality?: 'pip' | 'rex';
	jev?: boolean;
	when?: 'always' | 'players';
	max?: number;
	joinPlan?: boolean;
}

export interface StartContext {
	types: readonly string[];
	whenSupported: boolean;
}

/** Validates an untrusted start request against the whitelists. Returns the clean spec or an error. */
export function validateStart(raw: unknown, ctx: StartContext): StartSpec | { error: string } {
	if (!raw || typeof raw !== 'object') return { error: 'body must be a JSON object' };
	const r = raw as Record<string, unknown>;
	const type = BOT_TYPES.find((t) => t.id === r.type);
	if (!type || !ctx.types.includes(type.id)) return { error: `unknown or unavailable bot type: ${String(r.type)}` };
	if (!isValidName(r.name)) return { error: 'name: letters, digits and spaces, 1–16 characters' };
	if (!isValidSkin(r.skin)) return { error: `skin must be one of ${SKIN_IDS.join(', ')}` };
	if (r.target !== 'live' && r.target !== 'local') return { error: 'target must be live or local' };
	if (!isValidWorld(r.world)) return { error: 'world must be a world uuid' };
	const spec: StartSpec = { type: type.id, name: r.name, skin: r.skin, target: r.target, world: r.world };
	if (type.family === 'companion') {
		if (r.personality !== 'pip' && r.personality !== 'rex') return { error: 'personality must be pip or rex' };
		spec.personality = r.personality;
		spec.jev = r.jev === true;
	}
	if (type.brain) {
		if (r.brain !== 'laya' && r.brain !== 'jev') return { error: 'brain must be laya or jev' };
		spec.brain = r.brain;
		spec.compare = r.compare === true;
	}
	if (r.when !== undefined && r.when !== null && r.when !== '') {
		if (r.when !== 'always' && r.when !== 'players') return { error: 'when must be always or players' };
		if (!ctx.whenSupported) return { error: 'this CLI has no --when flag yet' };
		spec.when = r.when;
	}
	if (type.maxFlag && r.max !== undefined && r.max !== null && r.max !== '') {
		const n = typeof r.max === 'number' ? r.max : typeof r.max === 'string' && /^\d{1,4}$/.test(r.max) ? Number(r.max) : NaN;
		if (!Number.isInteger(n) || n < 1 || n > 9999) return { error: 'max must be a whole number 1–9999' };
		spec.max = n;
	}
	if (type.joinPlan) spec.joinPlan = r.joinPlan === true;
	return spec;
}

/** The bot CLI's arguments (after `npm --prefix bots run bot --`). */
export function botArgs(spec: StartSpec): string[] {
	const type = BOT_TYPES.find((t) => t.id === spec.type);
	if (!type) throw new Error(`unknown type ${spec.type}`);
	const a = [spec.type, '--target', spec.target, '--world', spec.world, '--name', spec.name, '--skin', spec.skin];
	if (type.family === 'companion') {
		a.push('--brain', 'v2', '--personality', spec.personality ?? 'pip');
		if (spec.jev) a.push('--jev');
	}
	if (type.brain && spec.brain) {
		a.push('--brain', spec.brain);
		if (spec.compare) a.push('--compare');
	}
	if (type.maxFlag && spec.max !== undefined) a.push(type.maxFlag, String(spec.max));
	if (spec.joinPlan) a.push('--join-plan');
	if (spec.when) a.push('--when', spec.when);
	if (spec.target === 'live') a.push('--i-deployed-the-server');
	return a;
}

export interface RunEnv {
	/** The worktree root (the directory holding bots/). */
	worktree: string;
	/** The directory of the node binary (goes first on PATH). */
	nodeDir: string;
	/** Absolute path to npm. */
	npm: string;
}

/** The full `systemd-run` argv — executed with execFile, never through a shell. */
export function systemdRunArgv(spec: StartSpec, env: RunEnv): string[] {
	return [
		'systemd-run', '--user', `--unit=${unitFor(spec.name)}`, `--working-directory=${env.worktree}`,
		'--property=Restart=on-failure', '--property=RestartSec=60',
		'--property=StartLimitIntervalSec=3600', '--property=StartLimitBurst=5',
		`--setenv=PATH=${env.nodeDir}:/usr/local/bin:/usr/bin:/bin`,
		env.npm, '--prefix', 'bots', 'run', 'bot', '--', ...botArgs(spec),
	];
}

/** Splits a systemd Description (the quoted command line systemd-run records) into words. */
export function splitCommandLine(s: string): string[] {
	const out: string[] = [];
	let cur = '';
	let has = false;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
			else cur += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			has = true;
		} else if (/\s/.test(c)) {
			if (has) out.push(cur);
			cur = '';
			has = false;
		} else {
			cur += c;
			has = true;
		}
	}
	if (has) out.push(cur);
	return out;
}

export interface UnitCommand { type: string | null; name: string | null; target: string; world: string | null; personality: string | null }

/** Reads the bot type, name, target, world and (for companions) personality from a unit's Description. */
export function parseUnitCommand(description: string): UnitCommand {
	const w = splitCommandLine(description);
	const flag = (f: string): string | null => {
		const i = w.indexOf(f);
		return i >= 0 && i + 1 < w.length ? w[i + 1] : null;
	};
	const known = BOT_TYPES.map((t) => t.id);
	let type: string | null = null;
	const dd = w.indexOf('--');
	const cli = w.findIndex((x) => x.endsWith('cli.ts'));
	const after = dd >= 0 ? w[dd + 1] : cli >= 0 ? w[cli + 1] : undefined;
	if (after && known.includes(after)) type = after;
	else if (after?.startsWith('--')) type = 'companion';
	return { type, name: flag('--name'), target: flag('--target') ?? 'local', world: flag('--world'), personality: flag('--personality') };
}

/** Parses `systemctl show` output (blank-line separated blocks of Key=Value). */
export function parseShow(text: string): Array<Record<string, string>> {
	return text.split(/\n\s*\n/).map((block) => {
		const o: Record<string, string> = {};
		for (const line of block.split('\n')) {
			const i = line.indexOf('=');
			if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
		}
		return o;
	}).filter((o) => Object.keys(o).length > 0);
}

/** Parses the CLI's world list (`<uuid>  <name>  online: a, b`). */
export function parseWorlds(text: string): Array<{ uuid: string; name: string; online: string }> {
	const out: Array<{ uuid: string; name: string; online: string }> = [];
	for (const line of text.split('\n')) {
		const m = /^([0-9a-f-]{36})\s{2}(.*?)(?:\s{2}\(mustMine\))?\s{2}online: (.*)$/.exec(line.trim());
		if (m) out.push({ uuid: m[1], name: m[2], online: m[3] });
	}
	return out;
}

/** True when `file` is one of `name`'s session logs (`<name>-<ISO stamp>[-n].jsonl`). */
export function isLogOf(file: string, name: string): boolean {
	if (!file.startsWith(`${name}-`) || !file.endsWith('.jsonl')) return false;
	return /^\d{4}-\d\d-\d\dT[\d-]+Z(?:-\d+)?\.jsonl$/.test(file.slice(name.length + 1));
}

// ---- log summary -------------------------------------------------------------------------------

type Line = Record<string, unknown> & { k?: string; t?: number };

function parseLines(text: string): Line[] {
	const out: Line[] = [];
	for (const raw of text.split('\n')) {
		if (!raw.trim()) continue;
		try {
			const o = JSON.parse(raw);
			if (o && typeof o === 'object') out.push(o);
		} catch {
			// a torn first/last line: skip
		}
	}
	return out;
}

function setPath(root: Record<string, unknown>, path: string, value: unknown, deleted: boolean): void {
	const parts = path.split('.');
	let o: Record<string, unknown> = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const next = o[parts[i]];
		if (!next || typeof next !== 'object' || Array.isArray(next)) o[parts[i]] = {};
		o = o[parts[i]] as Record<string, unknown>;
	}
	const last = parts[parts.length - 1];
	if (deleted) delete o[last];
	else o[last] = value;
}

function short(v: unknown, n = 160): string {
	const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function axes(o: unknown): Record<string, { value: number | null; band: string | null }> {
	const out: Record<string, { value: number | null; band: string | null }> = {};
	if (!o || typeof o !== 'object') return out;
	for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
		const a = v as { value?: unknown; band?: unknown } | null;
		out[k] = { value: typeof a?.value === 'number' ? a.value : null, band: typeof a?.band === 'string' ? a.band : null };
	}
	return out;
}

export interface Brain2Summary {
	kind: 'brain2';
	behaviour: { kind: string | null; params: unknown; step: unknown; progress: unknown; failures: unknown; startedT: unknown } | null;
	emotions: Record<string, { value: number | null; band: string | null }>;
	relations: Record<string, Record<string, { value: number | null; band: string | null }>>;
	inventory: Record<string, unknown>;
	selections: Array<{ t: unknown; trigger: unknown; winner: unknown; player: unknown; urgent: unknown }>;
	events: Array<{ t: unknown; kind: unknown; data: string }>;
}

export interface BuilderSummary {
	kind: 'builder';
	start: Line | null;
	project: Line | null;
	placed: number;
	buildEnds: { done: number; abandoned: number; last: Line | null };
	cap: Line | null;
	stop: Line | null;
	decisions: Array<{ t: unknown; what: unknown; question: string; choice: unknown; option: string; engine: unknown; ms: unknown; fallback: unknown; agree: unknown; other: unknown }>;
	movement: Array<{ t: unknown; k: unknown; detail: string }>;
}

export type LogSummary = Brain2Summary | BuilderSummary;

/**
 * Summarises a log tail. `firstLine` is the file's first line (the meta/start line, possibly outside
 * the tail); `persisted` is brain2's saved state file (the base the change lines fold onto).
 */
export function summarizeLog(tail: string, firstLine: string | null, persisted: unknown): LogSummary {
	const lines = parseLines(tail);
	const head = firstLine ? parseLines(firstLine)[0] ?? null : null;
	const brain2 = head?.k === 'meta' || lines.some((l) => l.k === 'change' || l.k === 'select');
	if (brain2) return summarizeBrain2(lines, persisted);
	return summarizeBuilder(lines, head?.k === 'start' ? head : null);
}

function summarizeBrain2(lines: Line[], persisted: unknown): Brain2Summary {
	const state: Record<string, unknown> = persisted && typeof persisted === 'object' ? structuredClone(persisted) as Record<string, unknown> : {};
	const selections: Brain2Summary['selections'] = [];
	const events: Brain2Summary['events'] = [];
	for (const l of lines) {
		if (l.k === 'change' && typeof l.path === 'string') setPath(state, l.path, l.new, l.deleted === true);
		else if (l.k === 'select') selections.push({ t: l.t, trigger: l.trigger, winner: l.winner, player: l.player, urgent: l.urgent });
		else if (l.k === 'event') events.push({ t: l.t, kind: l.kind, data: short(l.data) });
	}
	const b = state.behaviour as Record<string, unknown> | null | undefined;
	const relations: Brain2Summary['relations'] = {};
	const rel = state.relations as Record<string, { axes?: unknown }> | undefined;
	for (const [who, r] of Object.entries(rel ?? {})) relations[who] = axes(r?.axes);
	return {
		kind: 'brain2',
		behaviour: b && typeof b === 'object' ? { kind: typeof b.kind === 'string' ? b.kind : null, params: b.params ?? null, step: b.step ?? null, progress: b.progress ?? null, failures: b.failures ?? null, startedT: b.startedT ?? null } : null,
		emotions: axes(state.emotions),
		relations,
		inventory: (state.inventory && typeof state.inventory === 'object' ? state.inventory : {}) as Record<string, unknown>,
		selections: selections.slice(-8).reverse(),
		events: events.slice(-10).reverse(),
	};
}

const MOVEMENT_RE = /fly|stuck|unstick|unreachable/;

function summarizeBuilder(lines: Line[], start: Line | null): BuilderSummary {
	let project: Line | null = null;
	let cap: Line | null = null;
	let stop: Line | null = null;
	let lastEnd: Line | null = null;
	let done = 0;
	let abandoned = 0;
	const decisions: BuilderSummary['decisions'] = [];
	const movement: BuilderSummary['movement'] = [];
	const placedBy = new Map<string, number>();
	for (const l of lines) {
		const k = l.k;
		if (k === 'start') start = l;
		else if (k === 'project' || k === 'lot' || k === 'village' || k === 'plan' || k === 'decoration') project = l;
		else if (k === 'cap-reached') cap = l;
		else if (k === 'stop') stop = l;
		else if (k === 'build-end' || k === 'decoration-end') {
			lastEnd = l;
			if (l.status === 'done') done++;
			else abandoned++;
		} else if (k === 'place' && l.ok === true) {
			const id = typeof l.id === 'string' ? l.id : typeof l.what === 'string' ? l.what : '';
			placedBy.set(id, (placedBy.get(id) ?? 0) + 1);
		} else if (k === 'decision') {
			const p = (l.primary ?? {}) as Record<string, unknown>;
			const s = (l.secondary ?? null) as Record<string, unknown> | null;
			const options = (l.options ?? {}) as Record<string, unknown>;
			const choice = p.choice ?? null;
			decisions.push({
				t: l.t, what: l.what, question: short(l.instructions, 120), choice,
				option: typeof choice === 'string' ? short(options[choice], 100) : '',
				engine: p.engine ?? null, ms: p.ms ?? null, fallback: l.fallback ?? null, agree: l.agree ?? null,
				other: s ? `${String(s.engine)}: ${String(s.choice)}` : null,
			});
		} else if (typeof k === 'string' && MOVEMENT_RE.test(k)) {
			const rest: Record<string, unknown> = { ...l };
			delete rest.k;
			delete rest.t;
			movement.push({ t: l.t, k, detail: short(rest, 140) });
		}
	}
	const pid = project && typeof project.id === 'string' ? project.id : null;
	return {
		kind: 'builder', start, project, placed: pid ? placedBy.get(pid) ?? 0 : [...placedBy.values()].reduce((a, b) => a + b, 0),
		buildEnds: { done, abandoned, last: lastEnd }, cap, stop,
		decisions: decisions.slice(-10).reverse(), movement: movement.slice(-10).reverse(),
	};
}
