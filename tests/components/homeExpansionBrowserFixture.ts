import "../../src/styles/global.css";
import App from "../../src/App.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { RECOMMENDED_COMMANDS } from "../../src/lib/uiState";
import type { FeatureAction, SearchResult } from "../../src/lib/types";

const PLUGIN_ID = "synthetic-home-expansion-plugin";
const PIN_STORAGE = "atools:pinned-commands";
const SNAPSHOT_STORAGE = "atools:launcher-pin-snapshots:v1";
const HISTORY_STORAGE = "atools:command-history";
const SETTINGS_STORAGE = "atools:settings-general";
const SETTINGS = {
  theme: "system",
  localAppSearch: false,
  localLaunchSearch: false,
  autoPaste: "never",
  autoClear: "never",
  tabKeyFunction: "navigate",
  showRecentInSearch: true,
  pinnedRows: 1,
  recentRows: 1,
};

type FixtureCall = { command: string; args: Record<string, unknown> | null };
const pinItems = Array.from({ length: 12 }, (_, index) => ({
  code: `home-pin-${String(index + 1).padStart(2, "0")}`,
  label: `固定指令 ${String(index + 1).padStart(2, "0")}`,
  explain: "首页展开验收固定项",
}));
const recentItems = Array.from({ length: 24 }, (_, index) => {
  const recommendation = RECOMMENDED_COMMANDS[index];
  return recommendation
    ? { code: recommendation.code, label: recommendation.label, explain: recommendation.explain }
    : { code: `home-history-${String(index + 1).padStart(2, "0")}`, label: `最近使用 ${String(index + 1).padStart(2, "0")}`, explain: "首页展开验收历史项" };
});
const featureCatalog: SearchResult[] = [...pinItems, ...recentItems].map((item) => ({
  ...item,
  plugin_id: PLUGIN_ID,
  plugin_name: "首页展开验收插件",
  icon: null,
  score: 1,
  match_type: "exact",
}));
const commandHistory = recentItems.map((item, index) => ({
  ...item,
  plugin_id: PLUGIN_ID,
  plugin_name: "首页展开验收插件",
  icon: "",
  input: item.label,
  usedAt: new Date(Date.UTC(2026, 0, 24 - index)).toISOString(),
  useCount: index + 1,
}));
const searchResults: SearchResult[] = Array.from({ length: 3 }, (_, index) => ({
  code: `home-search-result-${index + 1}`,
  plugin_id: "synthetic-search-fixture",
  plugin_name: "固定搜索结果",
  label: `fixture-query 结果 ${index + 1}`,
  explain: "用于搜索输入选区键盘保护验收",
  icon: null,
  score: 100 - index,
  match_type: "exact",
}));

const calls: FixtureCall[] = [];
const activationCalls: Array<{ code: string; plugin_id: string }> = [];
const unexpectedCommands: string[] = [];
const eventHandlers = new Map<number, { name: string; handler: number }>();
let nextEventId = 0;
let app: ReturnType<typeof mount> | undefined;

mockWindows("main");
mockConvertFileSrc("macos");
mockIPC((command, rawArgs) => {
  const args = (rawArgs ?? null) as Record<string, unknown> | null;
  if (command === "plugin:event|listen") {
    const id = ++nextEventId;
    eventHandlers.set(id, { name: String(args?.event), handler: Number(args?.handler) });
    return id;
  }
  if (command === "plugin:event|unlisten") {
    eventHandlers.delete(Number(args?.eventId));
    return;
  }

  calls.push({ command, args });
  switch (command) {
    case "get_setting": return JSON.stringify(SETTINGS);
    case "set_setting": return;
    case "feature_catalog": return featureCatalog;
    case "search_features": return String(args?.query ?? "") === "fixture-query" ? searchResults : [];
    case "search_plugin_main_push_candidates": {
      const exactArgs = args !== null
        && args.query === "fixture-query"
        && args.fixedContent === false
        && Object.keys(args).length === 2;
      if (!exactArgs) {
        unexpectedCommands.push(`${command}:unexpected-args`);
        throw new Error(`Unexpected home expansion fixture IPC arguments for ${command}: ${JSON.stringify(args)}`);
      }
      return [];
    }
    case "list_pending_agent_requests":
    case "search_local_apps": return [];
    case "reset_window":
    case "expand_window":
    case "show_main_window":
    case "hide_main_window": return;
    case "get_accessibility_permission_status": return { supported: false, trusted: false };
    case "activate_feature": {
      const feature = args?.feature as FeatureAction | undefined;
      activationCalls.push({ code: String(feature?.feature_code ?? ""), plugin_id: String(feature?.plugin_id ?? "") });
      return Promise.reject(new Error("Activation is intentionally disabled in the home expansion fixture"));
    }
    default:
      unexpectedCommands.push(command);
      throw new Error(`Unexpected home expansion fixture IPC command: ${command}`);
  }
});

function seedStorage() {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(SETTINGS));
  localStorage.setItem(PIN_STORAGE, JSON.stringify(pinItems.map(({ code }) => code)));
  localStorage.setItem(SNAPSHOT_STORAGE, JSON.stringify(pinItems.map((item) => ({
    ...item,
    plugin_id: PLUGIN_ID,
    plugin_name: "首页展开验收插件",
    icon: null,
  }))));
  localStorage.setItem(HISTORY_STORAGE, JSON.stringify(commandHistory));
}

async function mountFixture() {
  seedStorage();
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync();
  await tick();
}

async function resetFixture() {
  if (app) await unmount(app);
  app = undefined;
  if (eventHandlers.size !== 0) throw new Error(`Fixture remount left ${eventHandlers.size} event listeners registered`);
  calls.length = 0;
  activationCalls.length = 0;
  unexpectedCommands.length = 0;
  await mountFixture();
  return true;
}

async function disposeFixture() {
  if (app) await unmount(app);
  app = undefined;
  await tick();
  return {
    appUnmounted: app === undefined,
    listenersRemoved: eventHandlers.size === 0,
    remainingEventListeners: eventHandlers.size,
  };
}

const homeExpansionFixture = {
  pinLabels: pinItems.map(({ label }) => label),
  recentLabels: recentItems.map(({ label }) => label),
  searchLabels: searchResults.map(({ label }) => label),
  get activationCount() { return activationCalls.length; },
  snapshot() {
    return {
      calls: structuredClone(calls),
      activationCalls: structuredClone(activationCalls),
      unexpectedCommands: [...unexpectedCommands],
      listenerCount: eventHandlers.size,
      featureCatalogCount: featureCatalog.length,
      pinnedSeedCount: pinItems.length,
      recentSeedCount: recentItems.length,
    };
  },
  resetFixture,
  disposeFixture,
};

Object.assign(window, { homeExpansionFixture });
void mountFixture();
