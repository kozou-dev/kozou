/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    // Allow leading-underscore parameters / variables to be unused. This
    // is the conventional way to mark a deliberately-ignored argument
    // that we still want to keep in the signature (e.g. command stubs
    // that match the production signature).
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  ignorePatterns: [
    'dist/',
    'build/',
    'node_modules/',
    '_*/',
    '*.tgz',
    '.pnpm-store/',
    '.svelte-kit/',
  ],
  overrides: [
    // Svelte single-file components: parse with svelte-eslint-parser
    // and delegate <script lang="ts"> blocks to @typescript-eslint
    // /parser. Without this override, eslint's default TS parser
    // tries to parse the <template> markup directly and errors out
    // on the first '<'.
    {
      files: ['*.svelte'],
      parser: 'svelte-eslint-parser',
      parserOptions: {
        parser: '@typescript-eslint/parser',
      },
      rules: {
        // The Svelte template emits its own assignments through the
        // generated reactive code (let bindings reassigned by event
        // handlers); the base no-unused-vars rule misfires there.
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
    // Kozou v0.1 spec §18.1.1 + Kozou v0.1 license compliance §3:
    // forbid direct PostgREST URL hardcoding. Everything outside
    // svelte-ui's adapter / server is barred from talking to PostgREST
    // directly so that swapping in `@kozou/api` for v1.0 is not a
    // breaking change. This rule is a regression guard.
    {
      files: ['packages/svelte-ui/src/**/*.{ts,svelte}'],
      excludedFiles: [
        'packages/svelte-ui/src/lib/adapter/**',
        'packages/svelte-ui/src/lib/server/**',
      ],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: "Literal[value=/postgrest/i]",
            message:
              'Direct references to PostgREST are forbidden; route the call through DataAdapter (Kozou v0.1 spec §18.1, Kozou v0.1 license compliance §3).',
          },
          {
            selector: "Literal[value=/^https?:\\/\\/postgrest/i]",
            message:
              'Hardcoding a PostgREST URL is forbidden; use env vars like KOZOU_ADAPTER_URL via DataAdapter.',
          },
          {
            selector: "Identifier[name=/^PGRST_/]",
            message:
              'svelte-ui code must not reference PostgREST env vars (PGRST_*) directly; use DataAdapter / server hooks.',
          },
        ],
      },
    },
  ],
};
