import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SystemPanel from "../../src/components/SystemPanel.svelte";
import { DEFAULT_ATOOLS_SETTINGS, SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import type { AToolsSettings } from "../../src/lib/settings";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, Function>() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: Function) => {
    mocks.listeners.set(name, callback);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => key in value));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listeners.clear();
  localStorage.clear();
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("waits for native settings, then edits one real setting without losing the shared snapshot", async () => {
  const storedSettings: AToolsSettings = {
    ...DEFAULT_ATOOLS_SETTINGS,
    theme: "dark",
    recentRows: 4,
    pinnedRows: 3,
    showTrayIcon: false,
  };
  const read = deferred<string | null>();
  let databaseRaw: string | null = null;
  mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === "get_setting") {
      if (!hasExactKeys(args, ["key"]) || args.key !== "settings-general") throw new Error("Invalid get_setting fixture request");
      return read.promise;
    }
    if (command === "save_general_settings") {
      const expected = args?.expected;
      const changes = args?.changes;
      if (!hasExactKeys(args, ["expected", "changes", "applyNative"])
        || !hasExactKeys(expected, ["raw"]) || expected.raw !== databaseRaw
        || !changes || typeof changes !== "object" || Array.isArray(changes)
        || typeof args.applyNative !== "boolean") {
        throw new Error("Invalid save_general_settings fixture request");
      }
      const base = databaseRaw === null ? {} : JSON.parse(databaseRaw) as Record<string, unknown>;
      const next = { ...base, ...changes as Record<string, unknown> };
      databaseRaw = JSON.stringify(next);
      return Promise.resolve({
        version: 1,
        raw: databaseRaw,
        notificationDelivered: true,
        effectsApplied: args.applyNative,
        aiInvalidated: args.applyNative,
      });
    }
    if (command === "get_accessibility_permission_status") {
      if (args !== undefined) throw new Error("Invalid get_accessibility_permission_status fixture request");
      return Promise.resolve({ supported: false, trusted: false });
    }
    if (command === "system_get_path") {
      if (!hasExactKeys(args, ["name"]) || args.name !== "home") throw new Error("Invalid system_get_path fixture request");
      return Promise.resolve(null);
    }
    throw new Error(`Unexpected settings fixture command: ${command}`);
  });

  const view = render(SystemPanel, { props: { panel: "settings", onpanelchange: vi.fn() } });
  expect(screen.getByRole("status").textContent).toContain("正在读取设置");
  expect(screen.queryByText("显示托盘图标", { selector: ".setting-label > span" })).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "get_setting")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_setting")).toHaveLength(0);

  read.resolve(JSON.stringify(storedSettings));
  await screen.findByText("显示托盘图标", { selector: ".setting-label > span" });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "get_setting")).toHaveLength(1);

  const label = screen.getByText("显示托盘图标", { selector: ".setting-label > span" });
  const settingRow = label.closest(".setting-item");
  expect(settingRow).toBeTruthy();
  const checkbox = within(settingRow as HTMLElement).getByRole("checkbox") as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  databaseRaw = JSON.stringify(storedSettings);
  await fireEvent.click(checkbox);
  view.unmount();

  await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "save_general_settings")).toHaveLength(1));
  const writeArgs = mocks.invoke.mock.calls.find(([command]) => command === "save_general_settings")?.[1] as {
    expected: { raw: string | null };
    changes: Record<string, unknown>;
    applyNative: boolean;
  };
  expect(writeArgs.expected).toEqual({ raw: JSON.stringify(storedSettings) });
  expect(writeArgs.applyNative).toBe(true);
  expect(writeArgs.changes).toMatchObject({
    theme: "dark",
    recentRows: 4,
    pinnedRows: 3,
    showTrayIcon: true,
  });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_setting")).toHaveLength(0);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "get_setting")).toHaveLength(1);
  expect(JSON.parse(databaseRaw ?? "{}")).toMatchObject({
    theme: "dark", recentRows: 4, pinnedRows: 3, showTrayIcon: true,
  });
  expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
});

it("rejects an unmount flush against its opening raw after another view changes the theme", async () => {
  const openingSettings: AToolsSettings = { ...DEFAULT_ATOOLS_SETTINGS, theme: "dark" };
  const openingRaw = JSON.stringify(openingSettings);
  let databaseRaw = openingRaw;
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_setting") {
      if (!hasExactKeys(args, ["key"]) || args.key !== "settings-general") throw new Error("Invalid get_setting fixture request");
      return databaseRaw;
    }
    if (command === "save_general_settings") {
      const expected = args?.expected;
      const changes = args?.changes;
      if (!hasExactKeys(args, ["expected", "changes", "applyNative"])
        || !hasExactKeys(expected, ["raw"]) || !changes || typeof changes !== "object" || Array.isArray(changes)
        || typeof args.applyNative !== "boolean") throw new Error("Invalid save_general_settings fixture request");
      if (expected.raw !== databaseRaw) throw new Error("General settings changed; reload before applying the patch");
      const current = JSON.parse(databaseRaw) as Record<string, unknown>;
      databaseRaw = JSON.stringify({ ...current, ...changes as Record<string, unknown> });
      return {
        version: 1,
        raw: databaseRaw,
        notificationDelivered: true,
        effectsApplied: args.applyNative,
        aiInvalidated: args.applyNative,
      };
    }
    if (command === "get_accessibility_permission_status") return { supported: false, trusted: false };
    if (command === "system_get_path") return null;
    throw new Error(`Unexpected settings fixture command: ${command}`);
  });

  const view = render(SystemPanel, { props: { panel: "settings", onpanelchange: vi.fn() } });
  await screen.findByText("显示托盘图标", { selector: ".setting-label > span" });
  const themeRow = screen.getByText("主题设置", { selector: ".setting-label > span" }).closest(".setting-item") as HTMLElement;
  const themeSelect = within(themeRow).getByRole("combobox") as HTMLSelectElement;
  await fireEvent.change(themeSelect, { target: { value: "light" } });

  databaseRaw = JSON.stringify({ ...openingSettings, theme: "system" });
  view.unmount();

  const calls = () => mocks.invoke.mock.calls;
  await waitFor(() => expect(calls().filter(([command]) => command === "save_general_settings")).toHaveLength(1));
  const attempted = calls().find(([command]) => command === "save_general_settings")?.[1] as {
    expected: { raw: string | null };
    changes: Record<string, unknown>;
    applyNative: boolean;
  };
  expect(attempted.expected).toEqual({ raw: openingRaw });
  expect(attempted.changes.theme).toBe("light");
  expect(attempted.applyNative).toBe(true);
  expect(calls().filter(([command]) => command === "get_setting")).toHaveLength(1);
  expect(JSON.parse(databaseRaw)).toMatchObject({ theme: "system" });
});

it("teardown flush keeps the opening CAS raw after an external settings commit", async () => {
  const openingSettings: AToolsSettings = { ...DEFAULT_ATOOLS_SETTINGS, theme: "dark" };
  const openingRaw = JSON.stringify(openingSettings);
  let databaseRaw = openingRaw;
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_setting") {
      if (!hasExactKeys(args, ["key"]) || args.key !== "settings-general") throw new Error("Invalid get_setting fixture request");
      return databaseRaw;
    }
    if (command === "save_general_settings") {
      const expected = args?.expected;
      const changes = args?.changes;
      if (!hasExactKeys(args, ["expected", "changes", "applyNative"])
        || !hasExactKeys(expected, ["raw"]) || !changes || typeof changes !== "object" || Array.isArray(changes)
        || typeof args.applyNative !== "boolean") throw new Error("Invalid save_general_settings fixture request");
      if (expected.raw !== databaseRaw) throw new Error("General settings changed; reload before applying the patch");
      const base = JSON.parse(databaseRaw) as Record<string, unknown>;
      databaseRaw = JSON.stringify({ ...base, ...changes as Record<string, unknown> });
      return {
        version: 1,
        raw: databaseRaw,
        notificationDelivered: true,
        effectsApplied: args.applyNative,
        aiInvalidated: args.applyNative,
      };
    }
    if (command === "get_accessibility_permission_status") return { supported: false, trusted: false };
    if (command === "system_get_path") return null;
    throw new Error(`Unexpected settings fixture command: ${command}`);
  });

  const view = render(SystemPanel, { props: { panel: "settings", onpanelchange: vi.fn() } });
  await screen.findByText("显示托盘图标", { selector: ".setting-label > span" });
  const themeSelect = within(screen.getByText("主题设置", { selector: ".setting-label > span" }).closest(".setting-item") as HTMLElement)
    .getByRole("combobox") as HTMLSelectElement;
  await fireEvent.change(themeSelect, { target: { value: "light" } });

  const externalSettings = { ...openingSettings, theme: "system" };
  databaseRaw = JSON.stringify(externalSettings);
  view.unmount();

  const getCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "get_setting");
  const saveCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "save_general_settings");
  await waitFor(() => expect(saveCalls()).toHaveLength(1));
  expect(getCalls()).toHaveLength(1);
  const attempted = saveCalls()[0][1] as {
    expected: { raw: string | null };
    changes: Record<string, unknown>;
    applyNative: boolean;
  };
  expect(attempted.expected).toEqual({ raw: openingRaw });
  expect(attempted.changes.theme).toBe("light");
  expect(attempted.applyNative).toBe(true);
  expect(JSON.parse(databaseRaw)).toMatchObject({ theme: "system" });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "get_setting")).toHaveLength(1);
});

it("preview teardown flush preserves a newer local theme through opening-raw CAS", async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  const openingSettings: AToolsSettings = { ...DEFAULT_ATOOLS_SETTINGS, theme: "dark" };
  const openingRaw = JSON.stringify(openingSettings);
  localStorage.setItem(SETTINGS_STORAGE_KEY, openingRaw);

  const originalGetItem = Storage.prototype.getItem;
  const originalSetItem = Storage.prototype.setItem;
  const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
    return originalGetItem.call(localStorage, key);
  });
  const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
    return originalSetItem.call(localStorage, key, value);
  });

  const view = render(SystemPanel, { props: { panel: "settings", onpanelchange: vi.fn() } });
  await screen.findByText("显示托盘图标", { selector: ".setting-label > span" });
  const openingReads = getItemSpy.mock.calls.filter(([key]) => key === SETTINGS_STORAGE_KEY).length;
  expect(openingReads).toBeGreaterThan(0);
  const themeRow = screen.getByText("主题设置", { selector: ".setting-label > span" }).closest(".setting-item") as HTMLElement;
  const themeSelect = within(themeRow).getByRole("combobox") as HTMLSelectElement;
  await fireEvent.change(themeSelect, { target: { value: "light" } });

  const externalRaw = JSON.stringify({ ...openingSettings, theme: "system" });
  localStorage.setItem(SETTINGS_STORAGE_KEY, externalRaw);
  const writesAfterExternalChange = setItemSpy.mock.calls.filter(([key]) => key === SETTINGS_STORAGE_KEY).length;
  view.unmount();

  await waitFor(() => {
    expect(getItemSpy.mock.calls.filter(([key]) => key === SETTINGS_STORAGE_KEY)).toHaveLength(openingReads + 1);
  });
  expect(setItemSpy.mock.calls.filter(([key]) => key === SETTINGS_STORAGE_KEY)).toHaveLength(writesAfterExternalChange);
  expect(mocks.invoke).not.toHaveBeenCalled();
  getItemSpy.mockRestore();
  setItemSpy.mockRestore();
  expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(externalRaw);
});
