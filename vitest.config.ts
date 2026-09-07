import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts', 'api/src/**/*.test.ts'],
		globals: false,
		// Local-time rules (schedule gate, day rollover) must be tested in a zone
		// where local and UTC dates differ, or a UTC-getter build passes in CI.
		env: { TZ: 'America/Toronto' },
	},
});
