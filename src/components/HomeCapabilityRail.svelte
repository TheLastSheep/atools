<script lang="ts">
  import type { ShellPanel } from "../lib/uiState";

  type Props = {
    oncommand: (query: string) => void;
    onpanelchange: (panel: ShellPanel) => void;
  };
  let { oncommand, onpanelchange }: Props = $props();

  // Navigation is local: opening the launcher never enumerates plugins or task history.
  const actions: { label: string; hint: string; panel?: ShellPanel; path: string }[] = [
    { label: "剪贴板", hint: "搜索剪贴板历史", path: "M9 4H6a2 2 0 0 0-2 2v14h16V6a2 2 0 0 0-2-2h-3M9 2h6v4H9zM8 11h8M8 15h6" },
    { label: "插件管理", hint: "管理和导入插件", panel: "plugins", path: "M8 3h8v5h5v8h-5v5H8v-5H3V8h5z" },
    { label: "结果中心", hint: "查看任务记录与文件", panel: "results", path: "M4 4h16v16H4zM8 9h8M8 13h8M8 17h5" },
    { label: "Agent / MCP", hint: "工具连接与权限", panel: "agent", path: "M8 8 3 12l5 4M16 8l5 4-5 4M14 4l-4 16" },
  ];
</script>

<nav class="capability-rail" aria-label="常用入口">
  {#each actions as action}
    <button
      title={action.hint}
      onclick={() => action.panel ? onpanelchange(action.panel) : oncommand("Paste剪切板")}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={action.path} /></svg>
      <span>{action.label}</span>
    </button>
  {/each}
</nav>

<style>
  .capability-rail {
    display: flex;
    gap: 4px;
    padding-top: 8px;
    margin-top: auto;
    border-top: 1px solid var(--border);
  }
  button {
    min-width: 0;
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 1;
    padding: 4px 8px;
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 11px;
    transition: background 100ms ease, color 100ms ease;
  }
  button:hover { color: var(--text-primary); background: var(--bg-hover); }
  button:active { background: var(--accent-subtle); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  svg { width: 15px; height: 15px; flex-shrink: 0; }
  span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 480px) {
    button { padding: 4px; gap: 4px; font-size: 10px; }
  }
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
  }
</style>
