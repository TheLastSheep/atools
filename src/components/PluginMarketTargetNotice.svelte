<script lang="ts">
  import type { MarketTargetState } from "../lib/pluginMarketTarget";
  let { target, retry, retryLabel = "重新查询发布信息", busy = false, installCheck = false }:
    { target: MarketTargetState; retry: () => void; retryLabel?: string; busy?: boolean; installCheck?: boolean } = $props();
</script>

{#if target.status === "unsupported_platform"}
  <section class="target-notice" aria-label="当前平台不支持">
    <strong>当前系统无法使用这个官方发布版</strong>
    <p>{installCheck ? `「${target.name || target.id}」` : ""}官方按插件 ID 返回了平台不支持。获得安装包也不会改变平台要求。{installCheck ? "未开始下载安装。" : ""}</p>
  </section>
{:else if target.status === "not_found"}
  <section class="target-notice" aria-label="未找到官方发布信息">
    <strong>暂未找到这个插件的官方发布信息</strong>
    <p>{installCheck ? `「${target.name || target.id}」` : ""}这次查询没有返回发布记录。可重试，或查看官方目录中的其他插件。{installCheck ? "未开始下载安装。" : ""}</p>
    <button onclick={retry} disabled={busy}>{retryLabel}</button>
  </section>
{:else if target.status === "error"}
  <section class="target-notice" aria-label="官方发布信息查询失败">
    <strong>暂时无法确认官方发布版</strong>
    <p>{installCheck ? `「${target.name || target.id}」` : ""}未能取得发布信息。请检查网络或稍后重试，当前无法安装。</p>
    <button onclick={retry} disabled={busy}>{retryLabel}</button>
    {#if target.error}<details><summary>错误详情</summary><p>{target.error}</p></details>{/if}
  </section>
{/if}

<style>
  .target-notice { padding: 16px; border: 1px solid var(--settings-control-border, #d0d0d0); border-radius: 8px; background: var(--settings-control, #fff); }
  strong { font-size: 14px; line-height: 1.5; } p { margin: 6px 0 10px; font-size: 13px; line-height: 1.6; color: var(--settings-text-secondary, #666); overflow-wrap: anywhere; }
  button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--settings-control-border, #d0d0d0); border-radius: 7px; color: inherit; background: var(--settings-control, #fff); font: inherit; font-size: 13px; cursor: pointer; }
  button:hover { border-color: var(--settings-primary, #2563eb); background: var(--settings-hover, #edf3ff); } button:active { transform: translateY(1px); }
  button:focus-visible, summary:focus-visible { outline: 2px solid var(--settings-primary, #2563eb); outline-offset: 2px; }
  button:disabled { cursor: default; opacity: .5; }
  details { margin-top: 10px; } summary { cursor: pointer; font-size: 12px; }
</style>
