<script lang="ts">
  import '../app.css';

  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();
</script>

<div class="min-h-screen bg-background text-foreground">
  <header class="border-b border-border">
    <div class="flex items-center justify-between px-6 py-4">
      <a href="/" class="text-lg font-semibold">{data.appName}</a>
      <nav class="flex items-center gap-4 text-sm text-muted-foreground">
        <span>{data.tableCount} tables</span>
        <span aria-hidden="true">/</span>
        <span>{data.viewCount} views</span>
        {#if data.mcpEnabled}
          <span aria-hidden="true">/</span>
          <a href="/connect" class="text-primary hover:underline">Connect an AI agent</a>
        {/if}
      </nav>
    </div>
  </header>
  <main class="px-6 py-8">
    {@render children()}
  </main>
</div>
