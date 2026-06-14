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
    '.next/',
    // Internal example apps (e.g. the Next.js read spike) bring their own
    // framework lint (next lint) and JSX/React conventions; keep them out of
    // the root TypeScript-only eslint config.
    'examples/',
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
      env: {
        // Svelte components run in the browser; surface DOM globals
        // (HTMLInputElement, HTMLTextAreaElement, Event, ...) to the
        // <script> block so event-handler type casts are recognised.
        browser: true,
      },
      rules: {
        // The Svelte template emits its own assignments through the
        // generated reactive code (let bindings reassigned by event
        // handlers); the base no-unused-vars rule misfires there.
        '@typescript-eslint/no-unused-vars': 'off',
        // svelte-eslint-parser treats the <script> block as a nested
        // function scope, so plain `function` declarations inside it
        // trip no-inner-declarations even though they are module-
        // scope inside the compiled component. Conventional Svelte
        // <script> code uses both `function foo() {}` and arrow
        // forms; allow both.
        'no-inner-declarations': 'off',
      },
    },
    // Forbid direct PostgREST URL hardcoding. Everything outside
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
              'Direct references to PostgREST are forbidden; route the call through DataAdapter.',
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
