// @vitest-environment node
import { expect, it, vi } from "vitest";
import vm from "node:vm";
import { createNodePromisePolling } from "../../src/lib/nodePromisePolling";
import { nodeModuleBridgeScript } from "../../src/lib/nodeModuleBridge";

const pending = { state: "pending" } as const;
const fulfilled = (value: string) => ({ state: "fulfilled", value: { kind: "value", value } } as const);
const rejected = (message: string, code?: string) => ({
  state: "rejected",
  error: { message, ...(code ? { code } : {}) },
} as const);

it("keeps the single-promise poll protocol for one pending handle", async () => {
  const requestAsync = vi.fn(async (method: string, params: Record<string, unknown>) => {
    expect(method).toBe("pollPromise");
    expect(params).toEqual({ handleId: 12 });
    return fulfilled("one");
  });
  const poll = createNodePromisePolling(requestAsync);

  await expect(poll([12])).resolves.toEqual(new Map([[12, fulfilled("one")]]));
  expect(requestAsync).toHaveBeenCalledTimes(1);
});

it("uses one checked batch for multiple handles and preserves mixed states", async () => {
  const requestAsync = vi.fn(async (method: string, params: Record<string, unknown>) => {
    expect(method).toBe("pollPromises");
    expect(params).toEqual({ handleIds: [12, 13, 14] });
    return {
      states: [
        { handleId: 12, state: pending },
        { handleId: 13, state: fulfilled("three") },
        { handleId: 14, state: rejected("read failed", "EIO") },
      ],
      fallback: [],
    };
  });
  const poll = createNodePromisePolling(requestAsync);

  await expect(poll([12, 13, 14])).resolves.toEqual(new Map([
    [12, pending],
    [13, fulfilled("three")],
    [14, rejected("read failed", "EIO")],
  ]));
  expect(requestAsync).toHaveBeenCalledTimes(1);
});

it("splits more than 32 handles into bounded batches and a single tail query", async () => {
  const requestAsync = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "pollPromises") {
      const handleIds = params.handleIds as number[];
      expect(handleIds).toHaveLength(32);
      return { states: handleIds.map((handleId) => ({ handleId, state: pending })), fallback: [] };
    }
    expect(method).toBe("pollPromise");
    expect(params).toEqual({ handleId: 33 });
    return pending;
  });
  const poll = createNodePromisePolling(requestAsync);

  const states = await poll(Array.from({ length: 33 }, (_, index) => index + 1));
  expect(states?.size).toBe(33);
  expect([...states!.values()].every((state) => state.state === "pending")).toBe(true);
  expect(requestAsync.mock.calls.map(([method]) => method)).toEqual(["pollPromises", "pollPromise"]);
});

it("falls back to single queries only for IDs the host marks", async () => {
  const requestAsync = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "pollPromises") {
      expect(params).toEqual({ handleIds: [21, 22, 23] });
      return {
        states: [{ handleId: 21, state: fulfilled("saved") }, { handleId: 22, state: pending }],
        fallback: [23],
      };
    }
    expect(method).toBe("pollPromise");
    expect(params).toEqual({ handleId: 23 });
    return rejected("permission denied", "EACCES");
  });
  const poll = createNodePromisePolling(requestAsync);

  await expect(poll([21, 22, 23])).resolves.toEqual(new Map([
    [21, fulfilled("saved")],
    [22, pending],
    [23, rejected("permission denied", "EACCES")],
  ]));
  expect(requestAsync.mock.calls.map(([method]) => method)).toEqual(["pollPromises", "pollPromise"]);
});

it("preserves requested handle order when an earlier ID uses single-query fallback", async () => {
  const requestAsync = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "pollPromises") {
      expect(params).toEqual({ handleIds: [1, 2] });
      return { states: [{ handleId: 2, state: pending }], fallback: [1] };
    }
    expect(method).toBe("pollPromise");
    expect(params).toEqual({ handleId: 1 });
    return fulfilled("first");
  });
  const poll = createNodePromisePolling(requestAsync);

  const states = await poll([1, 2]);
  expect([...states!.keys()]).toEqual([1, 2]);
  expect(states).toEqual(new Map([[1, fulfilled("first")], [2, pending]]));
});

it.each([
  ["missing requested handle", { states: [{ handleId: 1, state: pending }], fallback: [] }],
  ["duplicate handle", { states: [{ handleId: 1, state: pending }, { handleId: 1, state: pending }], fallback: [] }],
  ["unknown handle", { states: [{ handleId: 1, state: pending }, { handleId: 9, state: pending }], fallback: [] }],
  ["illegal state", { states: [{ handleId: 1, state: { state: "working" } }, { handleId: 2, state: pending }], fallback: [] }],
  ["malformed fallback", { states: [{ handleId: 1, state: pending }], fallback: ["2"] }],
  ["state and fallback duplicate", { states: [{ handleId: 1, state: pending }, { handleId: 2, state: pending }], fallback: [2] }],
] as const)("rejects malformed batch response: %s", async (_caseName, response) => {
  const poll = createNodePromisePolling(async () => response);
  await expect(poll([1, 2])).rejects.toMatchObject({ code: "ERR_ATOOLS_NODE_POLL_RESPONSE" });
});

it("rejects duplicate or unsafe requested IDs before sending them", async () => {
  const requestAsync = vi.fn();
  const poll = createNodePromisePolling(requestAsync);

  await expect(poll([1, 1])).rejects.toMatchObject({ code: "ERR_ATOOLS_NODE_POLL_REQUEST" });
  await expect(poll([Number.MAX_SAFE_INTEGER + 1])).rejects.toMatchObject({ code: "ERR_ATOOLS_NODE_POLL_REQUEST" });
  expect(requestAsync).not.toHaveBeenCalled();
});

it("preserves the original transport and Node budget error", async () => {
  const budgetError = Object.assign(new Error("ERR_ATOOLS_NODE_RESPONSE_BUDGET"), { code: "ERR_ATOOLS_NODE_RESPONSE_BUDGET" });
  const poll = createNodePromisePolling(async () => { throw budgetError; });

  await expect(poll([1, 2])).rejects.toBe(budgetError);
});

it("stops before starting a later batch or fallback when the session closes", async () => {
  let current = true;
  const batchRequest = vi.fn(async () => {
    current = false;
    return { states: Array.from({ length: 32 }, (_, index) => ({ handleId: index + 1, state: pending })), fallback: [] };
  });
  const batched = createNodePromisePolling(batchRequest, () => current);
  await expect(batched(Array.from({ length: 33 }, (_, index) => index + 1))).resolves.toBeUndefined();
  expect(batchRequest).toHaveBeenCalledTimes(1);

  current = true;
  const fallbackRequest = vi.fn(async (method: string) => {
    if (method === "pollPromises") return { states: [], fallback: [41, 42] };
    current = false;
    return pending;
  });
  const fallback = createNodePromisePolling(fallbackRequest, () => current);
  await expect(fallback([41, 42])).resolves.toBeUndefined();
  expect(fallbackRequest.mock.calls.map(([method]) => method)).toEqual(["pollPromises", "pollPromise"]);
});

it("drains final callback notifications before batched Promise settlement in serialized bridge", async () => {
  const callbackIds: string[] = [];
  const dispatchOrder: string[] = [];
  let pollCalls = 0;
  let promisesCompleted = false;
  let nextPromiseId = 30;
  const dispatch = (method: string, params: Record<string, any>): unknown => {
    if (method === "require") return { kind: "handle", handleId: 1, callable: false, keys: ["start"] };
    if (method === "get" && params.handleId === 1 && params.property === "start") {
      return { kind: "handle", handleId: 2, callable: true, keys: [] };
    }
    if (method === "call" && params.handleId === 2) {
      const callback = params.args[0];
      callbackIds.push(callback.id);
      return { kind: "promise", handleId: ++nextPromiseId };
    }
    if (method === "poll") {
      pollCalls++;
      return {
        events: !promisesCompleted ? [] : callbackIds.map((callbackId) => ({
          callbackId,
          args: [{ kind: "value", value: callbackId }],
        })),
        overflowed: false,
      };
    }
    if (method === "pollPromises") {
      promisesCompleted = true;
      const handleIds = params.handleIds as number[];
      return { states: handleIds.map((handleId) => ({ handleId, state: fulfilled(`result-${handleId}`) })), fallback: [] };
    }
    if (method === "release") return { released: 0, callbacksReleased: callbackIds.length };
    throw new Error(`Unexpected bridge request: ${method}`);
  };
  const envelope = (body: string, channel: "sync" | "async") => {
    const request = JSON.parse(body) as { method: string; params: Record<string, any> };
    if (["poll", "pollPromise", "pollPromises"].includes(request.method)) {
      dispatchOrder.push(`${request.method}:${channel}`);
    }
    try { return JSON.stringify({ ok: true, result: dispatch(request.method, request.params) }); }
    catch (error) {
      const caught = error as Error & { code?: string };
      return JSON.stringify({ ok: false, error: { message: caught.message, code: caught.code } });
    }
  };
  class LocalXmlHttpRequest {
    status = 0;
    responseText = "";
    open() {}
    setRequestHeader() {}
    send(body: string) { this.status = 200; this.responseText = envelope(body, "sync"); }
  }
  const sandbox: Record<string, any> = {
    XMLHttpRequest: LocalXmlHttpRequest,
    fetch: async (_url: string, options: { body: string }) => ({ ok: true, status: 200, json: async () => JSON.parse(envelope(options.body, "async")) }),
    URL,
    TextEncoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    WeakRef,
    FinalizationRegistry,
    console,
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`window.require = ${nodeModuleBridgeScript({ endpoint: `http://127.0.0.1:43121/node/${"b".repeat(64)}` })};`, sandbox);
  vm.runInContext(`
    window.__order = [];
    const api = window.require("test-double");
    window.__done = Promise.all([
      api.start((id) => window.__order.push("callback-" + id)),
      api.start((id) => window.__order.push("callback-" + id)),
    ]).then(() => window.__order.push("settled"));
  `, sandbox);

  await sandbox.__done;
  expect(sandbox.__order.slice(0, 2)).toEqual(callbackIds.map((id) => `callback-${id}`));
  expect(sandbox.__order.at(-1)).toBe("settled");
  expect(pollCalls).toBe(4);
  expect(dispatchOrder.slice(-3)).toEqual(["poll:async", "pollPromises:async", "poll:async"]);
  sandbox.require.close();
});
