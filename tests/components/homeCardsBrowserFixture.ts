import "../../src/styles/global.css";
import App from "../../src/App.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { COMMAND_HISTORY_STORAGE_KEY, COMMAND_HISTORY_UPDATED_EVENT, type CommandHistoryEntry } from "../../src/lib/commandHistory";
import { LAUNCHER_PIN_SNAPSHOTS_KEY } from "../../src/lib/launcherPins";
import { RECOMMENDED_COMMANDS, type RecommendedCommand } from "../../src/lib/uiState";
import type { FeatureAction, SearchResult } from "../../src/lib/types";

const PLUGIN_ID = "synthetic-home-cards-plugin";
const PIN_STORAGE = "atools:pinned-commands";
const SETTINGS_STORAGE = "atools:settings-general";
const SETTINGS = {
  theme: "system", localAppSearch: false, localLaunchSearch: false, autoPaste: "never", autoClear: "never",
  tabKeyFunction: "navigate", showRecentInSearch: true, pinnedRows: 1, recentRows: 2,
};
const metadata = {
  addressParser: {
    name: "address-parser", title: "收货地址智能解析", author: "harris", version: "0.1.0",
    code: "address-parser", explain: "收货地址智能解析", logo: "logo.svg",
  },
  liveMarkdown: {
    name: "live-markdown", title: "Live Markdown", author: "harris", version: "0.1.0",
    code: "typora-workbench", explain: "打开 Live Markdown 实时预览编辑器（支持大纲、文件树、数学公式、Mermaid 图表与多排版主题）",
  },
};
const addressLogoUrl = `${window.location.origin}/fixture-assets/address-parser.svg`;
const longLabel = "用于验证超长卡片标题在九列布局中被限制为两行且无障碍名称保持完整的测试样本";
const addressParser: RecommendedCommand = {
  code: metadata.addressParser.code, plugin_id: "address-parser", label: metadata.addressParser.title,
  explain: metadata.addressParser.explain, icon: addressLogoUrl,
};
const pinnedItems: RecommendedCommand[] = [
  addressParser,
  { code: "home-card-long-label", plugin_id: PLUGIN_ID, label: longLabel, explain: "超长标题两行截断验收", icon: null },
  { code: "home-card-short-label", plugin_id: PLUGIN_ID, label: "IP", explain: "短标题验收", icon: null },
  ...Array.from({ length: 9 }, (_, index) => ({
    code: `home-card-pin-${String(index + 4).padStart(2, "0")}`, plugin_id: PLUGIN_ID,
    label: `固定卡片 ${String(index + 4).padStart(2, "0")}`, explain: "首页卡片尺寸与间距验收", icon: null,
  })),
];
const liveMarkdown: RecommendedCommand = {
  code: metadata.liveMarkdown.code, plugin_id: "live-markdown", label: metadata.liveMarkdown.explain,
  explain: metadata.liveMarkdown.explain, icon: null,
};
const recommendationItems = RECOMMENDED_COMMANDS.map(item => ({ ...item }));
const recentCustom: RecommendedCommand[] = Array.from({ length: 8 }, (_, index) => ({
  code: `home-card-history-${String(index + 1).padStart(2, "0")}`, plugin_id: PLUGIN_ID,
  label: `自定义历史 ${String(index + 1).padStart(2, "0")}`, explain: "用于验证最近使用卡片布局", icon: null,
}));
const recentItems: RecommendedCommand[] = [liveMarkdown, ...recommendationItems, ...recentCustom];
const featureCatalog: SearchResult[] = [...pinnedItems, ...recentItems].map(item => ({
  code: item.code, plugin_id: item.plugin_id ?? "system", plugin_name: item.plugin_id === "address-parser" ? metadata.addressParser.title
    : item.plugin_id === "live-markdown" ? metadata.liveMarkdown.title : "ATools 卡片验收",
  label: item.label, explain: item.explain, icon: item.icon ?? null, score: 1, match_type: "exact",
}));
const pinCodes = pinnedItems.map(item => item.code);
const pinSnapshots = pinnedItems.map(item => ({
  code: item.code, plugin_id: item.plugin_id ?? PLUGIN_ID, plugin_name: item.plugin_id === "address-parser" ? metadata.addressParser.title : "ATools 卡片验收",
  label: item.label, explain: item.explain, icon: item.icon ?? null,
}));
const commandHistory: CommandHistoryEntry[] = recentItems.map((item, index) => ({
  code: item.code, plugin_id: item.plugin_id ?? "system", plugin_name: item.plugin_id === "live-markdown" ? metadata.liveMarkdown.title : "ATools 卡片验收",
  label: item.label, explain: item.explain, icon: item.icon ?? "", input: item.label,
  usedAt: new Date(Date.UTC(2026, 9, 25 - index)).toISOString(), useCount: index + 1,
}));

type FixtureCall = { command: string; args: Record<string, unknown> | null };
const calls: FixtureCall[] = [];
const eventCalls: FixtureCall[] = [];
const activationCalls: Array<{ code: string; plugin_id: string }> = [];
const unexpectedCommands: string[] = [];
const historyUpdates: string[][] = [];
const eventHandlers = new Map<number, { name: string; handler: number }>();
const resizeFailures: Array<{ args: { height: number }; error: string }> = [];
let rejectNextResize = false;
let nextEventId = 0;
let app: ReturnType<typeof mount> | undefined;

function rejectArgs(command: string, args: Record<string, unknown> | null): never {
  unexpectedCommands.push(`${command}:unexpected-args`);
  throw new Error(`Unexpected home cards fixture IPC arguments for ${command}: ${JSON.stringify(args)}`);
}

function recordHistoryUpdate(event: Event) {
  const detail = (event as CustomEvent<CommandHistoryEntry[]>).detail;
  historyUpdates.push(Array.isArray(detail) ? detail.map(entry => `${entry.plugin_id}:${entry.code}`) : []);
}

mockWindows("main");
mockConvertFileSrc("macos");
window.addEventListener(COMMAND_HISTORY_UPDATED_EVENT, recordHistoryUpdate);
mockIPC((command, rawArgs) => {
  const args = (rawArgs ?? null) as Record<string, unknown> | null;
  if (command === "plugin:event|listen") {
    eventCalls.push({ command, args });
    const target = args?.target as Record<string, unknown> | undefined;
    const validTarget = Boolean(target && target.kind === "Any" && Object.keys(target).length === 1);
    if (!args || typeof args.event !== "string" || !args.event || !validTarget
      || typeof args.handler !== "number" || !Number.isSafeInteger(args.handler)
      || Object.keys(args).length !== 3) return rejectArgs(command, args);
    const id = ++nextEventId;
    eventHandlers.set(id, { name: args.event, handler: Number(args.handler) });
    return id;
  }
  if (command === "plugin:event|unlisten") {
    eventCalls.push({ command, args });
    const eventId = args?.eventId;
    const registered = typeof eventId === "number" ? eventHandlers.get(eventId) : undefined;
    if (!args || typeof args.event !== "string" || typeof eventId !== "number"
      || !Number.isSafeInteger(eventId) || !registered || registered.name !== args.event
      || Object.keys(args).length !== 2) return rejectArgs(command, args);
    eventHandlers.delete(eventId);
    return;
  }

  calls.push({ command, args });
  switch (command) {
    case "get_setting":
      if (!args || args.key !== "settings-general" || Object.keys(args).length !== 1) return rejectArgs(command, args);
      return JSON.stringify(SETTINGS);
    case "set_setting":
      if (!args || typeof args.key !== "string" || !("value" in args) || Object.keys(args).length !== 2) return rejectArgs(command, args);
      return;
    case "feature_catalog":
      if (args && Object.keys(args).length) return rejectArgs(command, args);
      return featureCatalog;
    case "search_features":
      if (!args || typeof args.query !== "string" || Object.keys(args).length !== 1) return rejectArgs(command, args);
      return [];
    case "search_plugin_main_push_candidates":
      if (!args || args.query !== "fixture-query" || args.fixedContent !== false || Object.keys(args).length !== 2) return rejectArgs(command, args);
      return [];
    case "list_pending_agent_requests":
    case "search_local_apps":
    case "get_accessibility_permission_status":
      if (args && Object.keys(args).length) return rejectArgs(command, args);
      return command === "get_accessibility_permission_status" ? { supported: false, trusted: false } : [];
    case "reset_window":
    case "show_main_window":
    case "hide_main_window":
      if (args && Object.keys(args).length) return rejectArgs(command, args);
      return;
    case "expand_window":
      if (!args || typeof args.height !== "number" || !Number.isFinite(args.height) || Object.keys(args).length !== 1) return rejectArgs(command, args);
      if (rejectNextResize) {
        rejectNextResize = false;
        resizeFailures.push({ args: { height: args.height }, error: "private-fixture-resize-cause" });
        return Promise.reject(new Error("private-fixture-resize-cause"));
      }
      return;
    case "activate_feature": {
      const feature = args?.feature as FeatureAction | undefined;
      if (!feature || typeof feature.feature_code !== "string" || typeof feature.plugin_id !== "string" || Object.keys(args ?? {}).length !== 1) return rejectArgs(command, args);
      activationCalls.push({ code: feature.feature_code, plugin_id: feature.plugin_id });
      return Promise.reject(new Error("Activation is intentionally disabled in the home cards fixture"));
    }
    default:
      unexpectedCommands.push(command);
      throw new Error(`Unexpected home cards fixture IPC command: ${command}`);
  }
});

function seedStorage() {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(SETTINGS));
  localStorage.setItem(PIN_STORAGE, JSON.stringify(pinCodes));
  localStorage.setItem(LAUNCHER_PIN_SNAPSHOTS_KEY, JSON.stringify(pinSnapshots));
  localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(commandHistory));
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
  eventCalls.length = 0;
  activationCalls.length = 0;
  unexpectedCommands.length = 0;
  historyUpdates.length = 0;
  resizeFailures.length = 0;
  rejectNextResize = false;
  await mountFixture();
  return true;
}

function failNextResize() {
  if (rejectNextResize) throw new Error("A controlled resize rejection is already pending");
  rejectNextResize = true;
  return true;
}

async function disposeFixture() {
  if (app) await unmount(app);
  app = undefined;
  await tick();
  window.removeEventListener(COMMAND_HISTORY_UPDATED_EVENT, recordHistoryUpdate);
  return {
    appUnmounted: app === undefined, listenersRemoved: eventHandlers.size === 0,
    remainingEventListeners: eventHandlers.size, hintRemoved: !document.querySelector(".home-command-hint"),
  };
}

const homeCardsFixture = {
  metadata,
  sampleLabels: { addressParser: addressParser.label, longLabel, shortLabel: "IP", liveMarkdown: liveMarkdown.label },
  get activationCount() { return activationCalls.length; },
  snapshot() {
    let historyCodes: string[] = [];
    try { historyCodes = JSON.parse(localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY) ?? "[]").map((item: CommandHistoryEntry) => `${item.plugin_id}:${item.code}`); }
    catch { historyCodes = []; }
    return {
      calls: structuredClone(calls), eventCalls: structuredClone(eventCalls), activationCalls: structuredClone(activationCalls), unexpectedCommands: [...unexpectedCommands],
      historyUpdateEvents: structuredClone(historyUpdates), historyCodes, listenerCount: eventHandlers.size,
      resizeCalls: calls.filter(call => call.command === "expand_window").map(call => structuredClone(call.args)),
      resizeFailures: structuredClone(resizeFailures), resizeFailureCount: resizeFailures.length, rejectNextResize,
      featureCatalogCount: featureCatalog.length, pinnedSeedCount: pinnedItems.length, recentSeedCount: recentItems.length,
    };
  },
  failNextResize,
  resetFixture,
  disposeFixture,
};

Object.assign(window, { homeCardsFixture });
void mountFixture();
