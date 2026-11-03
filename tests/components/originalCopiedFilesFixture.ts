import vm from "node:vm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSourceFile, forEachChild, isFunctionDeclaration, ScriptTarget } from "typescript";
import { hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";
import { createPluginHostedIpcBridge } from "../../src/lib/pluginHostedIpcBridge";
import { createPluginSubInputBridge } from "../../src/lib/pluginSubInputBridge";
import { createPluginLifecycleBridge } from "../../src/lib/pluginLifecycleBridge";
import { createPluginFeatureExportsBridge } from "../../src/lib/pluginFeatureExportsBridge";
import { createPluginBrowserWorkerBridge } from "../../src/lib/pluginBrowserWorkerBridge";
import { createPluginBrowserWindowBridge } from "../../src/lib/pluginBrowserWindowBridge";
import { createPluginBrowserWindowGeometry } from "../../src/lib/pluginBrowserWindowGeometry";
import { browserBufferFactoryScript } from "../../src/lib/browserBuffer";

const pinnedOriginals = {
  imgbatch: ["ZTools-plugins/plugins/imgbatch/preload.js", "d8ca3f4614c5ad336a1a6b7e667bf11fbb2499189a6ab546b71b740504123867", [
    "sanitizeText", "safeInvoke", "uniqueStrings", "getHostApi", "normalizeCopiedFilePaths",
    "buildLaunchPathSignature", "readCopiedFilesSnapshot", "extractLaunchItems",
  ]],
  quickcommand: ["ZTools-plugins/plugins/quickcommand/plugin/lib/quickcomposer/status/getSelected.js", "506a0e7a427e2257d73eb0cec6f64ea013a1b152c80e1c6834f4c651468fd3fd", ["files"]],
  imageStitch: ["ZTools-plugins/plugins/image-stitch/app.js", "37105dde6dad683d2c4b211ccf51392f5f148c6c8bb02e20c3a264464133384c", ["pasteFromClipboard"]],
} as const;

export type CopiedEntry = { name: string; path: string; isFile: boolean; isDirectory: boolean; isDiractory?: boolean };
export type GeneratedXhrCall = { method: string; endpoint: string; async: boolean; payload: Record<string, unknown> };

async function extractPinnedFunctions(key: keyof typeof pinnedOriginals) {
  const [sourcePath, sha256, wanted] = pinnedOriginals[key];
  const source = await readFile(sourcePath, "utf8");
  const actual = createHash("sha256").update(source).digest("hex");
  if (actual !== sha256) throw new Error(`Pinned original source changed: ${sourcePath}`);
  const ast = createSourceFile(sourcePath, source, ScriptTarget.Latest, true);
  const found = new Map<string, string>();
  function visit(node: any) {
    if (isFunctionDeclaration(node) && wanted.includes(node.name?.text as never)) found.set(node.name!.text, node.getText(ast));
    forEachChild(node, visit);
  }
  visit(ast);
  const missing = wanted.filter(name => !found.has(name));
  if (missing.length) throw new Error(`Pinned original functions missing in ${sourcePath}: ${missing.join(", ")}`);
  return { sourcePath, sha256, functions: wanted.map(name => found.get(name)!).join("\n") };
}

/** Runs the exact serialized UTools template and final clipboard script in a generated, offline-only VM. */
export async function originalCopiedFilesHost(options: { endpoints?: boolean; responses?: CopiedEntry[][] } = {}) {
  const panel = await readFile("src/components/PluginPanel.svelte", "utf8");
  const template = panel.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/)?.[1];
  if (!template) throw new Error("Production UTools template is missing");
  let source = template;
  for (const [key, value] of Object.entries({
    __ATOOLS_HOSTED_IPC_FACTORY__: createPluginHostedIpcBridge.toString(),
    __ATOOLS_SUBINPUT_FACTORY__: createPluginSubInputBridge.toString(),
    __ATOOLS_LIFECYCLE_FACTORY__: createPluginLifecycleBridge.toString(),
    __ATOOLS_FEATURE_EXPORTS_FACTORY__: createPluginFeatureExportsBridge.toString(),
    __ATOOLS_BROWSER_WORKER_BRIDGE_FACTORY__: createPluginBrowserWorkerBridge.toString(),
    __ATOOLS_BROWSER_WINDOW_BRIDGE_FACTORY__: createPluginBrowserWindowBridge.toString(),
    __ATOOLS_BROWSER_WINDOW_GEOMETRY_FACTORY__: createPluginBrowserWindowGeometry.toString(),
    __ATOOLS_BUFFER_FACTORY__: browserBufferFactoryScript(),
    __ATOOLS_WEB_CONTENTS_ID__: "1", __ATOOLS_SUBINPUT_EPOCH__: "0",
    __ATOOLS_WORKER_SCOPE__: '"00000000-0000-4000-8000-000000000001"', __ACTION_ENTRY_TYPE__: '"text"',
    __ATOOLS_MAIN_PUSH_CONFIG__: "null",
    __PLUGIN_ID__: '"original-copied-files-fixture"', __FEATURE_CODE__: '"copied-files"', __ACTION_PAYLOAD__: "null",
    __PLUGIN_PATH__: '"/fixture"', __APP_NAME__: '"ATools"', __APP_VERSION__: '"3.0.0"',
    __ATOOLS_MAIN_PUSH_FACTORY__: "undefined", __ATOOLS_MAIN_PUSH_BUDGET_FACTORY__: "undefined",
    __ATOOLS_MAIN_PUSH_PRESENTATION_FACTORY__: "undefined",
  })) source = source.replaceAll(key, value);
  source = source.replace(/<\\\/script>/g, "</script>").replace(/^\s*<script>\s*/, "").replace(/\s*<\/script>\s*$/, "");

  const calls: GeneratedXhrCall[] = [], posts: any[] = [], listeners = new Map<string, Function[]>();
  const parent = { postMessage: (message: unknown) => posts.push(message) };
  const window: any = {
    parent, top: {}, console: { error() {} }, matchMedia: () => ({ matches: false }),
    addEventListener(name: string, fn: Function) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
    removeEventListener(name: string, fn: Function) { listeners.set(name, (listeners.get(name) ?? []).filter(old => old !== fn)); },
    dispatchEvent(event: { type: string }) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event); },
  };
  const queue = [...(options.responses ?? [])];
  class FakeXhr {
    status = 200; responseText = ""; method = ""; endpoint = ""; async = true; payload: Record<string, unknown> = {};
    open(method: string, endpoint: string, async = true) { this.method = method; this.endpoint = endpoint; this.async = async; }
    setRequestHeader() {}
    send(body: string) {
      this.payload = JSON.parse(body);
      calls.push({ method: this.method, endpoint: this.endpoint, async: this.async, payload: this.payload });
      const result = this.payload.format === "files" ? (queue.shift() ?? []) : "fixture text";
      this.responseText = JSON.stringify({ ok: true, result });
    }
  }
  class EventStub { constructor(public type: string) {} }
  class CustomEventStub extends EventStub { detail: unknown; constructor(type: string, options: { detail?: unknown } = {}) { super(type); this.detail = options.detail; } }
  window.addEventListener = window.addEventListener.bind(window);
  vm.runInNewContext(source, {
    window, parent, document: { readyState: "complete", addEventListener() {} }, navigator: { platform: "Win32", userAgent: "offline-fixture" },
    console: window.console, Event: EventStub, CustomEvent: CustomEventStub, TextEncoder, Promise, Math, Date, Number,
    queueMicrotask, setTimeout: () => 0, clearTimeout() {}, XMLHttpRequest: FakeXhr,
    addEventListener: (name: string, fn: Function) => window.addEventListener(name, fn),
  });
  const endpoint = "http://127.0.0.1:12345/host/" + "a".repeat(64);
  const clipboard = hostClipboardBridgeScript({ instanceId: "original-copied-files-instance", ...(options.endpoints === false ? {} : { endpoints: { read: endpoint } }) })
    .replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  vm.runInNewContext(clipboard, { window, parent, addEventListener: window.addEventListener, XMLHttpRequest: FakeXhr,
    TextEncoder, JSON, Object, Error, TypeError, Set, RegExp, String });
  const api = window.utools;
  if (!api || window.ztools !== api) throw new Error("Serialized UTools facade was not installed");
  function deliver(data: unknown) { for (const fn of [...(listeners.get("message") ?? [])]) fn({ source: parent, data }); }
  return { api, calls, posts, endpoint, deliver, listeners, sourcePath: "src/components/PluginPanel.svelte" };
}

export async function originalImgbatchSnapshot(api: unknown) {
  const original = await extractPinnedFunctions("imgbatch");
  const manifestPath = "ZTools-plugins/plugins/imgbatch/plugin.json";
  const manifest = await readFile(manifestPath, "utf8");
  const declaredPlatforms = JSON.parse(manifest).platform;
  if (!Array.isArray(declaredPlatforms) || declaredPlatforms.join(",") !== "win32") throw new Error("Imgbatch platform declaration changed");
  const result = vm.runInNewContext(`${original.functions}\nreadCopiedFilesSnapshot()`, { ztools: api, path: path.win32 });
  return { ...result, pin: { path: original.sourcePath, sha256: original.sha256 }, manifest: {
    path: manifestPath, sha256: createHash("sha256").update(manifest).digest("hex"), declaredPlatforms,
  } };
}

export async function originalQuickCommandFiles(api: any) {
  const original = await extractPinnedFunctions("quickcommand");
  const observed = { hideCalls: 0, simulated: [] as unknown[], restored: [] as unknown[], timers: [] as Function[] };
  const quietApi = {
    getCopyedFiles: () => api.getCopyedFiles(),
    hideMainWindow: () => { observed.hideCalls += 1; },
    simulateKeyboardTap: (...args: unknown[]) => { observed.simulated.push(args); },
    copyFile: (files: unknown) => { observed.restored.push(files); },
  };
  const invoke = vm.runInNewContext(`${original.functions}\nfiles()`, {
    window: { utools: quietApi }, utools: quietApi, process: { platform: "win32" },
    setTimeout: (fn: Function) => { observed.timers.push(fn); return 1; }, Promise,
  });
  return { result: invoke as Promise<unknown[]>, observed, pin: { path: original.sourcePath, sha256: original.sha256 } };
}

export async function originalImageStitch(api: any) {
  const original = await extractPinnedFunctions("imageStitch");
  const observed = { fallbackReads: 0, added: [] as unknown[] };
  const navigator = { clipboard: { read: () => { observed.fallbackReads += 1; return Promise.resolve([]); } } };
  vm.runInNewContext(`${original.functions}\npasteFromClipboard()`, {
    ztools: api, navigator, addImageFromPath: (value: unknown) => observed.added.push(value), Promise, RegExp,
  });
  await Promise.resolve();
  return { ...observed, pin: { path: original.sourcePath, sha256: original.sha256 } };
}

export const copiedFilePath = "C:\\Users\\QA User\\图片\n拼接 🧰.png";
