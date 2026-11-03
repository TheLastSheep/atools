import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SystemPanel from "../../src/components/SystemPanel.svelte";
import { DEFAULT_ATOOLS_SETTINGS } from "../../src/lib/settings";
import type { PluginMarketRequest } from "../../src/lib/pluginMarketNavigation";
import type { SettingsMenuId } from "../../src/lib/settingsPages";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../src/lib/settingsEditingSession", () => ({ openSettingsEditingSession: mocks.open }));
vi.mock("../../src/components/SettingsPanel.svelte", async () => ({
  default: (await import("./SettingsEditingPanelFixture.svelte")).default,
}));

type Session = { settings: typeof DEFAULT_ATOOLS_SETTINGS; close: ReturnType<typeof vi.fn> };
function session(): Session {
  return { settings: { ...DEFAULT_ATOOLS_SETTINGS }, close: vi.fn() };
}
function signalForCall(index: number): AbortSignal {
  return (mocks.open.mock.calls[index]?.[0] as { signal: AbortSignal }).signal;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function openSettings(settingsMenu: SettingsMenuId = "general", marketRequest: PluginMarketRequest | null = null) {
  return render(SystemPanel, { props: { panel: "settings", settingsMenu, marketRequest, onpanelchange: vi.fn() } });
}

beforeEach(() => mocks.open.mockReset());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("settings editing gate through SystemPanel", () => {
  it("keeps the settings form unmounted until the session snapshot is ready and releases it on exit", async () => {
    const pending = deferred<Session>();
    const lease = session();
    mocks.open.mockReturnValue(pending.promise);
    const view = openSettings();
    const signal = signalForCall(0);

    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("正在读取设置");
    expect(screen.queryByRole("region", { name: "设置表单夹具" })).toBeNull();

    pending.resolve(lease);
    expect(await screen.findByRole("region", { name: "设置表单夹具" })).toBeTruthy();
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(lease.close).toHaveBeenCalledTimes(1);
  });

  it("shows a fixed error and retries only after an explicit user action", async () => {
    const lease = session();
    mocks.open.mockRejectedValueOnce(new Error("secret native path /private/data"))
      .mockResolvedValueOnce(lease);
    const view = openSettings();

    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("设置加载失败");
    expect(error.textContent).toContain("设置暂不可用，请重试。");
    expect(error.textContent).not.toContain("secret native path");
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(signalForCall(0).aborted).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("region", { name: "设置表单夹具" })).toBeTruthy();
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(signalForCall(1)).not.toBe(signalForCall(0));
    expect(signalForCall(1).aborted).toBe(false);
    view.unmount();
    expect(signalForCall(1).aborted).toBe(true);
  });

  it("invalidates a timed-out read, closes its late lease, and mounts only the retry result", async () => {
    vi.useFakeTimers();
    const stale = deferred<Session>();
    const current = deferred<Session>();
    const staleLease = session();
    const currentLease = session();
    mocks.open.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const view = openSettings();
    const staleSignal = signalForCall(0);

    await vi.advanceTimersByTimeAsync(5_000);
    await tick();
    expect(staleSignal.aborted).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("设置暂不可用，请重试。");
    await fireEvent.click(screen.getByRole("button", { name: "重试" }));
    const currentSignal = signalForCall(1);
    expect(currentSignal).not.toBe(staleSignal);
    expect(currentSignal.aborted).toBe(false);

    stale.resolve(staleLease);
    await Promise.resolve();
    await tick();
    expect(staleLease.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "设置表单夹具" })).toBeNull();

    current.resolve(currentLease);
    await Promise.resolve();
    await tick();
    const panel = screen.getByRole("region", { name: "设置表单夹具" });
    expect(panel).toBeTruthy();
    expect(mocks.open).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(currentSignal.aborted).toBe(true);
    expect(currentLease.close).toHaveBeenCalledTimes(1);
  });

  it("closes a read that resolves after unmount and does not start a late UI", async () => {
    vi.useFakeTimers();
    const pending = deferred<Session>();
    const lease = session();
    mocks.open.mockReturnValue(pending.promise);
    const view = openSettings();
    const signal = signalForCall(0);

    view.unmount();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    pending.resolve(lease);
    await Promise.resolve();
    await tick();

    expect(lease.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "设置表单夹具" })).toBeNull();
  });

  it("passes the latest menu and market request without opening another read", async () => {
    const pending = deferred<Session>();
    const lease = session();
    mocks.open.mockReturnValue(pending.promise);
    const view = openSettings();
    const marketRequest = { source: "official_ztools", pluginName: "长名称插件" } satisfies PluginMarketRequest;

    view.rerender({ panel: "settings", settingsMenu: "sync", marketRequest, onpanelchange: vi.fn() });
    pending.resolve(lease);
    const panel = await screen.findByRole("region", { name: "设置表单夹具" });
    expect(panel.getAttribute("data-menu")).toBe("sync");
    expect(panel.getAttribute("data-market-plugin")).toBe("长名称插件");

    view.rerender({ panel: "settings", settingsMenu: "data", marketRequest: null, onpanelchange: vi.fn() });
    expect(screen.getByRole("region", { name: "设置表单夹具" })).toBe(panel);
    expect(panel.getAttribute("data-menu")).toBe("data");
    expect(panel.getAttribute("data-market-plugin")).toBe("");
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });
});
