import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Enforces the bots/ import boundary (spec §3, §12a: "the eslint patterns were wrong both ways" — a
 * vitest test that resolves paths, instead). `bots/` may depend on the game only through the built
 * `minicraft-bot` SDK; it must never reach into the game's `src/`, another package's `src/`, or the
 * game's own bundler-only deps (`three`, `vite`, ...).
 *
 * `vitest` itself is allowed **under `bots/test/` only**: bots/vitest.config.ts uses `globals: false`
 * (see spec §3's tsconfig note, `types: ["node"]` only — no ambient vitest globals), so every test
 * file, including this one, imports `describe`/`it`/`expect` from it explicitly. That is the test
 * runner bots/ is built on, not a game dependency, so it does not defeat the boundary's purpose —
 * but `bots/src/` code is not a test, so it has no legitimate reason to import `vitest` (e.g. `vi`
 * for mocking), and allowing it there would quietly let test-only tooling leak into shipped bot code.
 */

const testFileDir = dirname(fileURLToPath(import.meta.url));
const botsRoot = resolve(testFileDir, '..');
const testRoot = testFileDir;
const ALLOWED_BARE = new Set(['minicraft-bot']);
const ALLOWED_BARE_IN_TESTS = new Set(['minicraft-bot', 'vitest']);

function isAllowedBare(specifier: string, isTestFile: boolean): boolean {
	const allowed = isTestFile ? ALLOWED_BARE_IN_TESTS : ALLOWED_BARE;
	if (allowed.has(specifier)) return true;
	if (isTestFile && specifier.startsWith('vitest/')) return true;
	if (specifier.startsWith('node:')) return true;
	return false;
}

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			out.push(...listTsFiles(full));
		} else if (extname(entry) === '.ts') {
			out.push(full);
		}
	}
	return out;
}

/** Every `import`/`export ... from '...'`, bare side-effect `import '...'`, and dynamic `import('...')`. */
function specifiersIn(source: string): string[] {
	const specs: string[] = [];
	for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
	for (const m of source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]);
	for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
	return specs;
}

interface Violation {
	file: string;
	specifier: string;
	reason: string;
}

function findViolations(): Violation[] {
	const violations: Violation[] = [];
	const dirs = [join(botsRoot, 'src'), join(botsRoot, 'test'), join(botsRoot, 'bench')];
	for (const dir of dirs) {
		let files: string[];
		try {
			files = listTsFiles(dir);
		} catch {
			continue; // the directory may not exist yet in earlier tasks
		}
		for (const file of files) {
			const isTestFile = file === testRoot || file.startsWith(testRoot + sep);
			const source = readFileSync(file, 'utf8');
			for (const specifier of specifiersIn(source)) {
				if (specifier.startsWith('.')) {
					const resolved = resolve(dirname(file), specifier);
					if (resolved !== botsRoot && !resolved.startsWith(botsRoot + sep)) {
						violations.push({ file, specifier, reason: `resolves outside bots/ to ${resolved}` });
					}
				} else if (!isAllowedBare(specifier, isTestFile)) {
					const reason = isTestFile ? 'bare specifier is not minicraft-bot, vitest or node:*' : 'bare specifier is not minicraft-bot or node:* (vitest is test-only)';
					violations.push({ file, specifier, reason });
				}
			}
		}
	}
	return violations;
}

describe('bots/ import boundary', () => {
	it('never imports outside bots/, and only allows vitest as a bare specifier under test/', () => {
		const violations = findViolations();
		expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
	});
});
