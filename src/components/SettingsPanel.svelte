<script lang="ts">
  import { onMount } from "svelte";
  import { COMMAND_ALIASES_UPDATED_EVENT, loadCommandAliases, type CommandAliasEntry } from "../lib/commandAliases";
  import { COMMAND_HISTORY_UPDATED_EVENT, loadCommandHistory, type CommandHistoryEntry } from "../lib/commandHistory";
  import { validateShortcut } from "../lib/hotkeyRecorder";
  import type { PluginMarketRequest } from "../lib/pluginMarketNavigation";
  import {
    applyAToolsAppearance,
    createAToolsSettingsWriter,
    dispatchAToolsSettings,
    loadAToolsSettings,
    loadAToolsSettingsSync,
    SettingsSaveCoordinator,
    SettingsSaveDebouncer,
    type AToolsSettings,
  } from "../lib/settings";
  import { registerSettingsSaveFlushOnDestroy } from "../lib/settingsLifecycle";
  import { createSettingsAiController } from "../lib/settingsPanelAiController";
  import { createSettingsDataDebugController } from "../lib/settingsPanelDataDebugController";
  import { createSettingsEntriesController } from "../lib/settingsPanelEntriesController";
  import { createSettingsLocalLaunchController } from "../lib/settingsPanelLocalLaunchController";
  import { createSettingsMcpAboutController } from "../lib/settingsPanelMcpAboutController";
  import {
    applySettingsToState,
    buildCurrentSettings,
    createSettingsPanelState,
  } from "../lib/settingsPanelState.svelte";
  import { iconFor, menuItems, type MenuId } from "../lib/settingsPanelTypesAndOptions";
  import { createSettingsPanelViewModels } from "../lib/settingsPanelViewModels";
  import { createSettingsWebdavController } from "../lib/settingsPanelWebdavController";
  import "../styles/settings-responsive.css";
  import "./SettingsPanelBase.css";
  import "./SettingsPanelCommandCenter.css";
  import "./SettingsPanelControls.css";
  import "./SettingsPanelDomainCards.css";
  import "./SettingsPanelOverview.css";
  import "./SettingsPanelResponsive.css";
  import PluginInventoryPanel from "./PluginInventoryPanel.svelte";
  import PluginMarketPanel from "./PluginMarketPanel.svelte";
  import SettingsCommandsSection from "./SettingsCommandsSection.svelte";
  import SettingsConfirmDialog from "./SettingsConfirmDialog.svelte";
  import SettingsDataSection from "./SettingsDataSection.svelte";
  import SettingsDebugHttpAboutSection from "./SettingsDebugHttpAboutSection.svelte";
  import SettingsGeneralAppearanceSection from "./SettingsGeneralAppearanceSection.svelte";
  import SettingsGeneralBehaviorSection from "./SettingsGeneralBehaviorSection.svelte";
  import SettingsMcpSection from "./SettingsMcpSection.svelte";
  import SettingsProvidersAiSection from "./SettingsProvidersAiSection.svelte";
  import SettingsShortcutsSection from "./SettingsShortcutsSection.svelte";
  import SettingsSyncSection from "./SettingsSyncSection.svelte";
  import SettingsWebLocalSection from "./SettingsWebLocalSection.svelte";

  type Props = {
    initialMenu?: MenuId;
    marketRequest?: PluginMarketRequest | null;
  };

  let { initialMenu = "general", marketRequest = null }: Props = $props();

  const initialSettings = loadAToolsSettingsSync();
  const s = createSettingsPanelState(initialSettings);
  const settingsSaveCoordinator = new SettingsSaveCoordinator(initialSettings, createAToolsSettingsWriter());
  const settingsSaveDebouncer = new SettingsSaveDebouncer(enqueueSettingsSave);
  registerSettingsSaveFlushOnDestroy(settingsSaveDebouncer);
  let lastSavedSettings: AToolsSettings = initialSettings;
  let saveRevision = 0;

  function currentSettings(): AToolsSettings {
    return buildCurrentSettings(s, () => webdavCtrl.webdavConfigReady());
  }

  function applySettings(settings: AToolsSettings) {
    applySettingsToState(s, settings, () => aiCtrl.clearAiConnectionResult());
  }

  function restoreLastSavedSettings() {
    applySettings(lastSavedSettings);
    applyAToolsAppearance(lastSavedSettings);
    dispatchAToolsSettings(lastSavedSettings);
  }

  async function enqueueSettingsSave(settings: AToolsSettings, revision: number) {
    try {
      await settingsSaveCoordinator.enqueue(settings);
      lastSavedSettings = settingsSaveCoordinator.lastSaved();
      if (revision === saveRevision) {
        s.saveState = "saved";
        s.saveErrorMessage = "";
      }
    } catch (error) {
      lastSavedSettings = settingsSaveCoordinator.lastSaved();
      if (revision === saveRevision) {
        restoreLastSavedSettings();
        s.saveState = "error";
        s.saveErrorMessage = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }
  }

  async function saveSettingsImmediately(settings: AToolsSettings) {
    settingsSaveDebouncer.discard();
    const revision = ++saveRevision;
    s.saveState = "saving";
    s.saveErrorMessage = "";
    await enqueueSettingsSave(settings, revision);
  }

  function scheduleSave(settings: AToolsSettings) {
    const revision = ++saveRevision;
    const validation = validateShortcut(settings.hotkey, entriesCtrl.hotkeyPlatform());
    if (!validation.valid) {
      s.saveState = "error";
      s.saveErrorMessage = validation.message;
      settingsSaveDebouncer.discard();
      return;
    }

    s.saveState = "saving";
    s.saveErrorMessage = "";
    settingsSaveDebouncer.schedule(settings, revision);
  }

  function persistSoon() {
    s.dirty = true;
    const settings = currentSettings();
    applyAToolsAppearance(settings);
    dispatchAToolsSettings(settings);
    scheduleSave(settings);
  }

  const aiCtrl = createSettingsAiController(s, {
    persistSoon,
    currentSettings,
    saveSettingsImmediately,
  });

  const dataDebugCtrl = createSettingsDataDebugController(s, {
    currentSettings,
    applySettings,
    persistSoon,
    confirmSettingsAction: aiCtrl.confirmSettingsAction,
  });

  const localLaunchCtrl = createSettingsLocalLaunchController(s, {
    confirmSettingsAction: aiCtrl.confirmSettingsAction,
  });

  const viewModels = createSettingsPanelViewModels(s, {
    currentSettings,
    hotkeyPlatform: () => entriesCtrl.hotkeyPlatform(),
    aiProviderLabel: aiCtrl.aiProviderLabel,
    aiConfigReady: aiCtrl.aiConfigReady,
  });

  const entriesCtrl = createSettingsEntriesController(s, {
    persistSoon,
    confirmSettingsAction: aiCtrl.confirmSettingsAction,
    shortcutSaveText: viewModels.shortcutSaveText,
    aliasTargetOptions: viewModels.aliasTargetOptions,
    shortcutBuiltIns: viewModels.shortcutBuiltIns,
    updateLocalLaunchEntry: localLaunchCtrl.updateLocalLaunchEntry,
  });

  const mcpAboutCtrl = createSettingsMcpAboutController(s, {
    aboutRuntimeInfoText: viewModels.aboutRuntimeInfoText,
    currentDiagnosticBundle: dataDebugCtrl.currentDiagnosticBundle,
  });

  const webdavCtrl = createSettingsWebdavController(s, {
    persistSoon,
    currentSettings,
    saveSettingsImmediately,
    applySettings,
    confirmSettingsAction: aiCtrl.confirmSettingsAction,
    hotkeyPlatform: entriesCtrl.hotkeyPlatform,
    refreshDataPage: dataDebugCtrl.refreshDataPage,
  });

  const actions = {
    menuItems,
    persistSoon,
    ...aiCtrl,
    ...dataDebugCtrl,
    ...localLaunchCtrl,
    ...viewModels,
    ...entriesCtrl,
    ...mcpAboutCtrl,
    ...webdavCtrl,
  };

  $effect(() => {
    s.activeMenu = initialMenu;
  });
  $effect(() => {
    if (marketRequest && marketRequest !== s.handledMarketRequest) s.activeMenu = "market";
  });
  $effect(() => {
    if (s.activeMenu === "market") s.marketVisited = true;
  });

  onMount(() => {
    let cancelled = false;
    const loadTimeout = setTimeout(() => {
      if (s.hydrated) return;
      cancelled = true;
      s.hydrated = true;
      s.saveState = "saved";
      persistSoon();
    }, 800);

    loadAToolsSettings().then((settings) => {
      if (cancelled || s.dirty) return;
      clearTimeout(loadTimeout);
      applySettings(settings);
      settingsSaveCoordinator.hydrate(settings);
      lastSavedSettings = settingsSaveCoordinator.lastSaved();
      dispatchAToolsSettings(settings);
      s.hydrated = true;
      s.saveState = "saved";
    }).catch(() => {
      clearTimeout(loadTimeout);
      s.hydrated = true;
      s.saveState = "error";
    });
    void mcpAboutCtrl.loadMcpInstallHomePath();
    const onCommandHistoryUpdated = (event: Event) => {
      s.commandHistory = (event as CustomEvent<CommandHistoryEntry[]>).detail ?? loadCommandHistory();
    };
    window.addEventListener(COMMAND_HISTORY_UPDATED_EVENT, onCommandHistoryUpdated);
    const onCommandAliasesUpdated = (event: Event) => {
      s.commandAliases = (event as CustomEvent<CommandAliasEntry[]>).detail ?? loadCommandAliases();
    };
    window.addEventListener(COMMAND_ALIASES_UPDATED_EVENT, onCommandAliasesUpdated);
    return () => {
      cancelled = true;
      aiCtrl.resolveSettingsConfirm(false);
      clearTimeout(loadTimeout);
      window.removeEventListener(COMMAND_HISTORY_UPDATED_EVENT, onCommandHistoryUpdated);
      window.removeEventListener(COMMAND_ALIASES_UPDATED_EVENT, onCommandAliasesUpdated);
    };
  });

  $effect(() => {
    if (s.activeMenu === "general") {
      void aiCtrl.refreshAccessibilityPermission();
    } else if (s.activeMenu === "mcp") {
      void mcpAboutCtrl.refreshMcpPage();
    } else if (s.activeMenu === "providers") {
      void aiCtrl.refreshPluginProviders();
    } else if (s.activeMenu === "data") {
      void dataDebugCtrl.refreshDataPage();
    } else if (s.activeMenu === "debug") {
      void dataDebugCtrl.refreshDebugPage();
    } else if (s.activeMenu === "http") {
      void mcpAboutCtrl.refreshMcpPage();
    } else if (s.activeMenu === "about") {
      void mcpAboutCtrl.refreshAboutPage();
    }
  });
</script>

<svelte:window onkeydown={entriesCtrl.onSettingsWindowKeydown} />

<section class="settings-panel">
  <aside class="settings-sidebar" aria-label="设置菜单">
    {#each menuItems as item}
      <button class="menu-item" class:active={s.activeMenu === item.id} onclick={() => s.activeMenu = item.id}>
        <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
          {@html iconFor(item.icon)}
        </svg>
        <span>{item.label}</span>
      </button>
    {/each}
    <span class="save-status" aria-live="polite">
      {s.saveState === "idle" ? "加载中" : s.saveState === "saving" ? "保存中" : s.saveState === "error" ? "保存失败" : "已保存"}
    </span>
  </aside>

  <main class="settings-content">
    {#if s.marketVisited}
      <div class="market-page-holder" hidden={s.activeMenu !== "market"}>
        <PluginMarketPanel
          sharedSession={true}
          visible={s.activeMenu === "market"}
          custom={s.pluginMarketCustom}
          url={s.pluginMarketUrl}
          trustedPublicKeys={s.pluginMarketTrustedPublicKeysText}
          marketRequest={marketRequest !== s.handledMarketRequest ? marketRequest : null}
          confirm={aiCtrl.confirmSettingsAction}
          onRequestHandled={(request) => { s.handledMarketRequest = request; }}
          onManageInstalled={(pluginId) => {
            s.selectedPluginId = pluginId;
            s.pluginFilterQuery = pluginId;
            s.activeMenu = "plugins";
          }}
          onInstalled={(plugin, plugins) => {
            s.selectedPluginId = plugin.id;
            s.installedPlugins = plugins;
          }}
        />
      </div>
    {/if}
    {#if s.activeMenu === "general"}
      <div class="content-panel">
        <SettingsGeneralAppearanceSection
          {...s}
          {...actions}
          bind:hotkey={s.hotkey}
          bind:launchAtLogin={s.launchAtLogin}
          bind:launchAtLoginRuntimeState={s.launchAtLoginRuntimeState}
          bind:showTrayIcon={s.showTrayIcon}
          bind:wakeupBlacklistDraft={s.wakeupBlacklistDraft}
          bind:theme={s.theme}
          bind:primaryColor={s.primaryColor}
          bind:customColor={s.customColor}
          bind:opacity={s.opacity}
          bind:windowMaterial={s.windowMaterial}
        />
        <SettingsGeneralBehaviorSection
          {...s}
          {...actions}
          bind:placeholder={s.placeholder}
          bind:searchMode={s.searchMode}
          bind:showRecentInSearch={s.showRecentInSearch}
          bind:showMatchRecommendation={s.showMatchRecommendation}
          bind:localAppSearch={s.localAppSearch}
          bind:localLaunchSearch={s.localLaunchSearch}
          bind:spaceOpenCommand={s.spaceOpenCommand}
          bind:recentRows={s.recentRows}
          bind:pinnedRows={s.pinnedRows}
          bind:tabKeyFunction={s.tabKeyFunction}
          bind:tabTarget={s.tabTarget}
          bind:autoPaste={s.autoPaste}
          bind:autoClear={s.autoClear}
          bind:autoBackToSearch={s.autoBackToSearch}
          bind:pluginEscapeToSearch={s.pluginEscapeToSearch}
          bind:windowDefaultHeight={s.windowDefaultHeight}
          bind:windowPositionStrategy={s.windowPositionStrategy}
          bind:clipboardRetentionDays={s.clipboardRetentionDays}
          bind:superPanelEnabled={s.superPanelEnabled}
          bind:floatingBallEnabled={s.floatingBallEnabled}
          bind:proxyEnabled={s.proxyEnabled}
          bind:proxyUrl={s.proxyUrl}
          bind:pluginMarketCustom={s.pluginMarketCustom}
          bind:pluginMarketUrl={s.pluginMarketUrl}
          bind:pluginMarketTrustedPublicKeysText={s.pluginMarketTrustedPublicKeysText}
          bind:devToolsMode={s.devToolsMode}
          bind:disableGpuAcceleration={s.disableGpuAcceleration}
        />
      </div>
    {:else if s.activeMenu === "shortcuts"}
      <SettingsShortcutsSection
        {...s}
        {...actions}
        bind:activeShortcutTab={s.activeShortcutTab}
        bind:hotkey={s.hotkey}
        bind:spaceOpenCommand={s.spaceOpenCommand}
        bind:tabKeyFunction={s.tabKeyFunction}
        bind:tabTarget={s.tabTarget}
      />
    {:else if s.activeMenu === "plugins"}
      <div class="content-panel">
        <PluginInventoryPanel
          initialPlugins={s.installedPlugins}
          bind:query={s.pluginFilterQuery}
          bind:selectedPluginId={s.selectedPluginId}
          bind:browseState={s.pluginInventoryBrowseState}
          confirm={aiCtrl.confirmSettingsAction}
          onpluginsloaded={(plugins) => { s.installedPlugins = plugins; }}
          onmarket={() => { s.activeMenu = "market"; }}
        />
      </div>
    {:else if s.activeMenu === "providers" || s.activeMenu === "ai"}
      <SettingsProvidersAiSection
        {...s}
        {...actions}
        bind:aiBaseUrl={s.aiBaseUrl}
        bind:aiDefaultModel={s.aiDefaultModel}
        bind:aiApiKey={s.aiApiKey}
        bind:aiTemperature={s.aiTemperature}
        bind:aiUseForAgent={s.aiUseForAgent}
      />
    {:else if s.activeMenu === "mcp"}
      <SettingsMcpSection {...s} {...actions} bind:activeMenu={s.activeMenu} />
    {:else if s.activeMenu === "web" || s.activeMenu === "local"}
      <SettingsWebLocalSection {...s} {...actions} />
    {:else if s.activeMenu === "commands"}
      <SettingsCommandsSection
        {...s}
        {...actions}
        bind:commandCenterQuery={s.commandCenterQuery}
        bind:commandCenterSourceFilter={s.commandCenterSourceFilter}
        bind:commandCenterStatusFilter={s.commandCenterStatusFilter}
      />
    {:else if s.activeMenu === "data"}
      <SettingsDataSection {...s} {...actions} />
    {:else if s.activeMenu === "sync"}
      <SettingsSyncSection
        {...s}
        {...actions}
        bind:webdavUrl={s.webdavUrl}
        bind:webdavUsername={s.webdavUsername}
        bind:webdavPassword={s.webdavPassword}
        bind:webdavRemotePath={s.webdavRemotePath}
        bind:webdavSyncSettings={s.webdavSyncSettings}
        bind:webdavSyncPlugins={s.webdavSyncPlugins}
        bind:webdavSyncClipboard={s.webdavSyncClipboard}
      />
    {:else}
      <SettingsDebugHttpAboutSection {...s} {...actions} bind:activeMenu={s.activeMenu} />
    {/if}
  </main>
  {#if s.settingsConfirmRequest}
    <SettingsConfirmDialog
      title={s.settingsConfirmRequest.title}
      message={s.settingsConfirmRequest.message}
      confirmLabel={s.settingsConfirmRequest.confirmLabel}
      cancelLabel={s.settingsConfirmRequest.cancelLabel}
      tone={s.settingsConfirmRequest.tone}
      onconfirm={() => aiCtrl.resolveSettingsConfirm(true)}
      oncancel={() => aiCtrl.resolveSettingsConfirm(false)}
    />
  {/if}
</section>

<style>
  :global(:root[data-atools-theme="dark"]) .settings-panel {
    color: #f3f4f6;
    background: rgba(48, 49, 51, 0.92);
    --settings-primary: var(--accent);
    --settings-primary-soft: var(--accent-subtle);
    --settings-hover: color-mix(in srgb, var(--accent) 18%, rgba(255, 255, 255, 0.06));
    --settings-divider: rgba(255, 255, 255, 0.1);
    --settings-control: rgba(255, 255, 255, 0.04);
    --settings-control-border: rgba(255, 255, 255, 0.1);
    --settings-text-secondary: #bfc0c3;
  }

  :global(:root[data-atools-theme="dark"]) .content-panel {
    background: rgba(48, 49, 51, 0.92);
  }

  :global(:root[data-atools-theme="dark"]) .settings-sidebar,
  :global(:root[data-atools-theme="dark"]) .content-panel {
    scrollbar-color: rgba(255, 255, 255, 0.24) transparent;
  }

  :global(:root[data-atools-theme="dark"]) .settings-sidebar::-webkit-scrollbar-thumb,
  :global(:root[data-atools-theme="dark"]) .content-panel::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.24);
  }

  :global(:root[data-atools-theme="dark"]) .settings-sidebar::-webkit-scrollbar-thumb:hover,
  :global(:root[data-atools-theme="dark"]) .content-panel::-webkit-scrollbar-thumb:hover {
    background-color: rgba(255, 255, 255, 0.38);
  }
</style>
