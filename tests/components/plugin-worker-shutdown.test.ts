import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestPluginWorkerShutdown } from "../../src/lib/pluginWorkerShutdown";

type ShutdownMessage = { __atools_worker_shutdown__: true; requestId: string; scopeId: string };
type FakeSource = Window & { sent: Array<{ message: ShutdownMessage; origin: string }> };

let messageTarget: Window;
let sequence: number;

function source(throws = false): FakeSource {
  const fake = {
    sent: [] as FakeSource["sent"],
    postMessage(message: ShutdownMessage, origin: string) {
      if (throws) throw new Error("closed source");
      this.sent.push({ message, origin });
    },
  };
  return fake as unknown as FakeSource;
}

function dispatch(sourceWindow: Window, data: unknown, origin = "null") {
  messageTarget.dispatchEvent(new MessageEvent("message", { source: sourceWindow, origin, data }));
}

function scope(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  messageTarget = new EventTarget() as Window;
  sequence = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `request-${++sequence}` });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("registers before sending and only accepts a source-bound zero-remaining acknowledgement", async () => {
  const first = source();
  const second = source();
  const remove = vi.spyOn(messageTarget, "removeEventListener");
  const pending = requestPluginWorkerShutdown([{ source: first, scopeId: scope(1), origin: "null" }, { source: second, scopeId: scope(2) }], { messageTarget });
  expect(first.sent).toHaveLength(1);
  expect(second.sent).toHaveLength(1);
  expect(first.sent[0].origin).toBe("null");
  expect(second.sent[0].origin).toBe("*");

  const firstId = first.sent[0].message.requestId;
  const secondId = second.sent[0].message.requestId;
  const firstScope = first.sent[0].message.scopeId;
  const secondScope = second.sent[0].message.scopeId;
  dispatch(second, { __atools_worker_shutdown_ack__: true, requestId: firstId, scopeId: firstScope, remaining: 0 });
  dispatch(first, { __atools_worker_shutdown_ack__: true, requestId: firstId, scopeId: firstScope, remaining: "0" }, "null");
  dispatch(first, { __atools_worker_shutdown_ack__: true, requestId: firstId, scopeId: firstScope, remaining: 1 }, "null");
  dispatch(first, { __atools_worker_shutdown_ack__: true, requestId: firstId, scopeId: firstScope, remaining: 0 }, "https://wrong-origin.example");
  dispatch(first, { __atools_worker_shutdown_ack__: true, requestId: firstId, scopeId: scope(99), remaining: 0 }, "null");
  dispatch(first, { __atools_worker_shutdown_ack__: true, requestId: firstId, scopeId: firstScope, remaining: 0 }, "null");
  dispatch(first, { __atools_worker_shutdown_ack__: true, requestId: firstId, scopeId: firstScope, remaining: 0 }, "null");
  dispatch(second, { __atools_worker_shutdown_ack__: true, requestId: secondId, scopeId: secondScope, remaining: 0 });

  await expect(pending).resolves.toEqual({ requested: 2, acknowledged: 2, timedOut: false });
  expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
  dispatch(first, { __atools_worker_shutdown_ack__: true, requestId: firstId, scopeId: firstScope, remaining: 0 }, "null");
});

it("times out and removes its listener so late acknowledgements cannot change the result", async () => {
  const target = source();
  const remove = vi.spyOn(messageTarget, "removeEventListener");
  const pending = requestPluginWorkerShutdown([{ source: target, scopeId: scope(3) }], { messageTarget, timeoutMs: 25 });
  expect(remove).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(25);
  await expect(pending).resolves.toEqual({ requested: 1, acknowledged: 0, timedOut: true });
  expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
  dispatch(target, { __atools_worker_shutdown_ack__: true, requestId: target.sent[0].message.requestId,
    scopeId: target.sent[0].message.scopeId, remaining: 0 });
});

it("cancels immediately and deduplicates each source within one request", async () => {
  const target = source();
  const controller = new AbortController();
  const pending = requestPluginWorkerShutdown([{ source: target, scopeId: scope(4) }, { source: target, scopeId: scope(4) }], { messageTarget, signal: controller.signal });
  expect(target.sent).toHaveLength(1);
  controller.abort();
  await expect(pending).resolves.toEqual({ requested: 1, acknowledged: 0, timedOut: true });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not let an old document scope acknowledge a new request through the same WindowProxy", async () => {
  const target = source();
  const oldScope = scope(40);
  const oldPending = requestPluginWorkerShutdown([{ source: target, scopeId: oldScope }], { messageTarget, timeoutMs: 10 });
  const oldRequest = target.sent[0].message;
  const newScope = scope(41);
  const newPending = requestPluginWorkerShutdown([{ source: target, scopeId: newScope }], { messageTarget });
  const newRequest = target.sent[1].message;

  await vi.advanceTimersByTimeAsync(10);
  await expect(oldPending).resolves.toEqual({ requested: 1, acknowledged: 0, timedOut: true });
  dispatch(target, { __atools_worker_shutdown_ack__: true, requestId: oldRequest.requestId, scopeId: oldScope, remaining: 0 });
  dispatch(target, { __atools_worker_shutdown_ack__: true, requestId: newRequest.requestId, scopeId: oldScope, remaining: 0 });
  dispatch(target, { __atools_worker_shutdown_ack__: true, requestId: newRequest.requestId, scopeId: newScope, remaining: 0 });

  await expect(newPending).resolves.toEqual({ requested: 1, acknowledged: 1, timedOut: false });
});

it("reports postMessage failures as incomplete and rejects over-cap target sets", async () => {
  const broken = source(true);
  const remove = vi.spyOn(messageTarget, "removeEventListener");
  const result = await requestPluginWorkerShutdown([{ source: broken, scopeId: scope(5) }], { messageTarget });
  expect(result).toEqual({ requested: 1, acknowledged: 0, timedOut: true });
  expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
  await expect(requestPluginWorkerShutdown(Array.from({ length: 65 }, (_, index) => ({ source: source(), scopeId: scope(index + 10) })), { messageTarget }))
    .rejects.toThrow(/At most 64/);
  await expect(requestPluginWorkerShutdown([{ source: source(), scopeId: "not-a-uuid" }], { messageTarget }))
    .rejects.toThrow(/UUIDv4/);
  expect(vi.getTimerCount()).toBe(0);
});

it("finishes with no targets and clamps the deadline to the hard 250 ms ceiling", async () => {
  await expect(requestPluginWorkerShutdown([], { messageTarget })).resolves.toEqual({ requested: 0, acknowledged: 0, timedOut: false });
  const aborted = new AbortController();
  aborted.abort();
  await expect(requestPluginWorkerShutdown([{ source: source(), scopeId: scope(6) }], { messageTarget, signal: aborted.signal }))
    .resolves.toEqual({ requested: 0, acknowledged: 0, timedOut: true });
  const target = source();
  const pending = requestPluginWorkerShutdown([{ source: target, scopeId: scope(7) }], { messageTarget, timeoutMs: 10_000 });
  await vi.advanceTimersByTimeAsync(250);
  await expect(pending).resolves.toEqual({ requested: 1, acknowledged: 0, timedOut: true });
});
