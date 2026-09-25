// Spec §3 / §12a, plan Task 5 step 1: the import guard checks the module graph (resolved ids), not text.
// Every case asserts its OWN message, so disabling one rule turns its case red instead of being caught by another.
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { botConfig, PKG_ROOT, REPO_ROOT } from '../vite.config';
import { buildCode, cleanup, fixture, tempDir } from './build-helpers';

afterAll(cleanup);

/** An in-memory build of `entry` with the package's config; the fixture dir is admitted by `extraAllowed`. */
function buildEntry(entry: string, extraAllowed: string[]): Promise<string> {
	return buildCode(botConfig({ entry, extraAllowed, write: false }));
}

describe('the import guard', () => {
	it('1. the real SDK entry builds clean', async () => {
		const code = await buildCode(botConfig({ write: false }));
		expect(code).toContain('class BotClient');
		expect(code).not.toMatch(/from ["']three["']/);
	});

	it('1b. a fixture entry importing allowed modules by absolute path builds clean', async () => {
		const dir = tempDir('guard-ok');
		const entry = fixture(dir, 'entry.ts', `import { World } from ${JSON.stringify(join(REPO_ROOT, 'src/engine/world/world.ts'))};\nexport const w = () => new World(1);\n`);
		await expect(buildEntry(entry, [dir])).resolves.toContain('World');
	});

	it("2. import 'three' → GUARD: three", async () => {
		const dir = tempDir('guard-three');
		const entry = fixture(dir, 'entry.ts', `import * as T from 'three';\nexport const v = () => new T.Vector3();\n`);
		await expect(buildEntry(entry, [dir])).rejects.toThrow(/GUARD: three/);
	});

	it('3. a .png import → GUARD: asset', async () => {
		const dir = tempDir('guard-png');
		const png = join(REPO_ROOT, 'src/assets/blocks/stone.png');
		const entry = fixture(dir, 'entry.ts', `import url from ${JSON.stringify(png)};\nexport default url;\n`);
		await expect(buildEntry(entry, [dir])).rejects.toThrow(/GUARD: asset/);
	});

	it('3b. a ?url import → GUARD: asset', async () => {
		const dir = tempDir('guard-url');
		const entry = fixture(dir, 'entry.ts', `import url from ${JSON.stringify(join(REPO_ROOT, 'src/net/echo.ts') + '?url')};\nexport default url;\n`);
		await expect(buildEntry(entry, [dir])).rejects.toThrow(/GUARD: asset/);
	});

	it('4. a module outside the allow-list, reached through a relative import in an allowed module → GUARD: module', async () => {
		const dir = tempDir('guard-module');
		// The entry is allowed; it imports a sibling (allowed) that imports a DOM-only UI module by absolute path.
		fixture(dir, 'mid.ts', `export { MpOverlays } from ${JSON.stringify(join(REPO_ROOT, 'src/ui/mp-overlays.ts'))};\n`);
		const entry = fixture(dir, 'entry.ts', `export { MpOverlays } from './mid';\n`);
		await expect(buildEntry(entry, [dir])).rejects.toThrow(/GUARD: module .*src\/ui\/mp-overlays\.ts/);
	});

	it('5. import.meta.glob → GUARD: glob', async () => {
		const dir = tempDir('guard-glob');
		const entry = fixture(dir, 'entry.ts', `const m = import.meta.glob('./*.ts', { eager: true });\nexport default m;\n`);
		await expect(buildEntry(entry, [dir])).rejects.toThrow(/GUARD: glob/);
	});

	it('the package paths it guards are the real ones', () => {
		expect(PKG_ROOT).toBe(join(REPO_ROOT, 'packages/minicraft-bot'));
	});
});
