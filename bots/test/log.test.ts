import { describe, expect, it } from 'vitest';
import { DECISION_KEYS, decisionLine, eventLine, jsonlLogger } from '../src/body/log.js';
import type { DecisionEntry } from '../src/body/log.js';
import { formatStatus } from '../src/body/status.js';
import type { Status } from '../src/body/status.js';
import type { Snapshot } from '../src/types.js';

/**
 * Task 4: the decision log's schema (spec §6 step 5) and the status line (§6, §12a, §12b).
 */

const SNAPSHOT: Snapshot = {
	nowMs: 5000,
	followDist: 2,
	bot: { pose: { x: 1, y: 64, z: 2, yaw: 0, pitch: 0 }, lastActions: ['watch'] },
	target: null,
	others: [],
	stopActiveForTarget: false,
	switchedFrom: null,
};

function entry(over: Partial<DecisionEntry> = {}): DecisionEntry {
	return {
		seed: 9,
		tick: 3,
		t: 5000,
		snapshot: SNAPSHOT,
		text: 'No one is here.\nYou last waited.',
		candidates: ['wander', 'idle'],
		brain: 'scripted',
		raw: null,
		action: 'idle',
		reason: 'scripted',
		result: 'idle',
		latency: 0,
		...over,
	};
}

describe('the decision log', () => {
	it('has exactly the schema keys: seed, tick, t, snapshot, text, candidates, brain, raw, action, reason, result, latency', () => {
		expect([...DECISION_KEYS]).toEqual(['seed', 'tick', 't', 'snapshot', 'text', 'candidates', 'brain', 'raw', 'action', 'reason', 'result', 'latency']);
	});

	it('writes one JSON object per line, keys in schema order, round-tripping the entry', () => {
		const e = entry({ raw: { type: 'choice', best: 'idle', probs: { idle: 1 }, confidence: 1 } });
		const line = decisionLine(e);
		expect(line.endsWith('\n')).toBe(true);
		// A newline inside the text is escaped: still one line.
		expect(line.indexOf('\n')).toBe(line.length - 1);
		const parsed = JSON.parse(line) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual([...DECISION_KEYS]);
		expect(parsed).toEqual(e);
	});

	it('keeps a missing field as null instead of dropping the key', () => {
		const e = entry();
		delete (e as Partial<DecisionEntry>).raw;
		const parsed = JSON.parse(decisionLine(e)) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual([...DECISION_KEYS]);
		expect(parsed.raw).toBeNull();
	});

	it('writes events as their own lines, with the seed and the clock', () => {
		const lines: string[] = [];
		const log = jsonlLogger((l) => lines.push(l), 9, () => 1234);
		log.decision(entry());
		log.event('stop', { kid: 'Noah' });
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1])).toEqual({ seed: 9, t: 1234, event: 'stop', kid: 'Noah' });
		expect(eventLine(1, 2, 'x')).toBe('{"seed":1,"t":2,"event":"x"}\n');
	});
});

describe('the status line', () => {
	const base: Status = {
		name: 'Robo',
		action: 'follow',
		target: 'Noah',
		mode: 'fly',
		switchedFrom: null,
		brain: 'laya',
		scriptedSession: false,
		fallbacks: 3,
		editsUsed: 4,
		editBudget: 50,
		hops: 1,
		stops: [],
	};

	it('shows what it does, the brain, fallbacks, edits used / budget and hops', () => {
		expect(formatStatus(base)).toBe('Robo: following Noah (fly) | brain laya | fallbacks 3 | edits 4/50 | hops 1');
	});

	it('shows "paused near <kid> <min>m" for each active stop, rounded up', () => {
		const line = formatStatus({ ...base, stops: [{ name: 'Noah', remainingMs: 8 * 60_000 + 1 }] });
		expect(line).toContain('paused near Noah 9m');
	});

	it('shows the target switch and SCRIPTED-FALLBACK', () => {
		const line = formatStatus({ ...base, action: 'watch', switchedFrom: { name: 'Julien', idleMs: 30_500 }, scriptedSession: true });
		expect(line).toContain('watching Noah (switched: Julien idle 30s)');
		expect(line.endsWith('SCRIPTED-FALLBACK')).toBe(true);
	});
});
