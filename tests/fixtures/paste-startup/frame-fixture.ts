import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { JSDOM } from "jsdom";
import { managePasteStartupWorker, type PasteStartupEndpoints } from "./worker-lifecycle";
import { createPasteStartupDocument } from "./document-fixture";

function installSyncHttpBridge(window: Record<string, any>, origin: string) {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
parentPort.on("message", async ({ signal, port, method, url, headers, body }) => {
  try {
    const response = await fetch(url, { method, headers, body: body ?? undefined });
    port.postMessage({ status: response.status, responseText: await response.text() });
  } catch (error) {
    port.postMessage({ status: 0, responseText: "", error: String(error?.message ?? error) });
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
    port.close();
  }
});`,
    { eval: true },
  );
  worker.unref();
  const NativeXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class LoopbackSyncXMLHttpRequest {
    status = 0;
    responseText = "";
    timeout = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    #async = true;
    #method = "GET";
    #url = "";
    #headers: Record<string, string> = { Origin: origin };
    #aborted = false;
    #controller: AbortController | null = null;
    open(method: string, url: string, async = true) {
      this.#method = method;
      this.#url = new URL(url, origin).href;
      this.#async = async !== false;
    }
    setRequestHeader(name: string, value: string) {
      this.#headers[name] = value;
    }
    abort() {
      this.#aborted = true;
      this.#controller?.abort();
      this.onabort?.();
    }
    send(body?: string | null) {
      if (this.#async) {
        this.#controller = new AbortController();
        void globalThis.fetch(this.#url, {
          method: this.#method,
          headers: this.#headers,
          body: body ?? undefined,
          signal: this.#controller.signal,
        }).then(async response => {
          if (this.#aborted) return;
          this.status = response.status;
          this.responseText = await response.text();
          if (!this.#aborted) this.onload?.();
        }).catch(() => {
          if (!this.#aborted) this.onerror?.();
        });
        return;
      }
      const signal = new Int32Array(new SharedArrayBuffer(4));
      const { port1, port2 } = new MessageChannel();
      worker.postMessage({ signal, port: port2, method: this.#method, url: this.#url, headers: this.#headers, body: body ?? null }, [port2]);
      Atomics.wait(signal, 0, 0, 10_000);
      const message = receiveMessageOnPort(port1)?.message as { status: number; responseText: string; error?: string } | undefined;
      port1.close();
      if (!message || message.error) throw new Error(message?.error ?? "Sync XHR timed out");
      this.status = message.status;
      this.responseText = message.responseText;
    }
  };
  void NativeXHR;
  return () => { void worker.terminate(); };
}

const builtFiles = [
  ["plugin.json", "c56457879db7cfea1b9b39de1e62ea9953f737651cba16ab56c4cc5c2c964939"],
  ["package.json", "8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a"],
  ["index.html", "ff46c4132bcb07c5929af9c48b37e41eb22f63004ddf175915b17eafb0a7fd84"],
  ["preload.js", "cf394cb02fcf7879f1e3a2410ff5253791275d199c213d6d785055454a3722ba"],
  ["chunks/history-search-index-C5CG7yxr.cjs", "83593ecc7176e00c98f80f251785c28b9bdffe92929924a914581ff5af7927c3"],
  ["chunks/clipboard-tombstone-v2-28uC8Qy5.cjs", "d9d739344096da02dcdf31ee98ea9a1ed2c9ab53ae16891fcfdc1addc1116711"],
  ["chunks/index-Cy80EH4d.cjs", "4df269f98e289aba0c308095ac2d478779d50aca8324adb0dd8196914ed88fe4"],
  ["content-scan-worker.cjs", "09228265c43277d62f89f233189e4cae5f8f4509529ed2478ab524e21303781f"],
  ["history-worker.cjs", "2cf8151743b2e799d6e94f24d59ff719b4516961bf5eb0bb62be7e80e98059ef"],
  ["paste-stack-key-monitor.py", "17b3cb5bbad34ef2de9ed27784277bb4b3e480600fda837ebc5f7e62149d3012"],
] as const;

export async function createReadOnlyBuiltPackage(pluginsRoot: string, scratchRoot: string) {
  const sourceRoot = resolve(pluginsRoot, "pasteboard-pro", "dist", "ztools");
  const pluginRoot = join(scratchRoot, "plugin");
  const sourceDigests = new Map<string, string>();
  const builtHashes: Record<string, string> = {};
  for (const [relative, expectedHash] of builtFiles) {
    const source = join(sourceRoot, relative);
    const bytes = await readFile(source);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedHash) throw new Error(`Original Paste build hash changed: ${relative} (${digest})`);
    const destination = join(pluginRoot, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o400 });
    sourceDigests.set(source, digest);
    builtHashes[relative] = digest;
  }
  const manifest = JSON.parse(await readFile(join(pluginRoot, "plugin.json"), "utf8"));
  if (manifest.author !== "harris" || manifest.version !== "1.4.0" || manifest.preload !== "preload.js"
    || manifest.pluginSetting?.backgroundRunning !== true) {
    throw new Error("Pinned Paste build manifest does not match Harris Paste 1.4.0 background startup");
  }
  // The CJS package root and every artifact are immutable to the test child.
  for (const relative of [...builtFiles].map(([path]) => path).sort((a, b) => b.length - a.length)) {
    await chmod(join(pluginRoot, relative), 0o400);
  }
  for (const directory of ["chunks", "", "."]) await chmod(join(pluginRoot, directory), 0o500);
  return { pluginRoot, preloadPath: join(pluginRoot, "preload.js"), indexHtml: await readFile(join(pluginRoot, "index.html"), "utf8"), builtHashes, sourceDigests };
}

export async function createPasteStartupWorker(options: {
  root: string;
  scratchRoot: string;
  pluginRoot: string;
  preloadPath: string;
  pluginDataRoot: string;
  fixtureEnv: Record<string, string>;
  scenario?: "text" | "files";
  filePaths?: string[];
}) {
  const worker = new Worker(new URL("./node-worker.mjs", import.meta.url), {
    workerData: {
      root: options.root,
      scratchRoot: options.scratchRoot,
      pluginRoot: options.pluginRoot,
      preloadPath: options.preloadPath,
      pluginDataRoot: options.pluginDataRoot,
      scenario: options.scenario ?? "text",
      filePaths: options.filePaths ?? [],
      fixtureEnv: options.fixtureEnv,
      nodeBinary: join(options.root, "src-tauri/binaries/node-aarch64-apple-darwin"),
      codecPath: join(options.root, "crates/atools-plugin/src/legacy_node/codec.cjs"),
      bootstrapPath: join(options.root, "crates/atools-plugin/src/legacy_node/bootstrap.cjs"),
      monitorPath: join(options.pluginRoot, "paste-stack-key-monitor.py"),
    },
  });
  return await managePasteStartupWorker(worker);
}

export function createPasteStartupFrame(options: {
  pluginRoot: string;
  indexHtml: string;
  preloadScript: string;
  endpoints: PasteStartupEndpoints;
  pluginDataPath: string;
  nativeCalls: Array<Record<string, unknown>>;
  ipcCalls: Array<Record<string, unknown>>;
}) {
  const instanceId = randomUUID();
  const secretStorageInstanceId = randomUUID();
  const { html: injectedHtml } = createPasteStartupDocument({
    ...options, instanceId, secretStorageInstanceId,
  });
  const dom = new JSDOM(injectedHtml, { runScripts: "outside-only", url: "https://pasteboard-pro.fixture.invalid/" });
  const window = dom.window as JSDOM["window"] & Record<string, any>;
  Object.assign(window, { TextEncoder, TextDecoder, Buffer, structuredClone: globalThis.structuredClone.bind(globalThis) });
  const disposeSyncHttp = installSyncHttpBridge(window, "https://pasteboard-pro.fixture.invalid");
  let blockedFetches = 0;
  const nodeEndpoint = new URL(options.endpoints.node).href;
  window.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).href;
    if (target !== nodeEndpoint || init?.method !== "POST") {
      blockedFetches++;
      return Promise.reject(Object.assign(new Error("ERR_ATOOLS_TEST_FETCH_BLOCKED"), { code: "ERR_ATOOLS_TEST_FETCH_BLOCKED" }));
    }
    return globalThis.fetch(target, init);
  };
  const consoleErrors: string[] = [];
  const originalConsoleError = window.console.error.bind(window.console);
  window.console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(value => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(" "));
    originalConsoleError(...args);
  };
  let featureEntries = 0;
  window.addEventListener("atools-plugin-enter", () => { featureEntries++; });
  const businessErrors: string[] = [];
  const pasteStackEvents: unknown[] = [];
  window.addEventListener("pasteboard-pro:sync-error", (event: Event) => {
    businessErrors.push(String((event as CustomEvent).detail));
  });
  window.addEventListener("pasteboard-pro:paste-stack-changed", (event: Event) => {
    pasteStackEvents.push((event as CustomEvent).detail);
  });
  window.addEventListener("pasteboard-pro:history-mirrored", (event: Event) => {
    pasteStackEvents.push({ historyMirrored: (event as CustomEvent).detail });
  });
  const nativeNames = new Set(["simulateKeyboardTap"]);
  const messageListener = (event: MessageEvent) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.__ipc_call__ === true) {
      options.ipcCalls.push(message);
      window.postMessage({ __ipc_response__: true, reqId: message.reqId, error: "ERR_ATOOLS_TEST_UNEXPECTED_IPC" }, "*");
    }
    if (message.__atools_native_call__ === true) {
      options.nativeCalls.push(message);
      const allowed = typeof message.method === "string" && nativeNames.has(message.method);
      window.postMessage({ __atools_native_response__: true, reqId: message.reqId,
        ...(allowed ? { result: null } : { error: "ERR_ATOOLS_TEST_NATIVE_OPERATION_DENIED" }) }, "*");
    }
  };
  window.addEventListener("message", messageListener);
  const parsed = new window.DOMParser().parseFromString(injectedHtml, "text/html");
  const executed: string[] = [];
  for (const script of Array.from(parsed.querySelectorAll("script:not([src])"))) {
    if (script.type === "module") continue;
    const body = script.textContent ?? "";
    if (!body.trim()) continue;
    window.eval(body);
    executed.push(script.hasAttribute("data-atools-plugin-data") ? "plugin-data"
      : script.hasAttribute("data-atools-node-modules") ? "node-modules"
        : script.hasAttribute("data-atools-plugin-preload") ? "original-preload"
          : script.hasAttribute("data-atools-electron-adapter") ? "electron-adapter" : "host-bridge");
  }
  return {
    dom, window, executed, instanceId, consoleErrors, businessErrors, pasteStackEvents,
    get blockedFetches() { return blockedFetches; },
    get featureEntries() { return featureEntries; },
    dispose() {
      window.dispatchEvent(new window.Event("beforeunload"));
      window.dispatchEvent(new window.Event("pagehide"));
      window.dispatchEvent(new window.Event("atools-plugin-out"));
      window.removeEventListener("message", messageListener);
      dom.window.close();
      disposeSyncHttp();
    },
  };
}

export async function sourceDigestsUnchanged(sourceDigests: Map<string, string>) {
  for (const [source, expected] of sourceDigests) {
    const actual = createHash("sha256").update(await readFile(source)).digest("hex");
    if (actual !== expected) throw new Error(`Published Paste source changed during fixture: ${source}`);
  }
}

export function inside(root: string, candidate: string) {
  const actual = resolve(candidate);
  return actual === root || actual.startsWith(`${root}${sep}`);
}
