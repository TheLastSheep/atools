import { describe, expect, it, vi } from "vitest";
import { createRendererContextMenu, type RendererContextMenuItem } from "../../packages/ztools-renderer/src/contextMenu";
import type { RendererHostListener, RendererHostUnlisten, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function makeClient(overrides: {
  show?: (items: RendererContextMenuItem[]) => Promise<unknown>;
} = {}) {
  let emit!: RendererHostListener;
  const unlisten = vi.fn();
  const listen = vi.fn(async (event: string, listener: RendererHostListener): Promise<RendererHostUnlisten> => {
    expect(event).toBe("atools://renderer-context-menu");
    emit = listener;
    return unlisten;
  });
  const transport: Pick<ZToolsRendererTransport, "listen"> = { listen };
  const show = overrides.show ?? vi.fn(async () => undefined);
  const client = createRendererContextMenu({ transport, show });
  return { client, emit: (value: unknown) => emit(value), listen, unlisten, show };
}

function commandId(action: string, payload: Record<string, unknown>): string {
  return action + ":" + JSON.stringify(payload);
}

describe("ZTools renderer context menu client", () => {
  it("enables only the three validated recommendation pin actions through the existing event gate", async () => {
    const validRows = [
      { path: "/plugins/demo", name: "Demo", type: "plugin", pluginName: "demo", featureCode: "feature-a" },
      { path: "/apps/reader", name: "Reader", type: "direct" },
      { path: "/builtins/calc", name: "Calculator", type: "builtin" },
    ];
    const actions = ["pin-recommendation", "unpin-recommendation", "move-recommendation-to-front"];
    const shown: RendererContextMenuItem[][] = [];
    const client = makeClient({ show: vi.fn(async (items) => { shown.push(items); }) });
    const received: string[] = [];
    client.client.subscribe((command) => received.push(command));
    await settlePromises();

    for (const [index, action] of actions.entries()) {
      const id = commandId(action, validRows[index]);
      await client.client.showContextMenu([{ id, label: action }]);
      expect(shown.at(-1)?.[0]).toMatchObject({ id, enabled: true });
      client.emit(id);
      expect(received).toEqual(actions.slice(0, index + 1).map((name, actionIndex) =>
        commandId(name, validRows[actionIndex]),
      ));
    }

    const invalidIds = [
      commandId("pin-recommendation", { path: "/plugins/demo", name: "Demo", type: "app" }),
      commandId("pin-recommendation", { path: "", name: "Demo", type: "plugin" }),
      commandId("pin-recommendation", { path: "/plugins/\u0000demo", name: "Demo", type: "plugin" }),
      commandId("pin-recommendation", { path: "/plugins/demo", name: "Demo", type: "plugin", pluginName: 7 }),
      commandId("pin-app", { path: "/plugins/demo", name: "Demo", type: "plugin" }),
      commandId("pin-recommendation-extra", validRows[0]),
    ];
    for (const id of invalidIds) {
      await client.client.showContextMenu([{ id, label: "Invalid" }]);
      expect(shown.at(-1)?.[0]).toMatchObject({ id, enabled: false });
      client.emit(id);
    }
    expect(received).toHaveLength(3);
    expect(client.client.snapshot()).toMatchObject({ acceptedCommands: 3, whitelistedCommands: 0 });
    client.client.dispose();
  });

  it("keeps only supported app actions enabled and consumes displayed ids once", async () => {
    const pinId = commandId("pin-app", {
      type: "direct", subType: "app", path: "/Applications/A.app", name: "A",
    });
    const unpinId = commandId("unpin-app", { path: "/Applications/A.app", name: "A" });
    const historyId = commandId("remove-from-history", { path: "/Applications/A.app", name: "A" });
    const revealId = commandId("reveal-in-finder", { path: "/Applications/A.app" });
    const pluginPinId = commandId("pin-app", {
      type: "plugin", path: "/plugins/demo", name: "Demo", featureCode: "feature-a",
    });
    const pluginUnpinId = commandId("unpin-app", {
      path: "/plugins/demo", name: "Demo", featureCode: "feature-a",
    });
    const pluginHistoryId = commandId("remove-from-history", {
      path: "/plugins/demo", name: "Demo", featureCode: "feature-a",
    });
    const unknownId = commandId("toggle-auto-kill", { path: "/plugins/demo" });
    const childId = commandId("pin-app", {
      type: "app", path: "/Applications/Child.app", name: "Child",
    });
    const shown: RendererContextMenuItem[][] = [];
    const client = makeClient({ show: vi.fn(async (items) => { shown.push(items); }) });
    const received: string[] = [];
    const unsubscribe = client.client.subscribe((command) => received.push(command));
    await settlePromises();

    await client.client.showContextMenu([
      { id: pinId, label: "Pin app" },
      { id: unpinId, label: "Unpin app" },
      { id: historyId, label: "Remove history" },
      { id: revealId, label: "Reveal" },
      { type: "separator" },
      { id: pluginPinId, label: "Plugin pin" },
      { id: pluginUnpinId, label: "Plugin unpin" },
      { id: pluginHistoryId, label: "Plugin history" },
      { id: unknownId, label: "Unknown command" },
      { id: unpinId, label: "Already disabled", enabled: false },
      { label: "Plugin settings", submenu: [{ id: childId, label: "Child pin" }] },
    ]);

    expect(shown[0]).toEqual([
      { id: pinId, label: "Pin app", enabled: true },
      { id: unpinId, label: "Unpin app", enabled: true },
      { id: historyId, label: "Remove history", enabled: true },
      { id: revealId, label: "Reveal", enabled: true },
      { type: "separator" },
      { id: pluginPinId, label: "Plugin pin", enabled: false },
      { id: pluginUnpinId, label: "Plugin unpin", enabled: false },
      { id: pluginHistoryId, label: "Plugin history", enabled: false },
      { id: unknownId, label: "Unknown command", enabled: false },
      { id: unpinId, label: "Already disabled", enabled: false },
      { id: "atools-disabled-menu-item", label: "Plugin settings", enabled: false },
    ]);

    client.emit(pluginPinId);
    client.emit(pluginUnpinId);
    client.emit(pluginHistoryId);
    client.emit(unknownId);
    client.emit(childId);
    client.emit(pinId);
    client.emit(pinId);
    client.emit(unpinId);
    expect(received).toEqual([pinId]);

    for (const id of [unpinId, historyId, revealId]) {
      await client.client.showContextMenu([{ id, label: "Supported action" }]);
      client.emit(id);
    }
    expect(received).toEqual([pinId, unpinId, historyId, revealId]);
    expect(client.client.snapshot()).toMatchObject({
      acceptedCommands: 4,
      whitelistedCommands: 0,
      ignoredEvents: 7,
    });
    expect(JSON.stringify(client.client.snapshot())).not.toContain("/Applications/A.app");
    expect(client.listen).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(client.unlisten).toHaveBeenCalledTimes(1);
    client.client.dispose();
  });

  it("enables local-shortcut menu identities and rejects unknown subtypes through the same nonce gate", async () => {
    const localPinId = commandId("pin-app", {
      type: "direct", subType: "local-shortcut", path: "/tmp/notes.txt", name: "Notes",
    });
    const localUnpinId = commandId("unpin-app", {
      subType: "local-shortcut", path: "/tmp/notes.txt", name: "Notes",
    });
    const localHistoryId = commandId("remove-from-history", {
      subType: "local-shortcut", path: "/tmp/notes.txt", name: "Notes",
    });
    const localRevealId = commandId("reveal-in-finder", {
      subType: "local-shortcut", path: "/tmp/notes.txt",
    });
    const invalidSubtypeId = commandId("pin-app", {
      type: "direct", subType: "plugin", path: "/tmp/notes.txt", name: "Notes",
    });
    const shown: RendererContextMenuItem[][] = [];
    const client = makeClient({ show: vi.fn(async (items) => { shown.push(items); }) });
    const received: string[] = [];
    client.client.subscribe((command) => received.push(command));
    await settlePromises();

    const ids = [localPinId, localUnpinId, localHistoryId, localRevealId];
    for (const [index, id] of ids.entries()) {
      await client.client.showContextMenu([{ id, label: id.split(":", 1)[0] }]);
      expect(shown[index]?.[0]).toMatchObject({ id, enabled: true });
      client.emit(id);
    }
    await client.client.showContextMenu([{ id: invalidSubtypeId, label: "Invalid" }]);
    expect(shown[ids.length]?.[0]).toMatchObject({ id: invalidSubtypeId, enabled: false });
    client.emit(invalidSubtypeId);
    expect(received).toEqual(ids);
    client.client.dispose();
  });

  it("does not evaluate extra getters or JSON toJSON methods and replaces stale menu ids", async () => {
    const oldId = commandId("reveal-in-finder", { path: "/Applications/Old.app" });
    const currentId = commandId("reveal-in-finder", { path: "/Applications/Current.app" });
    const client = makeClient();
    const received: string[] = [];
    client.client.subscribe((command) => received.push(command));
    await settlePromises();

    const action = { id: oldId, label: "Old item" };
    Object.defineProperty(action, "unusedDisplayValue", {
      enumerable: true,
      get() {
        throw new Error("unexpected getter");
      },
    });
    Object.defineProperty(action, "toJSON", {
      value() {
        throw new Error("unexpected toJSON");
      },
    });
    await client.client.showContextMenu([action]);
    await client.client.showContextMenu([{ id: currentId, label: "Current item" }]);

    client.emit(oldId);
    client.emit(currentId);
    expect(received).toEqual([currentId]);
    expect(client.client.snapshot()).toMatchObject({ acceptedCommands: 1, ignoredEvents: 1 });
    expect(JSON.stringify(client.client.snapshot())).not.toContain(currentId);
    client.client.dispose();
  });

  it("enforces menu item, UTF-8 label, id, and serialized payload budgets", async () => {
    const client = makeClient();
    const exactLabel = "é".repeat(256);
    await expect(client.client.showContextMenu([{ id: "unknown-action", label: exactLabel }]))
      .resolves.toBeUndefined();
    await expect(client.client.showContextMenu([{ id: "unknown-action", label: "\uD800".repeat(170) }]))
      .resolves.toBeUndefined();
    await expect(client.client.showContextMenu([{ id: "unknown-action", label: "\uD800".repeat(171) }]))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    await expect(client.client.showContextMenu([{ id: "unknown-action", label: exactLabel + "é" }]))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    await expect(client.client.showContextMenu([
      { id: "x".repeat(16 * 1024 + 1), label: "too long" },
    ])).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    await expect(client.client.showContextMenu(
      Array.from({ length: 65 }, () => ({ type: "separator" as const })),
    )).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    await expect(client.client.showContextMenu(
      Array.from({ length: 8 }, () => ({ id: "x".repeat(16 * 1024), label: "x" })),
    )).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });

    const sparse: unknown[] = [];
    sparse.length = 1;
    await expect(client.client.showContextMenu(sparse))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    expect(client.client.snapshot()).toMatchObject({ showRequests: 2, showFailures: 0 });
    client.client.dispose();
  });

  it("ignores non-string, oversized, stale, and duplicate events while exposing event lifecycle diagnostics", async () => {
    const id = commandId("reveal-in-finder", { path: "/Applications/A.app" });
    const client = makeClient();
    const received: string[] = [];
    client.client.subscribe((command) => received.push(command));
    await settlePromises();
    await client.client.showContextMenu([{ id, label: "Reveal" }]);

    client.emit({ command: id });
    client.emit("x".repeat(16 * 1024 + 1));
    expect(received).toEqual([]);
    expect(client.client.snapshot()).toMatchObject({ invalidEvents: 2 });
    expect(client.client.snapshot().eventSource).toMatchObject({
      subscribers: 1,
      listenerState: "listening",
      registrationsPending: 0,
      cleanupPending: 0,
      registrationErrors: 0,
      cleanupErrors: 0,
    });

    client.emit(id);
    client.emit(id);
    expect(received).toEqual([id]);
    expect(client.client.snapshot()).toMatchObject({ acceptedCommands: 1, ignoredEvents: 1 });
    expect(JSON.stringify(client.client.snapshot())).not.toContain("/Applications/A.app");
    client.client.dispose();
    expect(client.client.snapshot().eventSource.listenerState).toBe("disposed");
  });

  it("allows one in-flight show, rejects work on dispose, and ignores a late show completion", async () => {
    const gate = deferred<unknown>();
    const id = commandId("reveal-in-finder", { path: "/Applications/A.app" });
    const show = vi.fn(() => gate.promise);
    const client = makeClient({ show });
    const received: string[] = [];
    client.client.subscribe((command) => received.push(command));
    await settlePromises();

    const pendingShow = client.client.showContextMenu([{ id, label: "Reveal" }]);
    await settlePromises();
    expect(client.client.snapshot().showInFlight).toBe(true);
    await expect(client.client.showContextMenu([])).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT",
    });
    expect(show).toHaveBeenCalledTimes(1);

    client.client.dispose();
    await expect(pendingShow).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    gate.resolve(undefined);
    await settlePromises();
    client.emit(id);

    expect(received).toEqual([]);
    expect(client.client.snapshot()).toMatchObject({
      disposed: true,
      showInFlight: false,
      whitelistedCommands: 0,
      showRequests: 1,
    });
    expect(client.unlisten).toHaveBeenCalledTimes(1);
  });

  it("accepts native selection while the blocking popup RPC is pending without restoring consumed ids", async () => {
    const gate = deferred<unknown>();
    const id = commandId("reveal-in-finder", { path: "/Applications/A.app" });
    const client = makeClient({ show: vi.fn(() => gate.promise) });
    const received: string[] = [];
    client.client.subscribe((command) => received.push(command));
    await settlePromises();

    const pendingShow = client.client.showContextMenu([{ id, label: "Reveal" }]);
    await settlePromises();
    expect(client.client.snapshot()).toMatchObject({ showInFlight: true, whitelistedCommands: 1 });
    client.emit(id);
    expect(received).toEqual([id]);
    expect(client.client.snapshot().whitelistedCommands).toBe(0);

    gate.resolve(undefined);
    await pendingShow;
    client.emit(id);
    expect(received).toEqual([id]);
    expect(client.client.snapshot()).toMatchObject({
      showInFlight: false,
      whitelistedCommands: 0,
      acceptedCommands: 1,
      ignoredEvents: 1,
    });
    client.client.dispose();
  });

  it("does not let an earlier show completion clear the next in-flight session", async () => {
    const secondGate = deferred<unknown>();
    const ids = ["one", "two", "three"].map((name) =>
      commandId("reveal-in-finder", { path: "/Applications/" + name + ".app" }),
    );
    let callCount = 0;
    const show = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? Promise.resolve() : secondGate.promise;
    });
    const client = makeClient({ show });

    await client.client.showContextMenu([{ id: ids[0], label: "First" }]);
    const secondShow = client.client.showContextMenu([{ id: ids[1], label: "Second" }]);
    await settlePromises();
    expect(show).toHaveBeenCalledTimes(2);
    expect(client.client.snapshot().showInFlight).toBe(true);
    await expect(client.client.showContextMenu([{ id: ids[2], label: "Third" }]))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });

    secondGate.resolve(undefined);
    await secondShow;
    expect(client.client.snapshot().showInFlight).toBe(false);
    client.client.dispose();
  });

  it("propagates one show failure without retrying or retaining the attempted menu ids", async () => {
    const failure = new Error("native show failure");
    const retryFailure = new Error("second native show failure");
    const retryGate = deferred<unknown>();
    const id = commandId("reveal-in-finder", { path: "/Applications/A.app" });
    const show = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => retryGate.promise);
    const client = makeClient({ show });
    const received: string[] = [];
    client.client.subscribe((command) => received.push(command));
    await settlePromises();

    await expect(client.client.showContextMenu([{ id, label: "Reveal" }])).rejects.toBe(failure);
    client.emit(id);
    expect(received).toEqual([]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(client.client.snapshot()).toMatchObject({
      showInFlight: false,
      showFailures: 1,
      whitelistedCommands: 0,
    });

    const retry = client.client.showContextMenu([{ id, label: "Reveal again" }]);
    await settlePromises();
    expect(client.client.snapshot().showInFlight).toBe(true);
    await expect(client.client.showContextMenu([{ id, label: "Concurrent" }]))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    retryGate.reject(retryFailure);
    await expect(retry).rejects.toBe(retryFailure);
    expect(client.client.snapshot()).toMatchObject({
      showInFlight: false,
      showFailures: 2,
      whitelistedCommands: 0,
    });
    client.client.dispose();
  });
});
