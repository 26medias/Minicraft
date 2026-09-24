// Multiplayer plan task C7, T9 (spec §7.4): the leaving countdown sends each threshold once, even
// when a 2 s tick jumps over it; joining late sends the real value once and marks passed thresholds.
import { describe, it, expect } from 'vitest';
import { LeavingCountdown, leavingText } from './leaving';

function run(startS: number, stepS: number, endS: number): number[] {
	const sent: number[] = [];
	const c = new LeavingCountdown((s) => sent.push(s));
	for (let s = startS; s >= endS; s -= stepS) c.update(s * 1000);
	return sent;
}

describe('LeavingCountdown (T9)', () => {
	it('stepping down from 130 s in 2 s steps sends exactly [120, 60, 30, 0]', () => {
		expect(run(130, 2, -4)).toEqual([120, 60, 30, 0]);
	});

	it('a step that jumps 121 → 119 still sends 120 once (catches exact-second matching)', () => {
		expect(run(131, 2, -5)).toEqual([120, 60, 30, 0]);
	});

	it('never sends a threshold twice while time stays below it', () => {
		const sent: number[] = [];
		const c = new LeavingCountdown((s) => sent.push(s));
		c.update(125_000);
		c.update(119_000);
		c.update(119_000);
		c.update(118_000);
		c.update(0);
		c.update(0);
		c.update(-2_000);
		expect(sent).toEqual([120, 0]);
	});

	it('a first update at 90 s sends [90] now, then 60, 30, 0; never 120 (catches unmarked passed thresholds)', () => {
		expect(run(90, 2, -2)).toEqual([90, 60, 30, 0]);
	});

	it('a first update at or above 120 s sends nothing immediately', () => {
		const sent: number[] = [];
		const c = new LeavingCountdown((s) => sent.push(s));
		c.update(300_000);
		expect(sent).toEqual([]);
		c.update(120_000);
		expect(sent).toEqual([120]);
	});

	it('a first update sends the real value, rounded up', () => {
		const sent: number[] = [];
		const c = new LeavingCountdown((s) => sent.push(s));
		c.update(44_200);
		expect(sent).toEqual([45]);
		c.update(29_000);
		expect(sent).toEqual([45, 30]);
	});

	it('a tick that crosses several thresholds at once sends only the lowest', () => {
		const sent: number[] = [];
		const c = new LeavingCountdown((s) => sent.push(s));
		c.update(200_000);
		c.update(50_000);
		expect(sent).toEqual([60]);
		c.update(0);
		expect(sent).toEqual([60, 0]);
	});
});

describe('leavingText', () => {
	it('names the time left for any secondsLeft', () => {
		expect(leavingText('Noah', 120)).toBe('Noah has to go in 2 minutes');
		expect(leavingText('Noah', 90)).toBe('Noah has to go in 2 minutes');
		expect(leavingText('Noah', 89)).toBe('Noah has to go in 1 minute');
		expect(leavingText('Noah', 60)).toBe('Noah has to go in 1 minute');
		expect(leavingText('Noah', 45)).toBe('Noah has to go in 1 minute');
		expect(leavingText('Noah', 44)).toBe('Noah has to go in 30 seconds');
		expect(leavingText('Noah', 30)).toBe('Noah has to go in 30 seconds');
		expect(leavingText('Noah', 1)).toBe('Noah has to go in 30 seconds');
		expect(leavingText('Noah', 0)).toBe('Noah went home');
	});
});
