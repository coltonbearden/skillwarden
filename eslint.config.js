import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Plain-JS test helpers/specs run directly under Node (no tsc/type-stripping),
    // so declare the Node globals eslint:recommended's no-undef otherwise flags —
    // TypeScript files are exempt from no-undef via tseslint's eslint-recommended overrides.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
);
