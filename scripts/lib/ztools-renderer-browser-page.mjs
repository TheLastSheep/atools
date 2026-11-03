import assert from "node:assert/strict";

const ACTIVE_CALLBACKS = [
  "onFocusSearch",
  "onAppsChanged",
  "onAppLaunched",
  "onHistoryChanged",
  "onPinnedChanged",
  "onContextMenuCommand",
  "onCommandAliasesChanged",
  "onDisabledCommandsChanged",
  "onPluginsChanged",
  "onShowPluginPlaceholder",
  "onPluginOpened",
  "onPluginLoaded",
  "onPluginClosed",
  "onBackToSearch",
  "onUpdatePlaceholder",
  "onUpdateAutoClear",
  "onUpdateAutoPaste",
  "onUpdatePrimaryColor",
  "onUpdateShowRecentInSearch",
  "onUpdateRecentRows",
  "onUpdatePinnedRows",
  "onUpdateSearchMode",
  "onUpdateMatchRecommendation",
  "onUpdateLocalAppSearch",
  "onUpdateTabKeyFunction",
  "onUpdateTabTarget",
  "onUpdateSpaceOpenCommand",
  "onUpdateSubInputVisible",
  "onUpdateSubInputPlaceholder",
  "onSetSubInputValue",
  "onFocusSubInput",
  "onSelectSubInput",
];

const EVENT_SNAPSHOTS = {
  "tauri://focus": (snapshot) => snapshot?.focusEvents,
  "atools://renderer-app-state": (snapshot) => snapshot?.appState?.eventSource,
  "atools://renderer-app-launched": (snapshot) => snapshot?.appLaunched?.eventSource,
  "atools://renderer-context-menu": (snapshot) => snapshot?.contextMenu?.eventSource,
  "atools://renderer-apps-changed": (snapshot) => snapshot?.appCatalog?.eventSource,
  "atools://renderer-plugins-changed": (snapshot) => snapshot?.pluginCatalog?.eventSource,
  "atools://renderer-settings-view": (snapshot) => snapshot?.settingsView,
  "atools://renderer-command-aliases": (snapshot) => snapshot?.commandAliasEvents,
  "atools://renderer-disabled-commands": (snapshot) => snapshot?.disabledCommandsEvents,
};

const INACTIVE_CALLBACKS = [
  "onAiStatusChanged",
  "onAutoCheckUpdateChanged",
  "onFloatingBallDoubleClickCommand",
  "onFloatingBallFiles",
  "onIpcLaunch",
  "onLocalShortcutsChanged",
  "onRedirectSearch",
  "onSetSearchText",
  "onSuperPanelData",
  "onSuperPanelLaunch",
  "onSuperPanelSearch",
  "onSuperPanelSearchWindowCommands",
  "onSuperPanelTranslation",
  "onSuperPanelWindowCommandsData",
  "onUpdateAcrylicOpacity",
  "onUpdateAvailable",
  "onUpdateAvatar",
  "onUpdateDownloadFailed",
  "onUpdateDownloadStart",
  "onUpdateFloatingBallDoubleClickCommand",
  "onUpdateWindowMaterial",
  "onSuperPanelPinnedChanged",
];
const EXPECTED_CALLBACKS = [...ACTIVE_CALLBACKS, ...INACTIVE_CALLBACKS].sort();

export function assertRendererCallbackCapabilities(capabilities) {
  const events = capabilities?.events;
  assert.ok(events, "Adapter event capability map was not available");
  assert.equal(Object.keys(events).length, EXPECTED_CALLBACKS.length,
    `Host callback catalog must retain all ${EXPECTED_CALLBACKS.length} event descriptions`);
  assert.deepEqual(Object.keys(events).sort(), EXPECTED_CALLBACKS,
    "Host callback names must exactly match the supported and inactive catalog");
  const limited = Object.entries(events).filter(([, state]) => state === "limited").map(([name]) => name).sort();
  assert.deepEqual(limited, [...ACTIVE_CALLBACKS].sort(), "Only the catalogued native-backed callbacks may be limited");
  assert.ok(Object.values(events).every((state) => state === "inactive" || state === "limited"),
    "Unsupported upstream event callbacks must remain inactive");
}

export function assertRendererEventListeners(fixture, adapterSnapshot, eventNames, listenerState) {
  const expected = [...eventNames].sort();
  const active = listenerState === "listening" ? 1 : 0;
  assert.equal(new Set(expected).size, expected.length, "Expected renderer event names must be unique");
  assert.deepEqual([...fixture.listenCalls].sort(), expected,
    "The mounted renderer must register exactly one listener for each supported event");
  assert.equal(fixture.listenCount, expected.length);
  assert.equal(fixture.activeListeners, expected.length * active);
  assert.equal(fixture.unlistenCount, expected.length * (1 - active));
  const eventCounts = Object.fromEntries(expected.map((name) => [name, active]));
  assert.deepEqual(fixture.activeListenersByEvent, eventCounts);
  assert.deepEqual(Object.keys(fixture.emittedEvents).sort(), expected);
  assert.deepEqual(Object.keys(fixture.deliveredEvents).sort(), expected);
  for (const name of expected) {
    assert.ok(Number.isInteger(fixture.emittedEvents[name]) && fixture.emittedEvents[name] >= 0);
    assert.ok(Number.isInteger(fixture.deliveredEvents[name]) && fixture.deliveredEvents[name] >= 0);
    if (name === "tauri://focus") {
      assert.equal(fixture.emittedFocusEvents, fixture.emittedEvents[name]);
      assert.equal(fixture.deliveredFocusEvents, fixture.deliveredEvents[name]);
    }
    const source = EVENT_SNAPSHOTS[name]?.(adapterSnapshot);
    if (name === "atools://renderer-general-settings") {
      assert.equal(adapterSnapshot?.generalPreferenceEvents?.invalidPayloads, 0);
      continue;
    }
    if (name === "atools://renderer-command-aliases") {
      assert.equal(adapterSnapshot?.commandAliasEvents?.invalidPayloads, 0);
    }
    if (name === "atools://renderer-disabled-commands") {
      assert.equal(adapterSnapshot?.disabledCommandsEvents?.invalidPayloads, 0);
    }
    if (name === "atools://renderer-plugins-changed") {
      assert.equal(adapterSnapshot?.pluginCatalog?.invalidPayloads, 0);
    }
    if (name === "atools://renderer-app-launched") {
      assert.equal(adapterSnapshot?.appLaunched?.invalidPayloads, 0);
    }
    assert.ok(source, `Adapter must expose diagnostics for ${name}`);
    assert.equal(source.listenerState, listenerState, `${name} listener state`);
    assert.equal(source.registrationErrors, 0, `${name} registration errors`);
    assert.equal(source.cleanupErrors, 0, `${name} cleanup errors`);
    if ("registrationsPending" in source) assert.equal(source.registrationsPending, 0);
    if ("cleanupPending" in source) assert.equal(source.cleanupPending, 0);
    if ("callbackErrors" in source) assert.equal(source.callbackErrors, 0);
  }
}

export function createZtoolsRendererBrowserPage({
  page,
  evaluate,
  waitFor,
  settleRequests,
  origin,
  eventNames,
  namespacedReadKeys,
  fixtureAppPath,
  fixtureAppAliasName,
  setDocumentKey,
}) {
  async function navigateVariant({ color, scheme, autoClear = "immediately", documentKey }) {
    assert.ok(color === "green" || color === "blue");
    assert.ok(scheme === "light" || scheme === "dark");
    assert.ok(autoClear === "immediately" || autoClear === "never");
    assert.ok(typeof documentKey === "string" && documentKey.length > 0);
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await page.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    const loaded = page.waitForEvent("Page.loadEventFired", 20000);
    setDocumentKey(documentKey);
    await page.send("Page.navigate", {
      url: `${origin}/?color=${color}&scheme=${scheme}&autoClear=${autoClear}`,
    }, { timeoutMs: 10000 });
    await loaded;
    await waitFor("document.querySelector('.search-input') && document.querySelector('.app-container')");
    const expectedEvents = JSON.stringify([...eventNames].sort());
    await waitFor(`(() => {
      const fixture = window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot();
      const adapter = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot();
      const expected = ${expectedEvents};
      return fixture?.settingsBatchLoads === 1
        && fixture.listenCalls.length === expected.length
        && JSON.stringify([...fixture.listenCalls].sort()) === JSON.stringify(expected)
        && JSON.stringify(Object.keys(fixture.activeListenersByEvent).sort()) === JSON.stringify(expected)
        && expected.every(name => fixture.activeListenersByEvent[name] === 1)
        && fixture.activeListeners === expected.length
        && fixture.calls.some(call => call.command === 'list_launcher_apps')
        && fixture.calls.some(call => call.command === 'list_plugins')
        && adapter?.focusEvents?.listenerState === 'listening'
        && adapter?.appState?.eventSource?.listenerState === 'listening'
        && adapter?.appLaunched?.eventSource?.listenerState === 'listening'
        && adapter?.contextMenu?.eventSource?.listenerState === 'listening'
        && adapter?.appCatalog?.eventSource?.listenerState === 'listening'
        && adapter?.settingsView?.listenerState === 'listening'
        && adapter?.commandAliasEvents?.listenerState === 'listening'
        && adapter?.disabledCommandsEvents?.listenerState === 'listening'
        && adapter?.pluginCatalog?.eventSource?.listenerState === 'listening'
        && adapter.imageAnalysis.cacheEntries > 0;
    })()`);
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot()?.updaterStatusReads === 1");
    await waitFor("document.body.classList.contains('theme-' + new URL(location.href).searchParams.get('color'))");
    await settleRequests();

    const state = await evaluate(`(()=>({
      color:document.body.className,
      primary:(()=>{const probe=document.createElement('span');probe.style.color=getComputedStyle(document.body).getPropertyValue('--primary-color').trim();probe.style.cssText+=';position:fixed;visibility:hidden';document.body.append(probe);const value=getComputedStyle(probe).color;probe.remove();return value})(),
      background:getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim(),
      dark:matchMedia('(prefers-color-scheme: dark)').matches,
      input:!!document.querySelector('.search-input'),
      text:document.querySelector('#app')?.innerText?.slice(0,500) || ''
    }))()`);
    const expectedPrimary = {
      light: { green: "rgb(5, 150, 105)", blue: "rgb(2, 132, 199)" },
      dark: { green: "rgb(52, 211, 153)", blue: "rgb(56, 189, 248)" },
    }[scheme][color];
    assert.ok(state.color.includes(`theme-${color}`), `Original body theme class missing: ${JSON.stringify(state)}`);
    assert.equal(state.primary, expectedPrimary, `Original renderer primary color did not apply for ${color}`);
    assert.equal(state.dark, scheme === "dark", "Browser media emulation did not reach the original renderer");
    assert.equal(state.input, true);
    assert.ok(state.text.length > 0, "Original Vue application rendered no visible text");

    const fixture = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot()");
    const adapter = await evaluate("({snapshot:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot(),capabilities:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.capabilities()})");
    assert.ok(adapter.snapshot, "Pinned adapter was not installed before the original app mounted");
    assert.ok(adapter.capabilities?.methods, "Pinned adapter capability map was not available");
    const updaterStatusCalls = fixture.calls.filter((call) => call.command === "get_app_update_status");
    assert.equal(updaterStatusCalls.length, 1, "Each original Main document must read updater status exactly once");
    assert.equal(fixture.updaterStatusReads, 1, "The synthetic updater snapshot must be read once per Main document");
    assert.equal(updaterStatusCalls[0].args, null, "Updater status getter must receive no arguments");
    assert.equal(updaterStatusCalls[0].outcome, "fixture-updater-status");
    assert.deepEqual(fixture.updaterStatus, {
      operation: "idle", update: null, checked: false, lastError: null,
    }, "An idle, unchecked snapshot means no update was observed, not that the app is up to date");
    assert.equal(Object.hasOwn(adapter.capabilities.methods, "updater"), false,
      "The existing method catalog lists callable leaf methods, not namespace objects");
    assert.equal(adapter.capabilities.methods["updater.getDownloadStatus"], "limited");
    assert.equal(adapter.capabilities.methods["updater.showUpdateWindow"], "unavailable");
    assert.equal(adapter.snapshot.nativeCalls.get_app_update_status, 1);
    assert.ok(!adapter.snapshot.unsupportedMethods.includes("updater.getDownloadStatus()"),
      "A supported status snapshot must not be recorded as an unsupported method");
    assertRendererEventListeners(fixture, adapter.snapshot, eventNames, "listening");
    assertRendererCallbackCapabilities(adapter.capabilities);
    assert.equal(adapter.snapshot.focusEvents?.registrationErrors, 0,
      "Native focus listener registration failed before DOM focus verification");
    assert.equal(adapter.snapshot.focusEvents?.listenerState, "listening",
      "Native focus listener did not reach listening state before DOM focus verification");
    assert.equal(adapter.snapshot.focusEvents?.registrationsPending, 0,
      "Native focus listener registration remained pending before DOM focus verification");
    assert.equal(adapter.snapshot.focusEvents?.cleanupPending, 0,
      "Native focus listener cleanup remained pending before DOM focus verification");
    assert.equal(adapter.snapshot.focusEvents?.cleanupErrors, 0,
      "Native focus listener cleanup recorded an error before DOM focus verification");
    const commands = new Set(fixture.calls.map((call) => call.command));
    assert.ok(commands.has("list_launcher_apps") && commands.has("list_plugins"),
      "Original stores did not load the controlled app/plugin catalogs");
    assert.equal(fixture.autoClear, autoClear);
    assert.equal(fixture.settingsBatchLoads, 1, "Original stores must use one settings snapshot read");
    assert.equal(namespacedReadKeys.length, 13, "Fixture must keep the exact 13-key renderer read allowlist");
    assert.equal(fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings").length, 1);
    const settingsBatch = fixture.calls.find((call) => call.command === "get_ztools_renderer_settings");
    assert.equal(settingsBatch.args, null, "Batched settings command must receive no arguments");
    assert.equal(fixture.settingsBatchSummary.version, 1);
    assert.deepEqual(fixture.settingsBatchSummary.keys, [
      "settings-general",
      ...namespacedReadKeys.map((key) => `ztools-renderer:${key}`),
    ].sort());
    assert.deepEqual(fixture.settingsBatchSummary.nullKeys, namespacedReadKeys
      .filter((key) => !["command-aliases", "command-usage-stats"].includes(key))
      .map((key) => `ztools-renderer:${key}`).sort());
    assert.deepEqual(fixture.settingsBatchSummary.nonNullNamespacedKeys, [
      "ztools-renderer:command-aliases",
      "ztools-renderer:command-usage-stats",
    ].sort(), "Only configured app aliases and the fixed plugin usage fixture are non-null among namespaced reads");
    assert.deepEqual(fixture.settingsBatchSummary.commandAliases, {
      [`direct:app:${fixtureAppPath}`]: [{ alias: fixtureAppAliasName }],
    }, "The original renderer must receive the exact path-keyed app alias configuration");
    assert.equal(fixture.settingsBatchSummary.settingsGeneral.theme, "system");
    assert.equal(fixture.settingsBatchSummary.settingsGeneral.primaryColor, color);
    assert.equal(fixture.settingsBatchSummary.settingsGeneral.autoClear, autoClear);
    assert.equal(fixture.settingsBatchSummary.settingsGeneral.showRecentInSearch, true);
    assert.equal(fixture.settingsBatchSummary.settingsGeneral.autoPaste, "never",
      "The fixture must disable auto-paste so focus tests never access the real clipboard");
    assert.equal(adapter.snapshot.nativeCalls.get_ztools_renderer_settings, 1);
    assert.ok(!adapter.snapshot.unsupportedMethods.includes("getLastCopiedContent()"),
      "The controlled autoPaste=never fixture must not call the unsupported clipboard bridge");
    assert.equal(adapter.capabilities.methods.getLastCopiedContent, "limited",
      "The clipboard reader is exposed as a bounded typed capability; auto-paste remains unused in this document");
    assert.equal(fixture.calls.filter((call) => call.command === "get_setting").length, 0,
      "Original renderer must not call the legacy per-key settings route");
    assert.equal(fixture.calls.filter((call) => call.command === "list_launcher_apps").length, 1);
    assert.equal(fixture.calls.filter((call) => call.command === "list_plugins").length, 1);
    assert.equal(fixture.rejected.length, 0, "Fixture rejected a native route unexpectedly");
    return { documentKey, scheme, color, autoClear, fixture, adapter, state };
  }

  return Object.freeze({ navigateVariant });
}
