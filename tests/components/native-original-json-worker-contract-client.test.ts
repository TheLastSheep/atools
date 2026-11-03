import { afterEach, beforeEach, expect, it, vi } from "vitest";
import clientSource from "./nativeOriginalJsonWorkerContract.js?raw";

type ContractClient = { run: () => Promise<{ completed: boolean; failureKind?: string; elapsedMs: number }> };
type FakeWorkerInstance = {
  listeners: Map<string, Set<(event: unknown) => void>>;
  messages: unknown[];
  terminated: boolean;
  addEventListener: (name: string, listener: (event: unknown) => void) => void;
  removeEventListener: (name: string, listener: (event: unknown) => void) => void;
  postMessage: (message: unknown) => void;
  terminate: () => void;
};
const host = window as typeof window & {
  MonacoEnvironment?: { getWorkerUrl: (moduleId: string, label: string) => string };
  __ATOOLS_JSON_WORKER_CONTRACT__?: ContractClient;
};
let previousMonaco: typeof host.MonacoEnvironment;
let workers: FakeWorkerInstance[];

function installClient(mode: "silent" | "wrong-sequence" | "error"): void {
  class FakeWorker implements FakeWorkerInstance {
    listeners = new Map<string, Set<(event: unknown) => void>>();
    messages: unknown[] = [];
    terminated = false;
    constructor(url: string, options: WorkerOptions) {
      expect(url).toBe("atools-plugin://localhost/local-json/json.worker.js");
      expect(options.name).toBe("json-contract");
      workers.push(this);
    }
    addEventListener(name: string, listener: (event: unknown) => void) {
      const group = this.listeners.get(name) ?? new Set();
      group.add(listener);
      this.listeners.set(name, group);
    }
    removeEventListener(name: string, listener: (event: unknown) => void) {
      this.listeners.get(name)?.delete(listener);
    }
    postMessage(message: unknown) {
      this.messages.push(message);
      if (typeof message === "string" || mode === "silent") return;
      const rpc = message as { req: string };
      queueMicrotask(() => {
        const listeners = this.listeners.get(mode === "error" ? "error" : "message");
        if (mode === "error") listeners?.forEach(listener => listener({ isTrusted: true }));
        else listeners?.forEach(listener => listener({ isTrusted: true, data: {
          vsWorker: 1, type: 1, seq: String(Number(rpc.req) + 1), res: [], err: null,
        } }));
      });
    }
    terminate() { this.terminated = true; }
  }
  vi.stubGlobal("Worker", FakeWorker);
  host.MonacoEnvironment = { getWorkerUrl: () => "atools-plugin://localhost/local-json/json.worker.js" };
  window.eval(clientSource);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  previousMonaco = host.MonacoEnvironment;
  workers = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (previousMonaco) host.MonacoEnvironment = previousMonaco;
  else delete host.MonacoEnvironment;
  delete host.__ATOOLS_JSON_WORKER_CONTRACT__;
});

it("times out a silent transport with a bounded request and always terminates", async () => {
  installClient("silent");
  const pending = host.__ATOOLS_JSON_WORKER_CONTRACT__!.run();
  const worker = workers[0];
  await vi.advanceTimersByTimeAsync(701);
  const result = await pending;
  expect(result).toMatchObject({ completed: false, failureKind: "timeout" });
  expect(worker.messages).toHaveLength(2); // bootstrap string plus one RPC
  expect(worker.terminated).toBe(true);
  expect([...worker.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
});

it("does not accept a response whose sequence does not match its pending RPC", async () => {
  installClient("wrong-sequence");
  const pending = host.__ATOOLS_JSON_WORKER_CONTRACT__!.run();
  const worker = workers[0];
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(701);
  const result = await pending;
  expect(result).toMatchObject({ completed: false, failureKind: "timeout" });
  expect(worker.messages).toHaveLength(2);
  expect(worker.terminated).toBe(true);
  expect([...worker.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
});

it("records a native worker error without retaining listeners or claiming completion", async () => {
  installClient("error");
  const pending = host.__ATOOLS_JSON_WORKER_CONTRACT__!.run();
  const worker = workers[0];
  const result = await pending;
  expect(result).toMatchObject({ completed: false, failureKind: "worker-error" });
  expect(worker.terminated).toBe(true);
  expect([...worker.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
});
