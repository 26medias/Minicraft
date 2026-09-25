import { describe, expect, it } from 'vitest';
import type { WorldListing } from 'minicraft-bot';
import { checkLiveAck, checkName, ConfigError, loadConfig, pickSkin, resolveWorld } from '../src/config.js';
import type { BotsConfigData, Config } from '../src/config.js';
import { SKIN_IDS } from '../src/skins.js';

/**
 * Task 1 (spec §4, §9 #7, §12a): pure, fully injected config and CLI parsing, with its safety
 * refusals. Every target used here is synthetic (never the real live URL, never port 8080 on
 * purpose except where that's exactly what's under test) so these tests never touch the real
 * filesystem, env, or the live server — everything is injected.
 */

const COMPANION_TUNING = {
	tickMs: 500,
	editEveryMs: 2000,
	editBudget: 50,
	followDist: 2,
	minConfidence: 0.4,
	stopMs: 600_000,
	wanderTether: 12,
	statusEveryMs: 30_000,
	idleSwitchMs: 30_000,
	minTargetMs: 20_000,
};

function testConfig(targets: BotsConfigData['targets']): BotsConfigData {
	return {
		targets,
		brains: {
			laya: { url: 'http://127.0.0.1:8000', health: '/health', home: '~/Projects/AI/laya', start: ['laya-serve'], timeoutMs: 400 },
		},
		companion: COMPANION_TUNING,
	};
}

function noFile(): string | null {
	return null;
}
function noWrite(): void {
	throw new Error('writeFile should not be called in this test');
}

describe('loadConfig: port 8080 refusal', () => {
	it('refuses http://localhost:8080', () => {
		const config = testConfig({ bad: { url: 'http://localhost:8080', token: 'x' } });
		expect(() => loadConfig({ argv: ['--target', 'bad'], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config })).toThrow(ConfigError);
	});

	it('refuses http://127.0.0.1:8080/ (trailing slash)', () => {
		const config = testConfig({ bad: { url: 'http://127.0.0.1:8080/', token: 'x' } });
		expect(() => loadConfig({ argv: ['--target', 'bad'], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config })).toThrow(ConfigError);
	});

	it('a non-8080 port is accepted', () => {
		const config = testConfig({ local: { url: 'http://localhost:18090', token: 'e2e' } });
		const cfg = loadConfig({ argv: ['--target', 'local'], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config });
		expect(cfg.target.url).toBe('http://localhost:18090');
	});
});

describe('loadConfig: live token resolution', () => {
	function liveConfig(): BotsConfigData {
		return testConfig({
			live: { url: 'http://mc.example.test', tokenEnv: 'MC_LIVE_TOKEN', tokenFile: '~/minicraft-mp/token' },
		});
	}

	it('no MC_LIVE_TOKEN, no .env.live and no token file → error', () => {
		expect(() => loadConfig({ argv: ['--target', 'live'], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config: liveConfig() })).toThrow(ConfigError);
	});

	it('never reads the token file for a target with a static token (local)', () => {
		let readFileCalled = false;
		const readFile = (_path: string) => {
			readFileCalled = true;
			return null;
		};
		const config = testConfig({ local: { url: 'http://localhost:18090', token: 'e2e' } });
		loadConfig({ argv: ['--target', 'local'], env: {}, readFile, homedir: () => '/home/fake', stateRoot: '.state', config });
		expect(readFileCalled).toBe(false);
	});

	it('MC_LIVE_TOKEN (env) beats the token file', () => {
		const readFile = (path: string) => {
			if (path === '/home/fake/minicraft-mp/token') return 'token-from-file\n';
			return null;
		};
		const cfg = loadConfig({
			argv: ['--target', 'live'],
			env: { MC_LIVE_TOKEN: 'token-from-env' },
			readFile,
			homedir: () => '/home/fake',
			stateRoot: '.state',
			config: liveConfig(),
		});
		expect(cfg.target.token).toBe('token-from-env');
	});

	it('falls back to bots/.env.live when the env var is absent', () => {
		const readFile = (path: string) => {
			if (path === '.env.live') return 'MC_LIVE_TOKEN=token-from-dotenv\n';
			return null;
		};
		const cfg = loadConfig({ argv: ['--target', 'live'], env: {}, readFile, homedir: () => '/home/fake', stateRoot: '.state', config: liveConfig() });
		expect(cfg.target.token).toBe('token-from-dotenv');
	});

	it('falls back to the token file, with `~` expanded via the injected homedir', () => {
		const seenPaths: string[] = [];
		const readFile = (path: string) => {
			seenPaths.push(path);
			if (path === '/home/fake/minicraft-mp/token') return 'token-from-file\n';
			return null;
		};
		const cfg = loadConfig({ argv: ['--target', 'live'], env: {}, readFile, homedir: () => '/home/fake', stateRoot: '.state', config: liveConfig() });
		expect(cfg.target.token).toBe('token-from-file');
		expect(seenPaths).toContain('/home/fake/minicraft-mp/token');
	});
});

describe('checkLiveAck', () => {
	function liveCfg(ackLive: boolean): Config {
		const config = testConfig({ live: { url: 'http://mc.example.test', tokenEnv: 'MC_LIVE_TOKEN', tokenFile: '~/minicraft-mp/token' } });
		const args = ['--target', 'live'];
		if (ackLive) args.push('--i-deployed-the-server');
		return loadConfig({ argv: args, env: { MC_LIVE_TOKEN: 'tok' }, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config });
	}

	it('first run per world, without --i-deployed-the-server → error', () => {
		const cfg = liveCfg(false);
		const result = checkLiveAck({ cfg, worldUuid: 'uuid-1', readFile: noFile, writeFile: noWrite, now: () => 1_000 });
		expect(result).toBeInstanceOf(ConfigError);
	});

	it('first run with the flag → writes the ack via the injected writeFile/now', () => {
		const cfg = liveCfg(true);
		let written: { path: string; content: string } | null = null;
		const writeFile = (path: string, content: string) => {
			written = { path, content };
		};
		const result = checkLiveAck({ cfg, worldUuid: 'uuid-1', readFile: noFile, writeFile, now: () => 1_700_000_000_000 });
		expect(result).toBeUndefined();
		expect(written).not.toBeNull();
		expect(written!.path).toBe('.state/live-ack.json');
		expect(JSON.parse(written!.content)).toEqual({ 'uuid-1': new Date(1_700_000_000_000).toISOString() });
	});

	it('a later run, without the flag, is ok once the world is in the ack file', () => {
		const cfg = liveCfg(false);
		const readFile = (path: string) => (path === '.state/live-ack.json' ? JSON.stringify({ 'uuid-1': '2026-01-01T00:00:00.000Z' }) : null);
		const result = checkLiveAck({ cfg, worldUuid: 'uuid-1', readFile, writeFile: noWrite, now: () => 2_000 });
		expect(result).toBeUndefined();
	});

	it('does nothing for a non-live target', () => {
		const config = testConfig({ local: { url: 'http://localhost:18090', token: 'e2e' } });
		const cfg = loadConfig({ argv: ['--target', 'local'], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config });
		const result = checkLiveAck({ cfg, worldUuid: 'uuid-1', readFile: noFile, writeFile: noWrite, now: () => 1_000 });
		expect(result).toBeUndefined();
	});
});

describe('resolveWorld', () => {
	const worlds: WorldListing[] = [
		{ uuid: 'uuid-1', name: 'Home', mustMine: false, createdAt: 1, online: [] },
		{ uuid: 'uuid-2', name: 'noah', mustMine: false, createdAt: 2, online: [] },
		{ uuid: 'uuid-3', name: 'Home Copy', mustMine: false, createdAt: 3, online: [] },
	];

	it('resolves by uuid', () => {
		expect(resolveWorld(worlds, 'uuid-2')).toBe(worlds[1]);
	});

	it('resolves by exact case-insensitive name', () => {
		expect(resolveWorld(worlds, 'HOME')).toBe(worlds[0]);
		expect(resolveWorld(worlds, 'Noah')).toBe(worlds[1]);
	});

	it('an ambiguous name errors and lists the candidates', () => {
		const ambiguous: WorldListing[] = [
			{ uuid: 'uuid-a', name: 'Dup', mustMine: false, createdAt: 1, online: [] },
			{ uuid: 'uuid-b', name: 'dup', mustMine: false, createdAt: 2, online: [] },
		];
		const result = resolveWorld(ambiguous, 'dup');
		expect(result).toBeInstanceOf(ConfigError);
		expect((result as ConfigError).message).toContain('uuid-a');
		expect((result as ConfigError).message).toContain('uuid-b');
	});

	it('missing arg → listOnly', () => {
		expect(resolveWorld(worlds, undefined)).toBe('listOnly');
	});

	it('a name matching nothing errors', () => {
		expect(resolveWorld(worlds, 'nope')).toBeInstanceOf(ConfigError);
	});
});

describe('checkName', () => {
	it('ok when the name is free', () => {
		expect(checkName('Robo', ['Noah', 'Julien'])).toBe('ok');
	});

	it('refuses a case-insensitive collision with an online or in-world name', () => {
		expect(checkName('noah', ['Noah', 'Julien'])).toBeInstanceOf(ConfigError);
		expect(checkName('NOAH', ['Noah'])).toBeInstanceOf(ConfigError);
	});
});

describe('pickSkin', () => {
	it('defaults to the first catalog skin no kid is wearing', () => {
		expect(pickSkin(SKIN_IDS, ['milo', 'chip'])).toBe('crazy-fan-girl');
	});

	it('falls back to the first catalog skin if every one is taken', () => {
		expect(pickSkin(SKIN_IDS, [...SKIN_IDS])).toBe(SKIN_IDS[0]);
	});

	it('honours a valid requested skin even if a kid wears it', () => {
		expect(pickSkin(SKIN_IDS, ['milo'], 'milo')).toBe('milo');
	});

	it('refuses an unknown requested skin', () => {
		expect(pickSkin(SKIN_IDS, [], 'not-a-skin')).toBeInstanceOf(ConfigError);
	});
});

describe('statePath', () => {
	it('is .state/<target>/<uuid>/<name>.json', () => {
		const config = testConfig({ local: { url: 'http://localhost:18090', token: 'e2e' } });
		const cfg = loadConfig({ argv: ['--target', 'local', '--name', 'Robo'], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config });
		expect(cfg.statePath('uuid-123')).toBe('.state/local/uuid-123/Robo.json');
	});
});

describe('loadConfig: defaults and validation', () => {
	it('uses the real bots.config.ts default export when `config` is omitted', () => {
		const cfg = loadConfig({ argv: ['--target', 'local'], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state' });
		expect(cfg.target.url).toBe('http://localhost:18090');
		expect(cfg.companion.tickMs).toBe(500);
	});

	it('refuses an unknown --target', () => {
		const config = testConfig({ local: { url: 'http://localhost:18090', token: 'e2e' } });
		expect(() => loadConfig({ argv: ['--target', 'nope'], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config })).toThrow(ConfigError);
	});

	it('requires --target', () => {
		const config = testConfig({ local: { url: 'http://localhost:18090', token: 'e2e' } });
		expect(() => loadConfig({ argv: [], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config })).toThrow(ConfigError);
	});

	it('refuses an unknown --brain', () => {
		const config = testConfig({ local: { url: 'http://localhost:18090', token: 'e2e' } });
		expect(() => loadConfig({ argv: ['--target', 'local', '--brain', 'nope'], env: {}, readFile: noFile, homedir: () => '/home/fake', stateRoot: '.state', config })).toThrow(ConfigError);
	});

	it('never reads the real filesystem or env when everything is injected', () => {
		// Sentinels that would blow up if config.ts ever called the real fs/env instead of the
		// injected functions.
		const readFile = (): string | null => {
			throw new Error('real fs read attempted');
		};
		const config = testConfig({ live: { url: 'http://mc.example.test', tokenEnv: 'MC_LIVE_TOKEN', tokenFile: '~/minicraft-mp/token' } });
		const cfg = loadConfig({ argv: ['--target', 'live'], env: { MC_LIVE_TOKEN: 'tok' }, readFile, homedir: () => '/home/fake', stateRoot: '.state', config });
		expect(cfg.target.token).toBe('tok');
	});
});
