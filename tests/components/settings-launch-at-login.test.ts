import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import SettingsLaunchAtLoginControl from "../../src/components/SettingsLaunchAtLoginControl.svelte";
import {
  createAToolsSettingsWriter,
  normalizeSettings,
  SETTINGS_STORAGE_KEY,
  type AToolsSettings,
} from "../../src/lib/settings";
import { generalOverviewCards } from "../../src/lib/settingsPages";
import { openSettingsEditingSession } from "../../src/lib/settingsEditingSession";
import { applySettingsTransaction } from "../../src/lib/settingsNativeTransaction";
import type { SettingsLaunchAtLoginPort } from "../../src/lib/settingsLaunchAtLogin";
import { createLaunchAtLoginController } from "../../packages/ztools-settings/src/launchAtLoginController";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: native.invoke,
}));

const mounted: Array<{ instance: ReturnType<typeof mount>; target: HTMLElement }> = [];
const sessions: Array<{ close(): void }> = [];

function useNativeRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: native.invoke },
  });
}

function usePreviewRuntime() {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

function mountControl(props: {
  port?: SettingsLaunchAtLoginPort;
  onStateChange?: (enabled: boolean | null) => void;
}, target = document.createElement("div")) {
  document.body.append(target);
  const instance = mount(SettingsLaunchAtLoginControl, { target, props });
  mounted.push({ instance, target });
  return target;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function nativeDatabase(initialRaw: string) {
  let raw = initialRaw;
  native.invoke.mockImplementation(async (command, rawArgs) => {
    if (command === "get_setting") return raw as never;
    if (command !== "save_general_settings") throw new Error(`Unexpected command ${String(command)}`);
    const request = rawArgs as { expected: { raw: string | null }; changes: Record<string, unknown> };
    if (request.expected.raw !== raw) throw new Error("General settings CAS conflict");
    raw = JSON.stringify({ ...JSON.parse(raw) as Record<string, unknown>, ...request.changes });
    return {
      version: 1,
      raw,
      notificationDelivered: true,
      effectsApplied: true,
      aiInvalidated: true,
    } as never;
  });
  return { get raw() { return raw; } };
}

beforeEach(() => {
  native.invoke.mockReset();
  localStorage.clear();
  usePreviewRuntime();
});

afterEach(async () => {
  for (const view of mounted.splice(0)) {
    await unmount(view.instance);
    view.target.remove();
  }
  for (const session of sessions.splice(0)) session.close();
  usePreviewRuntime();
  localStorage.clear();
});

describe("Settings launch-at-login control", () => {
  it("uses the same status shape for initial, subscribed and published loading states", async () => {
    const pending = deferred<unknown>();
    const controller = createLaunchAtLoginController({
      read: () => pending.promise,
      change: vi.fn(),
    });
    const initial = controller.state();
    const snapshots: unknown[] = [];
    const unsubscribe = controller.subscribe(state => snapshots.push(state));

    expect(initial).toEqual({
      phase: "loading",
      enabled: null,
      message: "正在读取…",
      retryable: false,
      legacy: null,
    });
    expect(snapshots).toEqual([initial]);
    const starting = controller.start();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toEqual(initial);
    expect(snapshots[1]).not.toBe(initial);

    pending.resolve({ enabled: false });
    await expect(starting).resolves.toBe(true);
    expect(controller.state()).toEqual({
      phase: "ready",
      enabled: false,
      message: "",
      retryable: false,
      legacy: null,
    });
    const beforeDispose = snapshots.length;
    controller.dispose();
    expect(snapshots).toHaveLength(beforeDispose);
    unsubscribe();
  });

  it("uses a fresh OS read instead of the persisted bool, including on reopen", async () => {
    useNativeRuntime();
    const initialRaw = JSON.stringify({ launchAtLogin: true });
    const database = nativeDatabase(initialRaw);
    const session = await openSettingsEditingSession();
    sessions.push(session);
    expect(session.settings.launchAtLogin).toBe(true);
    const read = vi.fn().mockResolvedValueOnce({ enabled: false }).mockResolvedValueOnce({ enabled: true });
    const port: SettingsLaunchAtLoginPort = { read, change: vi.fn() };
    const first = mountControl({ port });
    await vi.waitFor(() => expect(first.querySelector<HTMLInputElement>("input")?.disabled).toBe(false));
    expect(first.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
    expect(read).toHaveBeenCalledOnce();

    await unmount(mounted.pop()!.instance);
    first.remove();
    const reopened = mountControl({ port });
    await vi.waitFor(() => expect(reopened.querySelector<HTMLInputElement>("input")?.checked).toBe(true));
    expect(read).toHaveBeenCalledTimes(2);
    expect(database.raw).toBe(initialRaw);
  });

  it("keeps malformed reads unknown and disabled until the user explicitly rereads", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ enabled: "false" })
      .mockResolvedValueOnce({ enabled: false });
    const change = vi.fn();
    const target = mountControl({ port: { read, change } });
    const checkbox = target.querySelector<HTMLInputElement>("input")!;
    await vi.waitFor(() => expect(target.textContent).toContain("启动项状态未知"));
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(change).not.toHaveBeenCalled();

    (target.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(checkbox.checked).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy login state mixed and offers only explicit resolution choices", async () => {
    const legacy = { modernEnabled: true, revision: "a".repeat(64) };
    const read = vi.fn().mockRejectedValue({ code: "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION" });
    const inspectLegacy = vi.fn().mockResolvedValue(legacy);
    const resolveLegacy = vi.fn().mockResolvedValue({ enabled: false });
    const change = vi.fn();
    const target = mountControl({ port: { read, change, inspectLegacy, resolveLegacy } });
    const checkbox = target.querySelector<HTMLInputElement>("input")!;
    await vi.waitFor(() => expect(target.textContent).toContain("旧启动项存在"));

    expect(checkbox.checked).toBe(false);
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect([...target.querySelectorAll("button")].map(button => button.textContent?.trim())).toEqual([
      "关闭旧启动项", "迁移到新机制", "暂不处理",
    ]);
    (target.querySelectorAll("button")[0] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(resolveLegacy).toHaveBeenCalledWith({
      choice: "turnOff", expectedModern: true, revision: legacy.revision,
    });
    expect(change).not.toHaveBeenCalled();
    expect(checkbox.checked).toBe(false);
    expect(checkbox.indeterminate).toBe(false);
  });

  it("leaves legacy status unknown when the user defers and rereads before showing choices again", async () => {
    const read = vi.fn().mockRejectedValue({ code: "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION" });
    const inspectLegacy = vi.fn().mockResolvedValue({ modernEnabled: false, revision: "b".repeat(64) });
    const resolveLegacy = vi.fn();
    const target = mountControl({ port: { read, change: vi.fn(), inspectLegacy, resolveLegacy } });
    const checkbox = target.querySelector<HTMLInputElement>("input")!;
    await vi.waitFor(() => expect(target.querySelectorAll("button")).toHaveLength(3));

    (target.querySelectorAll("button")[2] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(target.textContent).toContain("未作更改"));
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(resolveLegacy).not.toHaveBeenCalled();

    (target.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(target.querySelectorAll("button")).toHaveLength(3));
    expect(read).toHaveBeenCalledTimes(2);
    expect(inspectLegacy).toHaveBeenCalledTimes(2);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "keeps prototype-named Native error code %s on the unknown path",
    async code => {
      const target = mountControl({
        port: { read: () => Promise.reject({ code }), change: vi.fn() },
      });
      const checkbox = target.querySelector<HTMLInputElement>("input")!;
      await vi.waitFor(() => expect(target.textContent).toContain("启动项状态未知"));
      expect(checkbox.indeterminate).toBe(true);
      expect(checkbox.disabled).toBe(true);
      expect(target.querySelector("button")?.textContent).toContain("重新读取");
    },
  );

  it("turns a CAS conflict into unknown and recovers only through an explicit read", async () => {
    const read = vi.fn().mockResolvedValueOnce({ enabled: true }).mockResolvedValueOnce({ enabled: false });
    const change = vi.fn().mockRejectedValue({ code: "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT" });
    const target = mountControl({ port: { read, change } });
    const checkbox = target.querySelector<HTMLInputElement>("input")!;
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
    checkbox.click();
    await vi.waitFor(() => expect(target.textContent).toContain("启动项已变化"));

    expect(change).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith({ expected: true, enabled: false });
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.disabled).toBe(true);
    (target.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(checkbox.checked).toBe(false);
    expect(change).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bounds duplicate clicks and stops native toggle events reaching the form save handler", async () => {
    const write = deferred<unknown>();
    const read = vi.fn().mockResolvedValue({ enabled: false });
    const change = vi.fn(() => write.promise);
    const fieldset = document.createElement("fieldset");
    const onInput = vi.fn();
    const onChange = vi.fn();
    fieldset.addEventListener("input", onInput);
    fieldset.addEventListener("change", onChange);
    const target = mountControl({ port: { read, change } }, fieldset);
    const checkbox = target.querySelector<HTMLInputElement>("input")!;
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));

    checkbox.click();
    checkbox.click();
    await vi.waitFor(() => expect(change).toHaveBeenCalledOnce());
    expect(change).toHaveBeenCalledWith({ expected: false, enabled: true });
    expect(onInput).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    write.resolve({ enabled: true });
    await vi.waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it("ignores late Native replies after the control is disposed", async () => {
    const pending = deferred<unknown>();
    const observed: Array<boolean | null> = [];
    const target = mountControl({
      port: { read: () => pending.promise, change: vi.fn() },
      onStateChange: enabled => observed.push(enabled),
    });
    const view = mounted.pop()!;
    await unmount(view.instance);
    target.remove();
    pending.resolve({ enabled: true });
    await tick();
    expect(observed).not.toContain(true);
  });

  it("ignores a late legacy resolution after the control is disposed", async () => {
    const pending = deferred<unknown>();
    const observed: Array<boolean | null> = [];
    const target = mountControl({
      port: {
        read: () => Promise.reject({ code: "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION" }),
        inspectLegacy: () => Promise.resolve({ modernEnabled: false, revision: "c".repeat(64) }),
        change: vi.fn(),
        resolveLegacy: () => pending.promise,
      },
      onStateChange: enabled => observed.push(enabled),
    });
    await vi.waitFor(() => expect(target.querySelectorAll("button")).toHaveLength(3));
    (target.querySelectorAll("button")[1] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(target.textContent).toContain("正在处理"));
    const view = mounted.pop()!;
    await unmount(view.instance);
    target.remove();
    pending.resolve({ enabled: true });
    await tick();
    expect(observed).not.toContain(true);
  });

  it("calls the fixed Native facade with exact operation names and payload", async () => {
    useNativeRuntime();
    native.invoke.mockRejectedValueOnce({ code: "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION" })
      .mockResolvedValueOnce({ modernEnabled: false, revision: "d".repeat(64) })
      .mockResolvedValueOnce({ enabled: true });
    const { createSettingsLaunchAtLoginController } = await import("../../src/lib/settingsLaunchAtLogin");
    const controller = createSettingsLaunchAtLoginController();
    await expect(controller.start()).resolves.toBe(true);
    expect(controller.state().phase).toBe("legacy");
    await expect(controller.resolveLegacy("migrate")).resolves.toBe(true);
    expect(native.invoke.mock.calls).toEqual([
      ["read_launch_at_login"],
      ["inspect_legacy_launch_at_login"],
      ["resolve_legacy_launch_at_login", {
        choice: "migrate", expectedModern: false, revision: "d".repeat(64),
      }],
    ]);
    controller.dispose();
  });
});

describe("Settings launch-at-login persistence separation", () => {
  it("omits OS-owned state from both Native full-form writer paths", async () => {
    useNativeRuntime();
    const initialRaw = JSON.stringify({ theme: "light", launchAtLogin: true, unknown: "keep" });
    const database = nativeDatabase(initialRaw);
    const session = await openSettingsEditingSession();
    sessions.push(session);
    const next: AToolsSettings = { ...session.settings, theme: "dark", launchAtLogin: false };

    await createAToolsSettingsWriter()(next, session.settings);
    let request = native.invoke.mock.calls[1][1] as { expected: { raw: string | null }; changes: Record<string, unknown> };
    expect(request.expected.raw).toBe(initialRaw);
    expect(request.changes).not.toHaveProperty("launchAtLogin");
    expect(JSON.parse(database.raw)).toMatchObject({ launchAtLogin: true, theme: "dark", unknown: "keep" });

    const following: AToolsSettings = { ...next, theme: "system", launchAtLogin: true };
    await applySettingsTransaction(following, next, async () => {
      throw new Error("Native transaction must not use the preview writer");
    }, normalizeSettings);
    request = native.invoke.mock.calls[2][1] as typeof request;
    expect(request.changes).not.toHaveProperty("launchAtLogin");
    expect(request.changes.theme).toBe("system");
    expect(JSON.parse(database.raw)).toMatchObject({ launchAtLogin: true, theme: "system", unknown: "keep" });
  });

  it("keeps preview checkbox state in the existing persisted full-form path", async () => {
    const initialRaw = JSON.stringify({ theme: "light", launchAtLogin: true });
    localStorage.setItem(SETTINGS_STORAGE_KEY, initialRaw);
    const session = await openSettingsEditingSession();
    sessions.push(session);
    await createAToolsSettingsWriter()({ ...session.settings, theme: "dark" }, session.settings);

    expect(native.invoke).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}")).toMatchObject({
      theme: "dark",
      launchAtLogin: true,
    });
  });

  it("does not call an unknown OS status manual startup in the General overview", () => {
    const cards = generalOverviewCards({
      hotkey: "Option+Z",
      saveLabel: "已保存",
      launchAtLogin: null,
      showTrayIcon: true,
      localAppSearch: true,
      localLaunchSearch: true,
      unsupportedCount: 0,
    });
    const entry = cards.find(card => card.label === "系统入口");
    expect(entry?.value).toContain("启动状态未知");
    expect(entry?.value).not.toContain("手动启动");
    expect(entry?.tone).toBe("warning");
  });
});
