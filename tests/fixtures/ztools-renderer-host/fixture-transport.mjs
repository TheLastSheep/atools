import { createRendererAppStateBrowserFixture } from "../../../scripts/lib/ztools-renderer-app-state-browser-fixture.mjs";
import { createRendererRecommendationBrowserFixture } from "../../../scripts/lib/ztools-renderer-recommendation-browser-fixture.mjs";

export const FIXTURE_APP_NAME = "ATools Renderer Fixture App";
export const FIXTURE_APP_PATH = "/fixture/apps/atools-renderer-fixture.app";
export const FIXTURE_APP_ALIAS_NAME = "ATools Alias Fixture";
export const FIXTURE_UPDATED_ALIAS_NAME = "ATools Updated Alias Fixture";
export const RENDERER_EVENT_NAMES = Object.freeze([
  "tauri://focus",
  "atools://renderer-app-state",
  "atools://renderer-app-launched",
  "atools://renderer-context-menu",
  "atools://renderer-apps-changed",
  "atools://renderer-settings-view",
  "atools://renderer-general-settings",
  "atools://renderer-command-aliases",
  "atools://renderer-disabled-commands",
  "atools://renderer-plugins-changed",
  "atools://renderer-local-shortcuts",
]);

export const NAMESPACED_READ_KEYS = [
  "command-aliases",
  "disable-commands",
  "enabled-main-push-plugin",
  "search-preference",
  "recommendation-pinned",
  "command-history",
  "pinned-commands",
  "out-kill-plugin",
  "auto-detach-plugin",
  "auto-start-plugin",
  "super-panel-pinned",
  "local-shortcuts",
  "command-usage-stats",
];

function installRendererFixtureTransport(options, createAppStateFixture, rendererEventNames, createRecommendationFixture) {
  const eventNames = new Set(rendererEventNames);
  const apps = [{ name: options.appName, path: options.appPath, icon: null }];
  const commandAliases = {
    [`direct:app:${options.appPath.replace(/\\/g, "/")}`]: [{ alias: options.aliasName }],
  };
  function isAllowedAppIdentity(identity) {
    if (!identity || typeof identity !== "object") return false;
    const app = apps.find(entry => entry.path === identity.path);
    if (!app) return false;
    if (app.name === identity.name) return true;
    const key = `direct:app:${app.path.replace(/\\/g, "/")}`;
    return (commandAliases[key] || []).some(entry => entry.alias === identity.name);
  }
  const state = {
    calls: [],
    listenCalls: [],
    listenCount: 0,
    unlistenCount: 0,
    activeListeners: 0,
    activeListenersByEvent: Object.fromEntries(rendererEventNames.map(name => [name, 0])),
    emittedFocusEvents: 0,
    deliveredFocusEvents: 0,
    emittedEvents: Object.fromEntries(rendererEventNames.map(name => [name, 0])),
    deliveredEvents: Object.fromEntries(rendererEventNames.map(name => [name, 0])),
    settingsBatchLoads: 0,
    settingsBatchSummary: null,
    updaterStatusReads: 0,
    updaterStatus: { operation: "idle", update: null, checked: false, lastError: null },
    settingWrites: [],
    agentToolIntents: [],
    appLaunchIntents: [],
    launchFailures: 0,
    appStateMutations: [],
    appStateReceipts: [],
    contextMenus: [],
    contextMenuSelections: [],
    contextMenuRepliesResolved: 0,
    rejected: [],
    overflowCalls: 0,
    theme: null,
    primaryColor: null,
    lastCommandAliasPayloadIsNull: null,
  };
  const params = new URL(window.location.href).searchParams;
  const recommendationActive = params.get("recommendationFixture") === "1";
  const recommendation = createRecommendationFixture(recommendationActive, params.get("recommendationVersion") === "2" ? 2 : 1);
  let releaseStartup;
  const startupGate = params.get("holdRendererStartup") === "1"
    ? new Promise(resolve => { releaseStartup = resolve; }) : null;
  state.startupHeld = false;
  const primaryColor = params.get("color") || "green";
  const autoClear = params.get("autoClear") || "immediately";
  if (!new Set(["green", "blue"]).has(primaryColor)) {
    throw new Error("Fixture URL must select the green or blue original theme color");
  }
  if (!new Set(["immediately", "never"]).has(autoClear)) {
    throw new Error("Fixture URL must select immediately or never for autoClear");
  }
  state.primaryColor = primaryColor;
  state.theme = params.get("scheme") || "light";
  state.autoClear = autoClear;
  state.pluginUsageSetting = JSON.stringify([
    { path: "/fixture/plugins/usage-example", featureCode: "usage-example", useCount: 7 },
  ]);
  const listeners = new Map();
  const pendingMenuReplies = [];
  let nextListenerId = 0;
  let failNextLaunch = false;

  function argumentSummary(command, args) {
    if (command === "get_setting" && args && typeof args.key === "string") {
      return { key: args.key };
    }
    if (command === "set_setting" && args && typeof args.key === "string") {
      return { key: args.key, valueBytes: typeof args.value === "string" ? args.value.length : null };
    }
    if (command === "call_agent_tool" && args && typeof args === "object") return { keys: Object.keys(args).slice(0, 8).sort() };
    if (command === "launch_renderer_app" && args?.target) {
      return { target: { path: args.target.path, name: args.target.name } };
    }
    if (command === "mutate_renderer_app_state" && args?.request) {
      return { operation: args.request.operation };
    }
    if (command === "show_renderer_context_menu" && Array.isArray(args?.items)) {
      return { itemCount: args.items.length };
    }
    if (command === "expand_window" && args && Number.isInteger(args.height)) {
      return { height: args.height };
    }
    if (args === undefined || args === null) return null;
    return { keys: Object.keys(args).slice(0, 12).sort() };
  }

  function record(command, args, outcome) {
    if (state.calls.length >= 256) {
      state.overflowCalls += 1;
      return;
    }
    state.calls.push({ command, args: argumentSummary(command, args), outcome });
  }

  function deliver(event, payload) {
    let delivered = 0;
    for (const entry of listeners.values()) {
      if (entry.event !== event) continue;
      try {
        entry.handler(event === "tauri://focus" ? undefined : payload);
        delivered += 1;
        state.deliveredEvents[event] += 1;
        if (event === "tauri://focus") state.deliveredFocusEvents += 1;
      } catch {
        state.rejected.push(`handler:${event}`);
      }
    }
    return delivered;
  }

  const appStateFixture = createAppStateFixture({
    apps,
    commandAliases,
    state,
    emit(payload) {
      state.emittedEvents["atools://renderer-app-state"] += 1;
      deliver("atools://renderer-app-state", payload);
    },
  });

  function noArguments(command, args) {
    if (args !== undefined && (!args || typeof args !== "object" || Object.keys(args).length !== 0)) {
      record(command, args, "rejected-arguments");
      throw new Error(`Fixture rejected arguments for ${command}`);
    }
  }

  async function invoke(command, args) {
    switch (command) {
      case "get_ztools_renderer_settings": {
        if (args !== undefined) {
          record(command, args, "rejected-arguments");
          throw new Error("Fixture requires get_ztools_renderer_settings to receive no arguments");
        }
        record(command, args, "fixture-settings-snapshot");
        state.settingsBatchLoads += 1;
        const settings = {
          "settings-general": JSON.stringify({
            theme: "system",
            primaryColor,
            autoClear,
            autoPaste: "never",
            placeholder: "搜索应用和指令",
            showRecentInSearch: true,
            showMatchRecommendation: recommendationActive,
            searchMode: "aggregate",
          }),
        };
        for (const key of options.readKeys) settings[`ztools-renderer:${key}`] = null;
        settings["ztools-renderer:command-aliases"] = JSON.stringify(commandAliases);
        settings["ztools-renderer:command-history"] = appStateFixture.snapshot().values["command-history"];
        settings["ztools-renderer:pinned-commands"] = appStateFixture.snapshot().values["pinned-commands"];
        settings["ztools-renderer:command-usage-stats"] = state.pluginUsageSetting;
        settings["ztools-renderer:recommendation-pinned"] = recommendation.raw();
        state.settingsBatchSummary = {
          version: 1,
          keys: Object.keys(settings).sort(),
          nullKeys: Object.entries(settings).filter(([, value]) => value === null)
            .map(([key]) => key).sort(),
          nonNullNamespacedKeys: Object.entries(settings)
            .filter(([key, value]) => key.startsWith("ztools-renderer:") && value !== null)
            .map(([key]) => key).sort(),
          commandAliases: JSON.parse(settings["ztools-renderer:command-aliases"]),
          settingsGeneral: JSON.parse(settings["settings-general"]),
        };
        return { version: 1, settings };
      }
      case "get_app_update_status": {
        if (args !== undefined) {
          record(command, args, "rejected-arguments");
          throw new Error("Fixture requires get_app_update_status to receive no arguments");
        }
        state.updaterStatusReads += 1;
        record(command, args, "fixture-updater-status");
        return { ...state.updaterStatus };
      }
      case "list_launcher_apps":
        noArguments(command, args);
        record(command, args, "fixture-catalog");
        if (startupGate) { state.startupHeld = true; await startupGate; }
        return apps;
      case "list_plugins":
        noArguments(command, args);
        record(command, args, recommendationActive ? "fixture-recommendation-metadata" : "fixture-empty-inventory");
        return recommendation.plugins();
      case "save_renderer_recommendation_pins":
        record(command, args, "fixture-recommendation-cas");
        return recommendation.save(args);
      case "get_setting": {
        record(command, args, "rejected-legacy-settings-route");
        state.rejected.push("get_setting");
        throw new Error("Fixture requires the batched get_ztools_renderer_settings route");
      }
      case "set_setting": {
        const keys = args && typeof args === "object" ? Object.keys(args).sort() : [];
        if (keys.length !== 2 || keys[0] !== "key" || keys[1] !== "value"
          || args.key !== "ztools-renderer:search-preference"
          || typeof args.value !== "string" || args.value.length > 128 * 1024) {
          record(command, args, "rejected-write");
          throw new Error("Fixture only records the bounded search-preference setting write");
        }
        let parsed;
        try { parsed = JSON.parse(args.value); } catch { parsed = null; }
        const plainObject = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          && Object.getPrototypeOf(parsed) === Object.prototype;
        const entries = plainObject ? Object.entries(parsed) : [];
        const fixtureNames = new Set([options.appName, options.aliasName]);
        const validEntries = entries.length >= 1 && entries.length <= fixtureNames.size
          && entries.every(([query, entry]) => entry && typeof entry === "object" && !Array.isArray(entry)
          && Object.getPrototypeOf(entry) === Object.prototype
          && entry.path === options.appPath && fixtureNames.has(entry.name)
          && query === entry.name.toLowerCase()
          && (entry.featureCode === undefined || typeof entry.featureCode === "string")
          && Object.keys(entry).every(key => ["path", "featureCode", "name"].includes(key)));
        if (!plainObject || !validEntries) {
          record(command, args, "rejected-write-shape");
          throw new Error("Fixture rejected an unrecognized search-preference write shape");
        }
        record(command, args, "fixture-write-intent-not-persisted");
        state.settingWrites.push({
          key: args.key,
          valueBytes: args.value.length,
          entryCount: entries.length,
          entriesMatchFixtureAppNames: true,
        });
        return null;
      }
      case "call_agent_tool": {
        const keys = args && typeof args === "object" ? Object.keys(args).sort() : [];
        const toolArgs = args?.arguments;
        const toolKeys = toolArgs && typeof toolArgs === "object" ? Object.keys(toolArgs).sort() : [];
        const valid = keys.join(",") === "arguments,clientId,confirmed,name"
          && args.name === "open_or_reveal_path" && args.clientId === "atools-ui" && args.confirmed === true
          && toolKeys.join(",") === "path,reveal" && toolArgs.path === options.appPath && toolArgs.reveal === false;
        if (!valid) {
          record(command, args, "rejected-agent-tool");
          state.rejected.push("call_agent_tool");
          throw new Error("Fixture only records the exact open_or_reveal_path intent for its catalog app");
        }
        const intent = {
          name: args.name,
          arguments: { path: toolArgs.path, reveal: toolArgs.reveal },
          clientId: args.clientId,
          confirmed: args.confirmed,
          taskRunPersisted: false,
        };
        record(command, args, "fixture-agent-tool-intent-not-persisted");
        state.agentToolIntents.push(intent);
        return null;
      }
      case "launch_renderer_app": {
        const keys = args && typeof args === "object" ? Object.keys(args).sort() : [];
        if (keys.join(",") !== "target") throw new Error("Fixture rejected launch route fields");
        const identity = args.target;
        if (!identity || typeof identity !== "object" || Object.keys(identity).sort().join(",") !== "name,path"
          || typeof identity.path !== "string" || typeof identity.name !== "string"
          || !isAllowedAppIdentity(identity)) {
          throw new Error("Fixture rejected a launch target outside its catalog app and configured alias");
        }
        if (failNextLaunch) {
          failNextLaunch = false;
          state.launchFailures += 1;
          record(command, args, "fixture-launch-failed");
          throw new Error("Fixture app launch failed");
        }
        const intent = { target: identity, taskRunPersisted: false, processOpened: false };
        record(command, args, "fixture-launch-intent");
        state.appLaunchIntents.push(intent);
        const receipt = appStateFixture.launch(identity);
        state.emittedEvents["atools://renderer-app-launched"] += 1;
        deliver("atools://renderer-app-launched", null);
        return receipt;
      }
      case "mutate_renderer_app_state": {
        if (!args || typeof args !== "object" || Object.keys(args).sort().join(",") !== "request") {
          throw new Error("Fixture rejected native app-state mutation arguments");
        }
        record(command, args, "fixture-app-state-mutation");
        const receipt = appStateFixture.mutate(args.request);
        return receipt;
      }
      case "show_renderer_context_menu": {
        if (!args || typeof args !== "object" || Object.keys(args).sort().join(",") !== "items"
          || !Array.isArray(args.items) || args.items.length > 64) {
          throw new Error("Fixture rejected native context-menu arguments");
        }
        const items = args.items.map(item => {
          if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some(key => !["id", "label", "type", "enabled"].includes(key))) {
            throw new Error("Fixture rejected context-menu item fields");
          }
          if (item.type === "separator") return { type: "separator" };
          if (typeof item.id !== "string" || item.id.length > 16 * 1024
            || typeof item.label !== "string" || item.label.length > 512
            || (item.enabled !== undefined && typeof item.enabled !== "boolean")) {
            throw new Error("Fixture rejected context-menu item shape");
          }
          return { id: item.id, label: item.label, ...(item.enabled === undefined ? {} : { enabled: item.enabled }) };
        });
        const entry = { items, replyPending: true };
        state.contextMenus.push(entry);
        record(command, args, "fixture-native-menu-intent");
        return new Promise(resolve => pendingMenuReplies.push(() => {
          entry.replyPending = false;
          state.contextMenuRepliesResolved += 1;
          resolve(null);
        }));
      }
      case "expand_window": {
        const keys = args && typeof args === "object" ? Object.keys(args) : [];
        if (keys.length !== 1 || !Number.isInteger(args.height) || args.height < 1 || args.height > 10_000) {
          record(command, args, "rejected-height");
          throw new Error("Fixture rejected invalid expand_window height");
        }
        record(command, args, "fixture-intent-only");
        return null;
      }
      case "reset_window":
      case "hide_main_window":
        noArguments(command, args);
        record(command, args, "fixture-intent-only");
        return null;
      default:
        record(String(command).slice(0, 120), args, "rejected-command");
        state.rejected.push(String(command).slice(0, 120));
        throw new Error("Fixture transport rejected an unknown native command");
    }
  }

  const transport = {
    invoke,
    async listen(event, handler) {
      const safeEvent = typeof event === "string" ? event.slice(0, 120) : "<invalid>";
      state.listenCalls.push(safeEvent);
      state.listenCount += 1;
      if (!eventNames.has(event) || typeof handler !== "function") {
        state.rejected.push(`listen:${safeEvent}`);
        throw new Error("Fixture rejected an unsupported native event subscription");
      }
      const id = ++nextListenerId;
      listeners.set(id, { event, handler });
      state.activeListeners = listeners.size;
      state.activeListenersByEvent[event] = (state.activeListenersByEvent[event] || 0) + 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(id);
        state.unlistenCount += 1;
        state.activeListeners = listeners.size;
        state.activeListenersByEvent[event] = Math.max(0, state.activeListenersByEvent[event] - 1);
      };
    },
  };
  const fixture = {
    snapshot() {
      return JSON.parse(JSON.stringify({
        ...state,
        appCatalog: apps,
        commandAliases,
        appState: appStateFixture.snapshot(),
        recommendation: recommendation.snapshot(),
      }));
    },
    emitFocus() {
      state.emittedFocusEvents += 1;
      state.emittedEvents["tauri://focus"] += 1;
      const delivered = deliver("tauri://focus", undefined);
      return delivered;
    },
    emitAutoPaste(value) {
      if (!["off", "1s", "3s", "5s", "10s"].includes(value) || !state.settingsBatchSummary) {
        throw new Error("Fixture rejected an invalid auto-paste notification");
      }
      const event = "atools://renderer-general-settings";
      state.emittedEvents[event] += 1;
      const raw = JSON.stringify({ ...state.settingsBatchSummary.settingsGeneral, autoPaste: value });
      return { value, delivered: deliver(event, { version: 1, raw }) };
    },
    releaseStartup() {
      if (!releaseStartup || !state.startupHeld) throw new Error("Fixture startup is not held");
      releaseStartup();
      releaseStartup = null;
      state.startupHeld = false;
      return { released: true };
    },
    chooseContextMenuAction(id) {
      const menu = state.contextMenus.at(-1);
      const item = menu?.items.find(candidate => candidate.id === id);
      if (!item || item.enabled === false || item.type === "separator") {
        state.rejected.push("context-menu-selection");
        return 0;
      }
      state.contextMenuSelections.push({ id });
      state.emittedEvents["atools://renderer-context-menu"] += 1;
      const delivered = deliver("atools://renderer-context-menu", id);
      pendingMenuReplies.shift()?.();
      return delivered;
    },
    updateCommandAliases(aliasName) {
      if (aliasName !== options.updatedAliasName) throw new Error("Fixture rejected an unknown alias update");
      const key = `direct:app:${options.appPath.replace(/\\/g, "/")}`;
      commandAliases[key] = [{ alias: aliasName }];
      const payload = null;
      state.lastCommandAliasPayloadIsNull = payload === null;
      state.emittedEvents["atools://renderer-command-aliases"] += 1;
      const delivered = deliver("atools://renderer-command-aliases", payload);
      return { delivered, payloadIsNull: state.lastCommandAliasPayloadIsNull };
    },
    failNextLaunch() { failNextLaunch = true; },
    failNextRecommendationWrite: recommendation.failNextWrite,
  };
  Object.defineProperty(window, "__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__", {
    value: transport,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, "__ATOOLS_ZTOOLS_RENDERER_FIXTURE__", {
    value: fixture,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export function rendererFixtureTransportScript() {
  return `(${installRendererFixtureTransport.toString()})(${JSON.stringify({
    appName: FIXTURE_APP_NAME,
    aliasName: FIXTURE_APP_ALIAS_NAME,
    updatedAliasName: FIXTURE_UPDATED_ALIAS_NAME,
    appPath: FIXTURE_APP_PATH,
    readKeys: NAMESPACED_READ_KEYS,
  })},${createRendererAppStateBrowserFixture.toString()},${JSON.stringify(RENDERER_EVENT_NAMES)},${createRendererRecommendationBrowserFixture.toString()});`;
}
