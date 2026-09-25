import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The SDK's own tests (`npm run test:bot`); the root vitest config only covers src/** and api/src/**.
export default defineConfig({
	root: here,
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		globals: false,
		// Vite builds (guard, env) and world generation (seed 12345 chunks) are slow.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		maxWorkers: 2,
	},
});
