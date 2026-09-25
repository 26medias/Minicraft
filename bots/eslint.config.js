import tseslint from '@typescript-eslint/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';

// No import-boundary rule here: eslint's `no-restricted-imports` patterns can't express "stay inside
// bots/" (see test/boundary.test.ts, which enforces it by resolving paths instead).
export default [
	{
		ignores: ['node_modules/**', '.state/**'],
	},
	...tseslint.configs['flat/recommended'],
	{
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'@typescript-eslint/no-explicit-any': 'warn',
		},
	},
	prettierConfig,
];
