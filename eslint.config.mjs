import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'server/data/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'e2e/.data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // An underscore marks a value that is deliberately unused (an ignored argument, a rest-spread omission).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['server/**/*.ts', 'e2e/**/*.ts', 'e2e/**/*.mjs', '*.config.*', 'playwright.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
