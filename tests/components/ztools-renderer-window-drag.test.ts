import { describe, expect, it, vi } from "vitest";
import {
  createRendererWindowDrag,
  type RendererWindowDragRequest,
} from "../../packages/ztools-renderer/src/windowDrag";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type { RendererHostCommand, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe("ZTools renderer window drag", () => {
  it("shares concurrent position reads and accepts finite negative logical coordinates", async () => {
    const reply = deferred<unknown>();
    const send = vi.fn((_request: RendererWindowDragRequest) => reply.promise);
    const drag = createRendererWindowDrag(send);
    const first = drag.getWindowPosition();
    const second = drag.getWindowPosition();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ operation: "position" });
    reply.resolve({ x: -1440, y: 28 });

    await expect(first).resolves.toEqual({ x: -1440, y: 28 });
    await expect(second).resolves.toEqual({ x: -1440, y: 28 });
    expect(drag.snapshot()).toMatchObject({ failures: 0, pending: 0, disposed: false });
  });

  it("rejects malformed native position replies without exposing payloads", async () => {
    for (const value of [
      null,
      [],
      { x: "10", y: 20 },
      { x: Number.NaN, y: 20 },
      { x: 10, y: Number.POSITIVE_INFINITY },
      { x: 10, y: 20, secret: "native-private" },
    ]) {
      const drag = createRendererWindowDrag(async () => value);
      await expect(drag.getWindowPosition()).rejects.toThrow(/drag response/i);
      expect(drag.snapshot().failures).toBe(1);
      expect(JSON.stringify(drag.snapshot())).not.toContain("native-private");
    }

    const getter = vi.fn(() => "private getter value");
    const drag = createRendererWindowDrag(async () => Object.defineProperties({}, {
      x: { enumerable: true, get: getter },
      y: { enumerable: true, value: 20 },
    }));
    await expect(drag.getWindowPosition()).rejects.toThrow(/drag response/i);
    expect(getter).not.toHaveBeenCalled();
  });

  it("coalesces mousemove bursts and keeps lock/unlock barriers around the last move", async () => {
    const firstLock = deferred<unknown>();
    const move = deferred<unknown>();
    const calls: RendererWindowDragRequest[] = [];
    const send = vi.fn((request: RendererWindowDragRequest) => {
      calls.push(request);
      if (calls.length === 1) return firstLock.promise;
      if (calls.length === 2) return move.promise;
      return Promise.resolve(null);
    });
    const drag = createRendererWindowDrag(send);

    drag.setWindowSizeLock(true);
    drag.setWindowPosition(-10, 20);
    drag.setWindowPosition(-9, 21);
    drag.setWindowPosition(-8, 22);
    drag.setWindowSizeLock(false);
    expect(calls).toEqual([{ operation: "lock", locked: true }]);
    expect(drag.snapshot()).toMatchObject({ pending: 3, queued: 2, coalescedMoves: 2 });

    firstLock.resolve(null);
    await settle();
    expect(calls[1]).toEqual({ operation: "move", x: -8, y: 22 });
    move.resolve(null);
    await settle();
    expect(calls[2]).toEqual({ operation: "lock", locked: false });
    await settle();
    expect(drag.snapshot()).toMatchObject({ pending: 0, failures: 0, queued: 0 });
  });

  it("does not lock or move when mouseup cancels a pending start-position read", async () => {
    const reply = deferred<unknown>();
    const send = vi.fn((request: RendererWindowDragRequest) =>
      request.operation === "position" ? reply.promise : Promise.resolve(null));
    const drag = createRendererWindowDrag(send);
    const position = drag.getWindowPosition();

    drag.setWindowSizeLock(false);
    reply.resolve({ x: 800, y: 120 });
    await expect(position).resolves.toEqual({ x: 800, y: 120 });
    await settle();

    expect(send.mock.calls.map(([request]) => request)).toEqual([
      { operation: "position" },
      { operation: "lock", locked: false },
    ]);
    expect(drag.snapshot()).toMatchObject({ failures: 0, pending: 0 });
  });

  it("reissues lock after the Native window clears stale drag state", async () => {
    const requests: RendererWindowDragRequest[] = [];
    let nativeLocked = false;
    const send = vi.fn(async (request: RendererWindowDragRequest) => {
      requests.push(request);
      if (request.operation === "lock") nativeLocked = request.locked;
      return request.operation === "position" ? { x: 12, y: -4 } : null;
    });
    const drag = createRendererWindowDrag(send);

    drag.setWindowSizeLock(true);
    await settle();
    expect(nativeLocked).toBe(true);

    nativeLocked = false; // Native hide clears its drag lock while this renderer remains alive.
    await expect(drag.getWindowPosition()).resolves.toEqual({ x: 12, y: -4 });
    drag.setWindowSizeLock(true);
    await settle();

    expect(requests.filter((request) => request.operation === "lock" && request.locked)).toHaveLength(2);
    expect(nativeLocked).toBe(true);
    expect(drag.snapshot()).toMatchObject({ pending: 0, failures: 0 });
  });

  it("bounds repeated lock barriers and preserves a final unlock", async () => {
    const first = deferred<unknown>();
    const requests: RendererWindowDragRequest[] = [];
    const send = vi.fn((request: RendererWindowDragRequest) => {
      requests.push(request);
      return requests.length === 1 ? first.promise : Promise.resolve(null);
    });
    const drag = createRendererWindowDrag(send);

    drag.setWindowSizeLock(true);
    for (let index = 0; index < 100; index += 1) {
      drag.setWindowPosition(index, -index);
      drag.setWindowSizeLock(index % 2 === 0);
    }
    drag.setWindowSizeLock(false);
    expect(drag.snapshot().queued).toBeLessThanOrEqual(18);
    expect(drag.snapshot().rejectedOperations).toBeGreaterThan(0);
    expect(drag.snapshot().pending).toBeLessThanOrEqual(19);

    first.resolve(null);
    await settle();
    for (let index = 0; index < 100 && drag.snapshot().pending; index += 1) await settle();
    expect(requests.at(-1)).toEqual({ operation: "lock", locked: false });
    expect(drag.snapshot()).toMatchObject({ pending: 0, failures: 0, disposed: false });
  });

  it("makes room for unlock when interleaved reads and moves fill the queue", async () => {
    const pendingMove = deferred<unknown>();
    const requests: RendererWindowDragRequest[] = [];
    const send = vi.fn((request: RendererWindowDragRequest) => {
      requests.push(request);
      if (requests.length === 2) return pendingMove.promise;
      return Promise.resolve(request.operation === "position" ? { x: 4, y: -6 } : null);
    });
    const drag = createRendererWindowDrag(send);

    drag.setWindowSizeLock(true);
    await settle();
    drag.setWindowPosition(0, 0);
    for (let index = 0; index < 7; index += 1) {
      drag.setWindowPosition(index + 1, -(index + 1));
      drag.setWindowSizeLock(false);
    }
    drag.setWindowPosition(20, -20);
    const firstRead = drag.getWindowPosition();
    drag.setWindowPosition(21, -21);
    const secondRead = drag.getWindowPosition();
    expect(drag.snapshot()).toMatchObject({ queued: 18, queuedLocks: 7 });

    drag.setWindowSizeLock(false);
    expect(drag.snapshot()).toMatchObject({
      queued: 3,
      queuedMoves: 0,
      queuedLocks: 1,
      pendingPositionReads: 2,
    });
    expect(drag.snapshot().rejectedOperations).toBeGreaterThan(0);

    pendingMove.resolve(null);
    await expect(firstRead).resolves.toEqual({ x: 4, y: -6 });
    await expect(secondRead).resolves.toEqual({ x: 4, y: -6 });
    for (let index = 0; index < 12 && drag.snapshot().pending; index += 1) await settle();
    expect(requests.at(-1)).toEqual({ operation: "lock", locked: false });
    expect(drag.snapshot()).toMatchObject({ pending: 0, failures: 0 });
  });

  it("contains command failures and invalid void calls in fixed diagnostics", async () => {
    const send = vi.fn(async (_request: RendererWindowDragRequest) => {
      throw new Error("private native window details");
    });
    const drag = createRendererWindowDrag(send);

    drag.setWindowPosition(-5, 7);
    drag.setWindowPosition(Number.NaN, 7);
    drag.setWindowSizeLock("true" as unknown as boolean);
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(drag.snapshot()).toMatchObject({ failures: 1, rejectedOperations: 2, pending: 0 });
    expect(JSON.stringify(drag.snapshot())).not.toContain("private native window details");
  });

  it("handles an ignored failed position read without an unhandled rejection", async () => {
    const reply = deferred<unknown>();
    const drag = createRendererWindowDrag(() => reply.promise);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const read = drag.getWindowPosition();
    reply.reject(new Error("private position read failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", onUnhandled);

    expect(unhandled).toEqual([]);
    expect(drag.snapshot()).toMatchObject({ failures: 1, pending: 0, pendingPositionReads: 0 });
    await expect(read).rejects.toThrow("private position read failure");
    expect(JSON.stringify(drag.snapshot())).not.toContain("private position read failure");
  });

  it("disposes queued work and prevents late replies from restarting native calls", async () => {
    const first = deferred<unknown>();
    const send = vi.fn((_request: RendererWindowDragRequest) => first.promise);
    const drag = createRendererWindowDrag(send);

    drag.setWindowSizeLock(true);
    drag.setWindowPosition(12, 34);
    drag.setWindowPosition(56, 78);
    expect(drag.snapshot()).toMatchObject({ pending: 2, queued: 1 });

    drag.dispose();
    expect(drag.snapshot()).toMatchObject({ disposed: true, pending: 1, queued: 0 });
    first.resolve(null);
    await settle();
    drag.setWindowPosition(90, 100);
    drag.setWindowSizeLock(false);
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(drag.snapshot()).toMatchObject({ disposed: true, pending: 0, queued: 0 });
  });

  it("wires the typed host methods and limits their capability", async () => {
    const calls: Array<{ command: RendererHostCommand; args?: Record<string, unknown> }> = [];
    const transport: ZToolsRendererTransport = {
      async invoke(command, args) {
        calls.push({ command, args });
        if (command === "renderer_window_drag" && args?.request
          && (args.request as RendererWindowDragRequest).operation === "position") {
          return { x: -20, y: 40 };
        }
        return null;
      },
      async listen() { return () => undefined; },
    };
    const adapter = createZtoolsRendererHostAdapter({ transport });

    await expect(adapter.api.getWindowPosition()).resolves.toEqual({ x: -20, y: 40 });
    expect(adapter.api.setWindowSizeLock(true)).toBeUndefined();
    expect(adapter.api.setWindowPosition(-21, 41)).toBeUndefined();
    expect(adapter.capabilities().methods).toMatchObject({
      getWindowPosition: "limited",
      setWindowPosition: "limited",
      setWindowSizeLock: "limited",
    });
    await settle();
    expect(calls.slice(0, 3)).toEqual([
      { command: "renderer_window_drag", args: { request: { operation: "position" } } },
      { command: "renderer_window_drag", args: { request: { operation: "lock", locked: true } } },
      { command: "renderer_window_drag", args: { request: { operation: "move", x: -21, y: 41 } } },
    ]);
    expect(adapter.snapshot().windowDrag).toMatchObject({
      positionReads: 1,
      lockRequests: 1,
      moveRequests: 1,
      dispatchedPositions: 1,
      dispatchedLocks: 1,
      dispatchedMoves: 1,
    });
    adapter.dispose();
    expect(adapter.snapshot().windowDrag).toMatchObject({ disposed: true });
  });

  it("does not drain queued moves through the adapter after disposal", async () => {
    const reply = deferred<unknown>();
    const calls: RendererHostCommand[] = [];
    const transport: ZToolsRendererTransport = {
      invoke: vi.fn((command: RendererHostCommand) => {
        calls.push(command);
        return reply.promise;
      }),
      async listen() { return () => undefined; },
    };
    const adapter = createZtoolsRendererHostAdapter({ transport });
    adapter.api.setWindowSizeLock(true);
    adapter.api.setWindowPosition(16, 32);
    await settle();
    expect(calls).toEqual(["renderer_window_drag"]);

    adapter.dispose();
    await settle();
    expect(adapter.snapshot().windowDrag).toMatchObject({
      disposed: true,
      pending: 0,
      queued: 0,
      pendingPositionReads: 0,
      queuedMoves: 0,
    });
    reply.resolve(null);
    adapter.api.setWindowPosition(64, 128);
    adapter.api.setWindowSizeLock(false);
    await settle();
    expect(calls).toEqual(["renderer_window_drag"]);
    expect(adapter.snapshot().windowDrag.droppedAfterDispose).toBe(2);
  });
});
