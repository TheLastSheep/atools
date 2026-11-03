import "../../src/styles/global.css";
import App from "../../src/App.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { FeatureAction } from "../../src/lib/types";

const PLUGIN_ID = "synthetic-home-plugin";
const PIN_STORAGE = "atools:pinned-commands";
const SNAPSHOT_STORAGE = "atools:launcher-pin-snapshots:v1";
const HISTORY_STORAGE = "atools:command-history";
const SETTINGS_STORAGE = "atools:settings-general";
const RELOAD_COUNTS_STORAGE = "atools:home-grid-fixture:initial-counts:v1";
const settings = {
  localAppSearch: false,
  localLaunchSearch: false,
  autoPaste: "never",
  autoClear: "never",
  tabKeyFunction: "navigate",
  showRecentInSearch: true,
  pinnedRows: 2,
  recentRows: 2,
};
type FixtureCounts = {
  pinnedCount: number;
  historyCount: number;
  historyOffset: number;
  recentVisibleCount: number;
};
const DEFAULT_COUNTS: FixtureCounts = { pinnedCount: 3, historyCount: 18, historyOffset: 0, recentVisibleCount: 18 };

type NativeCall = { command: string; args: Record<string, unknown> | null };
const calls: NativeCall[] = [];
const unexpectedCommands: string[] = [];
const features = Array.from({ length: 27 }, (_, index) => {
  const pinned = index < 9;
  const itemNumber = pinned ? index : index - 9;
  const code = pinned ? `home-pin-${itemNumber}` : `home-history-${itemNumber}`;
  const label = pinned ? `固定 ${itemNumber}` : itemNumber === 0 ? "结果中心" : `最近 ${itemNumber}`;
  return {
    code,
    plugin_id: PLUGIN_ID,
    plugin_name: "合成目录插件",
    label,
    explain: "只用于首页网格验收",
    icon: null,
    score: 1,
    match_type: "exact",
  };
});
const pinnedCommands = features.slice(0, 9);
const history = features.slice(9).map((feature, index) => ({
  code: feature.code,
  label: feature.label,
  explain: feature.explain,
  plugin_id: PLUGIN_ID,
  plugin_name: feature.plugin_name,
  icon: "",
  input: feature.label,
  usedAt: new Date(Date.UTC(2026, 0, 1, 18 - index)).toISOString(),
  useCount: 1,
}));
let nextEventId = 0;
const eventHandlers = new Map<number, { name: string; handler: number }>();
let pendingActivationReject: ((error: Error) => void) | null = null;
let app: ReturnType<typeof mount> | undefined;

function validCounts(value: unknown): value is FixtureCounts {
  if (!value || typeof value !== "object") return false;
  const counts = value as Record<string, unknown>;
  return Number.isInteger(counts.pinnedCount) && Number(counts.pinnedCount) >= 0
    && Number(counts.pinnedCount) <= pinnedCommands.length
    && Number.isInteger(counts.historyCount) && Number(counts.historyCount) >= 0
    && Number(counts.historyCount) <= history.length
    && Number.isInteger(counts.historyOffset) && Number(counts.historyOffset) >= 0
    && Number(counts.historyOffset) + Number(counts.historyCount) <= history.length
    && Number.isInteger(counts.recentVisibleCount) && Number(counts.recentVisibleCount) >= 0
    && Number(counts.recentVisibleCount) <= history.length + 2;
}

function consumeInitialCounts(): FixtureCounts {
  const raw = sessionStorage.getItem(RELOAD_COUNTS_STORAGE);
  if (!raw) return DEFAULT_COUNTS;
  sessionStorage.removeItem(RELOAD_COUNTS_STORAGE);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Home grid reload fixture counts are invalid"); }
  if (!validCounts(value)) throw new Error("Home grid reload fixture counts are out of bounds");
  return value;
}

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
    case "get_setting": return JSON.stringify(settings);
    case "set_setting": return;
    case "feature_catalog": return features;
    case "search_features":
    case "list_pending_agent_requests":
    case "search_local_apps": return [];
    case "reset_window":
    case "expand_window":
    case "show_main_window":
    case "hide_main_window": return;
    case "get_accessibility_permission_status": return { supported: false, trusted: false };
    case "activate_feature":
      return new Promise<FeatureAction>((_resolve, reject) => { pendingActivationReject = reject; });
    default:
      unexpectedCommands.push(command);
      throw new Error(`Unexpected home-grid fixture IPC command: ${command}`);
  }
});

function seedStorage({ pinnedCount, historyCount, historyOffset }: FixtureCounts) {
  const selectedPinned = pinnedCommands.slice(0, pinnedCount);
  const selectedHistory = history.slice(historyOffset, historyOffset + historyCount);
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(settings));
  localStorage.setItem(PIN_STORAGE, JSON.stringify(selectedPinned.map((feature) => feature.code)));
  localStorage.setItem(SNAPSHOT_STORAGE, JSON.stringify(selectedPinned.map(({ code, plugin_id, plugin_name, label, explain, icon }) => ({
    code, plugin_id, plugin_name, label, explain, icon,
  }))));
  localStorage.setItem(HISTORY_STORAGE, JSON.stringify(selectedHistory));
}

async function resetFixture(counts: FixtureCounts = DEFAULT_COUNTS) {
  if (!validCounts(counts)) {
    throw new Error("Home grid fixture counts are out of bounds");
  }
  if (app) await unmount(app);
  app = undefined;
  calls.length = 0;
  unexpectedCommands.length = 0;
  eventHandlers.clear();
  pendingActivationReject = null;
  seedStorage(counts);
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync();
  await tick();
}

async function disposeFixture() {
  pendingActivationReject = null;
  if (app) await unmount(app);
  app = undefined;
}

export const homeGridFixture = {
  calls,
  unexpectedCommands,
  features,
  get activationPending() { return Boolean(pendingActivationReject); },
  rejectActivation() {
    const reject = pendingActivationReject;
    pendingActivationReject = null;
    reject?.(new Error("Synthetic private activation failure; do not display this text"));
  },
  prepareReload(counts: FixtureCounts) {
    if (!validCounts(counts)) throw new Error("Home grid fixture reload counts are out of bounds");
    sessionStorage.setItem(RELOAD_COUNTS_STORAGE, JSON.stringify(counts));
    return true;
  },
  resetFixture,
  disposeFixture,
};
Object.assign(window, { homeGridFixture });
void resetFixture(consumeInitialCounts());
