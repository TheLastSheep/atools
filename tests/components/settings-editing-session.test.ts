import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createAToolsSettingsWriter, DEFAULT_ATOOLS_SETTINGS, loadAToolsSettings, loadAToolsSettingsSync, saveAToolsSettings,
  SETTINGS_STORAGE_KEY, type AToolsSettings } from "../../src/lib/settings";
import { openSettingsEditingSession } from "../../src/lib/settingsEditingSession";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const nativeInvoke = vi.mocked(invoke);
const opened: Array<{ close: () => void }> = [];

function useNativeRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true, value: { invoke: vi.fn() },
  });
}

function usePreviewRuntime() {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

function stored(value: Partial<AToolsSettings> & Record<string, unknown>) {
  return JSON.stringify(value);
}

function nativeReceipt(raw: string, applyNative = false) {
  return { version: 1, raw, notificationDelivered: true, effectsApplied: applyNative, aiInvalidated: applyNative };
}

async function open() {
  const session = await openSettingsEditingSession();
  opened.push(session);
  return session;
}

beforeEach(() => {
  nativeInvoke.mockReset();
  localStorage.clear();
  useNativeRuntime();
});

afterEach(() => {
  for (const session of opened.splice(0)) session.close();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  localStorage.clear();
});

describe("settings editing read session", () => {
  it("rejects accessor-backed explicit settings without invoking a getter or reading native", async () => {
    let getterCalls = 0;
    const settings = Object.defineProperty({ ...DEFAULT_ATOOLS_SETTINGS }, "theme", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "dark";
      },
    }) as AToolsSettings;

    await expect(saveAToolsSettings(settings)).rejects.toThrow(/accessors/);
    expect(getterCalls).toBe(0);
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it("waits for a strict native read and opens with defaults when native settings are null", async () => {
    let resolveRead!: (value: string | null) => void;
    nativeInvoke.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }) as never);
    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "stale-local" }));

    const pending = openSettingsEditingSession();
    await Promise.resolve();
    expect(nativeInvoke).toHaveBeenCalledTimes(1);
    expect(nativeInvoke).toHaveBeenCalledWith("get_setting", { key: "settings-general" });
    resolveRead(null);
    const session = await pending;
    opened.push(session);
    expect(session.raw).toBeNull();
    expect(session.settings).toMatchObject({ theme: DEFAULT_ATOOLS_SETTINGS.theme, hotkey: DEFAULT_ATOOLS_SETTINGS.hotkey });
    expect(loadAToolsSettingsSync().theme).toBe(DEFAULT_ATOOLS_SETTINGS.theme);
  });

  it("does not apply appearance when a delayed editor open resolves after its caller is abandoned", async () => {
    let resolveRead!: (value: string | null) => void;
    nativeInvoke.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }) as never);
    document.documentElement.dataset.atoolsTheme = "existing-theme";
    document.documentElement.style.setProperty("--accent", "initial-accent");

    const pending = openSettingsEditingSession();
    const callerAbandoned = true;
    resolveRead(stored({ theme: "late-native-theme", primaryColor: "green" }));
    const session = await pending;
    if (callerAbandoned) session.close();

    expect(document.documentElement.dataset.atoolsTheme).toBe("existing-theme");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("initial-accent");
  });

  it.each([
    ["native read rejection", new Error("native unavailable")],
    ["invalid JSON", "{"],
    ["non-record JSON", "[]"],
    ["null JSON", "null"],
  ])("rejects %s without falling back to localStorage", async (_label, response) => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "stale-local" }));
    if (response instanceof Error) nativeInvoke.mockRejectedValue(response);
    else nativeInvoke.mockResolvedValue(response as never);

    await expect(openSettingsEditingSession()).rejects.toThrow();
    expect(nativeInvoke).toHaveBeenCalledTimes(1);
    expect(nativeInvoke).toHaveBeenCalledWith("get_setting", { key: "settings-general" });
    expect(loadAToolsSettingsSync().theme).toBe("stale-local");
  });

  it("uses the existing local fallback in preview without invoking native settings", async () => {
    usePreviewRuntime();
    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "light", recentRows: 4 }));

    const session = await open();
    expect(session.settings.theme).toBe("light");
    expect(session.settings.recentRows).toBe(4);
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it("refreshes the preview lease after local persistence succeeds", async () => {
    usePreviewRuntime();
    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "before-preview-save" }));
    const session = await open();

    await saveAToolsSettings({ ...session.settings, theme: "after-preview-save" });

    expect(loadAToolsSettingsSync().theme).toBe("after-preview-save");
    expect((await loadAToolsSettings()).theme).toBe("after-preview-save");
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!).theme).toBe("after-preview-save");
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it("keeps the preview lease unchanged when local persistence fails", async () => {
    usePreviewRuntime();
    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "before-failed-preview-save" }));
    const session = await open();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });

    await expect(saveAToolsSettings({ ...session.settings, theme: "failed-preview-save" })).rejects.toThrow("quota");

    expect(loadAToolsSettingsSync().theme).toBe("before-failed-preview-save");
    expect((await loadAToolsSettings()).theme).toBe("before-failed-preview-save");
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it("shares one authoritative native snapshot across sync and async loads without exposing its arrays", async () => {
    nativeInvoke.mockResolvedValue(stored({ theme: "native", wakeupBlacklist: ["one"],
      appShortcuts: [{ id: "shortcut-1", shortcut: "⌘K", targetCode: "feature", enabled: true }] }) as never);
    const session = await open();
    session.settings.wakeupBlacklist.push("mutated-return-value");
    session.settings.appShortcuts[0].targetCode = "mutated-return-value";

    const sync = loadAToolsSettingsSync();
    const asyncSettings = await loadAToolsSettings();
    expect(sync.wakeupBlacklist).toEqual(["one"]);
    expect(asyncSettings.appShortcuts[0].targetCode).toBe("feature");
    sync.wakeupBlacklist.push("mutated-synchronous-read");
    asyncSettings.appShortcuts[0].targetCode = "mutated-asynchronous-read";
    expect(loadAToolsSettingsSync().wakeupBlacklist).toEqual(["one"]);
    expect((await loadAToolsSettings()).appShortcuts[0].targetCode).toBe("feature");
    expect(nativeInvoke).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer editing lease when an older lease closes", async () => {
    nativeInvoke.mockResolvedValueOnce(stored({ theme: "older" }) as never)
      .mockResolvedValueOnce(stored({ theme: "newer" }) as never);
    const older = await open();
    const newer = await open();
    older.close();
    expect(loadAToolsSettingsSync().theme).toBe("newer");
    newer.close();
    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "local-after-close" }));
    expect(loadAToolsSettingsSync().theme).toBe("local-after-close");
  });

  it("rejects a late older native read instead of replacing a newer lease", async () => {
    const replies: Array<(value: string | null) => void> = [];
    nativeInvoke.mockImplementation(() => new Promise(resolve => { replies.push(resolve); }) as never);
    const olderOpen = openSettingsEditingSession();
    const newerOpen = openSettingsEditingSession();

    replies[1](stored({ theme: "newer" }));
    const newer = await newerOpen;
    opened.push(newer);
    replies[0](stored({ theme: "older" }));

    await expect(olderOpen).rejects.toThrow("superseded");
    expect(loadAToolsSettingsSync().theme).toBe("newer");
  });

  it("does not start a native read when its caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(openSettingsEditingSession({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it("does not publish a cancelled late read for ordinary settings loads", async () => {
    const replies: Array<(value: string | null) => void> = [];
    nativeInvoke.mockImplementation(() => new Promise(resolve => { replies.push(resolve); }) as never);
    const controller = new AbortController();
    const pending = openSettingsEditingSession({ signal: controller.signal });
    controller.abort();
    replies[0](stored({ theme: "cancelled-late-value" }));
    const outcome = await pending.then(session => {
      opened.push(session);
      return { session } as const;
    }, error => ({ error }) as const);

    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "local-current" }));
    const ordinaryLoad = loadAToolsSettings();
    if (replies[1]) replies[1](stored({ theme: "native-current" }));
    const current = await ordinaryLoad;

    expect("error" in outcome && outcome.error.name).toBe("AbortError");
    expect(current.theme).toBe("native-current");
    expect(nativeInvoke).toHaveBeenCalledTimes(2);
  });

  it("closes an active lease synchronously when its signal aborts", async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "local-after-abort" }));
    nativeInvoke.mockResolvedValue(stored({ theme: "native-before-abort" }) as never);
    const controller = new AbortController();
    const session = await openSettingsEditingSession({ signal: controller.signal });
    opened.push(session);

    controller.abort();

    expect(loadAToolsSettingsSync().theme).toBe("local-after-abort");
  });

  it("detaches an old abort listener without allowing it to clear a newer lease", async () => {
    nativeInvoke.mockResolvedValueOnce(stored({ theme: "signalled-older" }) as never)
      .mockResolvedValueOnce(stored({ theme: "newer" }) as never);
    const controller = new AbortController();
    const older = await openSettingsEditingSession({ signal: controller.signal });
    opened.push(older);
    await open();

    older.close();
    controller.abort();

    expect(loadAToolsSettingsSync().theme).toBe("newer");
  });

  it("updates the active snapshot only after native persistence succeeds", async () => {
    let databaseRaw = stored({ theme: "before" });
    let failNextSave = true;
    nativeInvoke.mockImplementation(async (command, rawArgs) => {
      if (command === "get_setting") return databaseRaw as never;
      if (command !== "save_general_settings") throw new Error(`Unexpected settings command: ${command}`);
      const args = rawArgs as { expected: { raw: string | null }; changes: Record<string, unknown>; applyNative: boolean };
      if (args.expected.raw !== databaseRaw) throw new Error("General settings changed; reload before applying the patch");
      if (failNextSave) {
        failNextSave = false;
        throw new Error("save failed");
      }
      const base = JSON.parse(databaseRaw) as Record<string, unknown>;
      databaseRaw = JSON.stringify({ ...base, ...args.changes });
      return nativeReceipt(databaseRaw, args.applyNative) as never;
    });
    const session = await open();
    const failed = { ...session.settings, theme: "failed-write" };
    await expect(saveAToolsSettings(failed)).rejects.toThrow("save failed");
    expect(loadAToolsSettingsSync().theme).toBe("before");
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();

    const saved = { ...session.settings, theme: "saved-write" };
    await saveAToolsSettings(saved);
    expect(loadAToolsSettingsSync().theme).toBe("saved-write");
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!).theme).toBe("saved-write");
    expect(session.raw).toBe(stored({ theme: "before" }));
  });

  it("uses the opening raw for compare-and-swap without a blind read retry", async () => {
    const openedRaw = ' { "theme": "opened", "unknown": { "keep": true } } ';
    let databaseRaw = openedRaw;
    const session = await (async () => {
      nativeInvoke.mockImplementation(async command => command === "get_setting" ? databaseRaw as never : undefined as never);
      return open();
    })();
    databaseRaw = stored({ theme: "changed-elsewhere" });
    nativeInvoke.mockImplementation(async (command, rawArgs) => {
      if (command !== "save_general_settings") throw new Error(`Unexpected retry read: ${command}`);
      const args = rawArgs as { expected: { raw: string | null } };
      expect(args.expected.raw).toBe(openedRaw);
      throw new Error("General settings changed; reload before applying the patch");
    });

    await expect(saveAToolsSettings({ ...session.settings, theme: "stale-edit" })).rejects.toThrow("changed");
    expect(nativeInvoke.mock.calls.map(([command]) => command)).toEqual(["get_setting", "save_general_settings"]);
    expect(session.raw).toBe(openedRaw);
    expect(loadAToolsSettingsSync().theme).toBe("opened");
  });

  it("strictly reads native raw before an explicit save with no editing lease", async () => {
    let databaseRaw = stored({ theme: "current-native", unknown: "preserved" });
    nativeInvoke.mockImplementation(async (command, rawArgs) => {
      if (command === "get_setting") return databaseRaw as never;
      if (command !== "save_general_settings") throw new Error(`Unexpected settings command: ${command}`);
      const args = rawArgs as { expected: { raw: string | null }; changes: Record<string, unknown> };
      expect(args.expected.raw).toBe(stored({ theme: "current-native", unknown: "preserved" }));
      databaseRaw = JSON.stringify({ ...JSON.parse(databaseRaw), ...args.changes });
      return nativeReceipt(databaseRaw) as never;
    });
    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "stale-local" }));

    await saveAToolsSettings({ ...DEFAULT_ATOOLS_SETTINGS, theme: "explicit-save" });

    expect(nativeInvoke.mock.calls.map(([command]) => command)).toEqual(["get_setting", "save_general_settings"]);
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!).theme).toBe("explicit-save");
  });

  it("keeps a bound old-view writer from refreshing a newer lease after close", async () => {
    let databaseRaw = stored({ theme: "old-view" });
    let oldReceiptRaw = "";
    let resolveWrite!: (value: unknown) => void;
    const writeReceipt = new Promise<unknown>(resolve => { resolveWrite = resolve; });
    nativeInvoke.mockImplementation(async (command, rawArgs) => {
      if (command === "get_setting") return databaseRaw as never;
      if (command !== "save_general_settings") throw new Error(`Unexpected settings command: ${command}`);
      const args = rawArgs as { expected: { raw: string | null }; changes: Record<string, unknown>; applyNative: boolean };
      expect(args.expected.raw).toBe(stored({ theme: "old-view" }));
      const base = JSON.parse(databaseRaw) as Record<string, unknown>;
      oldReceiptRaw = JSON.stringify({ ...base, ...args.changes });
      databaseRaw = oldReceiptRaw;
      return writeReceipt as never;
    });
    const oldSession = await open();
    const oldWriter = createAToolsSettingsWriter();
    const oldNext = { ...oldSession.settings, theme: "late-old-save" };
    const lateSave = oldWriter(oldNext, oldSession.settings);
    await Promise.resolve();
    oldSession.close();
    databaseRaw = stored({ theme: "new-view" });
    const newSession = await open();

    resolveWrite(nativeReceipt(oldReceiptRaw));
    await lateSave;

    expect(newSession.raw).toBe(stored({ theme: "new-view" }));
    expect(loadAToolsSettingsSync().theme).toBe("new-view");
  });

  it("returns to the original local fallback after the matching lease closes", async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, stored({ theme: "local" }));
    nativeInvoke.mockResolvedValueOnce(stored({ theme: "native" }) as never)
      .mockRejectedValueOnce(new Error("legacy read unavailable"));
    const session = await open();
    expect(loadAToolsSettingsSync().theme).toBe("native");
    session.close();

    expect(loadAToolsSettingsSync().theme).toBe("local");
    expect((await loadAToolsSettings()).theme).toBe("local");
  });
});
