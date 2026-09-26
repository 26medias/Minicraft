import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { barCol, renderTui, startTui, type TuiModel } from '../../src/brain2/tui.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { GLOBAL_AXES, type State } from '../../src/brain2/types.js';
import type { LogLine } from '../../src/brain2/log.js';
import { pokeFor } from '../../src/cli.js';

type Select = Extract<LogLine, { k: 'select' }>;
const row = (behaviour: Select['rows'][number]['behaviour'], total: number, masked = false): Select['rows'][number] => ({
	behaviour, emotional: total, social: 0, situational: 0, inertia: 0, recency: 0, bonus: 0, masked, total: masked ? -Infinity : total,
});

function model(over: Partial<State['body']> = {}): TuiModel {
	const s = structuredClone(initialState(PIP, { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 })) as State;
	s.body = { ...s.body, ...over };
	s.relations = { Noah: { axes: { affection: { value: 0.4, band: 'high', deltas: [] }, cooperation: { value: 0, band: 'neutral', deltas: [] }, respect: { value: 0, band: 'neutral', deltas: [] }, grievance: { value: 0, band: 'neutral', deltas: [] } }, metSessions: 2, minutesTogether: 12, lastSeenT: 0 } };
	s.inventory = { stone: 12 };
	const sel: Select = {
		k: 'select', t: 1000, selectionId: 4, trigger: 'appraisal', urgent: false, player: 'Noah', inputs: {} as Select['inputs'],
		rows: [row('follow', 0.2), row('help-build', 0, true), row('build', 0.9), row('mine', 0.5), row('explore', 0.7), row('watch', 0.1), row('rest', -0.2)],
		winner: 'build', params: {},
	};
	return { state: s, lanes: { laya: { running: null, queued: [] }, llm: { running: null, queued: [] } }, health: null, lastSelect: sel, calls: [], now: 5000, world: 'Home', engines: 'code' };
}

describe('renderTui (spec §8)', () => {
	// Red if the halted flag isn't shown in the header.
	it('the header says EDITS HALTED when edits are halted, and engines: code without health', () => {
		expect(renderTui(model(), 200)[0]).not.toMatch(/EDITS HALTED/);
		const h = renderTui(model({ editsHalted: 'rate: 130 edits in 60 s' }), 200)[0];
		expect(h).toMatch(/EDITS HALTED \(rate: 130 edits in 60 s\)/);
		expect(h).toMatch(/engines: code/);
	});

	// Red if the baseline marker is off by one or missing, or an axis has no bar.
	it('one bar per global axis, with the baseline marker at its column', () => {
		const lines = renderTui(model(), 200);
		for (const ax of GLOBAL_AXES) {
			const l = lines.find((x) => x.startsWith(ax));
			expect(l, ax).toBeDefined();
			const bar = /\[(.{20})\]/.exec(l!)![1];
			const col = bar.indexOf('|') + 1;
			expect(col, ax).toBe(barCol(PIP.baselines[ax]));
		}
		// Pip's confidence baseline −0.3: round((−0.3 + 1) / 2 × 19) + 1 = round(6.65) + 1 = 8 (the plan's text says 7;
		// its formula gives 8, and the formula is what this pins).
		expect(barCol(-0.3)).toBe(8);
		expect(barCol(-1)).toBe(1);
		expect(barCol(1)).toBe(20);
	});

	// Red if the rows are printed in ORDER (or by emotional) rather than by total.
	it('the last selection\'s rows are sorted by total, masked last', () => {
		const lines = renderTui(model(), 200);
		const i = lines.findIndex((l) => l.startsWith('select #4'));
		const order = lines.slice(i + 1, i + 8).map((l) => l.trim().split(/\s+/)[0]);
		expect(order).toEqual(['build', 'explore', 'mine', 'follow', 'watch', 'rest', 'help-build']);
	});

	// Red if a line escapes the width.
	it('no line is longer than the width', () => {
		for (const w of [40, 80, 120]) for (const l of renderTui(model({ editsHalted: 'churn: 1,2,3 edited 3× in 10 min' }), w)) expect(l.length).toBeLessThanOrEqual(w);
	});
});

describe('poke keys (spec §8)', () => {
	// Red if a live target gets a poke function, or `p` opens the menu without one.
	it('the poke is refused against a live target', () => {
		const store = new Store(initialState(PIP, { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }), () => 0);
		expect(pokeFor(true, store, () => 0)).toBeUndefined();
		const poke = pokeFor(false, store, () => 1000)!;
		poke({ kind: 'axis', axis: 'mood', value: -0.8 });
		expect(store.state.emotions.mood).toMatchObject({ value: -0.8, band: 'very low' });

		const inp = new PassThrough() as unknown as NodeJS.ReadStream;
		let written = '';
		const out = { columns: 200, write: (s: string) => ((written += s), true) } as unknown as NodeJS.WriteStream;
		const stop = startTui({ model: () => model(), out, inp });
		(inp as unknown as PassThrough).write('p');
		return new Promise<void>((done) => setImmediate(() => {
			stop();
			expect(written).toMatch(/poke refused: live target/);
			expect(written).not.toMatch(/poke: axis/);
			done();
		}));
	});
});
