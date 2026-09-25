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
 * `vitest` itself is allowed: bots/vitest.config.ts uses `globals: false` (see spec §3's tsconfig
 * note, `types: ["node"]` only — no ambient vitest globals), so every test file, including this one,
 * imports `describe`/`it`/`expect` from it explicitly. That is the test runner bots/ is built on, not
 * a game dependency, so it does not defeat the boundary's purpose.
 */

const testFileDir = dirname(fileURLToPath(import.meta.url));
const botsRoot = resolve(testFileDir, '..');
const ALLOWED_BARE = new Set(['minicraft-bot', 'vitest']);

function isAllowedBare(specifier: string): boolean {
	if (ALLOWED_BARE.has(specifier)) return true;
	if (specifier.startsWith('vitest/')) return true;
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
	const dirs = [join(botsRoot, 'src'), join(botsRoot, 'test')];
	for (const dir of dirs) {
		let files: string[];
		try {
			files = listTsFiles(dir);
		} catch {
			continue; // the directory may not exist yet in earlier tasks
		}
		for (const file of files) {
			const source = readFileSync(file, 'utf8');
			for (const specifier of specifiersIn(source)) {
				if (specifier.startsWith('.')) {
					const resolved = resolve(dirname(file), specifier);
					if (resolved !== botsRoot && !resolved.startsWith(botsRoot + sep)) {
						violations.push({ file, specifier, reason: `resolves outside bots/ to ${resolved}` });
					}
				} else if (!isAllowedBare(specifier)) {
					violations.push({ file, specifier, reason: 'bare specifier is not minicraft-bot, vitest or node:*' });
				}
			}
		}
	}
	return violations;
}

describe('bots/ import boundary', () => {
	it('never imports outside bots/, and only minicraft-bot/vitest/node:* as bare specifiers', () => {
		const violations = findViolations();
		expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
	});
});
