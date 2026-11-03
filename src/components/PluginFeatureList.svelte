<script lang="ts">
  import { tick } from "svelte";
  import type { PluginFeatureList } from "../lib/pluginFeatureExportsState";
  import { pluginFeatureOptionId } from "../lib/pluginFeatureA11yIds";
  import type { FeatureActiveOptionIdentity, FeatureActiveOptionReport } from "../lib/pluginFeatureActiveDescendant.svelte.js";
  type Props = { state: PluginFeatureList; listboxId: string; onselect: (index: number) => void; onhover: (index: number) => void;
    onpointermove: () => void; onactiveoption: (value: FeatureActiveOptionReport | null, identity: FeatureActiveOptionIdentity) => void;
    resolveIcon: (value: string) => Promise<string> };
  let { state: model, listboxId, onselect, onhover, onpointermove, onactiveoption, resolveIcon }: Props = $props();
  let viewport = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let measuredViewportHeight = $state(0);
  let height = $derived(measuredViewportHeight || 480);
  let icons = $state<Record<number, string>>({});
  const iconCache = new Map<string, Promise<string>>();
  const rowHeight = 64;
  let start = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - 2));
  let end = $derived(Math.min(model.rows.length, start + Math.min(24, Math.ceil(height / rowHeight) + 4)));
  let visible = $derived(model.rows.slice(start, end));
  const activeOptionOwner = Symbol("plugin-feature-active-option-owner");
  $effect(() => {
    const selected = model.selected;
    const revision = model.revision;
    void tick().then(() => {
      if (!viewport || revision !== model.revision || selected !== model.selected) return;
      const top = selected * rowHeight;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + rowHeight > viewport.scrollTop + height) viewport.scrollTop = top + rowHeight - height;
      scrollTop = viewport.scrollTop;
    });
  });
  $effect(() => {
    const epoch = model.epoch, entry = model.entry, revision = model.revision;
    const selected = model.selected;
    const identity = { owner: activeOptionOwner, listboxId, epoch, entry, revision, selected };
    onactiveoption({ ...identity, rendered: model.mode === "list" && visible.some(row => row.index === selected),
      scrollTop, viewportHeight: measuredViewportHeight, rowHeight }, identity);
    return () => onactiveoption(null, identity);
  });
  $effect(() => {
    const rows = visible, revision = model.revision;
    let cancelled = false;
    icons = {};
    void Promise.all(rows.map(async row => {
      let resolved = iconCache.get(row.icon);
      if (!resolved) {
        if (iconCache.size >= 128) iconCache.delete(iconCache.keys().next().value!);
        resolved = resolveIcon(row.icon).catch(() => ""); iconCache.set(row.icon, resolved);
      }
      return [row.index, await resolved] as const;
    })).then(pairs => {
      if (!cancelled && revision === model.revision) icons = Object.fromEntries(pairs);
    });
    return () => { cancelled = true; };
  });
</script>

<section class="feature-list" aria-label={model.mode === "list" ? "插件列表" : "插件执行"}>
  {#if model.error}<div class="feature-error" role="alert">{model.error}</div>{/if}
  {#if model.mode === "none"}
    <div class="feature-empty" role="status">{model.busy ? "正在执行…" : model.error ? "请返回后重试" : "执行完成"}</div>
  {:else}
    <div class="feature-summary"><span>{model.rows.length} 项</span><span>{model.busy ? "正在执行…" : model.selectable ? "↑ ↓ 选择 · Enter 打开" : "↑ ↓ 查看"}</span></div>
    <div bind:this={viewport} bind:clientHeight={measuredViewportHeight} class="feature-viewport" id={listboxId} role="listbox" aria-label="插件结果"
      aria-busy={model.busy} onscroll={() => { onactiveoption(null, { owner: activeOptionOwner, listboxId,
        epoch: model.epoch, entry: model.entry, revision: model.revision, selected: model.selected }); scrollTop = viewport?.scrollTop ?? 0; }}>
      {#if model.rows.length === 0}<div class="feature-empty">{model.error ? "列表未更新" : "暂无结果"}</div>{/if}
      <div class="feature-spacer" style={`height:${model.rows.length * rowHeight}px;`}>
        {#each visible as row (row.index)}
          <button type="button" class="feature-row" class:selected={row.index === model.selected}
            id={pluginFeatureOptionId(listboxId, row.index)} role="option" aria-selected={row.index === model.selected} aria-posinset={row.index + 1} aria-setsize={model.rows.length}
            tabindex="-1" disabled={model.busy || !model.selectable} style={`top:${row.index * rowHeight}px;`}
            onmousemove={() => { onpointermove(); onhover(row.index); }}
            onmouseenter={() => { if (!model.keyboard) onhover(row.index); }}
            onmousedown={event => event.preventDefault()} onclick={() => onselect(row.index)}>
            <span class="feature-icon">{#if icons[row.index]}<img src={icons[row.index]} alt="" draggable="false" />{:else}<span aria-hidden="true">◇</span>{/if}</span>
            <span class="feature-copy"><span class="feature-title">{row.title || "未命名"}</span>
              {#if row.description}<span class="feature-description">{row.description}</span>{/if}</span>
            {#if row.index === model.selected && model.selectable}<span class="feature-enter" aria-hidden="true">↵</span>{/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .feature-list { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; background: var(--bg-primary); color: var(--text-primary); }
  .feature-summary { display: flex; justify-content: space-between; flex-shrink: 0; padding: 10px 16px; color: var(--text-secondary); font: 11px var(--font-sans); border-bottom: 1px solid var(--border); }
  .feature-viewport { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .feature-spacer { position: relative; }
  .feature-row { position: absolute; left: 0; right: 0; display: flex; align-items: center; gap: 12px; height: 64px; width: 100%; padding: 8px 16px; text-align: left; border: none; border-bottom: 1px solid var(--border); background: transparent; color: inherit; cursor: pointer; }
  .feature-row.selected { background: var(--accent-subtle); box-shadow: inset 3px 0 var(--accent); }
  .feature-row:disabled { cursor: wait; opacity: .6; }
  .feature-icon { width: 32px; height: 32px; display: grid; place-items: center; flex-shrink: 0; color: var(--text-secondary); }
  .feature-icon img { width: 28px; height: 28px; object-fit: contain; }
  .feature-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
  .feature-title, .feature-description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .feature-title { font: 500 13px var(--font-sans); }
  .feature-description { color: var(--text-secondary); font: 11px var(--font-sans); }
  .feature-enter { color: var(--text-secondary); font-size: 18px; }
  .feature-empty { padding: 40px 20px; color: var(--text-secondary); text-align: center; font: 13px var(--font-sans); }
  .feature-error { padding: 12px 16px; flex-shrink: 0; background: var(--bg-secondary); color: var(--text-primary); border-bottom: 1px solid var(--border); font: 12px var(--font-sans); overflow-wrap: anywhere; }
</style>
