import App from "../../src/App.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { SearchResult } from "../../src/lib/types";
import { alphaPlugin, betaPlugin, gammaPlugin } from "./launcherReturnContextFixture";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type SearchCommand = "search_features" | "search_local_apps";
type SearchCall = { command: SearchCommand; query: string; attempt: number; visibilityState: DocumentVisibilityState };
type PluginCandidateCall = { query: string; attempt: number; fixedContent: boolean; visibilityState: DocumentVisibilityState };
type FixtureCall = { command: string; query?: string; attempt?: number; visibilityState: DocumentVisibilityState; detail?: number };
type FixtureSnapshot = {
  mounted: boolean;
  visibilityState: DocumentVisibilityState;
  query: string | null;
  resultRows: Array<{ code: string; pluginId: string; selected: boolean; iconSource: string | null }>;
  selectedCode: string | null;
  shellPresent: boolean;
  calls: FixtureCall[];
  searchCalls: SearchCall[];
  pluginCandidateCalls: PluginCandidateCall[];
  unknownIpc: string[];
  pending: string[];
};
type BrowserFixture = {
  queries: { seed: string; stale: string; latest: string; dispose: string; remount: string };
  codes: { alpha: string; beta: string; gamma: string; localApp: string };
  snapshot: () => FixtureSnapshot;
  settleSearch: (command: SearchCommand, query: string, attempt: number, rows: SearchResult[]) => void;
  settleIcons: (attempt: number, icons: Record<string, string>) => void;
  setTheme: (theme: "light" | "dark") => void;
  dispatchDuplicateVisibleEvent: () => void;
  unmount: () => Promise<void>;
  remount: () => Promise<void>;
};

const queries = {
  seed: "qa-visibility-cycle-20261026-8d42",
  stale: "qa-visibility-stale-20261026-8d42",
  latest: "qa-visibility-latest-20261026-8d42",
  dispose: "qa-visibility-dispose-20261026-8d42",
  remount: "qa-visibility-remount-20261026-8d42",
};
const alpha: SearchResult = { ...alphaPlugin, code: "visibility-alpha", plugin_id: "visibility-fixture", label: "Visibility Alpha", score: 240 };
const beta: SearchResult = { ...betaPlugin, code: "visibility-beta", plugin_id: "visibility-fixture", label: "Visibility Beta", score: 180 };
const gamma: SearchResult = { ...gammaPlugin, code: "visibility-gamma", plugin_id: "visibility-fixture", label: "Visibility Gamma", score: 260 };
const localAppPath = "/fixture/Visibility QA.app";
const localApp: SearchResult = {
  code: `local-app:${localAppPath}`, plugin_id: "local-app", plugin_name: "本地应用", label: "Visibility QA App",
  explain: localAppPath, icon: null, score: 80, match_type: "exact",
};
const betaFirst = [{ ...beta, score: 320 }, alpha];
const featureCatalog = [alpha, beta, gamma];
const iconData = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${color}"/></svg>`)}`;
const settings = {
  localAppSearch: true, localLaunchSearch: false, autoPaste: "never", autoClear: "never",
  showRecentInSearch: false, theme: "light", pluginEscapeToSearch: true,
};

const calls: FixtureCall[] = [];
const searchCalls: SearchCall[] = [];
const pluginCandidateCalls: PluginCandidateCall[] = [];
const searchPending = new Map<string, Deferred<SearchResult[]>>();
const iconPending = new Map<number, Deferred<Record<string, string>>>();
const iconCalls: Array<{ attempt: number; visibilityState: DocumentVisibilityState }> = [];
const eventListeners = new Map<number, string>();
const unknownIpc: string[] = [];
let currentApp: ReturnType<typeof mount> | undefined;
let nextListenerId = 0;

mockWindows("main");
mockConvertFileSrc("macos");

function recordArgs(raw: InvokeArgs | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  if (Array.isArray(raw) || raw instanceof ArrayBuffer || raw instanceof Uint8Array) {
    throw new Error("Visibility fixture only accepts record IPC arguments");
  }
  return raw as Record<string, unknown>;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function searchKey(command: SearchCommand, query: string, attempt: number) {
  return `${command}\n${query}\n${attempt}`;
}

function deferSearch(command: SearchCommand, query: string, attempt: number): Promise<SearchResult[]> {
  const gate = deferred<SearchResult[]>();
  searchPending.set(searchKey(command, query, attempt), gate);
  return gate.promise;
}

function search(command: SearchCommand, query: string): Promise<SearchResult[]> {
  const attempt = searchCalls.filter((call) => call.command === command && call.query === query).length + 1;
  searchCalls.push({ command, query, attempt, visibilityState: document.visibilityState });
  calls.push({ command, query, attempt, visibilityState: document.visibilityState });

  if (query === queries.seed && attempt === 1 && command === "search_features") return deferSearch(command, query, attempt);
  if (query === queries.seed && attempt === 1 && command === "search_local_apps") return Promise.resolve([localApp]);
  if (query === queries.seed && attempt === 2) return Promise.resolve(command === "search_features" ? betaFirst : [localApp]);
  if (query === queries.stale || query === queries.dispose) return deferSearch(command, query, attempt);
  if (query === queries.latest || query === queries.remount) return Promise.resolve(command === "search_features" ? [gamma] : []);
  return Promise.resolve([]);
}

mockIPC((command, rawArgs) => {
  const args = recordArgs(rawArgs);
  if (command === "plugin:event|listen") {
    const id = ++nextListenerId;
    eventListeners.set(id, String(args.event ?? ""));
    return id;
  }
  if (command === "plugin:event|unlisten") {
    eventListeners.delete(Number(args.eventId));
    return;
  }
  if (command === "get_setting") {
    calls.push({ command, visibilityState: document.visibilityState });
    return JSON.stringify(settings);
  }
  if (command === "feature_catalog") {
    calls.push({ command, visibilityState: document.visibilityState });
    return featureCatalog;
  }
  if (command === "list_pending_agent_requests") {
    calls.push({ command, visibilityState: document.visibilityState });
    return [];
  }
  if (command === "search_features" || command === "search_local_apps") {
    return search(command, String(args.query ?? ""));
  }
  if (command === "search_plugin_main_push_candidates") {
    const query = String(args.query ?? "");
    const attempt = pluginCandidateCalls.filter((call) => call.query === query).length + 1;
    const fixedContent = args.fixedContent === true;
    pluginCandidateCalls.push({ query, attempt, fixedContent, visibilityState: document.visibilityState });
    calls.push({ command, query, attempt, visibilityState: document.visibilityState, detail: fixedContent ? 1 : 0 });
    return [];
  }
  if (command === "load_local_app_icons") {
    const attempt = iconCalls.length + 1;
    iconCalls.push({ attempt, visibilityState: document.visibilityState });
    calls.push({ command, attempt, visibilityState: document.visibilityState, detail: Array.isArray(args.paths) ? args.paths.length : 0 });
    if (attempt === 1) {
      const gate = deferred<Record<string, string>>();
      iconPending.set(attempt, gate);
      return gate.promise;
    }
    return { [localAppPath]: iconData("#178a64") };
  }
  if (command === "expand_window") {
    calls.push({ command, visibilityState: document.visibilityState, detail: Number(args.height) });
    return;
  }

  unknownIpc.push(command);
  calls.push({ command, visibilityState: document.visibilityState });
  throw new Error(`Visibility fixture refused unapproved IPC: ${command}`);
});

async function mountApp() {
  if (currentApp) throw new Error("Visibility fixture App is already mounted");
  currentApp = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync();
  await tick();
}

export async function mountFresh() {
  if (currentApp) await unmountApp();
  localStorage.clear();
  localStorage.setItem("atools:settings-general", JSON.stringify(settings));
  calls.length = 0;
  searchCalls.length = 0;
  searchPending.clear();
  iconPending.clear();
  iconCalls.length = 0;
  pluginCandidateCalls.length = 0;
  eventListeners.clear();
  unknownIpc.length = 0;
  nextListenerId = 0;
  await mountApp();
}

async function unmountApp() {
  const mounted = currentApp;
  if (!mounted) return;
  currentApp = undefined;
  await unmount(mounted);
  flushSync();
  await tick();
}

function settleSearch(command: SearchCommand, query: string, attempt: number, rows: SearchResult[]) {
  const key = searchKey(command, query, attempt);
  const gate = searchPending.get(key);
  if (!gate) throw new Error(`No pending ${command} reply for ${query} attempt ${attempt}`);
  searchPending.delete(key);
  gate.resolve(rows);
}

function settleIcons(attempt: number, icons: Record<string, string>) {
  const gate = iconPending.get(attempt);
  if (!gate) throw new Error(`No pending icon reply for attempt ${attempt}`);
  iconPending.delete(attempt);
  gate.resolve(icons);
}

function snapshot(): FixtureSnapshot {
  const input = document.querySelector<HTMLInputElement>("[data-atools-search-input]");
  const rows = [...document.querySelectorAll<HTMLElement>("#launcher-results [role=option][data-result-code]")];
  return {
    mounted: currentApp !== undefined,
    visibilityState: document.visibilityState,
    query: input?.value ?? null,
    resultRows: rows.map((row) => ({
      code: row.dataset.resultCode ?? "",
      pluginId: row.dataset.pluginId ?? "",
      selected: row.getAttribute("aria-selected") === "true",
      iconSource: row.querySelector<HTMLImageElement>("img")?.getAttribute("src") ?? null,
    })),
    selectedCode: rows.find((row) => row.getAttribute("aria-selected") === "true")?.dataset.resultCode ?? null,
    shellPresent: document.querySelector(".shell-frame") !== null,
    calls: calls.map((call) => ({ ...call })),
    searchCalls: searchCalls.map((call) => ({ ...call })),
    pluginCandidateCalls: pluginCandidateCalls.map((call) => ({ ...call })),
    unknownIpc: [...unknownIpc],
    pending: [...searchPending.keys(), ...[...iconPending.keys()].map((attempt) => `icons\n${attempt}`)],
  };
}

const fixture: BrowserFixture = {
  queries,
  codes: { alpha: alpha.code, beta: beta.code, gamma: gamma.code, localApp: localApp.code },
  snapshot,
  settleSearch,
  settleIcons,
  setTheme(theme) {
    window.dispatchEvent(new CustomEvent("atools-settings-updated", { detail: { theme } }));
  },
  dispatchDuplicateVisibleEvent() {
    if (document.visibilityState !== "visible") throw new Error("Duplicate visible event requires a genuinely visible document");
    document.dispatchEvent(new Event("visibilitychange"));
  },
  unmount: unmountApp,
  remount: mountApp,
};

(window as Window & { launcherSearchVisibilityBrowserFixture?: BrowserFixture }).launcherSearchVisibilityBrowserFixture = fixture;
