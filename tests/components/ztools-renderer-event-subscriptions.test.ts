import { describe, expect, it, vi } from "vitest";
import { createRendererEventSubscriptions } from "../../packages/ztools-renderer/src/eventSubscriptions";
import { createRendererFocusEvents } from "../../packages/ztools-renderer/src/focusEvents";
import type {
  RendererHostListener,
  RendererHostUnlisten,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function eventTransport(
  listen: (event: string, handler: RendererHostListener) => Promise<RendererHostUnlisten>,
): Pick<ZToolsRendererTransport, "listen"> {
  return { listen };
}

describe("ZTools renderer event subscriptions", () => {
  it("waits for the listener and only reports ready after registration succeeds", async () => {
    const pending = deferred<RendererHostUnlisten>();
    const unlisten = vi.fn();
    const listen = vi.fn(() => pending.promise);
    const subscriptions = createRendererEventSubscriptions(
      eventTransport(listen),
      "atools://renderer-app-state",
    );
    subscriptions.subscribe(vi.fn());

    const ready = subscriptions.ready();
    let settled = false;
    void ready.then(() => { settled = true; });
    await settlePromises();
    expect(settled).toBe(false);

    pending.resolve(unlisten);
    await expect(ready).resolves.toBe(true);
    expect(subscriptions.snapshot().listenerState).toBe("listening");
    subscriptions.dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("reports registration failure as not ready and allows a later retry", async () => {
    const unlisten = vi.fn();
    const listen = vi.fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(unlisten);
    const subscriptions = createRendererEventSubscriptions(
      eventTransport(listen),
      "atools://renderer-app-state",
    );
    subscriptions.subscribe(vi.fn());

    await expect(subscriptions.ready()).resolves.toBe(false);
    expect(subscriptions.snapshot().registrationErrors).toBe(1);
    await expect(subscriptions.ready()).resolves.toBe(true);
    expect(subscriptions.snapshot().listenerState).toBe("listening");
    expect(listen).toHaveBeenCalledTimes(2);
    subscriptions.dispose();
  });

  it.each([
    "atools://renderer-app-state",
    "atools://renderer-context-menu",
  ] as const)("forwards payloads through one shared %s listener", async (event) => {
    let emit!: RendererHostListener;
    const unlisten = vi.fn();
    const listen = vi.fn(async (registeredEvent: string, handler: RendererHostListener) => {
      expect(registeredEvent).toBe(event);
      emit = handler;
      return unlisten;
    });
    const subscriptions = createRendererEventSubscriptions(eventTransport(listen), event);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscriptions.subscribe(first);
    const unsubscribeSecond = subscriptions.subscribe(second);
    await settlePromises();

    const payload = { changed: true, nested: { opaque: "native-detail" } };
    emit(payload);

    expect(listen).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(payload);
    expect(second).toHaveBeenCalledWith(payload);
    expect(subscriptions.snapshot()).toMatchObject({
      subscribers: 2,
      listenerState: "listening",
      deliveredEvents: 1,
    });
    expect(JSON.stringify(subscriptions.snapshot())).not.toContain("native-detail");

    unsubscribeFirst();
    unsubscribeSecond();
    expect(unlisten).toHaveBeenCalledTimes(1);
    subscriptions.dispose();
  });

  it("isolates payload-filter exceptions before delivery accounting", async () => {
    let emit!: RendererHostListener;
    const callback = vi.fn();
    const subscriptions = createRendererEventSubscriptions(
      eventTransport(async (_event, handler) => {
        emit = handler;
        return vi.fn();
      }),
      "atools://renderer-app-launched",
      () => { throw new Error("private payload filter detail"); },
    );
    subscriptions.subscribe(callback);
    await settlePromises();

    expect(() => emit({ secret: "private launch payload" })).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(subscriptions.snapshot()).toMatchObject({ deliveredEvents: 0, callbackErrors: 0 });
    expect(JSON.stringify(subscriptions.snapshot())).not.toContain("private payload filter detail");
    expect(JSON.stringify(subscriptions.snapshot())).not.toContain("private launch payload");
    subscriptions.dispose();
  });

  it("runs the optional invalidation hook after validation and before callbacks", async () => {
    let emit!: RendererHostListener;
    const calls: string[] = [];
    const subscriptions = createRendererEventSubscriptions(
      eventTransport(async (_event, handler) => {
        emit = handler;
        return vi.fn();
      }),
      "atools://renderer-command-aliases",
      (payload) => payload === null,
      () => { calls.push("invalidate"); },
    );
    subscriptions.subscribe(() => { calls.push("callback"); });
    await settlePromises();

    emit({ changed: true });
    expect(calls).toEqual([]);
    emit(null);
    expect(calls).toEqual(["invalidate", "callback"]);
    expect(subscriptions.snapshot()).toMatchObject({ deliveredEvents: 1, callbackErrors: 0 });
    subscriptions.dispose();
  });

  it("isolates invalidation hook failures and suppresses stale public callbacks", async () => {
    let emit!: RendererHostListener;
    const callback = vi.fn();
    const subscriptions = createRendererEventSubscriptions(
      eventTransport(async (_event, handler) => {
        emit = handler;
        return vi.fn();
      }),
      "atools://renderer-disabled-commands",
      () => true,
      () => { throw new Error("private invalidator detail"); },
    );
    subscriptions.subscribe(callback);
    await settlePromises();

    expect(() => emit(null)).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(subscriptions.snapshot()).toMatchObject({ deliveredEvents: 1, callbackErrors: 1 });
    expect(JSON.stringify(subscriptions.snapshot())).not.toContain("private invalidator detail");
    subscriptions.dispose();
  });

  it("releases late generations and never delivers them to later subscribers", async () => {
    const oldRegistration = deferred<RendererHostUnlisten>();
    const oldUnlisten = vi.fn();
    const currentUnlisten = vi.fn();
    const handlers: RendererHostListener[] = [];
    const listen = vi.fn((_event: string, handler: RendererHostListener) => {
      handlers.push(handler);
      return handlers.length === 1 ? oldRegistration.promise : Promise.resolve(currentUnlisten);
    });
    const subscriptions = createRendererEventSubscriptions(
      eventTransport(listen),
      "atools://renderer-app-state",
    );
    const oldCallback = vi.fn();
    const currentCallback = vi.fn();
    const unsubscribeOld = subscriptions.subscribe(oldCallback);
    unsubscribeOld();
    const unsubscribeCurrent = subscriptions.subscribe(currentCallback);
    await settlePromises();

    handlers[0]({ stale: true });
    handlers[1]({ current: true });
    expect(oldCallback).not.toHaveBeenCalled();
    expect(currentCallback).toHaveBeenCalledWith({ current: true });

    oldRegistration.resolve(oldUnlisten);
    await settlePromises();
    expect(oldUnlisten).toHaveBeenCalledTimes(1);
    expect(subscriptions.snapshot().lateListenerUnlistens).toBe(1);
    expect(subscriptions.snapshot().listenerState).toBe("listening");

    unsubscribeCurrent();
    expect(currentUnlisten).toHaveBeenCalledTimes(1);
    subscriptions.dispose();
  });

  it("cleans up a registration that resolves after disposal and suppresses delivery", async () => {
    const pending = deferred<RendererHostUnlisten>();
    const unlisten = vi.fn();
    let emit!: RendererHostListener;
    const listen = vi.fn((_event: string, handler: RendererHostListener) => {
      emit = handler;
      return pending.promise;
    });
    const subscriptions = createRendererEventSubscriptions(
      eventTransport(listen),
      "atools://renderer-context-menu",
    );
    const callback = vi.fn();
    subscriptions.subscribe(callback);

    subscriptions.dispose();
    expect(subscriptions.snapshot()).toMatchObject({
      listenerState: "disposed",
      registrationsPending: 1,
      subscribers: 0,
    });

    pending.resolve(unlisten);
    await settlePromises();
    emit({ stale: true });

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    expect(subscriptions.snapshot()).toMatchObject({
      listenerState: "disposed",
      registrationsPending: 0,
      lateListenerUnlistens: 1,
      cleanupPending: 0,
    });
    expect(() => subscriptions.subscribe(vi.fn())).toThrowError(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" }),
    );
  });

  it("rejects invalid callbacks synchronously with the existing host error codes", () => {
    const transport = eventTransport(async () => vi.fn());
    const subscriptions = createRendererEventSubscriptions(
      transport,
      "atools://renderer-app-state",
    );
    const invalidCallback = null as unknown as (payload: unknown) => unknown;

    expect(() => subscriptions.subscribe(invalidCallback)).toThrowError(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" }),
    );
    subscriptions.dispose();
    expect(() => subscriptions.subscribe(invalidCallback)).toThrowError(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" }),
    );

    const focusEvents = createRendererFocusEvents(transport);
    const invalidFocusCallback = null as unknown as () => unknown;
    expect(() => focusEvents.subscribe(invalidFocusCallback)).toThrowError(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" }),
    );
    focusEvents.dispose();
    expect(() => focusEvents.subscribe(invalidFocusCallback)).toThrowError(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" }),
    );
  });
});
