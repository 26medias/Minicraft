import type { Spiral } from './behaviours/spiral.js';

export type Vec3 = { x: number; y: number; z: number };
export const GLOBAL_AXES = ['mood', 'confidence', 'trust', 'affection', 'curiosity', 'patience', 'outlook', 'stimulation'] as const;
export type GlobalAxis = (typeof GLOBAL_AXES)[number];
export const RELATION_AXES = ['affection', 'cooperation', 'respect', 'grievance'] as const;
export type RelationAxis = (typeof RELATION_AXES)[number];
/** 'mood' or 'rel.<player>.<axis>'. */
export type AxisId = GlobalAxis | `rel.${string}.${RelationAxis}`;
export type Band = 'very low' | 'low' | 'neutral' | 'high' | 'very high';
export interface Delta { amount: number; cause: string; t: number; appraisalId: number }
export interface AxisState { value: number; band: Band; deltas: Delta[] }   // pendingDrift is private to the decay expert (spec §4.1, rev 3.3)
export interface Relation { axes: Record<RelationAxis, AxisState>; metSessions: number; minutesTogether: number; lastSeenT: number }
export type BehaviourKind = 'follow' | 'help-build' | 'build' | 'mine' | 'explore' | 'watch' | 'rest';
export type Outcome = 'done' | 'abandoned' | 'interrupted' | 'failed' | 'paused';
export interface ActionEntry { behaviour: BehaviourKind; params: Record<string, unknown>; lastedMs: number; outcome: Outcome; why: string; endedT: number }  // endedT: internal (recency), never rendered to models
export type WorldEventKind =
	| 'placed' | 'broke' | 'player-near' | 'player-arrived' | 'player-gone' | 'broke-my-block' | 'added-to-my-build'
	| 'line-started' | 'looking-at-me' | 'following-me' | 'found' | 'need' | 'stuck' | 'hazard' | 'outcome';
export interface WorldEvent { id: number; kind: WorldEventKind; t: number; player?: string; cell?: Vec3; block?: string; detail?: string; salient: boolean }
export interface Build { id: string; template: string; variant: 'small' | 'medium'; origin: Vec3; cells: Array<{ cell: Vec3; block: string }>; status: 'planned' | 'building' | 'done' | 'reverted' | 'dismantled' }
/** cells: 'x,y,z' the dig broke or filled; spiral: the staircase geometry, persisted to resume (spec §6.2). */
export interface Dig { id: string; block: string; entrance: Vec3; target: Vec3; stepsDone: number; cells: string[]; status: 'active' | 'paused' | 'done' | 'reverted' | 'dropped'; spiral: Spiral }
export type Action =
	| { kind: 'place'; cell: Vec3; block: string; free?: boolean }
	| { kind: 'break'; cell: Vec3 }
	| { kind: 'mine'; cell: Vec3 }
	| { kind: 'walk'; to: { x: number; z: number }; speed: number }
	| { kind: 'fly'; to: Vec3 }
	| { kind: 'look'; at: Vec3 }
	| { kind: 'wait'; ms: number }
	/** One tick of today's standing-intent follow controller, driven by the runner (Follow). Never an edit. */
	| { kind: 'follow-tick'; kid: string };
export const EDIT_KINDS = new Set<Action['kind']>(['place', 'break', 'mine']);
export interface ActiveBehaviour { kind: BehaviourKind; params: Record<string, unknown>; startedT: number; step: number; rejections: number; failures: number; plannedEdits: number; progress: string; lastResults: boolean[] }  // lastResults: the last 3 executed actions' success (keep-going, spec §5.3)
/** A selection in flight (spec §5.3): the request writes it, social and situational answer it, merge marks it done. */
export interface Selection {
	id: number; t: number; trigger: string; urgent: boolean;
	social: Record<string, { near: number; help: number }> | null;            // per kid; null = not answered yet
	situational: { behaviour: BehaviourKind; params: Record<string, unknown>; because: string } | 'none' | null;
	done: boolean;
}
export interface Personality {
	name: string;
	summary: string; // ≤ 8 words, used in prompts
	baselines: Record<GlobalAxis, number>;
	halfLifeMs: Record<GlobalAxis, number>;
	relationHalfLifeMs: Record<RelationAxis, number>;
	favouriteTemplate?: string;
	favouriteBlock?: string;
	preferredDistance: number;
}
export interface State {
	personality: Personality;
	emotions: Record<GlobalAxis, AxisState>;
	relations: Record<string, Relation>;
	memory: { current: (ActionEntry & { startedT: number }) | null; past: ActionEntry[] };
	events: WorldEvent[];
	inventory: Record<string, number>;
	builds: Build[];
	digs: Dig[];
	owned: Record<string, number>;    // 'x,y,z' → block id the bot wrote
	explored: Record<string, true>;   // 'cx,cz'
	body: { pose: { x: number; y: number; z: number; yaw: number; pitch: number }; gesture: string | null; editsHalted: string | null };
	behaviour: ActiveBehaviour | null;
	selection: Selection | null;
	version: number;
}
