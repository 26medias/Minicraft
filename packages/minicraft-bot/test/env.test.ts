// Spec §3 / §12a, plan Task 5 step 2 (review focus 5): an SDK built while `.env.local` or `process.env`
// holds an MP token must not contain it. The fixture reads the variable; each "does not contain" has a
// positive control that proves the same fixture DOES leak without the setting under test.
// Never creates, edits or deletes the repo's `.env.local`: the file case uses a temp envDir.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolveConfig } from 'vite';
import { join } from 'node:path';
import { BOT_ENV, PKG_ROOT } from '../vite.config';
import { buildCode, cleanup, fixture, tempDir } from './build-helpers';

const VAR = 'VITE_MINICRAFT_MP_TOKEN';

afterAll(cleanup);

let saved: string | undefined;
beforeEach(() => {
	saved = process.env[VAR];
});
afterEach(() => {
	if (saved === undefined) delete process.env[VAR];
	else process.env[VAR] = saved;
});

/** A fixture entry returning the token, built in memory. `env` overrides envDir/envPrefix/mode. */
async function buildFixture(env: { envDir?: string; envPrefix?: string; mode?: string }): Promise<string> {
	const dir = tempDir('env');
	const entry = fixture(dir, 'entry.ts', `export const token = () => import.meta.env.${VAR};\n`);
	// Plain Vite defaults otherwise, no guard: root is the temp dir, so the repo's own .env files are never read.
	return buildCode({ root: dir, publicDir: false, ...env, build: { ssr: entry, write: false, minify: false } });
}

describe('env isolation', () => {
	it('(a) positive control: plain Vite inlines a process.env VITE_ variable', async () => {
		process.env[VAR] = 'leak-test-123';
		expect(await buildFixture({})).toContain('leak-test-123');
	});

	it("(b) with the package's env settings, the process.env variable is not inlined", async () => {
		process.env[VAR] = 'leak-test-123';
		expect(await buildFixture({ ...BOT_ENV })).not.toContain('leak-test-123');
	});

	it('(c) a .env.local in envDir leaks without envPrefix (control) and not with it', async () => {
		delete process.env[VAR];
		const envDir = tempDir('envdir');
		fixture(envDir, '.env.local', `${VAR}=file-leak-456\n`);
		expect(await buildFixture({ envDir, mode: 'production' })).toContain('file-leak-456');
		expect(await buildFixture({ envDir, envPrefix: BOT_ENV.envPrefix, mode: 'production' })).not.toContain('file-leak-456');
	});

	it("the package config's envDir is the empty folder, which holds only .gitkeep", async () => {
		const cfg = await resolveConfig({ configFile: join(PKG_ROOT, 'vite.config.ts'), logLevel: 'silent' }, 'build');
		expect(cfg.envDir.replace(/\\/g, '/')).toMatch(/packages\/minicraft-bot\/src\/empty-env$/);
		expect(cfg.envPrefix).toEqual(BOT_ENV.envPrefix);
		expect(cfg.mode).toBe('production');
		expect(readdirSync(cfg.envDir)).toEqual(['.gitkeep']);
	});
});
