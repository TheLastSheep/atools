<script lang="ts">
  import PluginNavigationBar from "../../src/components/PluginNavigationBar.svelte";
  import type { PluginHostAction } from "../../src/lib/pluginHostView";

  type ActionId = "settings" | "detach";
  type CallbackRecord = { type: "return" | "input" | "action" | "runtime-info" | "body" | "iframe-body"; value?: string; actionId?: ActionId };
  type Props = { onCallback: (record: CallbackRecord) => void };

  let { onCallback }: Props = $props();
  let settingsAvailable = $state(false);
  let inputValue = $state("");
  let runtimeExpanded = $state(false);
  const actions = $derived<PluginHostAction[]>([
    { id: "settings", label: "设置", available: settingsAvailable },
    { id: "detach", label: "分离", available: true },
  ]);

  $effect(() => {
    const updateSettings = (event: Event) => {
      settingsAvailable = Boolean((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener("fixture:set-settings", updateSettings);
    return () => window.removeEventListener("fixture:set-settings", updateSettings);
  });

  $effect(() => {
    const panel = document.querySelector<HTMLElement>("#fixture-runtime-info");
    if (panel) panel.hidden = !runtimeExpanded;
  });

  function recordAction(actionId: PluginHostAction["id"]) {
    if (actionId === "settings" || actionId === "detach") onCallback({ type: "action", actionId });
  }
</script>

<PluginNavigationBar
  title="Harris Live Markdown 中文编辑与多格式文档工作台"
  feature="typora-workbench-long-feature-identifier"
  source="harris.live-markdown"
  identity="harris.live-markdown:browser-fixture"
  {actions}
  inputVisible
  value={inputValue}
  placeholder="在 Harris 插件中搜索文档"
  controlsId="fixture-plugin-results"
  activeDescendantId="fixture-plugin-result-1"
  oninput={(value) => { inputValue = value; onCallback({ type: "input", value }); }}
  onreturn={() => onCallback({ type: "return" })}
  onescape={() => {}}
  onmove={() => false}
  onactivate={() => false}
  onboundary={() => false}
  onaction={recordAction}
  runtimeInfo={{
    controlsId: "fixture-runtime-info",
    expanded: runtimeExpanded,
    attention: "warning",
    onToggle: () => {
      runtimeExpanded = !runtimeExpanded;
      onCallback({ type: "runtime-info" });
    },
  }}
/>
