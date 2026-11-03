import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  generalSettingsSnapshotFromRaw,
  readGeneralSettingsSnapshot,
  saveGeneralSettings,
} from "../../src/lib/generalSettingsStore";
import { SETTINGS_STORAGE_KEY } from "../../src/lib/settingsStorage";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: native.invoke,
}));

beforeEach(() => {
  native.invoke.mockReset();
  localStorage.clear();
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: native.invoke },
  });
});

afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("retains a true null native raw snapshot without falling back to localStorage", async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: "stale-local" }));
  native.invoke.mockResolvedValueOnce(null);

  await expect(readGeneralSettingsSnapshot()).resolves.toEqual({ raw: null, value: {} });
  expect(native.invoke).toHaveBeenCalledWith("get_setting", { key: "settings-general" });
  expect(native.invoke).toHaveBeenCalledTimes(1);
});

it("sends a raw compare-and-swap patch and accepts a committed receipt without notification", async () => {
  const initialRaw = JSON.stringify({ theme: "light", unknown: { keep: true } });
  const committedRaw = JSON.stringify({ theme: "dark", unknown: { keep: true } });
  native.invoke.mockResolvedValueOnce({
    version: 1,
    raw: committedRaw,
    notificationDelivered: false,
    effectsApplied: false,
    aiInvalidated: false,
  });

  const snapshot = generalSettingsSnapshotFromRaw(initialRaw);
  const receipt = await saveGeneralSettings(snapshot, { theme: "dark" }, { applyNative: true });

  expect(native.invoke).toHaveBeenCalledWith("save_general_settings", {
    expected: { raw: initialRaw },
    changes: { theme: "dark" },
    applyNative: true,
  });
  expect(receipt).toEqual({
    version: 1,
    raw: committedRaw,
    notificationDelivered: false,
    effectsApplied: false,
    aiInvalidated: false,
  });
  expect(receipt.raw).toContain('"unknown":{"keep":true}');
});

it("rejects getter-backed changes without invoking their getter or calling native", async () => {
  const snapshot = generalSettingsSnapshotFromRaw(JSON.stringify({ theme: "light" }));
  let getterCalls = 0;
  const changes = Object.defineProperty({}, "theme", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "dark";
    },
  }) as Record<string, unknown>;

  await expect(saveGeneralSettings(snapshot, changes)).rejects.toThrow(/accessors/);
  expect(getterCalls).toBe(0);
  expect(native.invoke).not.toHaveBeenCalled();
});

it("rejects unsafe JSON keys, over-budget wire requests, and incomplete receipts", async () => {
  const initial = generalSettingsSnapshotFromRaw(JSON.stringify({ theme: "light" }));
  const unsafe = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(unsafe, "__proto__", { value: { polluted: true }, enumerable: true });
  await expect(saveGeneralSettings(initial, unsafe)).rejects.toThrow(/forbidden key/);

  const largeSnapshot = generalSettingsSnapshotFromRaw(JSON.stringify({ unknown: "x".repeat(64 * 1024 - 64) }));
  await expect(saveGeneralSettings(largeSnapshot, { theme: "dark" })).rejects.toThrow(/64 KiB/);
  expect(native.invoke).not.toHaveBeenCalled();

  native.invoke.mockResolvedValueOnce({
    version: 1,
    raw: JSON.stringify({ theme: "light" }),
    notificationDelivered: true,
    effectsApplied: false,
    aiInvalidated: false,
  });
  await expect(saveGeneralSettings(initial, { theme: "dark" })).rejects.toThrow(/requested changes/);
});

it("matches Native field, key, depth, and receipt-wire bounds", async () => {
  const initial = generalSettingsSnapshotFromRaw(JSON.stringify({ theme: "light" }));
  const tooManyFields = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field-${index}`, index]));
  await expect(saveGeneralSettings(initial, tooManyFields)).rejects.toThrow(/128-field/);

  const longKey = { ["界".repeat(43)]: true };
  await expect(saveGeneralSettings(initial, longKey)).rejects.toThrow(/128 UTF-8 bytes/);

  let nested: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 33; index += 1) nested = { child: nested };
  await expect(saveGeneralSettings(initial, { nested })).rejects.toThrow(/nesting limit/);
  expect(native.invoke).not.toHaveBeenCalled();

  const maxBytes = 64 * 1024;
  let raw: string | null = null;
  for (let size = maxBytes - 1; size >= maxBytes - 256; size -= 1) {
    const candidate = JSON.stringify({ unknown: "x".repeat(size) });
    const requestWire = JSON.stringify({ expected: { raw: candidate }, changes: {}, applyNative: false });
    const receiptWire = JSON.stringify({ version: 1, raw: candidate, notificationDelivered: false, effectsApplied: false, aiInvalidated: false });
    if (new TextEncoder().encode(candidate).byteLength <= maxBytes
      && new TextEncoder().encode(requestWire).byteLength <= maxBytes
      && new TextEncoder().encode(receiptWire).byteLength > maxBytes) {
      raw = candidate;
      break;
    }
  }
  expect(raw).not.toBeNull();
  if (raw === null) throw new Error("Could not find a request/receipt wire budget boundary");
  const snapshot = generalSettingsSnapshotFromRaw(raw);
  native.invoke.mockResolvedValueOnce({
    version: 1,
    raw,
    notificationDelivered: false,
    effectsApplied: false,
    aiInvalidated: false,
  });
  await expect(saveGeneralSettings(snapshot, {})).rejects.toThrow(/64 KiB/);
  expect(native.invoke).toHaveBeenCalledTimes(1);
});

it("uses the preview cache only when its raw compare-and-swap value still matches", async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  const initialRaw = JSON.stringify({ theme: "light", unknown: "keep" });
  localStorage.setItem(SETTINGS_STORAGE_KEY, initialRaw);
  const snapshot = await readGeneralSettingsSnapshot();

  await saveGeneralSettings(snapshot, { theme: "dark" });
  expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}")).toEqual({ theme: "dark", unknown: "keep" });
  expect(native.invoke).not.toHaveBeenCalled();

  await expect(saveGeneralSettings(snapshot, { theme: "system" })).rejects.toThrow(/changed/);
});
