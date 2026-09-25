/**
 * The status line (spec §6, §12a, §12b), printed every `statusEveryMs`: what the bot is doing and for
 * whom, the brain, how often it fell back to the script, edits used out of the budget, hops, any
 * active stop ("paused near Noah 9m"), and `SCRIPTED-FALLBACK` once the brain was given up for the
 * session.
 */
import type { Candidate } from '../types.js';

export interface Status {
	name: string;
	action: Candidate | null;
	target: string | null;
	/** The follow mode while following (`walk`, `fly`, `land`). */
	mode: string | null;
	switchedFrom: { name: string; idleMs: number } | null;
	brain: string;
	/** The brain was given up after 5 failures in a row: scripted for the rest of the session. */
	scriptedSession: boolean;
	fallbacks: number;
	editsUsed: number;
	editBudget: number;
	hops: number;
	stops: { name: string; remainingMs: number }[];
}

function doing(s: Status): string {
	const who = s.target ?? 'no one';
	let text: string;
	switch (s.action) {
		case 'follow':
			text = `following ${who}${s.mode ? ` (${s.mode})` : ''}`;
			break;
		case 'watch':
			text = `watching ${who}`;
			break;
		case 'help_build':
			text = `building with ${who}`;
			break;
		case 'wander':
			text = 'wandering';
			break;
		case 'idle':
			text = 'waiting';
			break;
		default:
			text = 'starting';
	}
	if (s.target && s.switchedFrom) text += ` (switched: ${s.switchedFrom.name} idle ${Math.floor(s.switchedFrom.idleMs / 1000)}s)`;
	return text;
}

export function formatStatus(s: Status): string {
	const parts = [`${s.name}: ${doing(s)}`, `brain ${s.brain}`, `fallbacks ${s.fallbacks}`, `edits ${s.editsUsed}/${s.editBudget}`, `hops ${s.hops}`];
	for (const stop of s.stops) parts.push(`paused near ${stop.name} ${Math.ceil(stop.remainingMs / 60_000)}m`);
	if (s.scriptedSession) parts.push('SCRIPTED-FALLBACK');
	return parts.join(' | ');
}
