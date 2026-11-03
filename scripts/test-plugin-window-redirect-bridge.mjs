import { assertPluginRedirectHostPath } from "./lib/plugin-redirect-fixture.mjs";
import { loadProductionPluginBridgeTemplate, readLauncherOwnerSource, readPanelHostSource } from "./lib/plugin-panel-source-test-adapter.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-window-redirect-"));

try {
  const helperSourcePath = new URL("src/lib/pluginRedirect.ts", root).pathname;
  const helperSource = await readLauncherOwnerSource(root, "src/lib/pluginRedirect.ts");
  const helperTransformed = await transformWithEsbuild(helperSource, helperSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  const helperOutFile = join(outDir, "pluginRedirect.mjs");
  await writeFile(helperOutFile, helperTransformed.code);
  const helper = await import(pathToFileURL(helperOutFile).href);

  assert.equal(typeof helper.normalizePluginRedirectLabel, "function");
  assert.equal(typeof helper.selectPluginRedirectResult, "function");

  assert.deepEqual(helper.normalizePluginRedirectLabel("翻译"), {
    query: "翻译",
    pluginName: "",
  });
  assert.deepEqual(helper.normalizePluginRedirectLabel(["聚合翻译", "翻译"]), {
    query: "翻译",
    pluginName: "聚合翻译",
  });
  assert.equal(helper.normalizePluginRedirectLabel(["聚合翻译", ""]), null);
  assert.equal(helper.normalizePluginRedirectLabel(""), null);

  const results = [
    {
      code: "translate",
      plugin_id: "plugin_translate",
      plugin_name: "聚合翻译",
      label: "翻译",
      icon: null,
      explain: "Translate text",
      score: 98,
      match_type: "label",
    },
    {
      code: "dictionary",
      plugin_id: "plugin_dictionary",
      plugin_name: "词典",
      label: "翻译",
      icon: null,
      explain: "Dictionary",
      score: 92,
      match_type: "label",
    },
  ];

  assert.deepEqual(helper.selectPluginRedirectResult({ query: "翻译", pluginName: "聚合翻译" }, results), {
    status: "ready",
    result: results[0],
    candidates: [results[0]],
  });
  assert.equal(
    helper.selectPluginRedirectResult({ query: "翻译", pluginName: "" }, results).status,
    "ambiguous",
  );
  assert.equal(
    helper.selectPluginRedirectResult({ query: "OCR", pluginName: "" }, results).status,
    "not_found",
  );

  const contracts = await readPanelHostSource(root, "src/lib/pluginPanelContracts.ts");
  const nativeBridgeRouter = await readPanelHostSource(root, "src/lib/pluginPanelNativeBridgeRouter.ts");
  const bridgeTemplate = await loadProductionPluginBridgeTemplate(root);
  const controllerSource = await readLauncherOwnerSource(root, "src/lib/launcherPluginWindowController.ts");
  const sessionSource = await readLauncherOwnerSource(root, "src/lib/launcherPluginSessionController.ts");
  const appSource = await readFile(new URL("src/App.svelte", root), "utf8");
  const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");

  const bridgeSource = bridgeTemplate
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
    .replace(/<\\\/script>/g, "</script>")
    .replace(/^\s*<script>\s*/, "")
    .replace(/\s*<\/script>\s*$/, "")
    .replace(/__PLUGIN_ID__/g, JSON.stringify("window-redirect-test-plugin"))
    .replace(/__FEATURE_CODE__/g, JSON.stringify("window-redirect-test-feature"))
    .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
    .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

  const listeners = new Map();
  const postedMessages = [];
  const windowStub = {
    parent: {
      postMessage(message) {
        postedMessages.push(message);
      },
    },
    top: {},
    addEventListener(type, cb) {
      const list = listeners.get(type) || [];
      list.push(cb);
      listeners.set(type, list);
    },
    dispatchEvent(event) {
      const list = listeners.get(event.type) || [];
      list.forEach((cb) => cb(event));
    },
    matchMedia() {
      return { matches: false };
    },
  };

  const documentStub = {
    readyState: "complete",
    addEventListener(type, cb) {
      const list = listeners.get(`document:${type}`) || [];
      list.push(cb);
      listeners.set(`document:${type}`, list);
    },
  };

  const context = vm.createContext({
    window: windowStub,
    document: documentStub,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" },
    Event,
    CustomEvent,
    console: {
      error() {},
      warn() {},
      log() {},
    },
    Date,
    Math,
    Number,
    Promise,
    setTimeout(cb) {
      cb();
      return 1;
    },
    clearTimeout() {},
  });

  vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.vm.js" });

  function respondToNativeCall(call, payload) {
    const handlers = listeners.get("message") || [];
    handlers.forEach((handler) => handler({
      data: {
        __atools_native_response__: true,
        reqId: call.reqId,
        ...payload,
      },
    }));
  }

  assert.equal(typeof windowStub.utools.redirect, "function", "utools.redirect should be exposed");
  const redirectPromise = windowStub.utools.redirect(["聚合翻译", "翻译"], "hello");
  const redirectCall = postedMessages.find((message) => message.method === "redirect");
  assert.ok(redirectCall, "redirect should route through the native bridge");
  assert.deepEqual(JSON.parse(JSON.stringify(redirectCall.args)), {
    label: ["聚合翻译", "翻译"],
    payload: "hello",
  });
  respondToNativeCall(redirectCall, { result: true });
  assert.equal(await redirectPromise, true, "redirect should resolve the host activation result");

  const failedPromise = windowStub.utools.redirect("missing-command");
  const failedCall = postedMessages.findLast((message) => message.method === "redirect");
  respondToNativeCall(failedCall, {
    error: "redirect failed: no plugin feature found for missing-command",
  });
  await assert.rejects(failedPromise, /redirect failed/);

  assert.match(contracts, /onredirect\?:/, "PluginPanel should accept a redirect host callback");
  assert.match(bridgeTemplate, /redirect:\s*function\(label,\s*payload\)/, "bridge should expose redirect(label, payload)");
  assert.match(nativeBridgeRouter, /case "redirect":/, "host should handle redirect native calls");
  assert.match(nativeBridgeRouter, /redirect unsupported/, "unsupported redirect errors should name the API");
  assert.match(capabilitySource, /"redirect"/, "shared capability inventory should include redirect");
  assert.match(helperSource, /normalizePluginRedirectLabel/, "redirect helper should normalize plugin redirect labels");
  assert.match(helperSource, /selectPluginRedirectResult/, "redirect helper should select a result from search matches");
  assert.match(controllerSource, /function handlePluginRedirect/, "launcher plugin-window controller should handle redirect requests");
  assert.match(controllerSource, /invoke<SearchResult\[]>\("search_features"/, "redirect should search plugin features");
  await assertPluginRedirectHostPath(controllerSource, sessionSource, helper);
  assert.match(controllerSource, /onredirect:\s*handlePluginRedirect/, "PluginPanel mount props should receive the controller redirect handler");
  assert.match(appSource, /onRedirect=\{handlePluginRedirect\}/, "App should pass the controller redirect handler into the mounted panel");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
