import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  createAToolsSettingsWriter,
  DEFAULT_ATOOLS_SETTINGS,
  normalizeSettings,
  SETTINGS_STORAGE_KEY,
  type AToolsSettings,
} from "../../src/lib/settings";
import { openSettingsEditingSession } from "../../src/lib/settingsEditingSession";
import { applySettingsTransaction } from "../../src/lib/settingsNativeTransaction";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: native.invoke,
}));

const nativeInvoke = vi.mocked(invoke);
const opened: Array<{ close: () => void }> = [];

function useNativeRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: native.invoke },
  });
}

function usePreviewRuntime() {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

function nativeReceipt(raw: string, applyNative: boolean) {
  return {
    version: 1,
    raw,
    notificationDelivered: true,
    effectsApplied: applyNative,
    aiInvalidated: applyNative,
  };
}

function useNativeDatabase(initialRaw: string) {
  let databaseRaw = initialRaw;
  nativeInvoke.mockImplementation(async (command, rawArgs) => {
    if (command === "get_setting") return databaseRaw as never;
    if (command !== "save_general_settings") throw new Error(`Unexpected settings command: ${command}`);

    const args = rawArgs as {
      expected: { raw: string | null };
      changes: Record<string, unknown>;
      applyNative: boolean;
    };
    if (args.expected.raw !== databaseRaw) throw new Error("General settings changed; reload before applying the patch");
    const base = JSON.parse(databaseRaw) as Record<string, unknown>;
    databaseRaw = JSON.stringify({ ...base, ...args.changes });
    return nativeReceipt(databaseRaw, args.applyNative) as never;
  });
  return { currentRaw: () => databaseRaw };
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
  usePreviewRuntime();
  localStorage.clear();
});

describe("legacy settings writer hotkey preservation", () => {
  it.each([false, ""])(
    "omits unchanged malformed hotkey %j from a Native settings patch and preserves its raw value",
    async invalidHotkey => {
      const initialRaw = JSON.stringify({ hotkey: invalidHotkey, placeholder: "before" });
      const database = useNativeDatabase(initialRaw);
      const session = await open();
      expect(session.settings.hotkey).toBe(DEFAULT_ATOOLS_SETTINGS.hotkey);

      const writer = createAToolsSettingsWriter();
      await writer({ ...session.settings, placeholder: "after" }, session.settings);

      expect(nativeInvoke).toHaveBeenCalledTimes(2);
      const [command, rawArgs] = nativeInvoke.mock.calls[1];
      expect(command).toBe("save_general_settings");
      const request = rawArgs as { expected: { raw: string | null }; changes: Record<string, unknown> };
      expect(request.expected.raw).toBe(initialRaw);
      expect(request.changes).not.toHaveProperty("hotkey");
      expect(request.changes.placeholder).toBe("after");
      expect(JSON.parse(database.currentRaw())).toMatchObject({ hotkey: invalidHotkey, placeholder: "after" });
    },
  );

  it("sends an explicitly changed valid hotkey with the Native settings patch", async () => {
    const initialRaw = JSON.stringify({ hotkey: false, placeholder: "before" });
    const database = useNativeDatabase(initialRaw);
    const session = await open();
    const writer = createAToolsSettingsWriter();
    const next = {
      ...session.settings,
      hotkey: "Command+Shift+F11",
      placeholder: "after",
    };

    await writer(next, session.settings);

    const request = nativeInvoke.mock.calls[1][1] as { changes: Record<string, unknown> };
    expect(request.changes.hotkey).toBe("Command+Shift+F11");
    expect(JSON.parse(database.currentRaw())).toMatchObject({
      hotkey: "Command+Shift+F11",
      placeholder: "after",
    });
  });

  it("uses the same omission for the direct Native transaction entry point", async () => {
    const initialRaw = JSON.stringify({ hotkey: false, placeholder: "before" });
    useNativeDatabase(initialRaw);
    const session = await open();

    await applySettingsTransaction(
      { ...session.settings, placeholder: "after" },
      session.settings,
      async () => { throw new Error("Native persistence must not use the preview writer"); },
      normalizeSettings,
    );

    const request = nativeInvoke.mock.calls[1][1] as { changes: Record<string, unknown> };
    expect(request.changes).not.toHaveProperty("hotkey");
    expect(request.changes.placeholder).toBe("after");
  });

  it("keeps the raw hotkey when the direct Native transaction opens its own snapshot", async () => {
    const initialRaw = JSON.stringify({ hotkey: "", placeholder: "before" });
    const database = useNativeDatabase(initialRaw);
    const previous = normalizeSettings(JSON.parse(initialRaw) as Partial<AToolsSettings>);

    await applySettingsTransaction(
      { ...previous, placeholder: "after" },
      previous,
      async () => { throw new Error("Native persistence must not use the preview writer"); },
      normalizeSettings,
    );

    const request = nativeInvoke.mock.calls[1][1] as {
      expected: { raw: string | null };
      changes: Record<string, unknown>;
    };
    expect(request.expected.raw).toBe(initialRaw);
    expect(request.changes).not.toHaveProperty("hotkey");
    expect(JSON.parse(database.currentRaw())).toMatchObject({ hotkey: "", placeholder: "after" });
  });

  it("validates own-data settings before comparing hotkey values", async () => {
    const initialRaw = JSON.stringify({ hotkey: false });
    useNativeDatabase(initialRaw);
    const session = await open();
    const writer = createAToolsSettingsWriter();
    let getterCalls = 0;
    const next = Object.defineProperty({ ...session.settings }, "hotkey", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return session.settings.hotkey;
      },
    }) as AToolsSettings;

    await expect(writer(next, session.settings)).rejects.toThrow(/accessors/);
    expect(getterCalls).toBe(0);
    expect(nativeInvoke).toHaveBeenCalledTimes(1);
  });

  it("keeps preview full-form persistence unchanged", async () => {
    usePreviewRuntime();
    const initialRaw = JSON.stringify({ hotkey: false, placeholder: "before" });
    localStorage.setItem(SETTINGS_STORAGE_KEY, initialRaw);
    const session = await open();
    const writer = createAToolsSettingsWriter();

    await writer({ ...session.settings, placeholder: "after" }, session.settings);

    expect(nativeInvoke).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toMatchObject({
      hotkey: DEFAULT_ATOOLS_SETTINGS.hotkey,
      placeholder: "after",
    });
  });
});

describe("Native settings writer default height preservation", () => {
  it.each([2001, 2001.5])(
    "omits unchanged normalized height when the stored value is %s",
    async rawHeight => {
      const initialRaw = JSON.stringify({ theme: "dark", windowDefaultHeight: rawHeight });
      const database = useNativeDatabase(initialRaw);
      const session = await open();
      expect(session.settings.windowDefaultHeight).toBe(1200);

      const writer = createAToolsSettingsWriter();
      await writer({ ...session.settings, theme: "light" }, session.settings);

      expect(nativeInvoke).toHaveBeenCalledTimes(2);
      const request = nativeInvoke.mock.calls[1][1] as {
        expected: { raw: string | null };
        changes: Record<string, unknown>;
      };
      expect(request.expected.raw).toBe(initialRaw);
      expect(request.changes.theme).toBe("light");
      expect(request.changes).not.toHaveProperty("windowDefaultHeight");
      expect(JSON.parse(database.currentRaw()).windowDefaultHeight).toBe(rawHeight);
    },
  );

  it("sends an explicitly changed fractional height", async () => {
    const initialRaw = JSON.stringify({ theme: "dark", windowDefaultHeight: 2001.5 });
    const database = useNativeDatabase(initialRaw);
    const session = await open();
    expect(session.settings.windowDefaultHeight).toBe(1200);

    const writer = createAToolsSettingsWriter();
    await writer({ ...session.settings, theme: "light", windowDefaultHeight: 700.5 }, session.settings);

    expect(nativeInvoke).toHaveBeenCalledTimes(2);
    const request = nativeInvoke.mock.calls[1][1] as { changes: Record<string, unknown> };
    expect(request.changes.windowDefaultHeight).toBe(700.5);
    expect(JSON.parse(database.currentRaw()).windowDefaultHeight).toBe(700.5);
  });

  it("keeps the raw height through a failed save and retry", async () => {
    const initialRaw = JSON.stringify({ theme: "dark", windowDefaultHeight: 2001.5 });
    const database = useNativeDatabase(initialRaw);
    const session = await open();
    const writer = createAToolsSettingsWriter();
    const next = { ...session.settings, theme: "light" };
    nativeInvoke.mockRejectedValueOnce(new Error("fixture atomic settings transaction failed"));

    await expect(writer(next, session.settings)).rejects.toThrow("fixture atomic settings transaction failed");
    expect(nativeInvoke).toHaveBeenCalledTimes(2);
    const failedRequest = nativeInvoke.mock.calls[1][1] as {
      expected: { raw: string | null };
      changes: Record<string, unknown>;
    };
    expect(failedRequest.expected.raw).toBe(initialRaw);
    expect(failedRequest.changes).not.toHaveProperty("windowDefaultHeight");
    expect(database.currentRaw()).toBe(initialRaw);

    await writer(next, session.settings);
    expect(nativeInvoke).toHaveBeenCalledTimes(3);
    const retryRequest = nativeInvoke.mock.calls[2][1] as {
      expected: { raw: string | null };
      changes: Record<string, unknown>;
    };
    expect(retryRequest.expected.raw).toBe(initialRaw);
    expect(retryRequest.changes).not.toHaveProperty("windowDefaultHeight");
    expect(JSON.parse(database.currentRaw())).toMatchObject({ theme: "light", windowDefaultHeight: 2001.5 });
  });
});
