<script lang="ts">
  import { onDestroy } from "svelte";
  import { createPluginRuntimeControl, providePluginRuntimeControl } from "../lib/pluginRuntimeControl";
  import ShellFrame from "./ShellFrame.svelte";
  import SearchBar from "./SearchBar.svelte";
  import SettingsHeader from "./SettingsHeader.svelte";
  import PluginLifecycleNotice from "./PluginLifecycleNotice.svelte";
  import PluginPanelMount from "./PluginPanelMount.svelte";
  import PluginBackgroundSessionHost from "./PluginBackgroundSessionHost.svelte";
  import LauncherMainPushHost from "./LauncherMainPushHost.svelte";
  import LauncherResultsSurface, { type LauncherResultsSurfaceProps } from "./LauncherResultsSurface.svelte";
  import type { MainPushState } from "../lib/launcherMainPush";
  import type { MainPushCandidate } from "../lib/pluginMainPushProtocol";
  import type { FeatureAction } from "../lib/types";
  import type { PluginPanelMountExports, PluginPanelMountProps } from "../lib/pluginPanelMount";
  import type { PluginCodeChange } from "../lib/pluginCodeLifecycle";
  import { pluginCodeChangeMessage } from "../lib/pluginCodeLifecycle";
  import type { PluginMarketRequest } from "../lib/pluginMarketNavigation";
  import type { SettingsMenuId } from "../lib/settingsPages";
  import type { ShellPanel } from "../lib/uiState";

  type Props = {
    activePanel: ShellPanel;
    expanded: boolean;
    contentVisible: boolean;
    searchVisible: boolean;
    targetHeight: number;
    activationError: string;
    showSettingsHeader: boolean;
    query: string;
    placeholder: string;
    focusToken: number;
    selectAllToken: number;
    matchSummary: string | null;
    mediaContext: { kind: "files" | "img"; summary: string } | null;
    resultsId?: string;
    resultsExpanded: boolean;
    activeDescendant?: string;
    onQueryChange: (value: string) => void;
    onMediaRemove: () => void;
    onMatchEdit: () => void;
    onMatchRemove: () => void;
    onBadgeClick: () => void;
    onPaste: (event: ClipboardEvent) => boolean | void;
    onPanelChange: (panel: ShellPanel) => void;
    lifecycleNotice: PluginCodeChange | null;
    detached: boolean;
    onReturn: () => void;
    activePlugin: FeatureAction | null;
    pluginPanelProps: PluginPanelMountProps | null;
    backgroundPanelPropsForAction: (action: FeatureAction) => PluginPanelMountProps;
    hidePluginPanel: boolean;
    onPluginPanelInstance: (instance: PluginPanelMountExports | null) => void;
    backgroundEnabled: boolean;
    onBackgroundPluginPanelInstance: (instance: PluginPanelMountExports | null) => void;
    onBackgroundInvalidated: (pluginId: string | null) => void;
    resultsSurface: LauncherResultsSurfaceProps;
    settingsMenu: SettingsMenuId;
    marketRequest: PluginMarketRequest | null;
    onMarketRequest: (request: PluginMarketRequest) => void;
    onMainPushInstance: (instance: ReturnType<typeof LauncherMainPushHost> | undefined) => void;
    mainPushQuery: string;
    mainPushFixed: boolean;
    mainPushFilter: string;
    mainPushActive: boolean;
    mainPushPromotedId: string | null;
    invoke: typeof import("@tauri-apps/api/core").invoke;
    listen: <T>(event: string, receive: (event: { payload: T }) => void) => Promise<() => void>;
    onMainPushClose: () => void | Promise<void>;
    onEscape: () => void | Promise<void>;
    onRedirect: (label: unknown, payload: unknown) => boolean | Promise<boolean>;
    onSettingsRedirect: (menu: "shortcuts" | "ai", detail?: Record<string, unknown>) => boolean | Promise<boolean>;
    onMainPushUpdate: (state: MainPushState) => void;
    onMainPushActivate: (candidate: MainPushCandidate, original: string, commit: (action: FeatureAction) => void,
      isCurrent: () => boolean, closeSelectedRunner: () => Promise<void>) => Promise<void>;
  };

  let {
    activePanel, expanded, contentVisible, searchVisible, targetHeight, activationError, showSettingsHeader,
    query, placeholder, focusToken, selectAllToken, matchSummary, mediaContext, resultsId, resultsExpanded,
    activeDescendant, onQueryChange, onMediaRemove, onMatchEdit, onMatchRemove, onBadgeClick, onPaste,
    onPanelChange, lifecycleNotice, detached, onReturn, activePlugin, pluginPanelProps, hidePluginPanel,
    onPluginPanelInstance, backgroundEnabled, backgroundPanelPropsForAction, onBackgroundPluginPanelInstance, onBackgroundInvalidated,
    resultsSurface, settingsMenu, marketRequest, onMarketRequest, onMainPushInstance,
    mainPushQuery, mainPushFixed, mainPushFilter, mainPushActive, mainPushPromotedId, invoke, listen, onMainPushClose, onEscape,
    onRedirect, onSettingsRedirect, onMainPushUpdate, onMainPushActivate,
  }: Props = $props();

  let mainPushHost: ReturnType<typeof LauncherMainPushHost> | undefined = $state();
  const runtimeControl = createPluginRuntimeControl();
  providePluginRuntimeControl(runtimeControl);
  onDestroy(() => runtimeControl.dispose());
  let backgroundManagedPluginIds = $state<string[]>([]);
  $effect(() => onMainPushInstance(mainPushHost));
</script>

<ShellFrame {activePanel} {expanded} {contentVisible} {searchVisible} {targetHeight}>
  {#snippet search()}
    {#if activationError}
      <p class="plugin-activation-error" role="alert">{activationError}</p>
    {/if}
    {#if showSettingsHeader}
      <SettingsHeader onclose={() => onPanelChange("home")} />
    {:else}
      <SearchBar {query} onchange={onQueryChange} {placeholder} initialFocus prominent={activePlugin === null}
        showBadge={activePlugin === null} {focusToken} {selectAllToken} {matchSummary} {mediaContext}
        onmediaremove={onMediaRemove} onmatchedit={onMatchEdit} onmatchremove={onMatchRemove}
        onbadgeclick={onBadgeClick} onpaste={onPaste} {resultsId} expanded={resultsExpanded} {activeDescendant} />
      {#if lifecycleNotice}
        <PluginLifecycleNotice message={pluginCodeChangeMessage(lifecycleNotice)} {detached} onreturn={onReturn} />
      {/if}
    {/if}
  {/snippet}

  {#if activePlugin}
    {#if activationError && !searchVisible}
      <p class="plugin-activation-error" role="alert">{activationError}</p>
    {/if}
    {#if !hidePluginPanel && !backgroundManagedPluginIds.includes(activePlugin.plugin_id)}
      <PluginPanelMount action={activePlugin} panelProps={pluginPanelProps} oninstance={onPluginPanelInstance} />
    {/if}
  {:else}
    <LauncherResultsSurface {...resultsSurface} />
    {#if activePanel !== "home"}
      {#await import("./SystemPanel.svelte") then module}
        {@const SystemPanel = module.default}
        <SystemPanel panel={activePanel} {settingsMenu} {marketRequest} onmarketrequest={onMarketRequest} onpanelchange={onPanelChange} />
      {/await}
    {/if}
  {/if}

  <LauncherMainPushHost bind:this={mainPushHost} query={mainPushQuery} fixed={mainPushFixed} filter={mainPushFilter}
    active={mainPushActive} {invoke} {listen} onclose={onMainPushClose} onescape={onEscape} onredirect={onRedirect}
    onsettingsredirect={onSettingsRedirect} onupdate={onMainPushUpdate} onactivate={onMainPushActivate} />
</ShellFrame>

<PluginBackgroundSessionHost enabled={backgroundEnabled} activeAction={activePlugin} {mainPushPromotedId}
  panelPropsForAction={backgroundPanelPropsForAction}
  onPanelInstance={onBackgroundPluginPanelInstance} onManagedPlugins={pluginIds => { backgroundManagedPluginIds = pluginIds; }}
  onInvalidated={onBackgroundInvalidated} releaseMainPushForForeground={preservedRunnerId =>
    mainPushHost?.releaseForForeground(preservedRunnerId) ?? Promise.resolve()}
  {invoke} {listen} />

<style>
  .plugin-activation-error { margin: 0; padding: 8px 14px; border-bottom: 1px solid #d6a24a; background: #fff5dc; color: #6b4700; font-size: 12px; line-height: 1.4; }
</style>

