import { describe, expect, it } from 'vitest';
import {
	botArgs, isLegacyUnit, isLogOf, isPanelUnit, isStoppableUnit, isValidName, isValidSkin, parseAvailableCommands, parseUnitCommand,
	parseWorlds, summarizeLog, systemdRunArgv, unitFor, validateStart, type StartSpec,
} from '../panel/lib.js';

const WORLD = '6d4d7631-8bd4-4cc1-a949-76f987b2c2d3';
const CTX = { types: ['companion', 'builder', 'decorator', 'village', 'helper', 'architect', 'foreman'], whenSupported: false };
const ENV = { worktree: '/w', nodeDir: '/n/bin', npm: '/n/bin/npm' };

describe('unit whitelist', () => {
	it('never lets the server or the tunnel through', () => {
		for (const u of ['minicraft-server', 'minicraft-tunnel', 'minicraft-server.service', 'minicraft-tunnel.service']) {
			expect(isStoppableUnit(u)).toBe(false);
			expect(isPanelUnit(u)).toBe(false);
			expect(isLegacyUnit(u)).toBe(false);
		}
	});
	it('accepts mcbot-<slug> and legacy minicraft-<bot>, rejects the rest', () => {
		expect(isPanelUnit('mcbot-enderman-3')).toBe(true);
		expect(isLegacyUnit('minicraft-archie')).toBe(true);
		expect(isPanelUnit('minicraft-archie')).toBe(false);
		for (const u of ['netmon-web', 'mcbot-', 'mcbot-A', 'mcbot-x;rm -rf', 'mcbot-../x', '--all', 'mcbot-x y', 'mcbot-x.service', '', 42, null]) {
			expect(isStoppableUnit(u)).toBe(false);
		}
	});
	it('unitFor slugs the name', () => {
		expect(unitFor('Enderman 3')).toBe('mcbot-enderman-3');
		expect(isPanelUnit(unitFor('Milo the noob'))).toBe(true);
	});
});

describe('name and skin validation', () => {
	it('names follow the server rule', () => {
		for (const n of ['Pip', 'Enderman 3', 'Milo the noob', 'a', 'ABCDEFGHIJKLMNOP']) expect(isValidName(n)).toBe(true);
		for (const n of ['', ' ', ' Pip', 'Pip ', 'ABCDEFGHIJKLMNOPQ', 'Pip!', 'Pip;ls', 'Pîp', '--name', 3]) expect(isValidName(n)).toBe(false);
	});
	it('skins come from SKIN_IDS', () => {
		expect(isValidSkin('enderman')).toBe(true);
		expect(isValidSkin('steve')).toBe(false);
	});
});

describe('argv builder', () => {
	it('a companion start is one argv array with the expected flags and no shell strings', () => {
		const spec = validateStart({ type: 'companion', name: 'Enderman 3', skin: 'enderman', target: 'live', world: WORLD, personality: 'rex', jev: true }, CTX) as StartSpec;
		expect('error' in spec).toBe(false);
		const argv = systemdRunArgv(spec, ENV);
		expect(argv.slice(0, 3)).toEqual(['systemd-run', '--user', '--unit=mcbot-enderman-3']);
		expect(argv).toContain('--property=StartLimitBurst=5');
		const tail = argv.slice(argv.indexOf('--') + 1);
		expect(tail).toEqual(['companion', '--target', 'live', '--world', WORLD, '--name', 'Enderman 3', '--skin', 'enderman', '--brain', 'v2', '--personality', 'rex', '--jev', '--i-deployed-the-server']);
		// No element is a shell command line: the name stays one argv element, nothing is quoted or joined.
		for (const a of argv) expect(a).not.toMatch(/["'`$;|&<>]/);
		expect(argv.some((a) => a === 'sh' || a === '-c' || a === 'bash')).toBe(false);
	});
	it('builder family: brain, compare, cap, join-plan; local target has no live flag', () => {
		const spec = validateStart({ type: 'builder', name: 'Snaky', skin: 'mikey', target: 'local', world: WORLD, brain: 'laya', compare: true, max: '20', joinPlan: true }, CTX) as StartSpec;
		expect(botArgs(spec)).toEqual(['builder', '--target', 'local', '--world', WORLD, '--name', 'Snaky', '--skin', 'mikey', '--brain', 'laya', '--compare', '--max-builds', '20', '--join-plan']);
		const dec = validateStart({ type: 'decorator', name: 'Decky', skin: 'jj', target: 'live', world: WORLD, brain: 'jev', max: 5 }, CTX) as StartSpec;
		expect(botArgs(dec)).toContain('--max-decorations');
	});
	it('rejects anything off the whitelist', () => {
		const base = { type: 'builder', name: 'Snaky', skin: 'mikey', target: 'live', world: WORLD, brain: 'jev' };
		expect(validateStart({ ...base, type: 'landscaper' }, CTX)).toHaveProperty('error');
		expect(validateStart({ ...base, type: 'revert' }, CTX)).toHaveProperty('error');
		expect(validateStart({ ...base, name: 'x; rm -rf ~' }, CTX)).toHaveProperty('error');
		expect(validateStart({ ...base, world: `${WORLD} --no-edits` }, CTX)).toHaveProperty('error');
		expect(validateStart({ ...base, brain: 'clm' }, CTX)).toHaveProperty('error');
		expect(validateStart({ ...base, target: 'prod' }, CTX)).toHaveProperty('error');
		expect(validateStart({ ...base, max: '1e3' }, CTX)).toHaveProperty('error');
		expect(validateStart({ ...base, when: 'players' }, CTX)).toHaveProperty('error'); // CLI lacks --when
		const ok = validateStart({ ...base, when: 'players' }, { ...CTX, whenSupported: true }) as StartSpec;
		expect(botArgs(ok)).toContain('--when');
	});
});

describe('CLI output parsing', () => {
	it('reads the available commands from the unknown-bot error', () => {
		expect(parseAvailableCommands('unknown bot "zz"; expected companion, revert, builder, decorator, village, helper, architect or foreman')).toEqual(['companion', 'revert', 'builder', 'decorator', 'village', 'helper', 'architect', 'foreman']);
	});
	it('reads the world list', () => {
		expect(parseWorlds(`${WORLD}  World #1  online: Julien, Noah\n`)).toEqual([{ uuid: WORLD, name: 'World #1', online: 'Julien, Noah' }]);
	});
	it('reads a unit description, quoted names included', () => {
		expect(parseUnitCommand(`/n/npm --prefix bots run bot -- companion --target live --world ${WORLD} --name "Enderman 2" --skin enderman`)).toEqual({ type: 'companion', name: 'Enderman 2', target: 'live', world: WORLD });
		expect(parseUnitCommand(`/n/npx tsx src/cli.ts companion --target live --world ${WORLD} --name "Enderman 3"`).name).toBe('Enderman 3');
	});
	it('matches only the named bot\'s logs', () => {
		expect(isLogOf('Enderman 2-2026-09-26T08-16-45-071Z-2.jsonl', 'Enderman 2')).toBe(true);
		expect(isLogOf('Enderman 2-2026-09-26T08-16-45-071Z.jsonl', 'Enderman')).toBe(false);
	});
});

describe('log summary', () => {
	it('folds brain2 changes onto the saved state', () => {
		const lines = [
			{ k: 'meta', v: 1, t: 1, bot: 'Pip', world: WORLD, personality: 'Pip', seed: 1, wallStart: 1 },
			{ k: 'change', t: 2, id: 1, path: 'behaviour', old: null, new: { kind: 'follow', params: { kid: 'Noah' }, step: 0, failures: 0, progress: '' }, cause: {} },
			{ k: 'change', t: 3, id: 2, path: 'behaviour.step', old: 0, new: 4, cause: {} },
			{ k: 'change', t: 3, id: 3, path: 'emotions.mood.value', old: 0, new: 0.5, cause: {} },
			{ k: 'change', t: 3, id: 4, path: 'emotions.mood.band', old: 'neutral', new: 'high', cause: {} },
			{ k: 'change', t: 3, id: 5, path: 'relations.Noah.axes.affection.value', old: 0.1, new: 0.2, cause: {} },
			{ k: 'change', t: 3, id: 6, path: 'inventory', old: {}, new: { dirt: 3 }, cause: {} },
			{ k: 'select', t: 4, selectionId: 1, trigger: 'appraisal', urgent: false, player: 'Noah', inputs: {}, rows: [], winner: 'follow', params: {} },
			{ k: 'event', t: 5, kind: 'walk-fly', data: { to: { x: 1 } } },
		];
		const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"k":"change","t":6,"torn';
		const persisted = { relations: { Noah: { axes: { affection: { value: 0.1, band: 'neutral' }, respect: { value: 0.7, band: 'very high' } } } } };
		const s = summarizeLog(text, JSON.stringify(lines[0]), persisted);
		expect(s.kind).toBe('brain2');
		if (s.kind !== 'brain2') return;
		expect(s.behaviour).toMatchObject({ kind: 'follow', step: 4 });
		expect(s.emotions.mood).toEqual({ value: 0.5, band: 'high' });
		expect(s.relations.Noah.affection).toEqual({ value: 0.2, band: 'neutral' });
		expect(s.relations.Noah.respect.value).toBe(0.7);
		expect(s.inventory).toEqual({ dirt: 3 });
		expect(s.selections[0]).toMatchObject({ winner: 'follow', trigger: 'appraisal' });
		expect(s.events[0].kind).toBe('walk-fly');
	});
	it('summarises a builder log', () => {
		const start = { k: 'start', t: 1, name: 'Snaky', primary: 'jev', secondary: 'laya', builds: 6 };
		const lines = [
			{ k: 'project', t: 2, id: 'p1', template: 'heart-medium' },
			{ k: 'decision', what: 'move', t: 3, instructions: 'Which block next?', options: { 'block-1': 'floor', 'block-2': 'wall' }, primary: { engine: 'jev', choice: 'block-2', ms: 140 }, secondary: { engine: 'laya', choice: 'block-1', ms: 15 }, agree: false, fallback: false },
			{ k: 'place', t: 4, id: 'p1', cell: { x: 1, y: 2, z: 3 }, block: 'stone', ok: true },
			{ k: 'place', t: 4, id: 'p1', cell: { x: 1, y: 3, z: 3 }, block: 'stone', ok: false },
			{ k: 'fly-blocked', to: { x: 1, z: 2 }, err: 'wall', t: 5 },
			{ k: 'build-end', t: 6, id: 'p0', status: 'done', why: 'finished', placed: 64, cells: 64 },
			{ k: 'cap-reached', t: 7, builds: 12, max: 12 },
		];
		const s = summarizeLog(lines.map((l) => JSON.stringify(l)).join('\n'), JSON.stringify(start), null);
		expect(s.kind).toBe('builder');
		if (s.kind !== 'builder') return;
		expect(s.start?.builds).toBe(6);
		expect(s.project?.id).toBe('p1');
		expect(s.placed).toBe(1);
		expect(s.buildEnds.done).toBe(1);
		expect(s.cap).toMatchObject({ builds: 12, max: 12 });
		expect(s.decisions[0]).toMatchObject({ choice: 'block-2', option: 'wall', engine: 'jev', ms: 140, other: 'laya: block-1' });
		expect(s.movement[0].k).toBe('fly-blocked');
	});
});
