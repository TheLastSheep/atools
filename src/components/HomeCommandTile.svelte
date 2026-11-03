<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import ResultTypeIcon from "./ResultTypeIcon.svelte";
  import { homeCommandFallbackIcon } from "../lib/homeSurface";
  import { hasTauriAssetRuntime, resultIconSrc } from "../lib/resultIcons";
  import type { RecommendedCommand } from "../lib/uiState";

  type Events = {
    activate: (command: RecommendedCommand, index: number) => void;
    keydown: (event: KeyboardEvent, index: number, command: RecommendedCommand) => void;
    focus: (command: RecommendedCommand, index: number, button: HTMLButtonElement) => void;
    blur: (button: HTMLButtonElement) => void;
    pointerEnter: (command: RecommendedCommand, index: number, button: HTMLButtonElement) => void;
    pointerLeave: (button: HTMLButtonElement) => void;
    removePointerEnter: (index: number) => void;
    removeFocus: (index: number) => void;
    contextMenu?: (event: MouseEvent, command: RecommendedCommand) => void;
    remove?: (event: MouseEvent, command: RecommendedCommand, index: number) => void;
  };

  type Props = {
    command: RecommendedCommand;
    commandIndex: number;
    selected: boolean;
    pinned: boolean;
    hintId: string;
    hintActive: boolean;
    events: Events;
  };

  let { command, commandIndex, selected, pinned, hintId, hintActive, events }: Props = $props();
  const source = $derived(resultIconSrc(command.icon, hasTauriAssetRuntime(), convertFileSrc));

  function buttonFrom(event: Event) {
    return event.currentTarget as HTMLButtonElement;
  }
</script>

<div
  class="recent-item-shell"
  data-home-command-index={commandIndex}
  class:pinned-item={pinned}
  class:selected={selected}
>
  <button
    class="recent-item"
    tabindex={selected ? 0 : -1}
    onmousedown={(event) => event.preventDefault()}
    onmouseenter={(event) => events.pointerEnter(command, commandIndex, buttonFrom(event))}
    onmouseleave={(event) => events.pointerLeave(buttonFrom(event))}
    onfocus={(event) => events.focus(command, commandIndex, buttonFrom(event))}
    onblur={(event) => events.blur(buttonFrom(event))}
    onclick={() => events.activate(command, commandIndex)}
    oncontextmenu={(event) => events.contextMenu?.(event, command)}
    onkeydown={(event) => events.keydown(event, commandIndex, command)}
    aria-haspopup={events.contextMenu ? "menu" : undefined}
    aria-describedby={hintActive ? hintId : undefined}
  >
    <span class:has-image={Boolean(source)} class="recent-icon">
      {#if source}
        <img src={source} alt="" />
      {:else}
        <ResultTypeIcon icon={homeCommandFallbackIcon(command)} />
      {/if}
    </span>
    <span class="recent-label">{command.label}</span>
  </button>
  {#if command.source === "history" && events.remove}
    <button
      class="recent-remove"
      tabindex="-1"
      aria-label={`移除 ${command.label}`}
      title="从最近使用移除"
      onmouseenter={() => events.removePointerEnter(commandIndex)}
      onfocus={() => events.removeFocus(commandIndex)}
      onclick={(event) => events.remove?.(event, command, commandIndex)}
    >×</button>
  {/if}
</div>

<style>
  .recent-item-shell {
    position: relative;
    min-width: 0;
    height: 86px;
    border-radius: 8px;
  }

  .recent-item {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    padding: 8px 4px;
    border-radius: 8px;
    color: var(--text-primary);
    background: transparent;
    text-align: center;
  }

  .recent-item-shell:hover .recent-item,
  .recent-item-shell.selected .recent-item {
    background: var(--accent-subtle);
  }

  .recent-item-shell.selected .recent-item {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent);
  }

  .recent-item-shell.pinned-item .recent-item {
    background: color-mix(in srgb, var(--accent-subtle) 46%, transparent);
  }

  .recent-item-shell.pinned-item:hover .recent-item,
  .recent-item-shell.pinned-item.selected .recent-item {
    background: var(--accent-subtle);
  }

  .recent-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .recent-item:active { background: var(--accent-subtle); }

  .recent-icon {
    width: 32px;
    height: 32px;
    display: inline-flex;
    flex: 0 0 32px;
    align-items: center;
    justify-content: center;
    border-radius: 7px;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.3);
    font-size: 15px;
    font-weight: 800;
    line-height: 1;
  }

  .recent-icon.has-image {
    overflow: hidden;
    background: color-mix(in srgb, var(--bg-secondary) 88%, var(--bg-primary));
  }

  .recent-icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .recent-icon :global(.result-type-icon) {
    width: 30px;
    height: 30px;
    border: 0;
    color: var(--text-secondary);
    background: transparent;
  }

  .recent-icon :global(.result-type-icon svg) { width: 17px; height: 17px; }

  .recent-label {
    width: 100%;
    height: 32px;
    overflow: hidden;
    padding: 0 4px;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    text-align: center;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    word-break: break-all;
  }

  .recent-remove {
    position: absolute;
    top: 3px;
    right: 4px;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 20%, transparent);
    border-radius: 50%;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-primary) 90%, transparent);
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    opacity: 0;
    transform: scale(0.92);
    transition: opacity 0.12s ease, transform 0.12s ease, color 0.12s ease, background 0.12s ease;
  }

  .recent-item-shell:hover .recent-remove,
  .recent-item-shell:focus-within .recent-remove {
    opacity: 1;
    transform: scale(1);
  }

  .recent-remove:hover {
    color: #dc2626;
    background: rgba(220, 38, 38, 0.1);
  }
</style>
