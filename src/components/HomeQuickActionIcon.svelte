<script lang="ts">
  import type { HomeQuickAction } from "../lib/homeSurface";

  type Props = {
    icon: HomeQuickAction["icon"];
  };

  let { icon }: Props = $props();
</script>

<span class="home-quick-action-icon" aria-hidden="true">
  {#if icon === "download"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v10" />
      <path d="m7 9 5 5 5-5" />
      <path d="M5 17h14" />
      <path d="M7 20h10" />
    </svg>
  {:else if icon === "plugins"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4v5" />
      <path d="M16 4v5" />
      <path d="M6 9h12v4a6 6 0 0 1-12 0V9Z" />
      <path d="M12 19v2" />
    </svg>
  {:else if icon === "agent"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="7" cy="8" r="3" />
      <circle cx="17" cy="8" r="3" />
      <circle cx="12" cy="17" r="3" />
      <path d="m9.4 10.1 2 4" />
      <path d="m14.6 10.1-2 4" />
    </svg>
  {:else if icon === "settings"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.2" />
      <path d="M12 18.8V21" />
      <path d="M3 12h2.2" />
      <path d="M18.8 12H21" />
      <path d="m5.6 5.6 1.6 1.6" />
      <path d="m16.8 16.8 1.6 1.6" />
      <path d="m18.4 5.6-1.6 1.6" />
      <path d="m7.2 16.8-1.6 1.6" />
    </svg>
  {/if}
</span>

<style>
  .home-quick-action-icon {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    color: #ffffff;
    background: #2f3136;
  }

  .home-quick-action-icon svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
