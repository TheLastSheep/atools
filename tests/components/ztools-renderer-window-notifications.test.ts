import { describe, expect, it, vi } from "vitest";
import {
  createRendererWindowNotifications,
  type RendererWindowNotificationCommand,
} from "../../packages/ztools-renderer/src/windowNotifications";

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

describe("ZTools renderer window notifications", () => {
  it("returns void while sending valid one-way resize and hide notifications", async () => {
    const send = vi.fn(async (
      _command: RendererWindowNotificationCommand,
      _args?: Record<string, unknown>,
    ) => undefined);
    const notifications = createRendererWindowNotifications(send, () => false);

    expect(notifications.resizeWindow(1)).toBeUndefined();
    expect(notifications.resizeWindow(10_000)).toBeUndefined();
    expect(notifications.hideWindow()).toBeUndefined();
    expect(send.mock.calls).toEqual([
      ["expand_window", { height: 1 }],
      ["expand_window", { height: 10_000 }],
      ["hide_main_window", undefined],
    ]);
    expect(notifications.snapshot()).toEqual({
      pendingReplies: 3,
      failures: 0,
      cancelled: 0,
      dropped: 0,
    });

    await settlePromises();
    expect(notifications.snapshot().pendingReplies).toBe(0);
  });

  it("counts synchronous throws and async rejects without leaking error details", async () => {
    const rejected = deferred<unknown>();
    let sendCount = 0;
    const send = vi.fn((_command: RendererWindowNotificationCommand) => {
      sendCount += 1;
      if (sendCount === 1) throw new Error("private synchronous send details");
      return rejected.promise;
    });
    const notifications = createRendererWindowNotifications(send, () => false);

    expect(() => notifications.hideWindow()).not.toThrow();
    expect(notifications.snapshot()).toMatchObject({ pendingReplies: 0, failures: 1 });
    notifications.resizeWindow(420);
    expect(notifications.snapshot()).toMatchObject({ pendingReplies: 1, failures: 1 });

    rejected.reject(new Error("private async reply details"));
    await settlePromises();
    expect(notifications.snapshot()).toMatchObject({ pendingReplies: 0, failures: 2 });
    expect(JSON.stringify(notifications.snapshot())).not.toContain("private synchronous send details");
    expect(JSON.stringify(notifications.snapshot())).not.toContain("private async reply details");
  });

  it("drops notifications after disposal without calling native send", () => {
    const send = vi.fn(async () => undefined);
    const notifications = createRendererWindowNotifications(send, () => true);

    notifications.resizeWindow(420);
    notifications.hideWindow();

    expect(send).not.toHaveBeenCalled();
    expect(notifications.snapshot()).toEqual({
      pendingReplies: 0,
      failures: 0,
      cancelled: 0,
      dropped: 2,
    });
  });

  it("counts queued dispose rejection as cancellation while handling the reply", async () => {
    const reply = deferred<unknown>();
    let disposed = false;
    const send = vi.fn(() => reply.promise);
    const notifications = createRendererWindowNotifications(send, () => disposed);

    notifications.resizeWindow(480);
    expect(notifications.snapshot()).toMatchObject({ pendingReplies: 1, cancelled: 0 });
    disposed = true;
    reply.reject(Object.assign(new Error("private dispose reply"), {
      code: "ERR_ATOOLS_ZTOOLS_DISPOSED",
    }));
    await settlePromises();

    expect(notifications.snapshot()).toEqual({
      pendingReplies: 0,
      failures: 0,
      cancelled: 1,
      dropped: 0,
    });
    expect(JSON.stringify(notifications.snapshot())).not.toContain("private dispose reply");
  });

  it("rejects invalid live heights through fixed diagnostics without sending", () => {
    const send = vi.fn(async () => undefined);
    const notifications = createRendererWindowNotifications(send, () => false);

    for (const height of [0, 10_001, Number.NaN, 1.5]) notifications.resizeWindow(height);

    expect(send).not.toHaveBeenCalled();
    expect(notifications.snapshot()).toEqual({
      pendingReplies: 0,
      failures: 4,
      cancelled: 0,
      dropped: 0,
    });
  });
});
