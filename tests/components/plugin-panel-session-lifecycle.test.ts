import { describe, expect, it, vi } from "vitest";
import { createPluginPanelSessionLifecycle, destroyPluginPanelSession } from "../../src/lib/pluginPanelSessionLifecycle";
import type { PluginPanelSessionLifecyclePorts } from "../../src/lib/pluginPanelSessionLifecycle";

describe("PluginPanel session teardown", () => {
  it("terminates native BrowserWindow host resources without using reusable invalidation", async () => {
    const order: string[] = [];
    const ports = {
      action: () => ({ plugin_id: "fixture" }), closingAction: () => undefined, setClosingAction: vi.fn(),
      workerDocument: { cancel: vi.fn(() => order.push("worker.cancel")), shutdown: vi.fn(async () => ({ requested: 0, acknowledged: 0, timedOut: false })) },
      nextGeneration: () => 2, currentGeneration: () => 2, retry: { invalidate: vi.fn() },
      clearLoadError: vi.fn(), resetFeatures: vi.fn(), hostedIpc: { clear: vi.fn(() => order.push("hosted.clear")) },
      invalidateBrowserWindows: vi.fn(() => order.push("windows.invalidate")), clearPermissionRequests: vi.fn(),
      closeResources: vi.fn(), iframeWindow: () => null, post: vi.fn(() => true),
      wasOutDispatched: () => false, setOutDispatched: vi.fn(), wasDetachDispatched: () => false,
      setDetachDispatched: vi.fn(), onclose: vi.fn(), invoke: vi.fn(async () => {}),
      webStorageRelay: { close: vi.fn() }, sources: { clear: vi.fn(() => order.push("sources.clear")) },
      persistentGrantsUpdatedEvent: "fixture", currentPluginId: () => "fixture", permissionGrants: () => [],
      setPersistentPermissions: vi.fn(), handlePanelKeydown: vi.fn(), resolveDestroyedSmokeProbe: vi.fn(),
    } as unknown as PluginPanelSessionLifecyclePorts;
    const lifecycle = createPluginPanelSessionLifecycle(ports);
    const messageHost = { close: vi.fn(() => order.push("message.close")) };
    const browserWindows = { destroyPluginBrowserWindows: vi.fn(() => { order.push("windows.destroy"); }) };

    await destroyPluginPanelSession(messageHost, lifecycle, browserWindows);

    expect(order).toEqual(["message.close", "worker.cancel", "windows.destroy", "hosted.clear", "sources.clear"]);
    expect(ports.invalidateBrowserWindows).not.toHaveBeenCalled();
    expect(browserWindows.destroyPluginBrowserWindows).toHaveBeenCalledOnce();
  });
});
