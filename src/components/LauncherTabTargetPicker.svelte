<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { resolveLauncherTabTarget, tabTargetFromFeature, type LauncherTabTarget } from "../lib/launcherTabTarget";
  import type { SearchResult } from "../lib/types";

  let { value, onchange, loadCatalog = () => invoke<SearchResult[]>("feature_catalog") }: {
    value: LauncherTabTarget | null;
    onchange: (value: LauncherTabTarget | null) => void;
    loadCatalog?: () => Promise<SearchResult[]>;
  } = $props();
  let catalog = $state<SearchResult[]>([]);
  let query = $state("");
  let loading = $state(true);
  let error = $state("");
  let alive = true;
  const resolution = $derived(resolveLauncherTabTarget(value, catalog));
  const filtered = $derived(catalog.filter(feature => `${feature.label} ${feature.plugin_name} ${feature.plugin_id} ${feature.code}`
    .toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 60));
  async function refresh() {
    if (loading && catalog.length) return;
    loading = true; error = "";
    try { const next = await loadCatalog(); if (alive) catalog = next; }
    catch { if (alive) error = "无法读取可用工具，请重试。"; }
    finally { if (alive) loading = false; }
  }
  onMount(() => { void refresh(); return () => { alive = false; }; });
</script>

<div class="tab-target-picker" aria-label="Tab 固定目标">
  <div class="target-current">
    <div>
      <strong>Tab 目标工具</strong>
      <p>主搜索输入按 Tab，将完整原文交给此工具。固定文本、文件和图片使用各自的入口。</p>
      {#if value}
        <span class="current-name">{resolution.status === "ready" ? resolution.feature.label : value.label}</span>
        <small class="identity">{value.pluginId} / {value.code}</small>
      {:else}<span class="current-name">尚未选择</span>{/if}
    </div>
    {#if value}<button type="button" onclick={() => onchange(null)}>清除目标</button>{/if}
  </div>
  {#if !loading && !error && resolution.status !== "ready"}
    <p class="feedback" role="status">{resolution.message}</p>
  {/if}
  <div class="target-search">
    <input type="search" aria-label="搜索 Tab 目标工具" placeholder="搜索工具名称或来源" bind:value={query} />
    <button type="button" onclick={refresh} disabled={loading}>刷新工具</button>
  </div>
  {#if loading}<p role="status">正在读取可用工具…</p>
  {:else if error}<p role="status" class="feedback">{error}</p>
  {:else}
    <div class="target-options" aria-label="可选 Tab 目标工具">
      {#each filtered as feature}
        {@const candidate = resolveLauncherTabTarget(tabTargetFromFeature(feature), catalog)}
        <button type="button" class="target-option" disabled={candidate.status !== "ready"}
          aria-pressed={value?.pluginId === feature.plugin_id && value?.code === feature.code}
          onclick={() => onchange(tabTargetFromFeature(feature))}>
          <span>{feature.label}</span>
          <small>{feature.plugin_name} · {feature.plugin_id} / {feature.code}{candidate.status !== "ready" ? " · 指令冲突" : ""}</small>
        </button>
      {:else}<p role="status">没有匹配的可用工具，请调整搜索或启用插件后刷新。</p>{/each}
    </div>
    {#if filtered.length === 60}<p>仅显示前 60 项，请输入名称缩小范围。</p>{/if}
  {/if}
</div>

<style>
  .tab-target-picker { margin: 8px 0 16px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-secondary); color: var(--text-primary); font-size: 12px; }
  .target-current, .target-search { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
  strong { font-size: 13px; font-weight: 650; }
  p { margin: 6px 0 10px; color: var(--text-secondary); line-height: 1.6; }
  .current-name { font-weight: 650; }
  .identity { margin-left: 8px; color: var(--text-tertiary); overflow-wrap: anywhere; }
  .feedback { color: var(--text-secondary); border-left: 2px solid var(--accent); padding-left: 8px; }
  .target-search { margin-top: 12px; }
  input { min-width: 0; flex: 1; padding: 8px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-primary); color: var(--text-primary); font: inherit; }
  button { flex: 0 0 auto; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-primary); color: var(--text-primary); font: inherit; cursor: pointer; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: .55; cursor: default; }
  .target-options { display: grid; gap: 4px; max-height: 224px; margin-top: 8px; overflow-y: auto; }
  .target-option { display: grid; gap: 3px; text-align: left; }
  .target-option small { color: var(--text-tertiary); overflow-wrap: anywhere; }
  .target-option[aria-pressed="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, var(--bg-primary)); }
  @media (max-width: 480px) { .target-current { align-items: flex-start; } .identity { display: block; margin: 4px 0 0; } }
</style>
