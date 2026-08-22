import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts', 'api/src/**/*.test.ts'],
		globals: false,
	},
});
