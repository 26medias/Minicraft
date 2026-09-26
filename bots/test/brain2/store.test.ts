import { describe, expect, it } from 'vitest';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';

const pose = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };

describe('Store (spec §3)', () => {
	// Red if apply mutates without recording: replay would diverge from the live run.
	it('every mutation yields one change event with old, new and cause', () => {
		const clock = new ManualClock(1000);
		const s = new Store(initialState(PIP, pose), clock.now);
		const seen: string[] = [];
		s.subscribe((cs) => cs.forEach((c) => seen.push(`${c.path}:${String(c.old)}→${String(c.new)}:${c.cause.kind}`)));
		const out = s.apply([{ path: ['inventory', 'stone'], value: 3 }], { kind: 'behaviour', by: 'mine' });
		expect(out).toHaveLength(1);
		expect(seen).toEqual(['inventory.stone:undefined→3:behaviour']);
		expect(out[0].t).toBe(1000);
	});
	// Red if no-op writes emit events: every expert keyed on changes would re-fire forever.
	it('a write of the same value is not a change and does not bump version', () => {
		const s = new Store(initialState(PIP, pose), new ManualClock().now);
		s.apply([{ path: ['inventory', 'stone'], value: 3 }], { kind: 'behaviour', by: 't' });
		const v = s.state.version;
		expect(s.apply([{ path: ['inventory', 'stone'], value: 3 }], { kind: 'behaviour', by: 't' })).toEqual([]);
		expect(s.state.version).toBe(v);
	});
	// Red if version bumps once per op instead of once per apply: a no-op alongside a real op would double-bump.
	it('a patch with one no-op and one real op bumps version once and emits only the real change', () => {
		const s = new Store(initialState(PIP, pose), new ManualClock().now);
		s.apply([{ path: ['inventory', 'stone'], value: 3 }], { kind: 'behaviour', by: 't' });
		const v = s.state.version;
		const out = s.apply(
			[
				{ path: ['inventory', 'stone'], value: 3 }, // no-op: already 3
				{ path: ['inventory', 'wood'], value: 5 },  // real change
			],
			{ kind: 'behaviour', by: 't' },
		);
		expect(out).toHaveLength(1);
		expect(out[0].path).toBe('inventory.wood');
		expect(s.state.version).toBe(v + 1);
	});
	it('undefined deletes a key', () => {
		const s = new Store(initialState(PIP, pose), new ManualClock().now);
		s.apply([{ path: ['owned', '1,2,3'], value: 5 }], { kind: 'body', by: 't' });
		s.apply([{ path: ['owned', '1,2,3'], value: undefined }], { kind: 'body', by: 't' });
		expect('1,2,3' in s.state.owned).toBe(false);
	});
	// Red if state is handed out mutable (initially OR after an apply): an expert could bypass apply.
	it('state is frozen, before and after apply', () => {
		const s = new Store(initialState(PIP, pose), new ManualClock().now);
		expect(() => {
			(s.state.inventory as Record<string, number>).x = 1;
		}).toThrow();
		s.apply([{ path: ['inventory', 'stone'], value: 1 }], { kind: 'behaviour', by: 't' });
		expect(() => {
			(s.state.inventory as Record<string, number>).stone = 9;
		}).toThrow();
	});
	it('initial emotions sit at the personality baselines, band set', () => {
		const st = initialState(PIP, pose);
		expect(st.emotions.confidence.value).toBe(PIP.baselines.confidence);
		expect(st.emotions.mood.band).toBe('neutral');
	});
});
