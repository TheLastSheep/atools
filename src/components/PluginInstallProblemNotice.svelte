<script lang="ts">
  import type { PluginInstallProblem } from "../lib/pluginInstallProblem";

  let { problem }: { problem: PluginInstallProblem } = $props();
</script>

<section class="install-problem" aria-label="安装问题与处理建议">
  <strong>{problem.title}</strong>
  <p>{problem.message}</p>
  <p>{problem.recovery}</p>
  <details>
    <summary>技术详情</summary>
    <pre>{problem.details}</pre>
  </details>
</section>

<style>
  .install-problem { width: 100%; min-width: 0; margin: 10px 0; padding: 12px; border: 1px solid var(--settings-control-border, #dedbe8); border-radius: 8px; background: var(--settings-primary-soft, #f4f0fd); color: inherit; font-size: 13px; line-height: 1.5; }
  strong { display: block; font-weight: 650; }
  p { margin: 5px 0 0; color: var(--settings-text-secondary, #5e5b67); overflow-wrap: anywhere; }
  details { margin-top: 8px; }
  summary { width: fit-content; cursor: pointer; color: var(--settings-text-secondary, #5e5b67); }
  summary:focus-visible { outline: 2px solid var(--settings-primary, #7355d5); outline-offset: 3px; border-radius: 2px; }
  pre { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 7px 0 0; padding: 8px; border-radius: 5px; background: var(--settings-control, #fafafd); font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  @media (max-width: 680px) { .install-problem { padding: 10px; font-size: 12px; } }
  @media (max-width: 360px) { .install-problem { padding: 8px; } }
</style>
