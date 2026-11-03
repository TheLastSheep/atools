<script lang="ts">
  import type { HomeCommandSectionView } from "../lib/homeSurface";

  type Props = {
    section: HomeCommandSectionView;
    onToggle?: () => void;
    onFocus?: (button: HTMLButtonElement) => void;
    onBlur?: (button: HTMLButtonElement) => void;
  };

  let { section, onToggle, onFocus, onBlur }: Props = $props();
</script>

<h2 class="home-section-heading">
  {#if section.canExpand && onToggle}
    <button
      class="home-section-toggle"
      type="button"
      aria-expanded={section.expanded}
      aria-controls={`atools-home-${section.id}-commands`}
      onclick={onToggle}
      onfocus={(event) => onFocus?.(event.currentTarget)}
      onblur={(event) => onBlur?.(event.currentTarget)}
    >
      <span>{section.label}</span>
      <span class="home-section-toggle-label">{section.expanded ? "收起" : `展开 (${section.total})`}</span>
    </button>
  {:else}
    {section.label}
  {/if}
</h2>

<style>
  .home-section-heading {
    display: flex;
    margin: 0 0 4px;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.01em;
  }

  .home-section-heading:not(:first-of-type) { margin-top: 6px; }

  .home-section-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .home-section-toggle:focus-visible {
    border-radius: 3px;
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .home-section-toggle-label {
    flex: 0 0 auto;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
  }

  .home-section-toggle:hover .home-section-toggle-label { color: var(--accent); }
</style>
