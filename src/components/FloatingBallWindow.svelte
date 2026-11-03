<script lang="ts">
  import AToolsMark from "./AToolsMark.svelte";

  let { onOpenMain }: { onOpenMain: () => void | Promise<void> } = $props();
</script>

<main class="floating-ball-shell">
  <button class="floating-ball-button" aria-label="打开 ATools 主搜索" onclick={onOpenMain}>
    <AToolsMark size="small" label="打开 ATools" />
  </button>
</main>

<style>
  .floating-ball-shell {
    width: 100vw;
    height: 100vh;
    display: grid;
    place-items: center;
    background: transparent;
    overflow: hidden;
  }

  .floating-ball-button {
    width: 58px;
    height: 58px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
    border: 1px solid var(--border-strong);
    box-shadow: 0 18px 44px -20px rgba(0, 0, 0, 0.54);
    transition:
      transform 120ms var(--ease-out-expo),
      box-shadow 120ms var(--ease-out-expo);
  }

  .floating-ball-button:hover {
    transform: translateY(-1px);
    box-shadow: 0 20px 48px -20px rgba(0, 0, 0, 0.62);
  }

  .floating-ball-button:active {
    transform: translateY(0) scale(0.97);
  }
</style>
