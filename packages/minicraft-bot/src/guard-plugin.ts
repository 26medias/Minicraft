/**
 * The SDK bundle's import guard (spec §3, §12a). It checks the module graph, never the text: pako
 * legitimately contains `state.window`, and a real three import can be minified past a grep.
 * - `resolveId` throws `GUARD: three` for `three` / `three/*` and `GUARD: asset` for `*.png` or `?url`.
 * - `load` (and again at `buildEnd`, over every module id) throws `GUARD: module <id>` for any resolved
 *   module outside the allow-list below. Resolved absolute paths are checked, so a relative import
 *   can't dodge it.
 * - `transform` throws `GUARD: glob` on `import.meta.glob`.
 * - Rollup virtual ids (`\0…`, e.g. `\0commonjsHelpers.js` for alea's CommonJS) are skipped.
 * - Node built-ins (`node:*`) are external: never bundled, provided by Node at run time.
 *
 * Used by the package's vite.config.ts only; it is not part of the bundle.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

export type GuardOptions = {
	/** The Minicraft repo root. */
	repoRoot: string;
	/** Extra allowed directories (absolute). Tests use it to admit their temp fixture folders; nothing else should. */
	extraAllowed?: string[];
};

/** Directories (repo-relative) whose modules may be bundled. */
export const ALLOWED_DIRS = ['src/engine/world/', 'src/data/', 'src/net/', 'packages/minicraft-bot/src/'] as const;
/** Single files (repo-relative) outside those directories that may be bundled. */
export const ALLOWED_FILES = [
	'src/engine/input/raycast.ts',
	'src/game/tools.ts',
	'src/game/mp-reconnect.ts',
	'src/game/player-constants.ts',
	'src/engine/world/apply-remote.ts',
] as const;
/** Runtime dependencies that may be bundled. */
export const ALLOWED_PACKAGES = ['pako', 'alea', 'simplex-noise'] as const;

function isUnder(dir: string, file: string): boolean {
	const r = relative(dir, file);
	return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}

export function guardPlugin(opts: GuardOptions): Plugin {
	const root = resolve(opts.repoRoot);
	const dirs = [...ALLOWED_DIRS.map((d) => resolve(root, d)), ...(opts.extraAllowed ?? []).map((d) => resolve(d))];
	const files = new Set(ALLOWED_FILES.map((f) => resolve(root, f)));
	const pkgs = ALLOWED_PACKAGES.map((p) => resolve(root, 'node_modules', p));

	/** Throws unless the resolved module id is on the allow-list. */
	const check = (id: string): void => {
		if (id.startsWith('\0')) return;
		if (id.startsWith('node:')) return;
		const file = resolve(id.split('?')[0]);
		if (files.has(file)) return;
		if (dirs.some((d) => isUnder(d, file))) return;
		if (pkgs.some((d) => isUnder(d, file))) return;
		throw new Error(`GUARD: module ${file} is outside the SDK allow-list (packages/minicraft-bot/src/guard-plugin.ts)`);
	};

	return {
		name: 'minicraft-bot-guard',
		// Otherwise Vite's resolver answers first and resolveId never runs.
		enforce: 'pre',
		resolveId(source, importer) {
			if (source.startsWith('\0')) return null;
			if (source === 'three' || source.startsWith('three/')) {
				throw new Error(`GUARD: three (imported by ${importer ?? 'the entry'})`);
			}
			const bare = source.split('?')[0];
			if (/\.png$/i.test(bare) || /[?&]url(&|$)/.test(source)) {
				throw new Error(`GUARD: asset ${source} (imported by ${importer ?? 'the entry'})`);
			}
			return null;
		},
		load(id) {
			check(id);
			return null;
		},
		transform(code, id) {
			if (id.startsWith('\0')) return null;
			if (/import\.meta\.glob\b/.test(code)) throw new Error(`GUARD: glob in ${id}`);
			return null;
		},
		buildEnd(err) {
			if (err) return;
			for (const id of this.getModuleIds()) {
				const info = this.getModuleInfo(id);
				// External built-ins are not bundled; anything else external is refused (ssr.noExternal: true).
				if (info?.isExternal && id.startsWith('node:')) continue;
				check(id);
			}
		},
	};
}
