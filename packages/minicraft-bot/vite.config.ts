/**
 * The SDK build (`npm run build:bot`, spec §3 / §12a): one ESM bundle for Node 22 at dist/index.js,
 * built from the game's own modules. The .d.ts rollup is a separate step (dts-bundle-generator).
 */
import { defineConfig, type UserConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardPlugin } from './src/guard-plugin';

export const PKG_ROOT = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(PKG_ROOT, '../..');

/**
 * Env isolation. `envDir` points at an empty folder, so no `.env*` file (e.g. `.env.local` holding the
 * MP token) is read. `envDir` alone does NOT stop Vite inlining `VITE_*` variables from `process.env`,
 * so `envPrefix` is set to a prefix nothing uses. `mode: 'production'` compiles `import.meta.env?.DEV`
 * in world.ts to false.
 */
export const BOT_ENV = {
	envDir: resolve(PKG_ROOT, 'src/empty-env'),
	envPrefix: '__MINICRAFT_BOT_NO_ENV__',
	mode: 'production',
} as const;

export type BotConfigOptions = {
	/** The entry module (default: src/index.ts). Tests pass temp fixtures. */
	entry?: string;
	/** Directories the guard admits besides the allow-list (tests only). */
	extraAllowed?: string[];
	/** false: build in memory (tests). */
	write?: boolean;
};

export function botConfig(opts: BotConfigOptions = {}): UserConfig {
	return {
		root: PKG_ROOT,
		...BOT_ENV,
		// Otherwise public/ (the block atlas) is copied into dist.
		publicDir: false,
		plugins: [guardPlugin({ repoRoot: REPO_ROOT, extraAllowed: opts.extraAllowed })],
		ssr: { noExternal: true, target: 'node' },
		build: {
			ssr: opts.entry ?? resolve(PKG_ROOT, 'src/index.ts'),
			target: 'node22',
			outDir: resolve(PKG_ROOT, 'dist'),
			emptyOutDir: true,
			minify: false,
			sourcemap: false,
			write: opts.write ?? true,
			rollupOptions: { output: { format: 'es', entryFileNames: 'index.js' } },
		},
	};
}

export default defineConfig(botConfig());
