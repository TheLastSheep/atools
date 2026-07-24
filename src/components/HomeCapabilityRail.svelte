<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import type { Capability, InstalledPlugin, McpServerStatus, TaskRun } from "../lib/types";
  import type { ShellPanel } from "../lib/uiState";

  type Props = {
    oncommand: (query: string) => void;
    onpanelchange: (panel: ShellPanel) => void;
  };

  let { oncommand, onpanelchange }: Props = $props();
  let plugins: InstalledPlugin[] = $state([]);
  let capabilities: Capability[] = $state([]);
  let taskRuns: TaskRun[] = $state([]);
  let mcpStatus: McpServerStatus | null = $state(null);
  let runtimeConnected = $state(false);

  const latestRun = $derived(taskRuns[0] ?? null);
  const enabledPluginCount = $derived(plugins.filter((plugin) => plugin.enabled).length);

  onMount(() => {
    void refreshOverview();
  });

  function hasTauriRuntime() {
    const runtime = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    return typeof runtime?.invoke === "function";
  }

  async function refreshOverview() {
    runtimeConnected = hasTauriRuntime();
    if (!runtimeConnected) return;
    const [pluginResult, capabilityResult, runResult, mcpResult] = await Promise.allSettled([
      invoke<InstalledPlugin[]>("list_plugins"),
      invoke<Capability[]>("list_capabilities"),
      invoke<TaskRun[]>("list_task_runs", { limit: 20 }),
      invoke<McpServerStatus | null>("get_mcp_status"),
    ]);
    if (pluginResult.status === "fulfilled") plugins = pluginResult.value;
    if (capabilityResult.status === "fulfilled") capabilities = capabilityResult.value;
    if (runResult.status === "fulfilled") taskRuns = runResult.value;
    if (mcpResult.status === "fulfilled") mcpStatus = mcpResult.value;
  }
</script>

<div class="capability-rail" aria-label="核心能力与运行状态">
  <button class="capability-card result-card" onclick={() => onpanelchange("results")}>
    <span class="capability-kicker"><i class:ready={latestRun?.status === "succeeded"}></i>结果中心</span>
    <strong>{taskRuns.length > 0 ? `${taskRuns.length} 次任务` : "任务历史"}</strong>
    <small>{latestRun?.summary ?? "查看 TaskRun、验收与产物"}</small>
  </button>
  <button class="capability-card" onclick={() => onpanelchange("plugins")}>
    <span class="capability-kicker"><i class:ready={enabledPluginCount > 0}></i>插件生态</span>
    <strong>{runtimeConnected ? `${enabledPluginCount}/${plugins.length} 启用` : "桌面端读取"}</strong>
    <small>管理本地与 ZTools 兼容插件</small>
  </button>
  <button class="capability-card" onclick={() => onpanelchange("agent")}>
    <span class="capability-kicker"><i class:ready={mcpStatus?.enabled}></i>Agent / MCP</span>
    <strong>{mcpStatus?.enabled ? "服务已就绪" : runtimeConnected ? "服务未启动" : "桌面端读取"}</strong>
    <small>{capabilities.length > 0 ? `${capabilities.length} 项统一能力` : "权限、工具与调用审计"}</small>
  </button>
  <button class="capability-card" onclick={() => oncommand("Paste剪切板")}>
    <span class="capability-kicker"><i class="ready"></i>Pasteboard</span>
    <strong>本地剪切板</strong>
    <small>离线历史、检索与分组</small>
  </button>
</div>

<style>
  .capability-rail {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    margin-bottom: 10px;
  }

  .capability-card {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 9px;
    border: 1px solid color-mix(in srgb, var(--border) 90%, transparent);
    border-radius: 10px;
    color: var(--text-primary);
    background: color-mix(in srgb, var(--bg-secondary) 72%, transparent);
    text-align: left;
    transition: border-color 0.12s ease, background 0.12s ease, transform 0.12s ease;
  }

  .capability-card:hover,
  .capability-card:focus-visible {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    background: var(--accent-subtle);
    transform: translateY(-1px);
  }

  .capability-card.result-card {
    border-color: color-mix(in srgb, var(--accent) 34%, var(--border));
    background: color-mix(in srgb, var(--accent-subtle) 66%, var(--bg-primary));
  }

  .capability-kicker {
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 720;
    letter-spacing: 0.025em;
  }

  .capability-kicker i {
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--text-tertiary);
  }

  .capability-kicker i.ready {
    background: #21a366;
    box-shadow: 0 0 0 3px rgba(33, 163, 102, 0.12);
  }

  .capability-card strong,
  .capability-card small {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .capability-card strong {
    font-size: 12px;
    line-height: 1.35;
  }

  .capability-card small {
    color: var(--text-tertiary);
    font-size: 9.5px;
    line-height: 1.35;
  }
</style>
