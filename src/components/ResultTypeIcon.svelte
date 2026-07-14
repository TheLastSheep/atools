<script lang="ts">
  import type { ResultFallbackIcon } from "../lib/resultIcons";

  type Props = {
    icon: ResultFallbackIcon;
  };

  let { icon }: Props = $props();
</script>

<span class={`result-type-icon tone-${icon}`} aria-hidden="true">
  {#if icon === "system"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2" />
      <path d="M12 19v2" />
      <path d="M3 12h2" />
      <path d="M19 12h2" />
      <path d="m5.6 5.6 1.4 1.4" />
      <path d="m17 17 1.4 1.4" />
      <path d="m18.4 5.6-1.4 1.4" />
      <path d="m7 17-1.4 1.4" />
    </svg>
  {:else if icon === "app"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <path d="M9 5V3" />
      <path d="M15 5V3" />
      <path d="M9 21v-2" />
      <path d="M15 21v-2" />
      <path d="M3 9h2" />
      <path d="M3 15h2" />
      <path d="M19 9h2" />
      <path d="M19 15h2" />
    </svg>
  {:else if icon === "folder"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7.5h6l1.5 2H20" />
      <path d="M4 7.5v10A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5v-8" />
    </svg>
  {:else if icon === "web"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16" />
      <path d="M12 4a12 12 0 0 1 0 16" />
      <path d="M12 4a12 12 0 0 0 0 16" />
    </svg>
  {:else if icon === "link"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.1 0l1.4-1.4a5 5 0 0 0-7.1-7.1L10.6 5" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8" />
    </svg>
  {:else if icon === "text"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h12" />
      <path d="M12 5v14" />
      <path d="M8 19h8" />
    </svg>
  {:else if icon === "paste"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="5" width="10" height="15" rx="2" />
      <path d="M9.5 5.5A2.5 2.5 0 0 1 12 3a2.5 2.5 0 0 1 2.5 2.5" />
      <path d="M10 11h4" />
      <path d="M10 15h4" />
    </svg>
  {:else if icon === "history"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.3-5.7" />
      <path d="M4 5v5h5" />
      <path d="M12 8v5l3 2" />
    </svg>
  {:else if icon === "alias"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7h10" />
      <path d="M7 12h5" />
      <path d="M7 17h10" />
      <path d="m15 10 3 2-3 2" />
    </svg>
  {:else if icon === "plugin"}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4v5" />
      <path d="M16 4v5" />
      <path d="M6 9h12v4a6 6 0 0 1-12 0V9Z" />
      <path d="M12 19v2" />
    </svg>
  {/if}
</span>

<style>
  .result-type-icon {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));
    border-radius: 7px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-secondary));
  }

  .result-type-icon svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .result-type-icon.tone-web,
  .result-type-icon.tone-link {
    border-color: color-mix(in srgb, #0f9f8f 22%, var(--border));
    color: #0f766e;
    background: color-mix(in srgb, #14b8a6 8%, var(--bg-secondary));
  }

  .result-type-icon.tone-app,
  .result-type-icon.tone-folder {
    border-color: color-mix(in srgb, #2563eb 22%, var(--border));
    color: #2563eb;
    background: color-mix(in srgb, #2563eb 7%, var(--bg-secondary));
  }

  .result-type-icon.tone-text,
  .result-type-icon.tone-paste {
    border-color: color-mix(in srgb, #d97706 22%, var(--border));
    color: #b45309;
    background: color-mix(in srgb, #f59e0b 8%, var(--bg-secondary));
  }

  .result-type-icon.tone-history,
  .result-type-icon.tone-alias {
    border-color: color-mix(in srgb, #7c3aed 22%, var(--border));
    color: #6d28d9;
    background: color-mix(in srgb, #7c3aed 8%, var(--bg-secondary));
  }
</style>
