import "../../src/styles/global.css";
import "../../src/styles/settings-responsive.css";
import SystemPanel from "../../src/components/SystemPanel.svelte";
import { DEFAULT_ATOOLS_SETTINGS, SETTINGS_STORAGE_KEY, normalizeSettings, type AToolsSettings } from "../../src/lib/settings";
import { currentSettingsReadSnapshot } from "../../src/lib/settingsReadSession";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

type RpcArgs = Record<string, unknown> | null;
type RecordedCall = { command: string; args: RpcArgs };
type ReadRecord = { id: number; status: "pending" | "resolved" | "rejected"; settings?: Pick<AToolsSettings, "theme" | "recentRows" | "pinnedRows">; error?: string };
type DeferredRead = ReadRecord & { resolve: (value: string) => void; reject: (error: Error) => void };

const authoritativeSettings: AToolsSettings = {
  ...DEFAULT_ATOOLS_SETTINGS, showTrayIcon: false,
  theme: "dark", primaryColor: "green", localAppSearch: false, localLaunchSearch: false,
  recentRows: 4, pinnedRows: 3, placeholder: "authoritative-settings-snapshot",
};
const staleSettings: AToolsSettings = {
  ...DEFAULT_ATOOLS_SETTINGS, showTrayIcon: false,
  theme: "light", primaryColor: "orange", localAppSearch: true, localLaunchSearch: true,
  recentRows: 1, pinnedRows: 1, placeholder: "stale-local-cache-must-not-appear",
};
const calls: RecordedCall[] = [];
const unexpectedCalls: RecordedCall[] = [];
const settingsWrites: Array<{ key: string; value: AToolsSettings }> = [];
const nativeWrites: RecordedCall[] = [];
const readRecords: DeferredRead[] = [];
const eventListeners = new Map<number, { event: string; handler: number }>();
let nextReadId = 0;
let nextEventId = 0;
let app: ReturnType<typeof mount> | undefined;
let databaseRaw: string | null = JSON.stringify(authoritativeSettings);
const baselineMode = new URLSearchParams(location.search).get("baseline") === "1";

function hasExactKeys(args: RpcArgs, keys: string[]): args is Record<string, unknown> {
  return Boolean(args && Object.keys(args).length === keys.length && keys.every(key => key in args));
}

function rejectUnknown(command: string, args: RpcArgs): never {
  const call = { command, args };
  unexpectedCalls.push(call);
  throw new Error(`Unexpected settings fixture IPC: ${command} ${JSON.stringify(args)}`);
}

function recordDeferredSettingsRead(args: RpcArgs): Promise<string> {
  if (!hasExactKeys(args, ["key"]) || args.key !== "settings-general") return rejectUnknown("get_setting", args);
  calls.push({ command: "get_setting", args });
  let resolvePromise!: (value: string) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<string>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  readRecords.push({ id: ++nextReadId, status: "pending", resolve: resolvePromise, reject: rejectPromise });
  return promise;
}

function eventTargetIsAny(target: unknown) {
  return Boolean(target && typeof target === "object" && !Array.isArray(target)
    && (target as Record<string, unknown>).kind === "Any" && Object.keys(target).length === 1);
}

mockWindows("main");
mockIPC((command, rawArgs) => {
  const args = (rawArgs ?? null) as RpcArgs;
  if (command === "plugin:event|listen") {
    calls.push({ command, args });
    if (!hasExactKeys(args, ["event", "target", "handler"]) || typeof args.event !== "string"
      || !args.event || !eventTargetIsAny(args.target) || typeof args.handler !== "number"
      || !Number.isSafeInteger(args.handler)) return rejectUnknown(command, args);
    const id = ++nextEventId;
    eventListeners.set(id, { event: args.event, handler: args.handler });
    return id;
  }
  if (command === "plugin:event|unlisten") {
    calls.push({ command, args });
    const id = args?.eventId;
    const registered = typeof id === "number" ? eventListeners.get(id) : undefined;
    if (!hasExactKeys(args, ["event", "eventId"]) || typeof args.event !== "string"
      || typeof id !== "number" || !Number.isSafeInteger(id) || !registered || registered.event !== args.event) {
      return rejectUnknown(command, args);
    }
    eventListeners.delete(id);
    return;
  }

  if (command === "get_setting") return recordDeferredSettingsRead(args);
  if (command === "set_setting") {
    if (!baselineMode) return rejectUnknown(command, args);
    if (!hasExactKeys(args, ["key", "value"]) || args.key !== "settings-general" || typeof args.value !== "string") return rejectUnknown(command, args);
    let value: unknown;
    try { value = JSON.parse(args.value); } catch { return rejectUnknown(command, args); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return rejectUnknown(command, args);
    calls.push({ command, args: { key: args.key, value } });
    settingsWrites.push({ key: args.key, value: value as AToolsSettings });
    databaseRaw = args.value;
    return;
  }
  if (command === "save_general_settings") {
    if (baselineMode || !hasExactKeys(args, ["expected", "changes", "applyNative"])) return rejectUnknown(command, args);
    const expected = args.expected as RpcArgs;
    const changes = args.changes;
    if (!hasExactKeys(expected, ["raw"]) || expected.raw !== databaseRaw
      || !changes || typeof changes !== "object" || Array.isArray(changes)
      || typeof args.applyNative !== "boolean") {
      throw new Error("General settings compare-and-swap conflict or invalid request");
    }
    const base = databaseRaw === null ? {} : JSON.parse(databaseRaw) as Record<string, unknown>;
    const value = { ...base, ...changes as Record<string, unknown> } as AToolsSettings;
    databaseRaw = JSON.stringify(value);
    calls.push({ command, args });
    settingsWrites.push({ key: "settings-general", value });
    const recorded = { command, args };
    nativeWrites.push(recorded);
    return {
      version: 1,
      raw: databaseRaw,
      notificationDelivered: true,
      effectsApplied: args.applyNative,
      aiInvalidated: false,
    };
  }
  if (command === "system_get_path") {
    if (!hasExactKeys(args, ["name"]) || args.name !== "home") return rejectUnknown(command, args);
    calls.push({ command, args });
    return "/fixture/home";
  }
  if (command === "get_accessibility_permission_status") {
    if (!hasExactKeys(args, [])) return rejectUnknown(command, args);
    calls.push({ command, args });
    return { supported: false, trusted: false };
  }

  const nativeWriteKeys: Record<string, string[]> = {
    update_global_hotkey: ["shortcut", "previousShortcut"],
    set_tray_icon_visible: ["visible"], set_launch_at_login: ["enabled"],
    set_super_panel_visible: ["visible"], set_floating_ball_visible: ["visible"],
    sync_app_shortcuts: ["shortcuts"],
  };
  const expectedKeys = nativeWriteKeys[command];
  if (baselineMode && expectedKeys) {
    const validValues = command === "update_global_hotkey"
      ? typeof args?.shortcut === "string" && typeof args?.previousShortcut === "string"
      : command === "sync_app_shortcuts"
        ? Array.isArray(args?.shortcuts)
        : command === "set_launch_at_login"
          ? typeof args?.enabled === "boolean"
          : typeof args?.visible === "boolean";
    if (!hasExactKeys(args, expectedKeys) || !validValues) return rejectUnknown(command, args);
    calls.push({ command, args });
    nativeWrites.push({ command, args });
    return;
  }
  return rejectUnknown(command, args);
});

function seedStaleLocalCache() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(staleSettings));
}

async function mountSystemPanel() {
  if (app) throw new Error("A settings SystemPanel is already mounted");
  const target = document.getElementById("settings-app");
  if (!target) throw new Error("Settings fixture root is missing");
  app = mount(SystemPanel, {
    target,
    props: { panel: "settings", settingsMenu: "general", onpanelchange: () => undefined },
  });
  flushSync();
  await tick();
  return true;
}

async function unmountSystemPanel() {
  if (app) await unmount(app);
  app = undefined;
  await tick();
  return true;
}

function resolveRead(id: number, kind: "authoritative" | "stale" | "current" = "authoritative") {
  const read = readRecords.find(entry => entry.id === id);
  if (!read || read.status !== "pending") throw new Error(`Settings read ${id} is not pending`);
  const currentSettings = databaseRaw === null ? authoritativeSettings : JSON.parse(databaseRaw) as AToolsSettings;
  const settings = kind === "current" ? currentSettings
    : kind === "stale" ? staleSettings
      : authoritativeSettings;
  read.status = "resolved";
  read.settings = { theme: settings.theme, recentRows: settings.recentRows, pinnedRows: settings.pinnedRows };
  read.resolve(JSON.stringify(settings));
  return true;
}

function rejectRead(id: number) {
  const read = readRecords.find(entry => entry.id === id);
  if (!read || read.status !== "pending") throw new Error(`Settings read ${id} is not pending`);
  read.status = "rejected";
  read.error = "private-fixture-native-read-cause";
  read.reject(new Error(read.error));
  return true;
}

async function remountSystemPanel() {
  await unmountSystemPanel();
  await mountSystemPanel();
  return true;
}

async function disposeFixture() {
  await unmountSystemPanel();
  const pendingAtDispose = readRecords.filter(read => read.status === "pending");
  for (const read of pendingAtDispose) rejectRead(read.id);
  await Promise.resolve();
  await tick();
  return {
    appUnmounted: app === undefined,
    activeReadLease: currentSettingsReadSnapshot() !== null,
    eventListenersRemaining: eventListeners.size,
    pendingReadsSettled: readRecords.every(read => read.status !== "pending"),
    cleanupRejectedReadIds: pendingAtDispose.map(read => read.id),
  };
}

seedStaleLocalCache();
Object.assign(window, {
  settingsLoadingFixture: {
    authoritativeValues: { theme: authoritativeSettings.theme, recentRows: authoritativeSettings.recentRows, pinnedRows: authoritativeSettings.pinnedRows },
    async mountSystemPanel() { return mountSystemPanel(); },
    async unmountSystemPanel() { return unmountSystemPanel(); },
    async remountSystemPanel() { return remountSystemPanel(); },
    resolveRead,
    rejectRead,
    seedStaleLocalCache,
    async disposeFixture() { return disposeFixture(); },
    snapshot() {
      const lease = currentSettingsReadSnapshot();
      return {
        calls: structuredClone(calls),
        unexpectedCalls: structuredClone(unexpectedCalls),
        authoritativeRaw: JSON.stringify(authoritativeSettings),
        readCalls: readRecords.map(({ id, status, settings, error }) => ({ id, status, settings, error })),
        settingsWrites: structuredClone(settingsWrites),
        expectedAfterTrayChange: normalizeSettings({ ...authoritativeSettings, showTrayIcon: true }),
        expectedAfterStaleTrayChange: normalizeSettings({ ...staleSettings, showTrayIcon: true }),
        baselineValues: { theme: staleSettings.theme, recentRows: staleSettings.recentRows, pinnedRows: staleSettings.pinnedRows, showTrayIcon: staleSettings.showTrayIcon },
        nativeWrites: structuredClone(nativeWrites),
        listenerCount: eventListeners.size,
        activeReadLease: lease ? { theme: lease.theme, recentRows: lease.recentRows, pinnedRows: lease.pinnedRows } : null,
        staleLocalCache: { theme: staleSettings.theme, recentRows: staleSettings.recentRows, pinnedRows: staleSettings.pinnedRows },
      };
    },
  },
});
void mountSystemPanel();
