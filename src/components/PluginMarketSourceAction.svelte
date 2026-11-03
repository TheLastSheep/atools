<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  type Props = { sourceUrl: string; runtime: boolean; label?: string;
    callCapability: (name: string, arguments_: Record<string, unknown>) => Promise<unknown> };
  let { sourceUrl, runtime, label = "打开来源", callCapability }: Props = $props();
  let busy = $state(false), status = $state("");
  let generation = 0, alive = true;
  $effect(() => { void sourceUrl; untrack(() => { generation++; busy = false; status = ""; }); });
  onDestroy(() => { alive = false; generation++; });
  async function openSource() {
    const source = sourceUrl.trim(), request = ++generation;
    const current = () => alive && request === generation;
    busy = true; status = "";
    try {
      let url: URL;
      try { url = new URL(source); } catch { throw new Error("插件市场地址格式无效"); }
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("插件市场地址仅支持 http/https");
      if (!runtime) throw new Error("需在桌面应用中打开插件市场地址");
      await callCapability("open_url", { url: source });
      if (current()) status = "已打开插件市场地址";
    } catch (error) { if (current()) status = String(error).replace(/^Error: /, ""); }
    finally { if (current()) busy = false; }
  }
</script>

<div class="market-source-action">
  <button onclick={openSource} disabled={!runtime || busy} title={runtime ? sourceUrl : "需在桌面应用中打开"}>{busy ? "正在打开…" : label}</button>
  {#if status}<p role="status">{status}</p>{/if}
</div>

<style>
  .market-source-action { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--settings-control-border, #d0d0d0); border-radius: 7px; color: inherit; background: var(--settings-control, #fff); font-size: 13px; font-weight: 600; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--settings-primary, #2563eb); background: var(--settings-hover, #edf3ff); }
  button:focus-visible { outline: 2px solid var(--settings-primary, #2563eb); outline-offset: 2px; }
  button:disabled { opacity: .5; cursor: default; }
  p { margin: 0; font-size: 12px; line-height: 1.4; color: var(--settings-text-secondary, #666); }
</style>
