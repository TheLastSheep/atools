<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ShellPanel } from "../lib/uiState";

  type Props = {
    activePanel: ShellPanel;
    expanded?: boolean;
    contentVisible?: boolean;
    targetHeight?: number;
    search: Snippet;
    children: Snippet;
  };

  let { activePanel, expanded = false, contentVisible = false, targetHeight = 600, search, children }: Props = $props();
</script>

<div class="shell-frame" class:expanded style={`--shell-target-height: ${targetHeight}px`}>
  <header class="shell-search">
    {@render search()}
  </header>

  {#if contentVisible}
    <main class="shell-content" class:panel={activePanel !== "home"}>
      {@render children()}
    </main>
  {/if}
</div>

<style>
  .shell-frame {
    width: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    color: var(--text-primary);
    background: var(--bg-primary);
    opacity: var(--atools-window-opacity, 1);
    border: 1px solid var(--border);
    border-radius: 18px;
    box-shadow:
      0 30px 78px -28px rgba(0, 0, 0, 0.46),
      0 12px 30px -24px rgba(0, 0, 0, 0.5),
      0 1px 0 rgba(255, 255, 255, 0.38) inset;
    backdrop-filter: blur(26px) saturate(1.08);
    animation: slideUp 0.18s var(--ease-out-expo);
  }

  .shell-frame.expanded {
    height: min(100vh, var(--shell-target-height));
  }

  .shell-search {
    flex-shrink: 0;
  }

  .shell-content {
    min-height: 0;
    flex: 1;
    border-top: 1px solid var(--border);
  }
</style>
