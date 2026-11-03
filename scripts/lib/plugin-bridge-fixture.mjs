//! Serialize the same production factories used by PluginPanel into raw bridge VM fixtures.
import { readFile } from "node:fs/promises";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const factories = [
  ["__ATOOLS_CLIPBOARD_FACTORY__", "pluginUtoolsBridgeSource/clipboard-api.ts", "createPluginClipboardApi"],
  ["__ATOOLS_CLIPBOARD_COPY_FACTORY__", "pluginClipboardCopyApi.ts", "createPluginClipboardCopyApi"],
  ["__ATOOLS_CLIPBOARD_HISTORY_CODEC_FACTORY__", "pluginUtoolsBridgeSource/clipboard-history.ts", "createClipboardHistoryCodec"],
  ["__ATOOLS_HOSTED_IPC_FACTORY__", "pluginHostedIpcBridge.ts", "createPluginHostedIpcBridge"],
  ["__ATOOLS_BROADCAST_CHANNEL_FACTORY__", "pluginBroadcastChannelBridge.ts", "createPluginBroadcastChannelBridge"],
  ["__ATOOLS_BROADCAST_PAYLOAD_MEASURE__", "pluginBroadcastPayload.ts", "measurePluginBroadcastPayload"],
  ["__ATOOLS_SUBINPUT_FACTORY__", "pluginSubInputBridge.ts", "createPluginSubInputBridge"],
  ["__ATOOLS_LIFECYCLE_FACTORY__", "pluginLifecycleBridge.ts", "createPluginLifecycleBridge"],
  ["__ATOOLS_FEATURE_EXPORTS_FACTORY__", "pluginFeatureExportsBridge.ts", "createPluginFeatureExportsBridge"],
  ["__ATOOLS_BROWSER_WORKER_BRIDGE_FACTORY__", "pluginBrowserWorkerBridge.ts", "createPluginBrowserWorkerBridge"],
  ["__ATOOLS_BROWSER_WINDOW_BRIDGE_FACTORY__", "pluginBrowserWindowBridge.ts", "createPluginBrowserWindowBridge"],
  ["__ATOOLS_BROWSER_WINDOW_GEOMETRY_FACTORY__", "pluginBrowserWindowGeometry.ts", "createPluginBrowserWindowGeometry"],
  ["__ATOOLS_NATIVE_WINDOW_DOM_CONTROLS_FACTORY__", "pluginNativeWindowDomControls.ts", "createPluginNativeWindowDomControls"],
  ["__ATOOLS_NATIVE_WINDOW_DRAG_REGIONS_FACTORY__", "pluginNativeWindowDragRegions.ts", "createPluginNativeWindowDragRegions"],
  ["__ATOOLS_NATIVE_APP_REGION_CSS_RUNTIME_FACTORY__", "pluginNativeAppRegionCssRuntime.ts", "createPluginNativeAppRegionCssRuntime"],
  ["__ATOOLS_NATIVE_APP_REGION_CSS_FACTORY__", "pluginNativeAppRegionCss.ts", "createPluginNativeAppRegionCss"],
  ["__ATOOLS_BUFFER_FACTORY__", "browserBuffer.ts", "browserBufferFactoryScript"],
];
const mainPushFactories = ["__ATOOLS_MAIN_PUSH_FACTORY__", "__ATOOLS_MAIN_PUSH_BUDGET_FACTORY__", "__ATOOLS_MAIN_PUSH_PRESENTATION_FACTORY__"];
const fileDropReceiverFactory = "__ATOOLS_FILE_DROP_RECEIVER_FACTORY__";
const fixedPlaceholders = ["__ATOOLS_WEB_CONTENTS_ID__", "__ATOOLS_SUBINPUT_EPOCH__", "__ATOOLS_MAIN_PUSH_CONFIG__",
  "__ATOOLS_WORKER_SCOPE__", "__ACTION_ENTRY_TYPE__", "__ATOOLS_ENTRY_MODE__"];
const deferredPlaceholders = new Set(["__PLUGIN_ID__", "__FEATURE_CODE__", "__ACTION_PAYLOAD__", "__PLUGIN_PATH__",
  "__APP_NAME__", "__APP_VERSION__"]);
const runtimeIdentifiers = new Set(["__ATOOLS_FRAME_TRANSPORT__"]);
let sources;

function moduleDataUrl(source) {
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64");
}

async function transpiledModuleDataUrl(filename) {
  const sourceUrl = new URL("../../src/lib/" + filename, import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const compiled = transpileModule(source, { fileName: sourceUrl.pathname,
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext } });
  return moduleDataUrl(compiled.outputText);
}

async function importTranspiledModule(filename, dependencies) {
  const sourceUrl = new URL("../../src/lib/" + filename, import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  let output = transpileModule(source, { fileName: sourceUrl.pathname,
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext } }).outputText;
  for (const [specifier, dependencyUrl] of dependencies) {
    const marker = "from " + JSON.stringify(specifier);
    if (!output.includes(marker)) throw Error("Production fixture dependency changed: " + filename + " -> " + specifier);
    output = output.replaceAll(marker, "from " + JSON.stringify(dependencyUrl));
  }
  return import(moduleDataUrl(output));
}

async function pluginFileDropReceiverFactorySource() {
  const identityUrl = await transpiledModuleDataUrl("pluginFileIdentity.ts");
  const packetUrl = await transpiledModuleDataUrl("pluginFileDropPacket.ts");
  const module = await importTranspiledModule("pluginPanelFileDropReceiver.ts", [
    ["./pluginFileIdentity", identityUrl], ["./pluginFileDropPacket", packetUrl],
  ]);
  if (typeof module.pluginPanelFileDropReceiverFactorySource !== "function") {
    throw Error("Production file-drop receiver factory export missing");
  }
  return module.pluginPanelFileDropReceiverFactorySource();
}

async function factorySources() {
  sources ||= Promise.all(factories.map(async ([placeholder, filename, exportName]) => {
    const sourceUrl = new URL("../../src/lib/" + filename, import.meta.url);
    const source = await readFile(sourceUrl, "utf8");
    const compiled = transpileModule(source, { fileName: sourceUrl.pathname,
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext } });
    let output = compiled.outputText;
    if (filename === "browserBuffer.ts") {
      const readers = transpileModule(await readFile(new URL("../../src/lib/nodeBufferNumbers.ts", import.meta.url), "utf8"),
        { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext } });
      const dependency = "data:text/javascript;base64," + Buffer.from(readers.outputText).toString("base64");
      if (!output.includes('from "./nodeBufferNumbers"')) throw Error("Buffer fixture dependency changed");
      output = output.replace('from "./nodeBufferNumbers"', () => "from " + JSON.stringify(dependency));
    }
    const module = await import(moduleDataUrl(output));
    if (typeof module[exportName] !== "function") throw Error("Production bridge factory export missing: " + exportName);
    return [placeholder, filename === "browserBuffer.ts" ? module[exportName]() : module[exportName].toString()];
  })).then(async entries => [
    ...entries,
    [fileDropReceiverFactory, await pluginFileDropReceiverFactorySource()],
  ]);
  return sources;
}

/** Expose serialized production factory source for narrow runtime behavior fixtures. */
export async function pluginBrowserWorkerBridgeFactorySource() {
  const factory = (await factorySources()).find(([placeholder]) => placeholder === "__ATOOLS_BROWSER_WORKER_BRIDGE_FACTORY__");
  if (!factory) throw Error("Production browser worker bridge factory is missing");
  return factory[1];
}

/** Expose the production synchronous BrowserWindow facade for lifecycle VM fixtures. */
export async function pluginBrowserWindowBridgeFactorySource() {
  const factory = (await factorySources()).find(([placeholder]) => placeholder === "__ATOOLS_BROWSER_WINDOW_BRIDGE_FACTORY__");
  if (!factory) throw Error("Production BrowserWindow bridge factory is missing");
  return factory[1];
}

/** Fill production factories and fixture document scope; each case retains its identity and policy. */
export async function injectPluginBridgeFactories(template, { subInputEpoch = 0, webContentsId = 1, entryType = "text" } = {}) {
  if (!Number.isSafeInteger(subInputEpoch) || subInputEpoch < 0) throw Error("Fixture subinput epoch must be a nonnegative safe integer");
  if (!["text", "regex", "over"].includes(entryType)) throw Error("Invalid fixture entry type");
  const expectedPlaceholders = new Set([
    ...factories.map(([placeholder]) => placeholder), fileDropReceiverFactory, ...mainPushFactories,
    ...fixedPlaceholders, ...deferredPlaceholders,
  ]);
  const unknown = [...new Set(template.match(/__[A-Z0-9_]+__/g) || [])]
    .filter(placeholder => !expectedPlaceholders.has(placeholder) && !runtimeIdentifiers.has(placeholder));
  if (unknown.length) throw Error("Unknown production bridge placeholder(s): " + unknown.join(", "));
  let result = template;
  for (const [placeholder, source] of await factorySources()) {
    if (!result.includes(placeholder)) throw Error("Raw production bridge placeholder missing: " + placeholder);
    result = result.replaceAll(placeholder, () => source);
  }
  for (const placeholder of mainPushFactories) {
    if (!result.includes(placeholder)) throw Error("Raw production bridge placeholder missing: " + placeholder);
    result = result.replaceAll(placeholder, "undefined");
  }
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) throw Error("Fixture webContentsId must be positive safe integer");
  result = result.replaceAll("__ATOOLS_WEB_CONTENTS_ID__", String(webContentsId)).replaceAll("__ATOOLS_SUBINPUT_EPOCH__", String(subInputEpoch))
    .replaceAll("__ATOOLS_MAIN_PUSH_CONFIG__", "null")
    .replaceAll("__ATOOLS_ENTRY_MODE__", JSON.stringify("activate"))
    .replaceAll("__ATOOLS_WORKER_SCOPE__", JSON.stringify("00000000-0000-4000-8000-000000000001"))
    .replaceAll("__ACTION_ENTRY_TYPE__", JSON.stringify(entryType));
  const unfilled = [...expectedPlaceholders].filter(placeholder => !deferredPlaceholders.has(placeholder) && result.includes(placeholder));
  if (unfilled.length) throw Error("Unfilled production bridge placeholder(s): " + unfilled.join(", "));
  return result;
}
