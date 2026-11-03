import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { nodeModuleBridgeScript } from "../../../src/lib/nodeModuleBridge";

export type PollingTransport = "requestSync" | "requestAsync";

export type RecordedNodeRequest = {
  phase: "open" | "closed";
  transport: PollingTransport;
  method: string;
  promisePollRound?: number;
  promiseHandleCount?: number;
  requestJsonBytes: number;
  responseJsonBytes: number;
};

export type NodeDispatch = (method: string, params: Record<string, unknown>) => unknown;

const legacyNodeSources = [
  "codec.cjs",
  "bounded_png_path.cjs",
  "bounded_native_image_path.cjs",
  "bootstrap.cjs",
] as const;

/** Executes the production legacy Node dispatcher in this Node process. */
export function createProductionLegacyNodeDispatch(pluginEntry: string): {
  dispatch: NodeDispatch;
  sourceFiles: string[];
} {
  const nodeRequire = createRequire(pluginEntry);
  const legacyNodeDir = resolve("crates/atools-plugin/src/legacy_node");
  const sourceFiles = legacyNodeSources.map((name) => join(legacyNodeDir, name));
  const source = sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n");
  const processStub = {
    env: { ...process.env, ATOOLS_PRELOAD_ENTRY: pluginEntry },
    pid: process.pid,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    stdin: {},
    stdout: { write(_value: string) { return true; } },
    stderr: { write(_value: string) { return true; } },
    exit(code?: number) { throw new Error(`Unexpected legacy Node protocol exit: ${code}`); },
  };
  const localRequire = (specifier: string) => {
    if (specifier === "node:readline") return { createInterface: () => ({ on() { return this; } }) };
    return nodeRequire(specifier);
  };
  const dispatch = new Function(
    "require",
    "process",
    "console",
    `${source}\n;return dispatch;`,
  )(localRequire, processStub, {}) as NodeDispatch;
  return { dispatch, sourceFiles };
}

/**
 * Runs production preload and bridge code against a local HTTP contract adapter.
 * Native text calls fall through, so Node fs methods reach the real temp files.
 */
export function createProductionPreloadFrame(
  html: string,
  dispatch: NodeDispatch,
  pluginEntry: string,
): {
  sandbox: Record<string, any>;
  requests: RecordedNodeRequest[];
  close(): void;
  isClosed(): boolean;
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const requests: RecordedNodeRequest[] = [];
  let closed = false;
  let nextPollPromiseRound = 0;
  let activePollPromiseRound: number | undefined;

  function response(transport: PollingTransport, requestBody: string, promisePollRound?: number): string {
    const request = JSON.parse(requestBody) as { method: string; params: Record<string, unknown> };
    let body: string;
    try {
      let result: unknown;
      if (request.method === "readTextPath" || request.method === "writeTextPath") {
        result = { handled: false };
      } else {
        result = JSON.parse(JSON.stringify(dispatch(request.method, request.params)));
      }
      body = JSON.stringify({ ok: true, result });
    } catch (error) {
      const caught = error as Error & { code?: string };
      body = JSON.stringify({ ok: false, error: { message: caught.message, code: caught.code } });
    }
    requests.push({
      phase: closed ? "closed" : "open",
      transport,
      method: request.method,
      ...(["pollPromise", "pollPromises"].includes(request.method) && promisePollRound !== undefined
        ? { promisePollRound }
        : {}),
      ...(request.method === "pollPromise" ? { promiseHandleCount: 1 }
        : request.method === "pollPromises" && Array.isArray(request.params.handleIds)
          ? { promiseHandleCount: request.params.handleIds.length }
          : {}),
      requestJsonBytes: Buffer.byteLength(requestBody),
      responseJsonBytes: Buffer.byteLength(body),
    });
    return body;
  }

  class LocalXmlHttpRequest {
    status = 0;
    responseText = "";
    open() {}
    setRequestHeader() {}
    send(body: string) {
      this.status = 200;
      this.responseText = response("requestSync", body);
    }
  }

  const sandbox: Record<string, any> = {
    XMLHttpRequest: LocalXmlHttpRequest,
    fetch: async (_url: string, options: { body: string }) => {
      const request = JSON.parse(options.body) as { method: string };
      let promisePollRound: number | undefined;
      if (["pollPromise", "pollPromises"].includes(request.method)) {
        if (activePollPromiseRound === undefined) {
          activePollPromiseRound = ++nextPollPromiseRound;
          const round = activePollPromiseRound;
          queueMicrotask(() => {
            if (activePollPromiseRound === round) activePollPromiseRound = undefined;
          });
        }
        promisePollRound = activePollPromiseRound;
      }
      await new Promise((done) => setTimeout(done, 0));
      const text = response("requestAsync", options.body, promisePollRound);
      return { ok: true, status: 200, json: async () => JSON.parse(text) };
    },
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    AbortController,
    WeakRef,
    FinalizationRegistry,
    console: {},
    addEventListener(type: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (...args: unknown[]) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`window.__atoolsNodeModuleRequire = ${nodeModuleBridgeScript({
    endpoint: `http://127.0.0.1:43121/node/${"a".repeat(64)}`,
  })};
window.require = window.__atoolsNodeModuleRequire;
window.process = window.require('process');
window.Buffer = window.require('buffer').Buffer;`, sandbox, { timeout: 5000 });
  const script = html.replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  vm.runInContext(script, sandbox, { timeout: 5000 });

  return {
    sandbox,
    requests,
    isClosed: () => closed,
    close() {
      if (closed) return;
      closed = true;
      for (const type of ["pagehide", "atools-plugin-out"]) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener();
      }
    },
  };
}
