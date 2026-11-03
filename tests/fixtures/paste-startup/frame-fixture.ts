import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { JSDOM } from "jsdom";
import { managePasteStartupWorker, type PasteStartupEndpoints } from "./worker-lifecycle";
import { createPasteStartupDocument } from "./document-fixture";

const builtFiles = [
  ["plugin.json", "58e89b2e6b9d3c95711fe5f41852b24e2de32e0c2575c4866eb9fc1cc9e62ae8"],
  ["package.json", "8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a"],
  ["index.html", "ade347e2d942ed126fbb623f6604d81b0e4e90cf20ecb70d45cfafe59ec5b684"],
  ["preload.js", "6566635ba6f1143379ec980e42248cd666b2fa8d871a621f65e76c04ab1c98d3"],
  ["chunks/history-search-index-Bm2oYZYG.cjs", "c5fb4fc0ec568f13dd4b411f13a6d91ead4eeac0bd3a1be904ec15daef9d84d7"],
  ["history-worker.cjs", "4dfd870808aecaaaecc4f0f7996ae2c27d9a0edf2a1c193fb817d36deff518cf"],
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
  if (manifest.author !== "harris" || manifest.version !== "1.3.1" || manifest.preload !== "preload.js"
    || manifest.pluginSetting?.backgroundRunning !== true) {
    throw new Error("Pinned Paste build manifest does not match Harris Paste 1.3.1 background startup");
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
