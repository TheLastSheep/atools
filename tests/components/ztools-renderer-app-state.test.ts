import { describe, expect, it, vi } from "vitest";
import { createRendererAppState } from "../../packages/ztools-renderer/src/appState";
import type { AppIdentity, AppMutationRequest, RendererAppStateValues } from "../../packages/ztools-renderer/src/appStateProtocol";
import type { RendererHostListener, RendererHostUnlisten, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

function payload(
  revision: number,
  changed: Array<"command-history" | "pinned-commands"> = [],
  values: RendererAppStateValues = { "command-history": null, "pinned-commands": null },
) {
  return { version: 1, revision, values, changed };
}

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
  mutate?: (request: AppMutationRequest) => Promise<unknown>;
  launch?: (target: AppIdentity) => Promise<unknown>;
  applyValues?: (values: RendererAppStateValues) => void;
} = {}) {
  let emit!: RendererHostListener;
  const unlisten = vi.fn();
  const listen = vi.fn(async (event: string, listener: RendererHostListener): Promise<RendererHostUnlisten> => {
    expect(event).toBe("atools://renderer-app-state");
    emit = listener;
    return unlisten;
  });
  const transport: Pick<ZToolsRendererTransport, "listen"> = { listen };
  const applyValues = overrides.applyValues ?? vi.fn();
  const mutate = overrides.mutate ?? vi.fn(async () => payload(1));
  const launch = overrides.launch ?? vi.fn(async () => "launched");
  const client = createRendererAppState({ transport, mutate, launch, applyValues });
  return { client, emit: (value: unknown) => emit(value), listen, unlisten, mutate, launch, applyValues };
}

describe("ZTools renderer app state client", () => {
  it("shares a lazy event listener and applies accepted values before changed callbacks", async () => {
    const order: string[] = [];
    const client = makeClient({
      applyValues(values) {
        order.push("apply:" + String(values["command-history"]));
      },
    });
    const onHistory = vi.fn(() => order.push("history"));
    const onPinned = vi.fn(() => order.push("pinned"));

    expect(client.listen).not.toHaveBeenCalled();
    const offHistory = client.client.onHistoryChanged(onHistory);
    const offPinned = client.client.onPinnedChanged(onPinned);
    await settlePromises();
    expect(client.listen).toHaveBeenCalledTimes(1);

    client.emit(payload(1, ["command-history", "pinned-commands"], {
      "command-history": "history-json",
      "pinned-commands": "pins-json",
    }));
    expect(order).toEqual(["apply:history-json", "history", "pinned"]);
    client.emit(payload(2, [], { "command-history": "history-json", "pinned-commands": "pins-json" }));
    expect(onHistory).toHaveBeenCalledTimes(1);
    expect(onPinned).toHaveBeenCalledTimes(1);

    offHistory();
    expect(client.unlisten).not.toHaveBeenCalled();
    offPinned();
    expect(client.unlisten).toHaveBeenCalledTimes(1);
    const snapshot = client.client.snapshot();
    expect(snapshot).toMatchObject({
      revision: 2,
      historySubscribers: 0,
      pinnedSubscribers: 0,
      listenerState: "idle",
    });
    expect(snapshot.eventSource).toEqual({
      subscribers: 0,
      listenerState: "idle",
      deliveredEvents: 2,
      registrationErrors: 0,
      callbackErrors: 0,
      registrationsPending: 0,
      lateListenerUnlistens: 0,
      cleanupPending: 0,
      cleanupErrors: 0,
    });
    client.client.dispose();
  });

  it("normalizes legacy and direct app aliases, serializes mutations, and continues after failures", async () => {
    const gate = deferred<unknown>();
    const failure = new Error("path-secret-from-host");
    const mutate = vi.fn((_request: AppMutationRequest) => {
      if (mutate.mock.calls.length === 1) return gate.promise;
      return Promise.resolve(payload(2, ["pinned-commands"]));
    });
    const client = makeClient({ mutate });
    const first = client.client.clearPins();
    await settlePromises();

    const commands = [{
      type: "direct",
      subType: "app",
      path: "/Applications/Example.app",
      name: "Visible alias",
      persistedName: "Stored alias",
      icon: "discarded-display-data",
    }];
    const second = client.client.updatePinnedOrder(commands);
    commands[0].path = "/mutated-after-enqueue.app";
    gate.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[0][0]).toEqual({ operation: "clear_pins" });
    expect(mutate.mock.calls[1][0]).toEqual({
      operation: "reorder_pins",
      apps: [{ path: "/Applications/Example.app", name: "Stored alias" }],
    });
    expect(client.client.snapshot()).toMatchObject({ mutationFailures: 1, queuedMutations: 0 });
    expect(JSON.stringify(client.client.snapshot())).not.toContain("path-secret-from-host");
    client.client.dispose();
  });

  it("preserves local-shortcut identity for launch, pin, and pin ordering while default apps keep the two-field wire", async () => {
    const mutations: AppMutationRequest[] = [];
    const launches: AppIdentity[] = [];
    let revision = 0;
    const client = makeClient({
      mutate: async (request) => {
        mutations.push(request);
        revision += 1;
        return payload(revision);
      },
      launch: async (target) => {
        launches.push(target);
        revision += 1;
        return payload(revision);
      },
    });
    const localCommand = {
      type: "direct",
      subType: "local-shortcut",
      path: "/tmp/notes.txt",
      name: "Notes",
    };

    await expect(client.client.pinApp(localCommand)).resolves.toBeUndefined();
    await expect(client.client.updatePinnedOrder([
      localCommand,
      { type: "direct", subType: "app", path: "/Applications/Example.app", name: "Example" },
    ])).resolves.toBeUndefined();
    await expect(client.client.launchApp({
      path: "/tmp/notes.txt", name: "Notes", subType: "local-shortcut",
    })).resolves.toMatchObject({ revision: 3 });

    expect(mutations).toEqual([
      { operation: "pin", app: { path: "/tmp/notes.txt", name: "Notes", subType: "local-shortcut" } },
      { operation: "reorder_pins", apps: [
        { path: "/tmp/notes.txt", name: "Notes", subType: "local-shortcut" },
        { path: "/Applications/Example.app", name: "Example" },
      ] },
    ]);
    expect(launches).toEqual([{
      path: "/tmp/notes.txt", name: "Notes", subType: "local-shortcut",
    }]);
    await expect(client.client.launchApp({
      path: "/tmp/notes.txt", name: "Notes", subType: "plugin" as never,
    })).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    expect(launches).toHaveLength(1);
    client.client.dispose();
  });

  it("uses only bounded app identities in native mutation requests", async () => {
    const requests: AppMutationRequest[] = [];
    let revision = 0;
    const client = makeClient({
      mutate: async (request) => {
        requests.push(request);
        revision += 1;
        return payload(revision);
      },
    });
    const exactPath = "😀".repeat(4_096);
    const exactName = "😀".repeat(1_024);
    const pinCommand = {
      type: "app",
      path: exactPath,
      name: "visible",
      persistedName: exactName,
    };
    Object.defineProperty(pinCommand, "icon", {
      enumerable: true,
      get() {
        throw new Error("display field must not be read");
      },
    });

    await client.client.pinApp(pinCommand);
    await client.client.unpinApp(exactPath, undefined, "alias");
    await client.client.removeFromHistory(exactPath);
    await client.client.updatePinnedOrder([{
      type: "direct", subType: "app", path: exactPath, name: "direct alias",
    }]);
    await client.client.clearPins();
    await client.client.clearHistory();

    expect(requests).toEqual([
      { operation: "pin", app: { path: exactPath, name: exactName } },
      { operation: "unpin", path: exactPath, name: "alias" },
      { operation: "remove_history", path: exactPath },
      { operation: "reorder_pins", apps: [{ path: exactPath, name: "direct alias" }] },
      { operation: "clear_pins" },
      { operation: "clear_history" },
    ]);

    await expect(client.client.pinApp({
      type: "app", path: exactPath + "😀", name: "too long",
    })).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    await expect(client.client.pinApp({
      type: "app", path: "/Applications/A.app", name: exactName + "😀",
    })).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    await expect(client.client.unpinApp("/Applications/A.app", undefined, ""))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    const sparse: unknown[] = [];
    sparse.length = 1;
    await expect(client.client.updatePinnedOrder(sparse))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    let enumerated = false;
    const oversizedOrder = new Proxy(new Array(4_097), {
      ownKeys() {
        enumerated = true;
        throw new Error("oversized order should be rejected before enumeration");
      },
    });
    await expect(client.client.updatePinnedOrder(oversizedOrder))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    expect(enumerated).toBe(false);
    expect(requests).toHaveLength(6);
    client.client.dispose();
  });

  it("deduplicates event and reply revisions without rolling back values", async () => {
    const reply = deferred<unknown>();
    const applied: RendererAppStateValues[] = [];
    const mutate = vi.fn(async () => reply.promise);
    const client = makeClient({ mutate, applyValues: (values) => applied.push(values) });
    const onHistory = vi.fn();
    const onPinned = vi.fn();
    client.client.onHistoryChanged(onHistory);
    client.client.onPinnedChanged(onPinned);
    await settlePromises();

    const write = client.client.clearHistory();
    await settlePromises();
    client.emit(payload(2, ["command-history", "pinned-commands"], {
      "command-history": "revision-2-history",
      "pinned-commands": "revision-2-pins",
    }));
    reply.resolve(payload(1, ["command-history"], {
      "command-history": "revision-1-history",
      "pinned-commands": null,
    }));
    await write;
    client.emit(payload(2, ["command-history"], {
      "command-history": "same-revision-stale",
      "pinned-commands": null,
    }));

    expect(applied).toEqual([{
      "command-history": "revision-2-history",
      "pinned-commands": "revision-2-pins",
    }]);
    expect(onHistory).toHaveBeenCalledTimes(1);
    expect(onPinned).toHaveBeenCalledTimes(1);
    expect(client.client.snapshot()).toMatchObject({ revision: 2, stalePayloads: 2 });
    client.client.dispose();
  });

  it("notifies every domain changed in a full snapshot even when its own event is late", async () => {
    let cache: RendererAppStateValues = { "command-history": null, "pinned-commands": null };
    const historyReads: Array<string | null> = [];
    const pinReads: Array<string | null> = [];
    const client = makeClient({ applyValues: (values) => { cache = values; } });
    client.client.onHistoryChanged(() => historyReads.push(cache["command-history"]));
    client.client.onPinnedChanged(() => pinReads.push(cache["pinned-commands"]));
    await settlePromises();

    client.emit(payload(0, [], {
      "command-history": "history-0",
      "pinned-commands": "pins-0",
    }));
    client.emit(payload(2, ["command-history"], {
      "command-history": "history-2",
      "pinned-commands": "pins-1",
    }));
    client.emit(payload(1, ["pinned-commands"], {
      "command-history": "history-1",
      "pinned-commands": "pins-1",
    }));

    expect(historyReads).toEqual(["history-0", "history-2"]);
    expect(pinReads).toEqual(["pins-0", "pins-1"]);
    expect(cache).toEqual({ "command-history": "history-2", "pinned-commands": "pins-1" });
    expect(client.client.snapshot()).toMatchObject({
      revision: 2,
      acceptedEvents: 2,
      stalePayloads: 1,
    });
    client.client.dispose();
  });

  it("retries a failed native listener registration when a new business subscriber arrives", async () => {
    let emit!: RendererHostListener;
    let registration = 0;
    const unlisten = vi.fn();
    const listen = vi.fn(async (_event: string, listener: RendererHostListener): Promise<RendererHostUnlisten> => {
      registration += 1;
      if (registration === 1) throw new Error("private registration failure");
      emit = listener;
      return unlisten;
    });
    const client = createRendererAppState({
      transport: { listen },
      mutate: async () => payload(1),
      launch: async () => payload(1),
      applyValues: vi.fn(),
    });
    const history = vi.fn();
    const pins = vi.fn();
    client.onHistoryChanged(history);
    await settlePromises();
    expect(client.snapshot().eventSource).toMatchObject({
      listenerState: "failed",
      registrationErrors: 1,
    });
    expect(listen).toHaveBeenCalledTimes(1);

    client.onPinnedChanged(pins);
    await settlePromises();
    expect(listen).toHaveBeenCalledTimes(2);
    expect(client.snapshot().eventSource).toMatchObject({
      listenerState: "listening",
      subscribers: 1,
      registrationErrors: 1,
      registrationsPending: 0,
    });

    emit(payload(0, [], { "command-history": "history", "pinned-commands": "pins" }));
    expect(history).toHaveBeenCalledTimes(1);
    expect(pins).toHaveBeenCalledTimes(1);
    client.dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("applies a successful launch reply and notifies after the read model is current", async () => {
    let cachedHistory: string | null = null;
    const observedHistory: Array<string | null> = [];
    const launch = vi.fn(async () => payload(1, ["command-history"], {
      "command-history": "fresh-history-from-launch-reply",
      "pinned-commands": null,
    }));
    const client = makeClient({
      launch,
      applyValues(values) {
        cachedHistory = values["command-history"];
      },
    });
    client.client.onHistoryChanged(() => observedHistory.push(cachedHistory));
    await settlePromises();

    await expect(client.client.launchApp({ path: "/Applications/Example.app", name: "Example" }))
      .resolves.toMatchObject({ revision: 1 });

    expect(launch).toHaveBeenCalledWith({ path: "/Applications/Example.app", name: "Example" });
    expect(cachedHistory).toBe("fresh-history-from-launch-reply");
    expect(observedHistory).toEqual(["fresh-history-from-launch-reply"]);
    expect(client.client.snapshot()).toMatchObject({
      revision: 1,
      acceptedReplies: 1,
      acceptedEvents: 0,
    });
    client.client.dispose();
  });

  it("does not advance a revision or notify if applying values fails, then accepts the same revision on retry", async () => {
    let failOnce = true;
    let cachedHistory: string | null = null;
    const reply = payload(1, ["command-history"], {
      "command-history": "retryable-history-value",
      "pinned-commands": null,
    });
    const mutate = vi.fn(async () => reply);
    const client = makeClient({
      mutate,
      applyValues(values) {
        if (failOnce) {
          failOnce = false;
          throw new Error("private-store-error");
        }
        cachedHistory = values["command-history"];
      },
    });
    const observedHistory: Array<string | null> = [];
    client.client.onHistoryChanged(() => observedHistory.push(cachedHistory));
    await settlePromises();

    await expect(client.client.clearHistory()).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(client.client.snapshot()).toMatchObject({
      revision: null,
      acceptedReplies: 0,
      applyErrors: 1,
      mutationFailures: 1,
    });
    expect(observedHistory).toEqual([]);
    expect(JSON.stringify(client.client.snapshot())).not.toContain("private-store-error");

    await expect(client.client.clearHistory()).resolves.toBeUndefined();
    expect(cachedHistory).toBe("retryable-history-value");
    expect(observedHistory).toEqual(["retryable-history-value"]);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(client.client.snapshot()).toMatchObject({
      revision: 1,
      acceptedReplies: 1,
      applyErrors: 1,
      mutationFailures: 1,
    });
    client.client.dispose();
  });

  it("rejects plugin identities and malformed or oversized native payloads", async () => {
    const client = makeClient({ mutate: vi.fn(async () => ({
      version: 1,
      revision: 1,
      values: { "command-history": null, "pinned-commands": null },
      changed: [],
      extra: "must-not-be-accepted",
    })) });

    await expect(client.client.pinApp({
      type: "plugin", path: "/plugins/test", name: "test", featureCode: "feature-a",
    })).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" });
    await expect(client.client.unpinApp("/plugins/test", "feature-a", "test"))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" });
    await expect(client.client.launchApp({
      path: "/plugins/test", name: "test", featureCode: "feature-a",
    } as unknown as { path: string; name: string })).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
    await expect(client.client.clearPins()).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });

    expect(client.client.snapshot()).toMatchObject({ invalidPayloads: 1, mutationFailures: 1 });
    client.client.dispose();
  });

  it("enforces the UTF-8 value limit and rejects extra or duplicate changed keys", async () => {
    const accepted = makeClient({
      mutate: vi.fn(async () => payload(0, [], {
        "command-history": "😀".repeat(32_768),
        "pinned-commands": null,
      })),
    });
    await expect(accepted.client.clearHistory()).resolves.toBeUndefined();
    expect(accepted.client.snapshot().revision).toBe(0);
    accepted.client.dispose();

    for (const changed of [["command-history", "command-history"], ["unknown"]]) {
      const invalid = makeClient({
        mutate: vi.fn(async () => ({ ...payload(1), changed })),
      });
      await expect(invalid.client.clearHistory()).rejects.toMatchObject({
        code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
      });
      invalid.client.dispose();
    }

    const tooLarge = makeClient({
      mutate: vi.fn(async () => payload(1, [], {
        "command-history": "😀".repeat(32_769),
        "pinned-commands": null,
      })),
    });
    await expect(tooLarge.client.clearHistory()).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(tooLarge.client.snapshot().revision).toBeNull();
    tooLarge.client.dispose();
  });

  it("caps the FIFO, rejects queued work on dispose, and ignores late RPC replies", async () => {
    const gate = deferred<unknown>();
    const launchGate = deferred<unknown>();
    const mutate = vi.fn(async () => gate.promise);
    const launch = vi.fn(async () => launchGate.promise);
    const applied = vi.fn();
    const client = makeClient({ mutate, launch, applyValues: applied });
    const first = client.client.clearPins();
    await settlePromises();
    const queued = Array.from({ length: 15 }, () => client.client.clearHistory());
    await expect(client.client.clearPins()).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT",
    });
    const launchPromise = client.client.launchApp({ path: "/Applications/A.app", name: "A" });
    await settlePromises();
    expect(mutate).toHaveBeenCalledTimes(1);

    client.client.dispose();
    await expect(first).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    for (const promise of queued) {
      await expect(promise).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    }
    await expect(launchPromise).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    gate.resolve(payload(1, ["pinned-commands"]));
    launchGate.resolve("late-launch-result");
    await settlePromises();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(applied).not.toHaveBeenCalled();
    expect(client.client.snapshot()).toMatchObject({ disposed: true, queuedMutations: 0 });
  });
});
