<script lang="ts">
  let { data } = $props();
</script>

<a
  href="/"
  class="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
>
  <span aria-hidden="true">←</span> Dashboard
</a>

<h1 class="mb-1 text-2xl font-semibold">Connect an AI agent</h1>
<p class="mb-8 max-w-3xl text-sm text-muted-foreground">
  Point an AI agent — Claude Desktop, Cursor, or Claude Code — at this database
  over <a
    href="https://modelcontextprotocol.io/"
    class="text-primary underline"
    target="_blank"
    rel="noreferrer">MCP</a
  >. It can then read what your tables, views, and columns
  <em>mean</em> — the descriptions you wrote in <code class="font-mono">COMMENT</code>
  — through seven <strong>read-only</strong> tools. There is no data access and
  no write path on this surface.
</p>

<section class="mb-8 max-w-3xl">
  <h2 class="mb-2 text-lg font-semibold">Endpoint</h2>
  <p class="mb-2 text-sm text-muted-foreground">
    <code class="font-mono">kozou dev</code> already serves the MCP endpoint here
    — no extra command to run:
  </p>
  <pre
    class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm">{data
      .connection.httpUrl}</pre>
</section>

<section class="mb-8 max-w-3xl">
  <h2 class="mb-2 text-lg font-semibold">Claude Desktop &amp; Cursor</h2>
  <p class="mb-2 text-sm text-muted-foreground">
    Add this under <code class="font-mono">mcpServers</code> in the client's MCP
    config, then fully quit and reopen the app. No secret is needed — the server
    already holds the database connection.
  </p>
  <pre
    class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{data
      .connection.jsonConfig}</pre>
</section>

<section class="mb-8 max-w-3xl">
  <h2 class="mb-2 text-lg font-semibold">Claude Code (CLI)</h2>
  <p class="mb-2 text-sm text-muted-foreground">Run this once in your project:</p>
  <pre
    class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm">{data
      .connection.claudeCodeCommand}</pre>
</section>

<section class="mb-8 max-w-3xl rounded-md border border-border p-4">
  <h2 class="mb-1 text-sm font-semibold">Good to know</h2>
  <ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
    <li>
      The tools are <strong>read-only</strong>: an agent can read your schema's
      meaning, never mutate data, through this surface.
    </li>
    <li>{data.connection.authNote}</li>
    <li>
      The URL above uses the host Kozou is configured with
      (<code class="font-mono">localhost</code> by default) and the MCP port; if
      you reach Kozou through a different host — a proxy or another machine —
      adjust the host accordingly.
    </li>
    <li>
      Full setup, the stdio transport, troubleshooting, and what each tool
      returns are in the
      <a
        href="https://kozou.org/guides/connect-mcp/"
        class="text-primary underline"
        target="_blank"
        rel="noreferrer">Connect an AI agent guide</a
      >.
    </li>
  </ul>
</section>
