/**
 * Test-only helpers for the Vite builds in guard.test.ts and env.test.ts.
 * - Every build here is `write: false`: the package `dist` is never touched (parity.test reads it in parallel).
 * - Fixture entries live in an `fs.mkdtemp` dir under the OS temp dir, outside the repo; `cleanup` removes only
 *   the dirs this file created.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type InlineConfig, type Rollup } from 'vite';

const created: string[] = [];

/** A fresh temp dir (fs.mkdtemp) for fixture files. */
export function tempDir(tag: string): string {
	const d = mkdtempSync(join(tmpdir(), `minicraft-bot-${tag}-`));
	created.push(d);
	return d;
}

/** Writes `name` in `dir` and returns its absolute path. */
export function fixture(dir: string, name: string, code: string): string {
	const p = join(dir, name);
	writeFileSync(p, code);
	return p;
}

/** Removes the temp dirs this module created, and nothing else. */
export function cleanup(): void {
	for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Runs one in-memory build and returns the code of every output chunk, joined. */
export async function buildCode(config: InlineConfig): Promise<string> {
	const out = (await build({ configFile: false, logLevel: 'silent', ...config })) as Rollup.RollupOutput | Rollup.RollupOutput[];
	const outputs = Array.isArray(out) ? out : [out];
	return outputs
		.flatMap((o) => o.output)
		.map((c) => (c.type === 'chunk' ? c.code : ''))
		.join('\n');
}
