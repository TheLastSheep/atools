<script lang="ts">
  import { manifestChoiceLabel, parseSourceManifestMetadata, requiresExplicitManifestChoice, type ManifestSelection } from "../lib/pluginSourceBuildManifest";
  import type { SourceBuildInspection } from "../lib/pluginSourceBuildProtocol";
  type Props = { inspection: SourceBuildInspection; confirmed: boolean; requested?: ManifestSelection; disabled: boolean; onchoose: (selection: ManifestSelection) => void };
  let { inspection, confirmed, requested, disabled, onchoose }: Props = $props();
  let metadata = $derived.by(() => {
    const parsed = parseSourceManifestMetadata(inspection);
    return parsed?.kind === "current" ? {
      candidates: parsed.value.manifestCandidates,
      differences: parsed.value.manifestDifferences,
      selectionRequired: requiresExplicitManifestChoice(parsed),
    } : null;
  });
  const differenceLabels: Record<string, string> = { id: "插件标识", version: "版本", main: "入口", preload: "预加载脚本", runtime: "有效运行类型", featureCodes: "功能集合" };
</script>

{#if metadata}
  <section class="manifest-choices" aria-label="源码清单">
    <h4>源码清单</h4>
    <p class="runtime-note">运行类型按清单规则显示有效值；预加载脚本单独列出。</p>
    {#if metadata.differences.length}
      <p class="difference">两份清单存在差异：{metadata.differences.map(item => differenceLabels[item]).join("、")}。{confirmed ? "当前结果已按所选清单重新检查。" : "请明确选择后重新检查。"}</p>
    {:else if metadata.selectionRequired && metadata.candidates[0].status === "invalid" && metadata.candidates[1].status === "valid"}
      <p class="difference">根目录清单不可用，{confirmed ? "当前结果已按所选清单重新检查。" : "请选择另一份清单后重新检查。"}</p>
    {:else if metadata.selectionRequired}
      <p class="difference">检查结果尚未绑定到一份清单，请明确选择后重新检查。</p>
    {/if}
    {#if requested && !confirmed}<p class="difference">正在重新检查你选择的{manifestChoiceLabel(requested)}。</p>{/if}
    <div class="candidates">
      {#each metadata.candidates as item (item.selection)}
        <article class:selected={inspection.manifestSelection === item.selection}>
          <div class="candidate-head">
            <strong>{manifestChoiceLabel(item.selection)}</strong>
            <small class="manifest-path">{item.selection === "root" ? "plugin.json" : "public/plugin.json"}</small>
            {#if item.status === "valid" && inspection.manifestSelection === item.selection && (!metadata.selectionRequired || confirmed)}
              <span class="selected-label">{metadata.selectionRequired ? "已按所选清单重新检查" : "当前检查结果"}</span>
            {/if}
          </div>
          {#if item.status === "valid"}
            <dl>
              <div><dt>插件标识</dt><dd>{item.identity.id}</dd></div>
              <div><dt>版本</dt><dd>{item.identity.version}</dd></div>
              <div><dt>入口</dt><dd>{item.identity.main}</dd></div>
              <div><dt>预加载</dt><dd>{item.identity.preload ?? "无"}</dd></div>
              <div><dt>有效运行类型</dt><dd>{item.identity.runtime}</dd></div>
            </dl>
            <details>
              <summary>功能 {item.identity.featureCodes.length} 项</summary>
              <ul>{#each item.identity.featureCodes as code, index (index)}<li>{code}</li>{/each}</ul>
            </details>
          {:else}
            <p class="unavailable">{item.status === "missing" ? "未找到这份清单。" : "清单无效，不能用于转换。"}</p>
          {/if}
          {#if metadata.selectionRequired && item.status === "valid"}
            <button type="button" aria-pressed={requested === item.selection && confirmed} disabled={disabled || requested === item.selection && confirmed}
              onclick={() => onchoose(item.selection)}>{requested === item.selection && confirmed ? "已选择" : "选择并重新检查"}</button>
          {/if}
        </article>
      {/each}
    </div>
  </section>
{/if}

<style>
  .manifest-choices { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
  h4 { margin: 0 0 5px; color: var(--text-secondary); font-size: 11px; }
  p { margin: 0; color: var(--text-secondary); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
  .runtime-note { margin-bottom: 6px; color: var(--text-tertiary); }
  .difference { margin-bottom: 7px; color: var(--text-primary); }
  .candidates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
  article { min-width: 0; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); }
  article.selected { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
  .candidate-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px; }
  strong { font-size: 11px; }
  .manifest-path { color: var(--text-tertiary); font-size: 10px; }
  .selected-label { color: var(--accent); font-size: 10px; }
  dl { margin: 6px 0; display: grid; gap: 3px; }
  dl div { display: grid; grid-template-columns: 6em minmax(0, 1fr); gap: 5px; font-size: 10px; }
  dt { color: var(--text-tertiary); } dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  details { color: var(--text-secondary); font-size: 10px; }
  summary { cursor: pointer; }
  ul { max-height: 120px; margin: 4px 0 0; padding-left: 16px; overflow: auto; }
  li { overflow-wrap: anywhere; }
  .unavailable { margin-top: 7px; color: var(--text-tertiary); }
  button { min-height: 28px; margin-top: 7px; padding: 3px 8px; border: 1px solid var(--border-strong); border-radius: 5px; color: var(--text-primary); background: var(--bg-tertiary); font-size: 10px; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { cursor: default; opacity: .6; }
  @media (max-width: 520px) { .candidates { grid-template-columns: minmax(0, 1fr); } }
</style>
