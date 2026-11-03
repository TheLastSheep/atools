<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import PluginNavigationBar from "./PluginNavigationBar.svelte";
  import PluginDiagnostics from "./PluginDiagnostics.svelte";
  import PluginWindowSettings from "./PluginWindowSettings.svelte";
  import HostClipboardNotice from "./HostClipboardNotice.svelte";
  import PluginDataNotice from "./PluginDataNotice.svelte";
  import type { PluginHostAction, PluginHostRuntimeChip } from "../lib/pluginHostView";
  import { createPluginWindowPreferencesController, emptyPluginWindowPreferencesState, type PluginWindowPreferencesState } from "../lib/pluginWindowPreferences";
  import type { HostClipboardStatus } from "../lib/hostClipboardController";
  import type { PluginDataStatus } from "../lib/pluginDataController";
  import type { PluginFeatureIntent } from "../lib/pluginFeatureExportsState";
  import { createPluginA11yId } from "../lib/pluginFeatureA11yIds";

  type Props = {
    visible: boolean;
    title: string;
    feature: string;
    actions: PluginHostAction[];
    inputVisible: boolean;
    value: string;
    placeholder: string;
    controlsId?: string;
    activeDescendantId?: string;
    inputRef?: HTMLInputElement | null;
    onInput: (value: string) => void;
    onReturn: () => void | Promise<void>;
    onEscape: () => void;
    onMove: (delta: -1 | 1) => boolean;
    onBoundary: (intent: Exclude<PluginFeatureIntent, "activate">) => boolean;
    onActivate: () => boolean;
    onAction: (actionId: PluginHostAction["id"]) => void;
    showDiagnostics: boolean;
    diagnosticsChips: PluginHostRuntimeChip[];
    diagnosticIdentity: { featureCode: string; source: string };
    displayStatus: PluginDataStatus | null;
    fileDropStatus: string | null;
    hostClipboardStatus: HostClipboardStatus | null;
    dialogsStatus: PluginDataStatus | null;
    pathsStatus: PluginDataStatus | null;
    dataStatus: PluginDataStatus | null;
    reopening: boolean;
    onReopenData: () => void;
    onReopenClipboard: () => void;
    onReopenPaths: () => void;
  };
  let {
    visible, title, feature, actions, inputVisible, value, placeholder, controlsId, activeDescendantId,
    inputRef = $bindable(null), onInput, onReturn, onEscape, onMove, onBoundary, onActivate, onAction,
    showDiagnostics, diagnosticsChips, diagnosticIdentity, displayStatus, fileDropStatus, hostClipboardStatus, dialogsStatus,
    pathsStatus, dataStatus, reopening, onReopenData, onReopenClipboard, onReopenPaths,
  }: Props = $props();

  const diagnosticsRegionId = createPluginA11yId("runtime-info");
  let pluginWindowPreferencesState = $state<PluginWindowPreferencesState>(emptyPluginWindowPreferencesState());
  let detachedPluginRoute = $state(typeof window !== "undefined" && window.location.hash.startsWith("#/plugin-detach"));
  const pluginWindowPreferences = createPluginWindowPreferencesController({
    invoke: (command, args) => invoke(command, args),
    currentPluginId: () => diagnosticIdentity.source,
    onChange: state => { pluginWindowPreferencesState = state; },
  });
  function hasDesktopInvoke(): boolean {
    return typeof window !== "undefined"
      && typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke === "function";
  }
  onMount(() => {
    const updateDetachedRoute = () => {
      detachedPluginRoute = window.location.hash.startsWith("#/plugin-detach");
    };
    window.addEventListener("hashchange", updateDetachedRoute);
    return () => window.removeEventListener("hashchange", updateDetachedRoute);
  });
  const toolbarActions = $derived(actions
    .filter(action => !(detachedPluginRoute && action.id === "detach"))
    .map(action => action.id === "settings"
    ? { ...action, available: action.available || hasDesktopInvoke() }
    : action));
  function handleToolbarAction(actionId: PluginHostAction["id"]): void {
    if (actionId === "settings") {
      const action = toolbarActions.find(item => item.id === "settings");
      if (action?.available) void pluginWindowPreferences.open(diagnosticIdentity.source);
      return;
    }
    onAction(actionId);
  }
  let runtimeInfoExpanded = $state(false);
  let previousDiagnosticIdentity = "";
  $effect(() => {
    const nextIdentity = `${diagnosticIdentity.source}\u0000${diagnosticIdentity.featureCode}`;
    if (nextIdentity !== previousDiagnosticIdentity) {
      previousDiagnosticIdentity = nextIdentity;
      runtimeInfoExpanded = false;
    }
  });
  $effect(() => {
    if (pluginWindowPreferencesState.open && (!visible || pluginWindowPreferencesState.pluginId !== diagnosticIdentity.source)) {
      if (visible) pluginWindowPreferences.pluginChanged(diagnosticIdentity.source);
      else pluginWindowPreferences.close();
    }
  });
  onDestroy(pluginWindowPreferences.dispose);
  const runtimeAttention = $derived(diagnosticsChips.some(chip => chip.tone === "error")
    ? "error"
    : diagnosticsChips.some(chip => chip.tone === "warning") ? "warning" : "none");
  const diagnosticsExpanded = $derived(showDiagnostics || runtimeInfoExpanded);
</script>

{#if visible}
  <PluginNavigationBar title={title} feature={feature} identity={`${diagnosticIdentity.source}\u0000${diagnosticIdentity.featureCode}`} actions={toolbarActions}
    inputVisible={inputVisible} value={value} placeholder={placeholder} controlsId={controlsId}
    activeDescendantId={activeDescendantId} bind:inputRef oninput={onInput} onreturn={onReturn}
    onescape={onEscape} onmove={onMove} onboundary={onBoundary} onactivate={onActivate} onaction={handleToolbarAction}
    runtimeInfo={!showDiagnostics ? {
      controlsId: diagnosticsRegionId, expanded: runtimeInfoExpanded, attention: runtimeAttention,
      onToggle: () => { runtimeInfoExpanded = !runtimeInfoExpanded; },
    } : undefined} />
  <div id={diagnosticsRegionId} class="runtime-diagnostics-region">
    <PluginDiagnostics chips={diagnosticsChips} identity={diagnosticIdentity} expanded={diagnosticsExpanded} />
  </div>
{/if}
{#if visible && fileDropStatus}<div class="file-drop-notice" role="status" aria-live="polite">{fileDropStatus}</div>{/if}
{#if displayStatus}<PluginDataNotice status={displayStatus} busy={reopening} onreopen={onReopenData} />{/if}
{#if hostClipboardStatus}<HostClipboardNotice status={hostClipboardStatus} busy={reopening} onreopen={onReopenClipboard} />{/if}
{#if dialogsStatus}<PluginDataNotice status={dialogsStatus} busy={reopening} onreopen={onReopenData} />{/if}
{#if pathsStatus}<PluginDataNotice status={pathsStatus} busy={reopening} onreopen={onReopenPaths} />{/if}
{#if dataStatus}<PluginDataNotice status={dataStatus} busy={reopening} onreopen={onReopenData} />{/if}
{#if pluginWindowPreferencesState.pluginId === diagnosticIdentity.source}
  <PluginWindowSettings
    preferences={pluginWindowPreferencesState}
    pluginName={title}
    onclose={pluginWindowPreferences.close}
    onautoDetach={enabled => {
      if (pluginWindowPreferencesState.pluginId === diagnosticIdentity.source) void pluginWindowPreferences.setAutoDetach(enabled);
    }}
    onreset={() => {
      if (pluginWindowPreferencesState.pluginId === diagnosticIdentity.source) void pluginWindowPreferences.resetToDefault();
    }}
    onretry={() => {
      if (pluginWindowPreferencesState.pluginId === diagnosticIdentity.source) void pluginWindowPreferences.retry();
    }}
  />
{/if}

<style>
  .file-drop-notice { padding: 8px 16px; border-bottom: 1px solid var(--border-strong); background: var(--bg-tertiary); color: var(--text-primary); font-size: 12px; line-height: 1.5; }
  .runtime-diagnostics-region :global(.plugin-diagnostics > summary) { display: none; }
  .runtime-diagnostics-region :global(.plugin-diagnostics) { border-bottom: 0; }
</style>
