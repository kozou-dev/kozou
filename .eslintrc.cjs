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
  ignorePatterns: [
    'dist/',
    'build/',
    'node_modules/',
    '_*/',
    '*.tgz',
    '.pnpm-store/',
  ],
  overrides: [
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
