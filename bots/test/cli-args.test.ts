import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli-args.js';

describe('parseArgs', () => {
	it('parses value and boolean flags', () => {
		const args = parseArgs(['--target', 'local', '--world', 'Home', '--name', 'Robo', '--skin', 'jj', '--brain', 'scripted', '--no-edits', '--revert-on-exit', '--i-deployed-the-server', '--personality', 'rex', '--builds', '--tui']);
		expect(args).toEqual({
			target: 'local',
			world: 'Home',
			name: 'Robo',
			skin: 'jj',
			brain: 'scripted',
			noEdits: true,
			revertOnExit: true,
			iDeployedTheServer: true,
			personality: 'rex',
			builds: true,
			tui: true,
			compare: false,
			jev: false,
		});
	});

	it('defaults booleans to false and leaves value flags undefined when absent', () => {
		const args = parseArgs([]);
		expect(args).toEqual({ noEdits: false, revertOnExit: false, iDeployedTheServer: false, builds: false, tui: false, compare: false, jev: false });
	});

	it('throws on an unknown flag', () => {
		expect(() => parseArgs(['--not-a-real-flag'])).toThrow(/unknown flag/);
	});

	it('throws when a value flag is missing its value', () => {
		expect(() => parseArgs(['--target'])).toThrow(/needs a value/);
	});
});
