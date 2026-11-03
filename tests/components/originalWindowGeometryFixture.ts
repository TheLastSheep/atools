import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createSourceFile, forEachChild, isCallExpression, isFunctionDeclaration, isStringLiteral, ScriptTarget } from "typescript";
import { createPluginHostedIpcBridge } from "../../src/lib/pluginHostedIpcBridge";
import { createPluginSubInputBridge } from "../../src/lib/pluginSubInputBridge";
import { createPluginLifecycleBridge } from "../../src/lib/pluginLifecycleBridge";
import { createPluginFeatureExportsBridge } from "../../src/lib/pluginFeatureExportsBridge";
import { createPluginBrowserWorkerBridge } from "../../src/lib/pluginBrowserWorkerBridge";
import { createPluginBrowserWindowBridge } from "../../src/lib/pluginBrowserWindowBridge";
import { createPluginBrowserWindowGeometry } from "../../src/lib/pluginBrowserWindowGeometry";
import { browserBufferFactoryScript } from "../../src/lib/browserBuffer";
import { createPluginBrowserWindowGeometryHost } from "../../src/lib/pluginBrowserWindowGeometryHost";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";

const pins = {
  typing: ["ZTools-plugins/plugins/english-typing-practice/preload.js", "c4f56a73f902f2840ea496805951110b1ea47a3dee987125a7588783db98ea41"],
  paintbrush: ["ZTools-plugins/plugins/clipboard-image-paintbrush/preload.js", "64799173ad66b029c4341fc8b97eec8f583f8e390b184c71e96b4833164e7be3"],
} as const;

/** Execute exact original functions only; no clipboard, file, image or whole-plugin workflow is run. */
export async function originalGeometryFunctions() {
  const extracted: Record<string, string> = {};
  for (const [kind, [path, pin]] of Object.entries(pins)) {
    const source = await readFile(path, "utf8");
    if (createHash("sha256").update(source).digest("hex") !== pin) throw Error(`Original source changed: ${path}`);
    const ast = createSourceFile(path, source, ScriptTarget.ESNext, true);
    if (kind === "typing") {
      const declarations = ast.statements.filter(node => isFunctionDeclaration(node)
        && ["getWinInfo", "hasWinInstance"].includes(node.name?.text ?? ""));
      if (declarations.length !== 2) throw Error("Original typing declarations missing");
      extracted.typing = declarations.map(node => node.getText(ast)).join("\n");
    } else {
      function visit(node: any) {
        if (isCallExpression(node) && node.expression.getText(ast) === "ipcRenderer.on"
          && isStringLiteral(node.arguments[0]) && ["floater:move", "floater:resize"].includes(node.arguments[0].text)) {
          extracted[node.arguments[0].text] = node.arguments[1].getText(ast);
        }
        forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  if (!extracted["floater:move"] || !extracted["floater:resize"]) throw Error("Original paintbrush handlers missing");
  return {
    typing: (handle: unknown) => vm.runInNewContext(`${extracted.typing}\ngetWinInfo(winRef)`, { winRef: handle, console: { log() {} } }),
    paintbrush: (channel: "floater:move" | "floater:resize", handle: unknown, data: unknown) =>
      vm.runInNewContext(`(${extracted[channel]})(null, data)`, { win: handle, data, Math }),
    pins,
  };
}

/** Real serialized UTools resolved handle/facade; only the host transport and its geometry are generated. */
export async function originalGeometryWindow() {
  let source = createPluginBridgeDocument({
    action: {
      plugin_id: "original-geometry-fixture",
      feature_code: "geometry",
      payload: null,
      plugin_path: "/fixture",
      plugin_permissions: ["browserWindow"],
      plugin_providers: {},
    },
    appName: "ATools",
    appVersion: "3.0.0",
    webContentsId: 1,
    subInputEpoch: 0,
    workerScope: "geometry-fixture-scope",
    windowType: "main",
    browserWindowId: "",
    geometrySnapshot: null,
    mainPushConfig: null,
  });
  source = source.replace(/<script[^>]*>/gi, "").replace(/<\/script>/gi, "");
  const listeners = new Map<string, Function[]>(), calls: any[] = [], errors: unknown[] = [];
  const parent = { postMessage: (message: unknown) => calls.push(message) };
  const window: any = {
    parent, top: {}, location: { href: "http://localhost/fixture", hash: "" }, console: { error: (...args: unknown[]) => errors.push(args) },
    addEventListener(name: string, fn: Function) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
    removeEventListener(name: string, fn: Function) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
    dispatchEvent(event: { type: string }) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event); },
    matchMedia: () => ({ matches: false }),
  };
  function deliver(data: unknown) { for (const fn of [...(listeners.get("message") ?? [])]) fn({ source: parent, data }); }
  function respond(call: any, result: unknown, error?: string) { deliver({ __atools_native_response__: true, reqId: call.reqId, result, error }); }
  class EventStub { constructor(public type: string) {} }
  class CustomEventStub extends EventStub { detail: unknown; constructor(type: string, options: { detail?: unknown } = {}) { super(type); this.detail = options.detail; } }
  vm.runInNewContext(source, { window, document: { readyState: "complete", addEventListener() {} },
    navigator: { platform: "MacIntel", userAgent: "fixture" }, console: window.console, Event: EventStub, CustomEvent: CustomEventStub,
    Date, Math, Number, Promise, TextEncoder, setTimeout: () => 0, clearTimeout() {}, queueMicrotask });
  const handle = window.utools.createBrowserWindow("original-geometry.html", {}, () => {});
  await Promise.resolve();
  const create = calls.find(call => call.method === "createBrowserWindow");
  if (!create) throw Error("Production create request missing");
  const owner = {}, identity = { kind: "main" as const, generation: 1 };
  const creator = { source: owner, identity };
  const host = createPluginBrowserWindowGeometryHost({
    creatorFor: () => creator, sourceFor: () => undefined, nonce: () => "original-geometry-instance",
    sources: { isCurrent: (source, current) => source === owner && current === identity, currentIdentityForHost: () => null },
    post: (source, message) => { if (source !== owner) throw Error("Unexpected geometry recipient"); deliver(message); return true; },
  });
  const state = { id: "original-geometry", clientCreateId: create.args.clientCreateId, documentGeneration: 1,
    x: -40, y: 20, width: 640, height: 360, minimumWidth: 100, minimumHeight: 80, maximumWidth: 1000, maximumHeight: 800 };
  respond(create, { id: state.id, clientCreateId: state.clientCreateId, url: "original-geometry.html", geometrySnapshot: host.snapshot(state) });
  await settle();
  deliver({ __atools_browser_window_ready__: true, windowId: state.id, clientCreateId: state.clientCreateId });
  await handle.ready;
  return { handle, state, host, calls, errors, respond, deliver, dispose() {
    window.dispatchEvent({ type: "unload" }); host.clear(); listeners.clear();
  } };
}

export async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
