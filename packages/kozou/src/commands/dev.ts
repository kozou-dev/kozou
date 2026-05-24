// `kozou dev` command implementation.
//
// In v0.1 this is a deliberate stub: the Admin UI (`@kozou/svelte-ui`) is
// scheduled for v0.1.1 per the Kozou v0.1 design spec §16.1.1 B, so there is nothing for the
// dev server to host yet. Until the UI lands, we print a hand-off message
// pointing adopters at `kozou mcp --stdio` for AI agent access.

export type DevOptions = {
  config?: string;
};

const DEV_HANDOFF_MESSAGE =
  'kozou dev: the bundled Admin UI is scheduled for v0.1.1.\n' +
  '  See Kozou v0.1 design spec §16.1.1 B for the roadmap and §8 for the\n' +
  '  @kozou/svelte-ui specification.\n' +
  '\n' +
  '  Available today:\n' +
  '    kozou mcp --stdio   Run the MCP server for AI agent access.\n' +
  '    kozou inspect       Dump the Schema Context as JSON or YAML.\n';

// The leading underscore on `_opts` flags this as a deliberately ignored
// parameter (eslint argsIgnorePattern: ^_). The full DevOptions shape is
// kept in the signature so it matches the v0.1.1 implementation that
// will actually consume the config.
export async function devCommand(_opts: DevOptions = {}): Promise<void> {
  process.stderr.write(DEV_HANDOFF_MESSAGE);
}
