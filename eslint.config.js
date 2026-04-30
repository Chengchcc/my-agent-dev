import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

export default [
  // ===== Base TS config =====
  {
    files: ['src/**/*.{ts,tsx}', 'bin/**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: { project: './tsconfig.json' },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
      'react': react,
    },
    settings: { react: { version: '18' } },
    rules: {
      // --- typescript-eslint ---
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // --- react-hooks (prevents the ThinkingMessage/ToolCallMessage class of crash) ---
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // --- react ---
      'react/jsx-key': 'error',
      'react/jsx-no-leaked-render': 'error',

      // --- base ---
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'complexity': ['error', 25],
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],

      // --- magic numbers ---
      '@typescript-eslint/no-magic-numbers': ['error', {
        ignore: [-1, 0, 1, 2],
        ignoreEnums: true,
        ignoreNumericLiteralTypes: true,
        ignoreReadonlyClassProperties: true,
        ignoreTypeIndexes: true,
      }],
    },
  },

  // ===== Test files — relax strict rules =====
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },

  // ===== Config defaults — values are self-documenting via key names =====
  {
    files: ['src/config/defaults.ts', 'src/config/schema.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },

  // ===== bin scripts — allow console =====
  {
    files: ['bin/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
