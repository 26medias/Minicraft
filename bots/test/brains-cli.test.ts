import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { expandHome, refusePort8080, resolveBrain, runBrainsCli } from '../src/brains-cli.js';
import type { BrainsCliDeps } from '../src/brains-cli.js';
import type { BotsConfigData, BrainDef } from '../src/config.js';
import botsConfig from '../bots.config.js';

/**
 * Task 6: the brains launcher (spec §4). `npm run brains -- laya|clm` spawns the configured start
 * argv with `cwd` = the expanded `home`, forwards signals to the child, and refuses port 8080 —
 * never the game server or a bot, and never spawns a real process here (the child is faked).
 */

function brainsConfig(overrides: Partial<Record<'laya' | 'clm', BrainDef>> = {}): BotsConfigData['brains'] {
	return {
		laya: { url: 'http://127.0.0.1:8000', health: '/health', home: '~/Projects/AI/laya', start: ['env', 'LAYA_PORT=8000', 'LAYA_MODELS=english', '.venv/bin/laya-serve'], timeoutMs: 400 },
		clm: { url: 'http://127.0.0.1:8701', health: '/health', home: '~/Projects/AI/clm', start: ['env', 'CLM_PORT=8701', '.venv/bin/clm-serve'], timeoutMs: 400, experimental: true },
		...overrides,
	};
}

describe('expandHome', () => {
	it('expands ~ and ~/... via the injected homedir', () => {
		expect(expandHome('~', () => '/home/fake')).toBe('/home/fake');
		expect(expandHome('~/Projects/AI/laya', () => '/home/fake')).toBe('/home/fake/Projects/AI/laya');
	});

	it('leaves an absolute path alone', () => {
		expect(expandHome('/opt/laya', () => '/home/fake')).toBe('/opt/laya');
	});
});

describe('refusePort8080', () => {
	it('refuses a brain url on port 8080', () => {
		expect(() => refusePort8080({ url: 'http://127.0.0.1:8080', health: '/health', home: '~', start: ['x'], timeoutMs: 400 })).toThrow(/8080/);
	});

	it('accepts a non-8080 port', () => {
		expect(() => refusePort8080({ url: 'http://127.0.0.1:8000', health: '/health', home: '~', start: ['x'], timeoutMs: 400 })).not.toThrow();
	});

	it('refuses an unparsable url', () => {
		expect(() => refusePort8080({ url: 'not-a-url', health: '/health', home: '~', start: ['x'], timeoutMs: 400 })).toThrow(/invalid brain url/);
	});
});

describe('resolveBrain', () => {
	it('resolves laya and clm', () => {
		const brains = brainsConfig();
		expect(resolveBrain('laya', brains).def.url).toBe('http://127.0.0.1:8000');
		expect(resolveBrain('clm', brains).def.url).toBe('http://127.0.0.1:8701');
	});

	it('throws a usage error with no arg, or an unknown one', () => {
		const brains = brainsConfig();
		expect(() => resolveBrain(undefined, brains)).toThrow(/usage: npm run brains/);
		expect(() => resolveBrain('scripted', brains)).toThrow(/usage: npm run brains/);
	});

	it('refuses a brain with an empty start argv', () => {
		const brains = brainsConfig({ laya: { url: 'http://127.0.0.1:8000', health: '/health', home: '~/Projects/AI/laya', start: [], timeoutMs: 400 } });
		expect(() => resolveBrain('laya', brains)).toThrow(/empty start argv/);
	});
});

function fakeChild(): ChildProcess & { killed_: (NodeJS.Signals | undefined)[] } {
	const ee = new EventEmitter() as unknown as ChildProcess & { killed_: (NodeJS.Signals | undefined)[] };
	ee.killed_ = [];
	ee.kill = ((signal?: NodeJS.Signals) => {
		ee.killed_.push(signal);
		return true;
	}) as ChildProcess['kill'];
	return ee;
}

function testDeps(overrides: Partial<BrainsCliDeps> = {}): { deps: BrainsCliDeps; spawned: { command: string; args: string[]; cwd: string }[]; printed: string[]; signalHandlers: Map<NodeJS.Signals, (() => void)[]> } {
	const spawned: { command: string; args: string[]; cwd: string }[] = [];
	const printed: string[] = [];
	const signalHandlers = new Map<NodeJS.Signals, (() => void)[]>();
	const deps: BrainsCliDeps = {
		config: { targets: {}, brains: brainsConfig(), companion: {} as BotsConfigData['companion'] },
		homedir: () => '/home/fake',
		spawnProcess: (command, args, options) => {
			spawned.push({ command, args, cwd: options.cwd });
			return fakeChild();
		},
		print: (l) => printed.push(l),
		onSignal: (signal, handler) => {
			const list = signalHandlers.get(signal) ?? [];
			list.push(handler);
			signalHandlers.set(signal, list);
			return () => {
				const idx = list.indexOf(handler);
				if (idx !== -1) list.splice(idx, 1);
			};
		},
		...overrides,
	};
	return { deps, spawned, printed, signalHandlers };
}

describe('runBrainsCli', () => {
	it('spawns the configured argv with cwd = the expanded home, and resolves with the exit code', async () => {
		const { deps, spawned } = testDeps();
		let child: ReturnType<typeof fakeChild> | null = null;
		deps.spawnProcess = (command, args, options) => {
			spawned.push({ command, args, cwd: options.cwd });
			child = fakeChild();
			return child;
		};
		const running = runBrainsCli(['laya'], deps);
		expect(spawned).toEqual([{ command: 'env', args: ['LAYA_PORT=8000', 'LAYA_MODELS=english', '.venv/bin/laya-serve'], cwd: '/home/fake/Projects/AI/laya' }]);
		child!.emit('exit', 0, null);
		expect(await running).toBe(0);
	});

	it('a non-zero exit code is passed through', async () => {
		const { deps } = testDeps();
		let child: ReturnType<typeof fakeChild> | null = null;
		deps.spawnProcess = () => {
			child = fakeChild();
			return child;
		};
		const running = runBrainsCli(['clm'], deps);
		child!.emit('exit', 3, null);
		expect(await running).toBe(3);
	});

	it('a null exit code with a signal resolves to 1', async () => {
		const { deps } = testDeps();
		let child: ReturnType<typeof fakeChild> | null = null;
		deps.spawnProcess = () => {
			child = fakeChild();
			return child;
		};
		const running = runBrainsCli(['laya'], deps);
		child!.emit('exit', null, 'SIGKILL');
		expect(await running).toBe(1);
	});

	it('forwards SIGINT and SIGTERM to the child, and unsubscribes once it exits', async () => {
		const { deps, signalHandlers } = testDeps();
		let child: ReturnType<typeof fakeChild> | null = null;
		deps.spawnProcess = () => {
			child = fakeChild();
			return child;
		};
		const running = runBrainsCli(['laya'], deps);
		expect(signalHandlers.get('SIGINT')).toHaveLength(1);
		expect(signalHandlers.get('SIGTERM')).toHaveLength(1);
		signalHandlers.get('SIGINT')![0]();
		expect(child!.killed_).toEqual(['SIGINT']);
		child!.emit('exit', 0, null);
		await running;
		expect(signalHandlers.get('SIGINT')).toHaveLength(0);
		expect(signalHandlers.get('SIGTERM')).toHaveLength(0);
	});

	it('refuses port 8080 without spawning anything', async () => {
		const { deps, spawned } = testDeps({ config: { targets: {}, brains: brainsConfig({ laya: { url: 'http://127.0.0.1:8080', health: '/health', home: '~/Projects/AI/laya', start: ['env', 'LAYA_MODELS=english', 'laya-serve'], timeoutMs: 400 } }), companion: {} as BotsConfigData['companion'] } });
		await expect(runBrainsCli(['laya'], deps)).rejects.toThrow(/8080/);
		expect(spawned).toHaveLength(0);
	});

	it('an unknown brain name is a usage error, without spawning anything', async () => {
		const { deps, spawned } = testDeps();
		await expect(runBrainsCli([], deps)).rejects.toThrow(/usage: npm run brains/);
		expect(spawned).toHaveLength(0);
	});
});


describe('Laya runs English-only (spec §3.2, Task 18)', () => {
	// Red if `brains start laya` launches Laya with all three checkpoints: the LLM then gets 1.4 of its 3.6 GB on
	// the GPU and appraise.size takes p50 4.4 s.
	it('`brains start laya` refuses a start argv without LAYA_MODELS=english, spawning nothing', async () => {
		const { deps, spawned } = testDeps({ config: { targets: {}, brains: brainsConfig({ laya: { url: 'http://127.0.0.1:8000', health: '/health', home: '~/Projects/AI/laya', start: ['env', 'LAYA_PORT=8000', 'LAYA_PRELOAD=1', '.venv/bin/laya-serve'], timeoutMs: 400 } }), companion: {} as BotsConfigData['companion'] } });
		await expect(runBrainsCli(['start', 'laya'], deps)).rejects.toThrow(/LAYA_MODELS=english/);
		await expect(runBrainsCli(['laya'], deps)).rejects.toThrow(/LAYA_MODELS=english/);
		expect(spawned).toHaveLength(0);
	});

	it('`brains start laya` spawns the configured argv when it sets LAYA_MODELS=english', async () => {
		const { deps, spawned } = testDeps();
		let child: ReturnType<typeof fakeChild> | null = null;
		deps.spawnProcess = (command, args, options) => {
			spawned.push({ command, args, cwd: options.cwd });
			child = fakeChild();
			return child;
		};
		const running = runBrainsCli(['start', 'laya'], deps);
		expect(spawned[0].args).toContain('LAYA_MODELS=english');
		child!.emit('exit', 0, null);
		expect(await running).toBe(0);
	});

	it('the committed bots.config.ts starts Laya with LAYA_MODELS=english', () => {
		expect(() => resolveBrain('laya', (botsConfig as BotsConfigData).brains)).not.toThrow();
		expect((botsConfig as BotsConfigData).brains.laya!.start).toContain('LAYA_MODELS=english');
	});
});
