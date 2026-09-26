import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appraisalPrompts, fewShotBlock, fewShotExamples, fitPrompt, socialPrompt, type AppraisalCase, type FitCase, type SituationalCase, type SocialCase } from '../../bench/prompts.js';
import { BUSY_NAMES, assertBudget, parseAxis, words } from '../../src/brain2/render.js';

/**
 * Task 19: the benchmark's labelled cases (spec §9.2) are well-formed. No models here: the run itself is measured,
 * not CI. Red if a case file is unbalanced, loses a gate case, or a prompt is over budget or leaks a name.
 */

const casesDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'bench/cases');
const load = <T>(f: string): T[] => JSON.parse(readFileSync(join(casesDir, f), 'utf8')) as T[];
const appraisal = load<AppraisalCase>('appraisal.json');
const social = load<SocialCase>('social.json');
const fit = load<FitCase>('fit.json');
const situational = load<SituationalCase>('situational.json');
const KINDS = ['follow', 'help-build', 'build', 'mine', 'explore', 'watch', 'rest'];

describe('appraisal cases (spec §9.2)', () => {
	it('has 63 cases, 21 per class', () => {
		expect(appraisal).toHaveLength(63);
		for (const c of ['down', 'stay', 'up']) expect(appraisal.filter((x) => x.expected === c)).toHaveLength(21);
	});

	it('every axis is valid, and every case has a value band and 1–3 events', () => {
		for (const c of appraisal) {
			expect(parseAxis(c.axis), c.id).not.toBeNull();
			expect(['very low', 'low', 'neutral', 'high', 'very high']).toContain(c.value);
			expect(c.events.length, c.id).toBeGreaterThanOrEqual(1);
			expect(c.events.length, c.id).toBeLessThanOrEqual(3);
			expect(Array.isArray(c.lastDeltas)).toBe(true);
		}
	});

	it('has no duplicate ids, across every case file', () => {
		const ids = [...appraisal, ...social, ...fit, ...situational].map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('includes the 12 gate cases g01–g12', () => {
		const ids = new Set(appraisal.map((c) => c.id));
		for (let i = 1; i <= 12; i++) expect(ids.has(`g${String(i).padStart(2, '0')}`)).toBe(true);
	});

	// Red if a renderer leaks the busy state into a prompt, or a wording grows past the 60-word budget.
	it('every appraisal prompt passes assertBudget(60), naming only Noah (few-shot: 60 plus its fixed example block)', () => {
		for (const c of appraisal) {
			const ps = appraisalPrompts(c, appraisal);
			expect(ps.map((p) => p.name)).toEqual(['laya-3way', 'laya-hi', 'laya-lo', 'llm', 'llm-fewshot']);
			for (const p of ps) assertBudget(p.text, p.name === 'llm-fewshot' ? 60 + words(fewShotBlock(c, appraisal)) : 60, ['Noah'], BUSY_NAMES);
		}
	});

	it('few-shot has 4 examples from the bench cases, one of them stay, and never the case itself', () => {
		for (const c of appraisal) {
			const ex = fewShotExamples(c, appraisal);
			expect(ex).toHaveLength(4);
			expect(ex.filter((e) => e.expected === 'stay')).toHaveLength(1);
			expect(ex.map((e) => e.id)).not.toContain(c.id);
		}
	});
});

describe('social, fit and situational cases', () => {
	it('has 10 social, 8 fit and 8 situational cases', () => {
		expect(social).toHaveLength(10);
		expect(fit).toHaveLength(8);
		expect(situational).toHaveLength(8);
	});

	it('labels are in range', () => {
		for (const c of social) {
			expect(['near', 'help']).toContain(c.question);
			expect(['no', 'maybe', 'yes']).toContain(c.expected);
		}
		for (const c of fit) expect(['no', 'wait', 'yes']).toContain(c.expected);
		for (const c of situational) {
			expect(c.acceptable.length).toBeGreaterThan(0);
			for (const k of c.acceptable) expect(KINDS).toContain(k);
		}
	});

	it('social and fit prompts are ≤ 60 words and name only their kid (spec §5.3, §7.1)', () => {
		for (const c of social) assertBudget(socialPrompt(c).text, 60, [c.kid], BUSY_NAMES);
		for (const c of fit) assertBudget(fitPrompt(c).text, 60, [c.kid.name], BUSY_NAMES);
	});
});
