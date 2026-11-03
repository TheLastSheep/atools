import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SystemPanel from "../../src/components/SystemPanel.svelte";
import { DEFAULT_ATOOLS_SETTINGS, SETTINGS_STORAGE_KEY, type AToolsSettings } from "../../src/lib/settings";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: native.invoke,
}));

type NativeArgs = Record<string, unknown>;
type NativeCall = { command: string; args: NativeArgs | null };

let databaseSettings: AToolsSettings;
let databaseRaw: string;
let nativeCalls: NativeCall[];
let persistenceWrites: AToolsSettings[];
let unexpectedCalls: NativeCall[];
let settingsEvents: AToolsSettings[];
let failNextNativeSave: boolean;
let nextNativeSaveGate: Promise<void> | null;
let operatingSystemLaunchAtLogin: boolean;
let eventListener: (event: Event) => void;

function cloneSettings(settings: AToolsSettings): AToolsSettings {
  return JSON.parse(JSON.stringify(settings)) as AToolsSettings;
}

function hasExactKeys(args: unknown, keys: string[]): args is NativeArgs {
  return Boolean(args && typeof args === "object" && !Array.isArray(args)
    && Object.keys(args).length === keys.length && keys.every(key => key in args));
}

function rejectUnexpected(command: string, args: unknown): never {
  const call = { command, args: args && typeof args === "object" ? args as NativeArgs : null };
  unexpectedCalls.push(call);
  throw new Error(`Unexpected settings recovery IPC: ${command}`);
}

function settingRow(label: string): HTMLElement {
  const labelNode = screen.getByText(label, { selector: ".setting-label > span" });
  const row = labelNode.closest<HTMLElement>(".setting-item");
  if (!row) throw new Error(`Missing settings row: ${label}`);
  return row;
}

beforeEach(() => {
  nativeCalls = [];
  persistenceWrites = [];
  unexpectedCalls = [];
  settingsEvents = [];
  failNextNativeSave = true;
  nextNativeSaveGate = null;
  operatingSystemLaunchAtLogin = false;
  databaseSettings = cloneSettings(DEFAULT_ATOOLS_SETTINGS);
  databaseRaw = JSON.stringify(databaseSettings);
  native.invoke.mockReset().mockImplementation(async (command: string, rawArgs?: NativeArgs) => {
    const args = rawArgs ?? null;
    if (command === "get_setting") {
      if (!hasExactKeys(args, ["key"]) || args.key !== "settings-general") return rejectUnexpected(command, args);
      nativeCalls.push({ command, args });
      return databaseRaw;
    }
    if (command === "get_accessibility_permission_status") {
      if (args !== null) return rejectUnexpected(command, args);
      nativeCalls.push({ command, args });
      return { supported: false, trusted: false };
    }
    if (command === "system_get_path") {
      if (!hasExactKeys(args, ["name"]) || args.name !== "home") return rejectUnexpected(command, args);
      nativeCalls.push({ command, args });
      return "/fixture/home";
    }
    if (command === "read_launch_at_login") {
      if (args !== null) return rejectUnexpected(command, args);
      nativeCalls.push({ command, args });
      return { enabled: operatingSystemLaunchAtLogin };
    }
    if (command === "change_launch_at_login") {
      if (!hasExactKeys(args, ["expected", "enabled"])
        || typeof args.expected !== "boolean" || typeof args.enabled !== "boolean") {
        return rejectUnexpected(command, args);
      }
      nativeCalls.push({ command, args: { ...args } });
      if (args.expected !== operatingSystemLaunchAtLogin) {
        throw { code: "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT" };
      }
      operatingSystemLaunchAtLogin = args.enabled;
      return { enabled: operatingSystemLaunchAtLogin };
    }
    if (command === "save_general_settings") {
      if (!hasExactKeys(args, ["expected", "changes", "applyNative"]) || !args.expected
        || typeof args.expected !== "object" || Array.isArray(args.expected)
        || !hasExactKeys(args.expected, ["raw"]) || args.expected.raw !== databaseRaw
        || !args.changes || typeof args.changes !== "object" || Array.isArray(args.changes)
        || typeof args.applyNative !== "boolean") return rejectUnexpected(command, args);
      nativeCalls.push({ command, args: JSON.parse(JSON.stringify(args)) as NativeArgs });
      if (args.applyNative && nextNativeSaveGate) {
        const gate = nextNativeSaveGate;
        nextNativeSaveGate = null;
        await gate;
      }
      if (args.applyNative && failNextNativeSave) {
        failNextNativeSave = false;
        throw new Error("fixture atomic settings transaction failed");
      }
      const base = JSON.parse(databaseRaw) as Record<string, unknown>;
      databaseSettings = { ...base, ...args.changes as Record<string, unknown> } as AToolsSettings;
      databaseRaw = JSON.stringify(databaseSettings);
      persistenceWrites.push(cloneSettings(databaseSettings));
      return {
        version: 1,
        raw: databaseRaw,
        notificationDelivered: true,
        effectsApplied: args.applyNative,
        aiInvalidated: args.applyNative,
      };
    }
    return rejectUnexpected(command, args);
  });

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: native.invoke },
  });
  eventListener = (event: Event) => {
    if (event instanceof CustomEvent) settingsEvents.push(cloneSettings(event.detail as AToolsSettings));
  };
  window.addEventListener("atools-settings-updated", eventListener);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.removeEventListener("atools-settings-updated", eventListener);
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("surfaces an atomic native save failure, then commits a later edit with the saved snapshot", async () => {
  const originalShortcut = { id: "shortcut-1", shortcut: "Option+1", targetCode: "system:settings", enabled: true };
  const nextShortcut = { ...originalShortcut, shortcut: "Option+2" };
  const initial: AToolsSettings = {
    ...DEFAULT_ATOOLS_SETTINGS,
    theme: "light",
    primaryColor: "red",
    showTrayIcon: false,
    recentRows: 3,
    placeholder: "saved-original-value",
    appShortcuts: [originalShortcut],
  };
  const staleLocalCache = JSON.stringify({ ...DEFAULT_ATOOLS_SETTINGS, theme: "system", placeholder: "stale-cache" });
  databaseSettings = cloneSettings(initial);
  databaseRaw = JSON.stringify(databaseSettings);
  localStorage.setItem(SETTINGS_STORAGE_KEY, staleLocalCache);

  const view = render(SystemPanel, { props: { panel: "settings", settingsMenu: "general", onpanelchange: vi.fn() } });
  await screen.findByText("显示托盘图标", { selector: ".setting-label > span" });
  expect(nativeCalls.filter(call => call.command === "get_setting")).toHaveLength(1);
  expect(document.documentElement.dataset.atoolsTheme).toBe("light");
  settingsEvents = [];
  vi.useFakeTimers();

  await fireEvent.click(screen.getByRole("button", { name: "快捷键" }));
  await fireEvent.click(screen.getByRole("tab", { name: /应用快捷键/ }));
  const shortcutInput = screen.getByRole("textbox", { name: "应用快捷键" }) as HTMLInputElement;
  await fireEvent.input(shortcutInput, { target: { value: nextShortcut.shortcut } });
  expect(shortcutInput.value).toBe(nextShortcut.shortcut);

  await fireEvent.click(screen.getByRole("button", { name: "通用设置" }));
  const themeSelect = within(settingRow("主题设置")).getByRole("combobox") as HTMLSelectElement;
  await fireEvent.change(themeSelect, { target: { value: "dark" } });
  expect(document.documentElement.dataset.atoolsTheme).toBe("dark");

  await vi.advanceTimersByTimeAsync(160);
  await tick();
  expect(screen.getByText("保存失败", { selector: ".save-status" })).toBeTruthy();
  vi.useRealTimers();
  expect(themeSelect.value).toBe("light");
  expect(document.documentElement.dataset.atoolsTheme).toBe("light");
  expect(databaseSettings).toMatchObject({ theme: "light", appShortcuts: [originalShortcut], placeholder: "saved-original-value" });
  expect(persistenceWrites).toHaveLength(0);
  expect(nativeCalls.filter(call => call.command === "set_setting")).toHaveLength(0);
  expect(nativeCalls.filter(call => call.command === "save_general_settings")).toHaveLength(1);
  expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(staleLocalCache);
  expect(settingsEvents.some(event => event.theme === "dark" && event.appShortcuts[0]?.shortcut === nextShortcut.shortcut)).toBe(true);
  expect(settingsEvents.at(-1)).toMatchObject({ theme: "light", appShortcuts: [originalShortcut], placeholder: "saved-original-value" });

  const failedTransaction = nativeCalls.find(call => call.command === "save_general_settings")?.args as {
    expected: { raw: string | null };
    changes: Record<string, unknown>;
    applyNative: boolean;
  };
  expect(failedTransaction.expected).toEqual({ raw: JSON.stringify(initial) });
  expect(failedTransaction.applyNative).toBe(true);
  expect(failedTransaction.changes).toMatchObject({ theme: "dark", appShortcuts: [nextShortcut] });

  const trayCheckbox = within(settingRow("显示托盘图标")).getByRole("checkbox") as HTMLInputElement;
  await fireEvent.click(trayCheckbox);
  await waitFor(() => expect(persistenceWrites).toHaveLength(1));
  expect(databaseSettings).toMatchObject({
    theme: "light",
    primaryColor: "red",
    showTrayIcon: true,
    recentRows: 3,
    placeholder: "saved-original-value",
    appShortcuts: [originalShortcut],
  });
  expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}"))
    .toMatchObject({ theme: "light", showTrayIcon: true, appShortcuts: [originalShortcut], placeholder: "saved-original-value" });
  expect(settingsEvents.at(-1)).toMatchObject({ theme: "light", showTrayIcon: true, appShortcuts: [originalShortcut] });
  expect(unexpectedCalls).toEqual([]);

  expect(nativeCalls.filter(call => call.command === "save_general_settings")).toHaveLength(2);
  expect(nativeCalls.filter(call => call.command === "set_setting")).toHaveLength(0);
  view.unmount();
  await Promise.resolve();
  expect(persistenceWrites).toHaveLength(1);
  expect(nativeCalls.filter(call => call.command === "save_general_settings")).toHaveLength(2);
});

it.each([
  { label: "启用超级面板", field: "superPanelEnabled" as const, legacyCommand: "set_super_panel_visible" },
  { label: "显示悬浮球", field: "floatingBallEnabled" as const, legacyCommand: "set_floating_ball_visible" },
])("restores and retries $label through one atomic settings save", async ({ label, field, legacyCommand }) => {
  const initialRaw = databaseRaw;
  render(SystemPanel, { props: { panel: "settings", settingsMenu: "general", onpanelchange: vi.fn() } });
  await screen.findByText("显示托盘图标", { selector: ".setting-label > span" });

  const checkbox = () => within(settingRow(label)).getByRole("checkbox") as HTMLInputElement;
  await fireEvent.click(checkbox());
  await waitFor(() => expect(screen.getByText("保存失败", { selector: ".save-status" })).toBeTruthy());

  expect(checkbox().checked).toBe(false);
  expect(databaseSettings[field]).toBe(false);
  expect(persistenceWrites).toHaveLength(0);
  expect(unexpectedCalls).toEqual([]);
  const failedCalls = nativeCalls.filter(call => call.command === "save_general_settings");
  expect(failedCalls).toHaveLength(1);
  const failedArgs = failedCalls[0].args as NativeArgs;
  expect(failedArgs.expected).toEqual({ raw: initialRaw });
  expect((failedArgs.changes as NativeArgs)[field]).toBe(true);
  expect(failedArgs.applyNative).toBe(true);
  expect(nativeCalls.filter(call => call.command === legacyCommand)).toHaveLength(0);

  await fireEvent.click(checkbox());
  await waitFor(() => expect(persistenceWrites).toHaveLength(1));

  expect(checkbox().checked).toBe(true);
  expect(databaseSettings[field]).toBe(true);
  const saveCalls = nativeCalls.filter(call => call.command === "save_general_settings");
  expect(saveCalls).toHaveLength(2);
  const successfulArgs = saveCalls[1].args as NativeArgs;
  expect(successfulArgs.expected).toEqual({ raw: initialRaw });
  expect((successfulArgs.changes as NativeArgs)[field]).toBe(true);
  expect(successfulArgs.applyNative).toBe(true);
  expect(nativeCalls.filter(call => call.command === legacyCommand)).toHaveLength(0);
  expect(unexpectedCalls).toEqual([]);
});

it("dispatches rapid visibility toggles only after each matching Native commit", async () => {
  failNextNativeSave = false;
  let releaseFirstAck!: () => void;
  nextNativeSaveGate = new Promise<void>(resolve => { releaseFirstAck = resolve; });
  const initialRaw = databaseRaw;
  render(SystemPanel, { props: { panel: "settings", settingsMenu: "general", onpanelchange: vi.fn() } });
  await screen.findByText("显示托盘图标", { selector: ".setting-label > span" });
  settingsEvents = [];

  const checkbox = () => within(settingRow("启用超级面板")).getByRole("checkbox") as HTMLInputElement;
  await fireEvent.click(checkbox());
  await waitFor(() => expect(nativeCalls.filter(call => call.command === "save_general_settings")).toHaveLength(1));
  const firstToggleValue = checkbox().checked;
  const writesBeforeAck = persistenceWrites.length;

  await fireEvent.click(checkbox());
  const secondToggleValue = checkbox().checked;
  const callsWhileFirstAckPending = nativeCalls.filter(call => call.command === "save_general_settings").length;
  expect(settingsEvents).toEqual([]);

  releaseFirstAck();
  await waitFor(() => expect(persistenceWrites).toHaveLength(2));
  await waitFor(() => expect(screen.getByText("已保存", { selector: ".save-status" })).toBeTruthy());

  expect(firstToggleValue).toBe(true);
  expect(secondToggleValue).toBe(false);
  expect(writesBeforeAck).toBe(0);
  expect(callsWhileFirstAckPending).toBe(1);
  expect(persistenceWrites.map(settings => settings.superPanelEnabled)).toEqual([true, false]);
  expect(databaseSettings.superPanelEnabled).toBe(false);
  expect(checkbox().checked).toBe(false);
  const saveCalls = nativeCalls.filter(call => call.command === "save_general_settings");
  expect(saveCalls).toHaveLength(2);
  await waitFor(() => {
    expect(settingsEvents).toHaveLength(2);
    expect(settingsEvents.map(settings => settings.superPanelEnabled)).toEqual([true, false]);
  expect(settingsEvents[0]).toEqual(persistenceWrites[0]);
  expect(settingsEvents[1]).toEqual(persistenceWrites[1]);
  });
  expect((saveCalls[0].args?.changes as NativeArgs).superPanelEnabled).toBe(true);
  expect((saveCalls[0].args?.expected as NativeArgs).raw).toBe(initialRaw);
  expect((saveCalls[1].args?.changes as NativeArgs).superPanelEnabled).toBe(false);
  expect((saveCalls[1].args?.expected as NativeArgs).raw).toBe(JSON.stringify(persistenceWrites[0]));
  expect(nativeCalls.some(call => ["set_super_panel_visible", "set_floating_ball_visible"].includes(call.command))).toBe(false);
  expect(unexpectedCalls).toEqual([]);
});

it("reads and changes launch-at-login from the OS without saving the persisted General bool", async () => {
  const initialSettings = cloneSettings({
    ...DEFAULT_ATOOLS_SETTINGS,
    theme: "light",
    launchAtLogin: true,
    placeholder: "keep General record",
  });
  databaseSettings = initialSettings;
  databaseRaw = JSON.stringify(initialSettings);
  operatingSystemLaunchAtLogin = false;
  const initialRaw = databaseRaw;

  const panel = render(SystemPanel, { props: { panel: "settings", settingsMenu: "general", onpanelchange: vi.fn() } });
  await screen.findByText("开机自动启动", { selector: ".setting-label > span" });
  const checkbox = () => within(settingRow("开机自动启动")).getByRole("checkbox") as HTMLInputElement;
  await waitFor(() => expect(checkbox().disabled).toBe(false));
  expect(checkbox().checked).toBe(false);
  expect(nativeCalls.filter(call => call.command === "read_launch_at_login")).toEqual([
    { command: "read_launch_at_login", args: null },
  ]);
  expect(databaseRaw).toBe(initialRaw);
  settingsEvents = [];

  await fireEvent.click(checkbox());
  await waitFor(() => expect(operatingSystemLaunchAtLogin).toBe(true));
  expect(checkbox().checked).toBe(true);
  expect(nativeCalls.filter(call => call.command === "change_launch_at_login").map(call => call.args)).toEqual([
    { expected: false, enabled: true },
  ]);
  expect(nativeCalls.filter(call => call.command === "save_general_settings")).toHaveLength(0);
  expect(persistenceWrites).toHaveLength(0);
  expect(databaseSettings).toEqual(initialSettings);
  expect(databaseRaw).toBe(initialRaw);
  expect(settingsEvents).toEqual([]);

  panel.unmount();
  cleanup();
  render(SystemPanel, { props: { panel: "settings", settingsMenu: "general", onpanelchange: vi.fn() } });
  await screen.findByText("开机自动启动", { selector: ".setting-label > span" });
  await waitFor(() => expect(checkbox().checked).toBe(true));
  expect(nativeCalls.filter(call => call.command === "read_launch_at_login")).toEqual([
    { command: "read_launch_at_login", args: null },
    { command: "read_launch_at_login", args: null },
  ]);
  expect(nativeCalls.filter(call => call.command === "change_launch_at_login")).toHaveLength(1);
  expect(nativeCalls.filter(call => call.command === "save_general_settings")).toHaveLength(0);
  expect(databaseRaw).toBe(initialRaw);
  expect(unexpectedCalls).toEqual([]);
});

it.each([
  { label: "启用超级面板", field: "superPanelEnabled" as const, message: "浏览器预览模式不会创建超级面板窗口" },
  { label: "显示悬浮球", field: "floatingBallEnabled" as const, message: "浏览器预览模式不会创建悬浮球窗口" },
])("explains that $label does not create a native window in preview", async ({ label, field, message }) => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(DEFAULT_ATOOLS_SETTINGS));
  render(SystemPanel, { props: { panel: "settings", settingsMenu: "general", onpanelchange: vi.fn() } });
  await screen.findByText("显示托盘图标", { selector: ".setting-label > span" });

  await fireEvent.click(within(settingRow(label)).getByRole("checkbox"));
  await waitFor(() => expect(within(settingRow(label)).getByText(message)).toBeTruthy());

  expect(native.invoke).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}")[field]).toBe(true);
});

it("shows preview persistence quota failures and restores the edited value", async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(DEFAULT_ATOOLS_SETTINGS));
  const originalSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
    if (key === SETTINGS_STORAGE_KEY) throw new Error("preview quota exceeded");
    originalSetItem.call(localStorage, key, value);
  });

  render(SystemPanel, { props: { panel: "settings", settingsMenu: "general", onpanelchange: vi.fn() } });
  await screen.findByText("显示托盘图标", { selector: ".setting-label > span" });
  const checkbox = within(settingRow("显示托盘图标")).getByRole("checkbox") as HTMLInputElement;
  await fireEvent.click(checkbox);

  await waitFor(() => expect(screen.getByText("保存失败", { selector: ".save-status" })).toBeTruthy());
  expect(checkbox.checked).toBe(true);
  expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}").showTrayIcon).toBe(true);
  expect(native.invoke).not.toHaveBeenCalled();
});
