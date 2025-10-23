import js from '@eslint/js';
import globals from 'globals';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // TypeScript rules - relaxed for practical development
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'off', // Allow any - we're practical here

      // General rules
      'no-console': 'off', // Allow console.log for server applications
      'no-unused-vars': 'off', // Use TypeScript version instead
      'prefer-const': 'warn',
      'no-var': 'error',
      'eqeqeq': ['error', 'allow-null'],
      'curly': ['error', 'all'],

      // Relaxed rules for practical development
      'no-empty': ['error', { allowEmptyCatch: true }], // Allow empty catch blocks
      'no-case-declarations': 'warn', // Warn instead of error
      'no-useless-escape': 'warn', // Warn instead of error
      'no-prototype-builtins': 'warn', // Warn instead of error
    },
  },
  {
    files: ['**/*.test.{js,ts}', '**/*.spec.{js,ts}'],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.vitest,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // Allow any in tests
      '@typescript-eslint/no-unused-vars': 'off', // Allow unused vars in tests
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/test-*.ts', // Ignore test scripts
      'mcp-servers/**/node_modules/**',
      'mcp-servers/**/dist/**',
      'packages/brain/**', // Brain has its own config
    ],
  },
  prettierConfig, // Must be last to override conflicting rules
];
