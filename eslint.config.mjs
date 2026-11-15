// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    // ESLint 8 skipped dotfiles and dot-directories by default; the flat
    // config does not. Keep skipping them (e.g. a local .venv or tool caches).
    '**/.*',
    '**/dist/',
    '**/build/',
    '**/node_modules/',
    '**/_*/',
    '**/*.tgz',
    '**/.pnpm-store/',
    '**/.svelte-kit/',
    '**/.next/',
    // Internal example apps (e.g. the Next.js read spike) bring their own
    // framework lint (next lint) and JSX/React conventions; keep them out of
    // the root TypeScript-only eslint config.
    '**/examples/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
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
  },
  // Svelte single-file components: parse with svelte-eslint-parser
  // and delegate <script lang="ts"> blocks to @typescript-eslint
  // /parser. Without this block, eslint's default TS parser
  // tries to parse the <template> markup directly and errors out
  // on the first '<'.
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
      },
      globals: {
        // Svelte components run in the browser; surface DOM globals
        // (HTMLInputElement, HTMLTextAreaElement, Event, ...) to the
        // <script> block so event-handler type casts are recognised.
        ...globals.browser,
      },
    },
    rules: {
      // The Svelte template emits its own assignments through the
      // generated reactive code (let bindings reassigned by event
      // handlers); the base no-unused-vars rule misfires there.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // Forbid direct PostgREST URL hardcoding. Everything outside
  // svelte-ui's adapter / server is barred from talking to PostgREST
  // directly so that swapping in `@kozou/api` for v1.0 is not a
  // breaking change. This rule is a regression guard.
  {
    files: ['packages/svelte-ui/src/**/*.{ts,svelte}'],
    ignores: [
      'packages/svelte-ui/src/lib/adapter/**',
      'packages/svelte-ui/src/lib/server/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/postgrest/i]',
          message:
            'Direct references to PostgREST are forbidden; route the call through DataAdapter.',
        },
        {
          selector: 'Literal[value=/^https?:\\/\\/postgrest/i]',
          message:
            'Hardcoding a PostgREST URL is forbidden; use env vars like KOZOU_ADAPTER_URL via DataAdapter.',
        },
        {
          selector: 'Identifier[name=/^PGRST_/]',
          message:
            'svelte-ui code must not reference PostgREST env vars (PGRST_*) directly; use DataAdapter / server hooks.',
        },
      ],
    },
  },
]);
