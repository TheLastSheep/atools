import { describe, expect, it, vi } from "vitest";
import { createPluginDataController } from "../../src/lib/pluginDataController";
import { createPluginPanelActiveResources } from "../../src/lib/pluginPanelActiveResources";
import { createPluginPanelCloseTracker } from "../../src/lib/pluginPanelCloseTracker";
import { createPluginPanelSurfaceApi } from "../../src/lib/pluginPanelSurfaceApi";
import { createPluginPanelSessionLifecycle, type PluginPanelSessionLifecyclePorts } from "../../src/lib/pluginPanelSessionLifecycle";
import { createPluginResourceLease } from "../../src/lib/pluginResourceLease";
import { createPluginWorkerDocumentLifecycle, type PluginWorkerDocumentLifecycle } from "../../src/lib/pluginWorkerDocumentLifecycle";

function lifecycleFor(resources: ReturnType<typeof createPluginPanelActiveResources>, owner: string,
  shutdownResult: unknown = { requested: 0, acknowledged: 0, timedOut: false },
  workerDocumentOverride?: PluginWorkerDocumentLifecycle) {
  let generation = 1;
  let outDispatched = false;
  const setOutDispatched = vi.fn((next: boolean) => { outDispatched = next; });
  const ports = {
    action: () => ({ plugin_id: owner }), documentPluginId: owner, persistentSessionId: `session-${owner}`,
    closingAction: () => undefined, setClosingAction: vi.fn(),
    workerDocument: workerDocumentOverride ?? { cancel: vi.fn(), shutdown: vi.fn(async () => shutdownResult) },
    nextGeneration: vi.fn(() => ++generation), currentGeneration: () => generation,
    retry: { invalidate: vi.fn() }, clearLoadError: vi.fn(), resetFeatures: vi.fn(),
    hostedIpc: { clear: vi.fn() }, invalidateBrowserWindows: vi.fn(), clearPermissionRequests: vi.fn(),
    closeResources: vi.fn(), closeResourcesStrict: resources.closeAllStrict,
    iframeWindow: () => null, post: vi.fn(() => true), wasOutDispatched: () => outDispatched,
    setOutDispatched,
    wasDetachDispatched: () => false, setDetachDispatched: vi.fn(), onclose: vi.fn(), invoke: vi.fn(async () => {}),
    webStorageRelay: { close: vi.fn() }, sources: { clear: vi.fn() },
    persistentGrantsUpdatedEvent: "fixture", currentPluginId: () => owner, permissionGrants: () => [],
    setPersistentPermissions: vi.fn(), handlePanelKeydown: vi.fn(), resolveDestroyedSmokeProbe: vi.fn(),
  } as unknown as PluginPanelSessionLifecyclePorts;
  return { lifecycle: createPluginPanelSessionLifecycle(ports), ports, setOutDispatched };
}

describe("PluginPanel explicit strict-close retry", () => {
  it("retries the exact failed owner close IPC without replaying lifecycle cleanup", async () => {
    const resources = createPluginPanelActiveResources();
    const failure = new Error("temporary native close transport failure");
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let rejectFirstDataClose = true;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "close_plugin_data" && rejectFirstDataClose) {
        rejectFirstDataClose = false;
        throw failure;
      }
      return undefined as never;
    });
    const controller = createPluginDataController(
      resources.closeTracker.wrap(invoke), "retry-owner", () => true, () => {}, { instanceId: "data-owner-1" },
    );
    const controllerClose = vi.spyOn(controller, "close");
    resources.data = controller;
    const siblingClose = vi.fn();
    resources.dialogs = { close: siblingClose } as never;
    const { lifecycle, ports, setOutDispatched } = lifecycleFor(resources, "retry-owner");
    const messageHostClose = vi.fn();
    const surface = createPluginPanelSurfaceApi({
      lifecycle, messageHost: { close: messageHostClose }, persistentSessionId: "session-retry-owner",
      documentPluginId: "retry-owner", resolveIcon: async () => "", afterRender: async () => {},
      focusFrame: vi.fn(), destroyBrowserWindows: vi.fn(),
    });

    const first = surface.closePersistentStrict();
    expect(surface.closePersistentStrict()).toBe(first);
    await expect(first).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_CLOSE_FAILED", cause: failure });
    expect(calls).toEqual([{ command: "close_plugin_data", args: { pluginId: "retry-owner", instanceId: "data-owner-1" } }]);
    expect(controllerClose).toHaveBeenCalledOnce();
    expect(siblingClose).toHaveBeenCalledOnce();

    await surface.closePersistentStrict({ retry: true });
    expect(calls).toEqual([
      { command: "close_plugin_data", args: { pluginId: "retry-owner", instanceId: "data-owner-1" } },
      { command: "close_plugin_data", args: { pluginId: "retry-owner", instanceId: "data-owner-1" } },
    ]);
    expect(controllerClose).toHaveBeenCalledOnce();
    expect(siblingClose).toHaveBeenCalledOnce();
    expect(ports.nextGeneration).toHaveBeenCalledOnce();
    expect(ports.workerDocument.shutdown).toHaveBeenCalledOnce();
    expect(setOutDispatched).toHaveBeenCalledOnce();
    expect(messageHostClose).toHaveBeenCalledOnce();
    expect(await surface.activatePersistentEntry({ plugin_id: "retry-owner" } as never)).toBe(false);

    await surface.closePersistentStrict({ retry: true });
    expect(calls).toHaveLength(2);

    const newResources = createPluginPanelActiveResources();
    const newOwnerInvoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return undefined as never;
    });
    const newController = createPluginDataController(
      newResources.closeTracker.wrap(newOwnerInvoke), "new-owner", () => true, () => {}, { instanceId: "data-owner-2" },
    );
    newResources.data = newController;
    await newResources.closeAllStrict();
    expect(newOwnerInvoke).toHaveBeenCalledOnce();
    expect(newOwnerInvoke).toHaveBeenCalledWith("close_plugin_data", { pluginId: "new-owner", instanceId: "data-owner-2" });
  });

  it("keeps a swallowed early data close failure visible to strict close and retries its exact owner", async () => {
    const resources = createPluginPanelActiveResources();
    const failure = new Error("early data close failed");
    let rejectFirst = true;
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
      if (command === "close_plugin_data" && rejectFirst) { rejectFirst = false; throw failure; }
      return undefined as never;
    });
    const controller = createPluginDataController(
      resources.closeTracker.wrap(invoke), "early-data-owner", () => true, () => {}, { instanceId: "early-data-1" },
    );
    resources.data = controller;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await controller.close();
      const { lifecycle } = lifecycleFor(resources, "early-data-owner");

      await expect(lifecycle.destroyStrict()).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_CLOSE_FAILED", cause: failure });
      await lifecycle.retryDestroyStrict();

      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenNthCalledWith(1, "close_plugin_data", { pluginId: "early-data-owner", instanceId: "early-data-1" });
      expect(invoke).toHaveBeenNthCalledWith(2, "close_plugin_data", { pluginId: "early-data-owner", instanceId: "early-data-1" });
    } finally { warn.mockRestore(); }
  });

  it("keeps a swallowed early resource lease close failure visible to strict close and retries its exact owner", async () => {
    const resources = createPluginPanelActiveResources();
    const failure = new Error("early resource close failed");
    let rejectFirst = true;
    const invokeCalls = vi.fn<(command: string, args?: Record<string, unknown>) => void>();
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      invokeCalls(command, args);
      if (command === "prepare_plugin_resources") return {
        sessionId: "11111111-1111-4111-8111-111111111111", pluginRoot: "/fixture/plugin",
      } as T;
      if (command === "close_plugin_resources" && rejectFirst) { rejectFirst = false; throw failure; }
      return undefined as T;
    };
    const lease = createPluginResourceLease({ invoke: resources.closeTracker.wrap(invoke),
      pluginId: "early-resource-owner", pluginRoot: "/fixture/plugin", isCurrent: () => true,
      convertFileSrc: () => "atools-plugin://localhost/" });
    resources.lease = lease;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await lease.prepare();
      await lease.close();
      const { lifecycle } = lifecycleFor(resources, "early-resource-owner");

      await expect(lifecycle.destroyStrict()).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_CLOSE_FAILED", cause: failure });
      await lifecycle.retryDestroyStrict();

      const closes = invokeCalls.mock.calls.filter(([command]) => command === "close_plugin_resources");
      expect(closes).toHaveLength(2);
      expect(closes[0][1]).toEqual(closes[1][1]);
      expect(closes[0][1]).toMatchObject({ pluginId: "early-resource-owner" });
    } finally { warn.mockRestore(); }
  });

  it("does not let a tracked undefined close rejection absorb an untracked undefined action failure", async () => {
    const resources = createPluginPanelActiveResources();
    let rejectFirstTrackedClose = true;
    const invokeCalls = vi.fn<(command: string, args?: Record<string, unknown>) => void>();
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      invokeCalls(command, args);
      if (command === "close_plugin_data" && rejectFirstTrackedClose) { rejectFirstTrackedClose = false; throw undefined; }
      return undefined as T;
    };
    resources.data = createPluginDataController(
      resources.closeTracker.wrap(invoke), "undefined-owner", () => true, () => {}, { instanceId: "undefined-data-1" },
    );
    const untrackedClose = vi.fn(async () => { throw undefined; });
    resources.dialogs = { close: untrackedClose } as never;
    const { lifecycle } = lifecycleFor(resources, "undefined-owner");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(lifecycle.destroyStrict()).rejects.toBeUndefined();
      await expect(lifecycle.retryDestroyStrict()).rejects.toBeUndefined();
      expect(invokeCalls).toHaveBeenCalledTimes(2);
      expect(untrackedClose).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });

  it("keeps a terminal native Node stop error after an exact-owner retry", async () => {
    const resources = createPluginPanelActiveResources();
    const terminal = new Error("native Node stop was not confirmed");
    const args = { pluginId: "terminal-owner", instanceId: "native-owner-1" };
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => { throw terminal; });
    const trackedInvoke = resources.closeTracker.wrap(invoke);
    const runtimeClose = vi.fn(() => trackedInvoke("close_legacy_node", args));
    const siblingClose = vi.fn();
    resources.runtime = { closeStrict: runtimeClose } as never;
    resources.dialogs = { close: siblingClose } as never;
    const { lifecycle } = lifecycleFor(resources, "terminal-owner");

    await expect(lifecycle.destroyStrict()).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_CLOSE_FAILED", cause: terminal });
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(siblingClose).toHaveBeenCalledOnce();
    await expect(lifecycle.retryDestroyStrict()).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_CLOSE_FAILED", cause: terminal });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, "close_legacy_node", args);
    expect(invoke).toHaveBeenNthCalledWith(2, "close_legacy_node", args);
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(siblingClose).toHaveBeenCalledOnce();
  });

  it("keeps an unconfirmed worker shutdown failure after resource retry succeeds", async () => {
    const resources = createPluginPanelActiveResources();
    let failFirstClose = true;
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
      if (command === "close_plugin_data" && failFirstClose) {
        failFirstClose = false;
        throw new Error("temporary data close failure");
      }
      return undefined as never;
    });
    resources.data = createPluginDataController(
      resources.closeTracker.wrap(invoke), "timeout-owner", () => true, () => {}, { instanceId: "timeout-data-1" },
    );
    const shutdownRequest = vi.fn(async () => ({ requested: 1, acknowledged: 0, timedOut: true }));
    const workerDocument = createPluginWorkerDocumentLifecycle({ getSource: () => ({} as Window),
      randomUUID: () => "11111111-1111-4111-8111-111111111111", shutdown: shutdownRequest });
    workerDocument.freshScope();
    const { lifecycle } = lifecycleFor(resources, "timeout-owner", undefined, workerDocument);

    await expect(lifecycle.destroyStrict()).rejects.toThrow("ERR_ATOOLS_PLUGIN_WORKER_SHUTDOWN_UNCONFIRMED");
    await expect(lifecycle.retryDestroyStrict()).rejects.toThrow("ERR_ATOOLS_PLUGIN_WORKER_SHUTDOWN_UNCONFIRMED");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(shutdownRequest).toHaveBeenCalledOnce();
  });

  it("rejects an invalid worker shutdown reply with the fixed terminal error", async () => {
    const { lifecycle, ports } = lifecycleFor(createPluginPanelActiveResources(), "invalid-worker-owner", null);
    await expect(lifecycle.destroyStrict()).rejects.toThrow("ERR_ATOOLS_PLUGIN_WORKER_SHUTDOWN_UNCONFIRMED");
    await expect(lifecycle.retryDestroyStrict()).rejects.toThrow("ERR_ATOOLS_PLUGIN_WORKER_SHUTDOWN_UNCONFIRMED");
    expect(ports.workerDocument.shutdown).toHaveBeenCalledOnce();
  });

  it("consumes an unmount rejection while strict close and retry keep reporting it", async () => {
    const { lifecycle } = lifecycleFor(createPluginPanelActiveResources(), "unmount-owner", {
      requested: 1, acknowledged: 0, timedOut: true,
    });
    const messageHostClose = vi.fn();
    const surface = createPluginPanelSurfaceApi({
      lifecycle, messageHost: { close: messageHostClose }, persistentSessionId: "session-unmount-owner",
      documentPluginId: "unmount-owner", resolveIcon: async () => "", afterRender: async () => {},
      focusFrame: vi.fn(), destroyBrowserWindows: vi.fn(),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(surface.destroyOnUnmount()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith("[PluginPanel] unmount teardown incomplete");
      await expect(surface.closePersistentStrict()).rejects.toThrow("ERR_ATOOLS_PLUGIN_WORKER_SHUTDOWN_UNCONFIRMED");
      await expect(surface.closePersistentStrict({ retry: true })).rejects.toThrow("ERR_ATOOLS_PLUGIN_WORKER_SHUTDOWN_UNCONFIRMED");
      expect(messageHostClose).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });

  it("attempts every resource after a synchronous close throw", async () => {
    const resources = createPluginPanelActiveResources();
    const terminal = new Error("resource close threw synchronously");
    const runtimeClose = vi.fn(() => { throw terminal; });
    const siblingClose = vi.fn();
    resources.runtime = { closeStrict: runtimeClose } as never;
    resources.dialogs = { close: siblingClose } as never;
    const { lifecycle, ports } = lifecycleFor(resources, "sync-owner");
    const messageHostFailure = new Error("message host close threw synchronously");
    const messageHostClose = vi.fn(() => { throw messageHostFailure; });
    const surface = createPluginPanelSurfaceApi({
      lifecycle, messageHost: { close: messageHostClose }, persistentSessionId: "session-sync-owner",
      documentPluginId: "sync-owner", resolveIcon: async () => "", afterRender: async () => {},
      focusFrame: vi.fn(), destroyBrowserWindows: vi.fn(),
    });

    await expect(surface.closePersistentStrict()).rejects.toBe(terminal);
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(siblingClose).toHaveBeenCalledOnce();
    expect(ports.workerDocument.shutdown).toHaveBeenCalledOnce();
    await expect(surface.closePersistentStrict({ retry: true })).rejects.toBe(terminal);
    expect(messageHostClose).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(siblingClose).toHaveBeenCalledOnce();
  });

  it("keeps cleanup budget overflow rejected after replaying only its bounded failures", async () => {
    await expect(createPluginPanelActiveResources().closeAllStrict({ retry: true }))
      .rejects.toThrow("ERR_ATOOLS_PLUGIN_CLEANUP_NOT_STARTED");
    const tracker = createPluginPanelCloseTracker();
    await expect(tracker.retryFailed()).rejects.toThrow("ERR_ATOOLS_PLUGIN_CLEANUP_NOT_STARTED");
    let reject = true;
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => {
      if (reject) throw new Error("temporary close failure");
      return undefined as never;
    });
    const close = tracker.wrap(invoke);
    tracker.begin();
    const attempts = Array.from({ length: 33 }, (_, index) => close("close_plugin_data", {
      pluginId: "bounded-owner", instanceId: `owner-${index}`,
    }));
    const results = await Promise.allSettled(attempts);
    expect(results[32]).toMatchObject({ status: "rejected", reason: {
      code: "ERR_ATOOLS_PLUGIN_CLEANUP_BUDGET", cause: expect.any(Error),
    } });
    await expect(tracker.drain()).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_CLOSE_FAILED", cause: expect.any(Error) });

    reject = false;
    await expect(tracker.retryFailed()).rejects.toThrow("ERR_ATOOLS_PLUGIN_CLEANUP_BUDGET");
    expect(invoke).toHaveBeenCalledTimes(65);
  });

  it("replays an immutable JSON snapshot of the original close owner and nested bindings", async () => {
    const tracker = createPluginPanelCloseTracker();
    const failure = new Error("close request failed");
    let reject = true;
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => {
      if (reject) throw failure;
      return undefined as never;
    });
    const wrapped = tracker.wrap(invoke);
    const args = { pluginId: "old-owner", instanceId: "old-instance", binding: { owner: "old-binding" } };
    tracker.begin();
    await expect(wrapped("close_plugin_data", args)).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_CLOSE_FAILED", cause: failure });
    await expect(tracker.drain()).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_CLOSE_FAILED", cause: failure });

    args.pluginId = "new-owner";
    args.instanceId = "new-instance";
    args.binding.owner = "new-binding";
    reject = false;
    await tracker.retryFailed();

    expect(invoke).toHaveBeenCalledTimes(2);
    const retriedArgs = invoke.mock.calls[1][1] as typeof args | undefined;
    expect(retriedArgs).toEqual({ pluginId: "old-owner", instanceId: "old-instance", binding: { owner: "old-binding" } });
    expect(Object.isFrozen(retriedArgs)).toBe(true);
    expect(Object.isFrozen(retriedArgs?.binding)).toBe(true);
  });

  it("keeps an unsnapshotable close failure unresolved instead of retrying mutated arguments", async () => {
    const tracker = createPluginPanelCloseTracker();
    const failure = new Error("close request failed");
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => { throw failure; });
    const wrapped = tracker.wrap(invoke);
    const args: Record<string, unknown> = { pluginId: "owner", instanceId: "instance", nested: { value: 1n } };
    tracker.begin();
    await expect(wrapped("close_plugin_data", args)).rejects.toMatchObject({
      code: "ERR_ATOOLS_PLUGIN_CLEANUP_ARGS_UNSNAPSHOTTABLE", cause: failure,
    });
    await expect(tracker.drain()).rejects.toMatchObject({
      code: "ERR_ATOOLS_PLUGIN_CLEANUP_ARGS_UNSNAPSHOTTABLE", cause: failure,
    });

    args.nested = { value: "changed" };
    await expect(tracker.retryFailed()).rejects.toMatchObject({
      code: "ERR_ATOOLS_PLUGIN_CLEANUP_ARGS_UNSNAPSHOTTABLE", cause: failure,
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
