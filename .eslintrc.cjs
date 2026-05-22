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
    // Kozou v0.1 spec §18.1.1 + Kozou v0.1 license compliance §3: PostgREST URL hardcode 防止
    // svelte-ui の adapter / server 以外から PostgREST に直接アクセスすることを禁止。
    // v1.0 で `@kozou/api` に切替するときの breaking change を防ぐ regression guard。
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
              'PostgREST への直接参照は禁止。DataAdapter 経由で呼び出すこと (Kozou v0.1 spec §18.1, Kozou v0.1 license compliance §3)。',
          },
          {
            selector: "Literal[value=/^https?:\\/\\/postgrest/i]",
            message:
              'PostgREST URL の直接 hardcode は禁止。KOZOU_ADAPTER_URL 等の env + DataAdapter 経由にする。',
          },
          {
            selector: "Identifier[name=/^PGRST_/]",
            message:
              'PostgREST 環境変数 (PGRST_*) を svelte-ui コードから直接参照することは禁止。DataAdapter / server hooks 経由にする。',
          },
        ],
      },
    },
  ],
};
