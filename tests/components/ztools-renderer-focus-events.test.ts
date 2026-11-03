import { describe, expect, it, vi } from "vitest";
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

function focusTransport(
  listen: (event: string, handler: RendererHostListener) => Promise<RendererHostUnlisten>,
): Pick<ZToolsRendererTransport, "listen"> {
  return { listen };
}

describe("ZTools renderer focus events", () => {
  it("notifies without forwarding native payload or inventing window context", async () => {
    let emit!: RendererHostListener;
    const unlisten = vi.fn();
    const listen = vi.fn(async (event: string, handler: RendererHostListener) => {
      expect(event).toBe("tauri://focus");
      emit = handler;
      return unlisten;
    });
    const focusEvents = createRendererFocusEvents(focusTransport(listen));
    const callback = vi.fn();
    const unsubscribe = focusEvents.subscribe(callback);
    await settlePromises();

    emit({ label: "secret-window-name", windowInfo: { title: "unavailable" } });
    emit({ another: "payload" });

    expect(listen).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1);
    expect(callback).toHaveBeenNthCalledWith(2);
    expect(focusEvents.snapshot()).toEqual({
      subscribers: 1,
      listenerState: "listening",
      deliveredEvents: 2,
      registrationErrors: 0,
      callbackErrors: 0,
      registrationsPending: 0,
      lateListenerUnlistens: 0,
      cleanupPending: 0,
      cleanupErrors: 0,
      windowContextAvailable: false,
    });
    expect("windowInfo" in focusEvents.snapshot()).toBe(false);

    unsubscribe();
    expect(unlisten).toHaveBeenCalledTimes(1);
    focusEvents.dispose();
  });

  it("shares exactly one native listener until the last subscriber leaves", async () => {
    let emit!: RendererHostListener;
    const unlisten = vi.fn();
    const listen = vi.fn(async (_event: string, handler: RendererHostListener) => {
      emit = handler;
      return unlisten;
    });
    const focusEvents = createRendererFocusEvents(focusTransport(listen));
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = focusEvents.subscribe(first);
    const unsubscribeSecond = focusEvents.subscribe(second);
    await settlePromises();

    expect(listen).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    emit({ ignored: false });
    expect(first).toHaveBeenCalledTimes(0);
    expect(second).toHaveBeenCalledTimes(1);
    expect(unlisten).not.toHaveBeenCalled();

    unsubscribeSecond();
    unsubscribeSecond();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(focusEvents.snapshot().listenerState).toBe("idle");
    focusEvents.dispose();
  });

  it("drops an old generation and releases its listener when registration resolves late", async () => {
    const oldRegistration = deferred<RendererHostUnlisten>();
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    const handlers: RendererHostListener[] = [];
    const listen = vi.fn((event: string, handler: RendererHostListener) => {
      handlers.push(handler);
      return handlers.length === 1 ? oldRegistration.promise : Promise.resolve(secondUnlisten);
    });
    const focusEvents = createRendererFocusEvents(focusTransport(listen));
    const oldSubscriber = vi.fn();
    const newSubscriber = vi.fn();

    const unsubscribeOld = focusEvents.subscribe(oldSubscriber);
    unsubscribeOld();
    unsubscribeOld();
    const unsubscribeNew = focusEvents.subscribe(newSubscriber);
    await settlePromises();

    expect(listen).toHaveBeenCalledTimes(2);
    handlers[0]({ stale: true });
    handlers[1]({ current: true });
    expect(oldSubscriber).not.toHaveBeenCalled();
    expect(newSubscriber).toHaveBeenCalledTimes(1);

    oldRegistration.resolve(firstUnlisten);
    await settlePromises();
    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(focusEvents.snapshot().listenerState).toBe("listening");

    unsubscribeNew();
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
    focusEvents.dispose();
  });

  it("retries failed registration and reports failure without exposing its error text", async () => {
    let emit!: RendererHostListener;
    const unlisten = vi.fn();
    const listen = vi.fn()
      .mockRejectedValueOnce(new Error("private native details"))
      .mockImplementationOnce(async (_event: string, handler: RendererHostListener) => {
        emit = handler;
        return unlisten;
      });
    const focusEvents = createRendererFocusEvents(focusTransport(listen));
    const callback = vi.fn();

    focusEvents.subscribe(callback);
    await settlePromises();
    expect(focusEvents.snapshot().listenerState).toBe("failed");
    expect(focusEvents.snapshot().registrationErrors).toBe(1);
    expect(JSON.stringify(focusEvents.snapshot())).not.toContain("private native details");

    const unsubscribe = focusEvents.subscribe(vi.fn());
    await settlePromises();
    expect(listen).toHaveBeenCalledTimes(2);
    expect(focusEvents.snapshot().listenerState).toBe("listening");
    emit({});
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    focusEvents.dispose();
  });

  it("counts synchronous and async callback errors while continuing delivery", async () => {
    let emit!: RendererHostListener;
    const listen = vi.fn(async (_event: string, handler: RendererHostListener) => {
      emit = handler;
      return vi.fn();
    });
    const focusEvents = createRendererFocusEvents(focusTransport(listen));
    const throws = vi.fn(() => {
      throw new Error("sensitive callback content");
    });
    const rejects = vi.fn(() => Promise.reject(new Error("sensitive async content")));
    const succeeds = vi.fn();
    focusEvents.subscribe(throws);
    focusEvents.subscribe(rejects);
    focusEvents.subscribe(succeeds);
    await settlePromises();

    emit({ message: "payload is ignored" });
    await settlePromises();

    expect(throws).toHaveBeenCalledTimes(1);
    expect(rejects).toHaveBeenCalledTimes(1);
    expect(succeeds).toHaveBeenCalledTimes(1);
    expect(focusEvents.snapshot().callbackErrors).toBe(2);
    expect(JSON.stringify(focusEvents.snapshot())).not.toContain("sensitive");
    focusEvents.dispose();
  });

  it("unlistens a registration that resolves after disposal and rejects new subscriptions", async () => {
    const pending = deferred<RendererHostUnlisten>();
    const unlisten = vi.fn();
    let emit!: RendererHostListener;
    const listen = vi.fn((_event: string, handler: RendererHostListener) => {
      emit = handler;
      return pending.promise;
    });
    const focusEvents = createRendererFocusEvents(focusTransport(listen));
    const callback = vi.fn();
    focusEvents.subscribe(callback);

    focusEvents.dispose();
    focusEvents.dispose();
    expect(focusEvents.snapshot()).toMatchObject({
      listenerState: "disposed",
      registrationsPending: 1,
      cleanupPending: 0,
    });
    pending.resolve(unlisten);
    await settlePromises();
    emit({ stale: true });

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    expect(focusEvents.snapshot()).toMatchObject({
      subscribers: 0,
      listenerState: "disposed",
      registrationsPending: 0,
      cleanupPending: 0,
    });
    expect(() => focusEvents.subscribe(vi.fn())).toThrowError(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" }),
    );
  });

  it("counts thrown and rejected cleanup without exposing error details", async () => {
    const syncUnlisten = vi.fn(() => {
      throw new Error("private synchronous cleanup details");
    });
    const syncEvents = createRendererFocusEvents(focusTransport(async () => syncUnlisten));
    const unsubscribeSync = syncEvents.subscribe(vi.fn());
    await settlePromises();
    unsubscribeSync();

    expect(syncEvents.snapshot()).toMatchObject({ cleanupErrors: 1, cleanupPending: 0 });
    expect(JSON.stringify(syncEvents.snapshot())).not.toContain("private synchronous cleanup details");
    syncEvents.dispose();

    const pendingCleanup = deferred<void>();
    const asyncUnlisten = vi.fn(() => pendingCleanup.promise);
    const asyncEvents = createRendererFocusEvents(focusTransport(async () => asyncUnlisten));
    const unsubscribeAsync = asyncEvents.subscribe(vi.fn());
    await settlePromises();
    unsubscribeAsync();

    expect(asyncEvents.snapshot()).toMatchObject({ cleanupErrors: 0, cleanupPending: 1 });
    pendingCleanup.reject(new Error("private asynchronous cleanup details"));
    await settlePromises();
    expect(asyncEvents.snapshot()).toMatchObject({ cleanupErrors: 1, cleanupPending: 0 });
    expect(JSON.stringify(asyncEvents.snapshot())).not.toContain("private asynchronous cleanup details");
    asyncEvents.dispose();
  });
});
