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
        NodeJS: 'readonly', // Allow NodeJS namespace (for Timeout, etc)
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
      // EJ's rule (2026-10-26): no ternaries anywhere. Use a named function or if/else, so
      // every decision has a name. Never a generic iff(cond, a, b) helper: it evaluates both
      // branches eagerly.
      'no-ternary': 'error',
      // ...and no ternary in disguise: a sync immediately-invoked function used to pick a
      // value. Name the function instead. (Async IIFEs, which await, are still allowed.)
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[arguments.length=0] > ArrowFunctionExpression.callee[async=false]',
          message: 'No IIFEs: give the decision a named function.',
        },
        {
          selector: 'CallExpression[arguments.length=0] > FunctionExpression.callee[async=false]',
          message: 'No IIFEs: give the decision a named function.',
        },
      ],
      // TypeScript already checks undefined names; core no-undef misfires on DOM/lib types
      // like RequestInit.
      'no-undef': 'off',

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
