<script lang="ts">
  import '../app.css';

  let { data, children } = $props();
</script>

<div class="min-h-screen bg-background text-foreground">
  <header class="border-b border-border">
    <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
      <a href="/" class="text-lg font-semibold">{data.appName}</a>
      <nav class="flex items-center gap-4 text-sm text-muted-foreground">
        <span>{data.tableCount} tables</span>
        <span aria-hidden="true">/</span>
        <span>{data.viewCount} views</span>
      </nav>
    </div>
  </header>
  <main class="mx-auto max-w-5xl px-6 py-8">
    {@render children()}
  </main>
</div>
