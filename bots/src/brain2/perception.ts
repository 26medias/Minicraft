/**
 * Perception v2 (spec §4.4, §5.1): world events from foreign edits and player poses, bucketed salience,
 * and relation bookkeeping (spec §4.2). The bot's own edits, and other bots', are never events.
 */
import { EYE_HEIGHT } from 'minicraft-bot';
import { createPerception, perceive, type PerceptionTuning } from '../body/perceive.js';
import type { Body, WorldView } from '../port.js';
import type { EditEvent, KidInfo } from '../types.js';
import type { Clock } from './clock.js';
import type { Ownership } from './ownership.js';
import type { Patch, Store } from './store.js';
import { RELATION_AXES, type Relation, type RelationAxis, type Vec3, type WorldEvent } from './types.js';
import { SALIENCE, bucket } from './data/salience.data.js';

export interface Perceiver { kids(): KidInfo[]; tick(now: number): Patch; close(): void }
type Raw = Omit<WorldEvent, 'id' | 'salient'>;

const EYE = EYE_HEIGHT, CHEST = 0.9;
const hdist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
export function viewDir(yaw: number, pitch: number): Vec3 {
	return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
}
function angleDeg(a: Vec3, b: Vec3): number {
	const la = Math.hypot(a.x, a.y, a.z), lb = Math.hypot(b.x, b.y, b.z);
	return (Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb)))) * 180) / Math.PI;
}
function newRelation(now: number): Relation {
	const axis = (): Relation['axes'][RelationAxis] => ({ value: 0, band: 'neutral', deltas: [] });
	return { axes: Object.fromEntries(RELATION_AXES.map((a) => [a, axis()])) as Relation['axes'], metSessions: 1, minutesTogether: 0, lastSeenT: now };
}

export function createPerceiver(d: { body: Body; world: WorldView; own: Ownership; store: Store; tuning: PerceptionTuning; clock: Clock; stopStartedAt?: (kid: string) => number | null }): Perceiver {
	const legacy = createPerception(d.body, { tuning: d.tuning, clock: d.clock });
	const edits: EditEvent[] = [];
	const offEdit = d.body.onEdit((e) => edits.push(e));
	let present = new Set<string>();
	const near = new Set<string>();
	const lineKeys = new Set<string>();
	const gaze = new Map<string, number>();
	const gazeFired = new Set<string>();
	const follow = new Map<string, { since: number; kidFrom: Vec3; botFrom: Vec3 }>();
	const lastFollow = new Map<string, number>();
	const recent = new Map<string, number[]>();
	const lastBucket = new Map<string, number>();
	let kids: KidInfo[] = [];
	let lastT = d.clock();

	return {
		kids: () => kids,
		close: () => {
			offEdit();
			legacy.unsubscribe();
		},
		tick(now: number): Patch {
			const s = d.store.state;
			const bot = d.body.pose();
			const raw: Raw[] = [];
			const patch: Patch = [];
			// 1. Foreign, non-bot edits.
			for (const e of edits.splice(0)) {
				if (e.by === d.body.you || e.byBot || !e.byName) continue;
				for (const c of e.cells) {
					const k = `${c.x},${c.y},${c.z}`;
					const cell = { x: c.x, y: c.y, z: c.z };
					const mine = s.owned[k];
					if (mine !== undefined && c.oldId === mine && c.newId !== mine) {
						const st = d.stopStartedAt?.(e.byName) ?? null;
						raw.push({ kind: 'broke-my-block', t: now, player: e.byName, cell, detail: st !== null && now - st <= 1000 ? 'stop' : undefined });
					}
					raw.push({ kind: c.newId !== 0 ? 'placed' : 'broke', t: now, player: e.byName, cell, block: d.world.blockName(c.newId !== 0 ? c.newId : (c.oldId ?? 0)) ?? undefined });
					if (c.newId !== 0 && s.builds.some((b) => (b.status === 'building' || b.status === 'done') && nextToBuild(b.cells.map((x) => x.cell), cell))) {
						raw.push({ kind: 'added-to-my-build', t: now, player: e.byName, cell });
					}
				}
				patch.push(...d.own.onEdit(e, d.body.you));
			}
			patch.push(...d.own.drainPending());
			// 2. Players.
			const { snapshot } = perceive(legacy, d.body, d.world, now);
			kids = [snapshot.target, ...snapshot.others].filter((k): k is KidInfo => k !== null);
			const names = new Set(kids.map((k) => k.name));
			for (const n of names) if (!present.has(n)) {
				raw.push({ kind: 'player-arrived', t: now, player: n });
				if (!s.relations[n]) patch.push({ path: ['relations', n], value: newRelation(now) });
			}
			for (const n of present) if (!names.has(n)) {
				raw.push({ kind: 'player-gone', t: now, player: n });
				near.delete(n);
			}
			present = names;
			const dtMin = (now - lastT) / 60_000;
			lastT = now;
			for (const k of kids) {
				const close = hdist(k.pose, bot) <= SALIENCE.NEAR;
				if (close && !near.has(k.name)) raw.push({ kind: 'player-near', t: now, player: k.name });
				if (close) near.add(k.name); else near.delete(k.name);
				const rel = s.relations[k.name];
				if (rel && close) {
					patch.push({ path: ['relations', k.name, 'minutesTogether'], value: rel.minutesTogether + dtMin });
					patch.push({ path: ['relations', k.name, 'lastSeenT'], value: now });
				}
				// 3a. line-started (today's detector conditions, without aim/hold).
				const pl = k.placements;
				if (pl.length >= 3) {
					const [a, b, c0] = pl.slice(-3);
					const dv = { x: b.cell.x - a.cell.x, y: b.cell.y - a.cell.y, z: b.cell.z - a.cell.z };
					const unit = Math.abs(dv.x) + Math.abs(dv.y) + Math.abs(dv.z) === 1;
					const same = a.block === b.block && b.block === c0.block;
					const straight = c0.cell.x - b.cell.x === dv.x && c0.cell.y - b.cell.y === dv.y && c0.cell.z - b.cell.z === dv.z;
					const quick = a.ageMs - b.ageMs <= 4000 && b.ageMs - c0.ageMs <= 4000 && c0.ageMs < 4000;
					const next = { x: c0.cell.x + dv.x, y: c0.cell.y + dv.y, z: c0.cell.z + dv.z };
					const lineId = `${k.name}|${dv.x},${dv.y},${dv.z}|${a.block}`;
					const armed = (c: Vec3) => `${lineId}|next|${c.x},${c.y},${c.z}`;
					if (unit && same && straight && quick) {
						if (lineKeys.has(armed(c0.cell))) {
							lineKeys.add(armed(next)); // extends a line already announced: re-arm, no event
						} else if (!lineKeys.has(armed(next))) {
							lineKeys.add(armed(next));
							raw.push({ kind: 'line-started', t: now, player: k.name, cell: next, block: a.block, detail: JSON.stringify({ next, d: dv, block: a.block }) });
						}
					}
				}
				// 3b. looking-at-me.
				const eye = { x: k.pose.x, y: k.pose.y + EYE, z: k.pose.z };
				const toBot = { x: bot.x - eye.x, y: bot.y + CHEST - eye.y, z: bot.z - eye.z };
				const looking = Math.hypot(toBot.x, toBot.y, toBot.z) <= SALIENCE.LOOK_RANGE && angleDeg(viewDir(k.pose.yaw, k.pose.pitch), toBot) <= SALIENCE.LOOK_CONE_DEG;
				if (looking) {
					const since = gaze.get(k.name) ?? now;
					gaze.set(k.name, since);
					if (now - since >= SALIENCE.LOOK_HOLD_MS && !gazeFired.has(k.name)) {
						gazeFired.add(k.name);
						raw.push({ kind: 'looking-at-me', t: now, player: k.name });
					}
				} else {
					gaze.delete(k.name);
					gazeFired.delete(k.name);
				}
				// 3c. following-me.
				if (hdist(k.pose, bot) <= SALIENCE.FOLLOW_RANGE) {
					const f = follow.get(k.name) ?? { since: now, kidFrom: { ...k.pose }, botFrom: { ...bot } };
					follow.set(k.name, f);
					const moved = hdist(f.kidFrom, k.pose) >= SALIENCE.FOLLOW_MOVE && hdist(f.botFrom, bot) >= SALIENCE.FOLLOW_MOVE;
					if (now - f.since >= SALIENCE.FOLLOW_HOLD_MS && moved && now - (lastFollow.get(k.name) ?? -Infinity) >= SALIENCE.FOLLOW_EVERY_MS) {
						lastFollow.set(k.name, now);
						raw.push({ kind: 'following-me', t: now, player: k.name });
						follow.delete(k.name);
					}
				} else follow.delete(k.name);
			}
			// 4. Salience and retention.
			const fresh: WorldEvent[] = raw.map((ev) => ({ ...ev, id: d.store.nextEventId(), salient: salient(ev, bot, now) }));
			if (fresh.length === 0 && s.events.every((e) => now - e.t <= SALIENCE.KEEP_MS)) return patch;
			const kept = [...s.events, ...fresh].filter((e) => now - e.t <= SALIENCE.KEEP_MS).slice(-SALIENCE.KEEP_MAX);
			patch.push({ path: ['events'], value: kept });
			return patch;
		},
	};

	function salient(ev: Raw, bot: Vec3, now: number): boolean {
		if (SALIENCE.ALWAYS.includes(ev.kind)) return true;
		if (!SALIENCE.BUCKETED.includes(ev.kind) || !ev.player) return false;
		if (ev.kind !== 'added-to-my-build' && (!ev.cell || hdist(ev.cell, bot) > SALIENCE.NEAR)) return false;
		const ts = (recent.get(ev.player) ?? []).filter((t) => now - t <= SALIENCE.BUCKET_WINDOW_MS);
		ts.push(now);
		recent.set(ev.player, ts);
		const b = bucket(ts.length);
		const changed = b !== (lastBucket.get(ev.player) ?? 0);
		lastBucket.set(ev.player, b);
		return changed;
	}
}

function nextToBuild(cells: Vec3[], c: Vec3): boolean {
	if (cells.length === 0) return false;
	const xs = cells.map((p) => p.x), ys = cells.map((p) => p.y), zs = cells.map((p) => p.z);
	const inBox = c.x >= Math.min(...xs) - 1 && c.x <= Math.max(...xs) + 1 && c.y >= Math.min(...ys) - 1 && c.y <= Math.max(...ys) + 1 && c.z >= Math.min(...zs) - 1 && c.z <= Math.max(...zs) + 1;
	return inBox && cells.some((p) => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) + Math.abs(p.z - c.z) === 1);
}
