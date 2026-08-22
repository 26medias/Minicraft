import tseslint from '@typescript-eslint/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';

export default [
	{
		ignores: ['dist/**', 'node_modules/**', 'public/atlas.*', 'api/build/**', 'api/node_modules/**'],
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
