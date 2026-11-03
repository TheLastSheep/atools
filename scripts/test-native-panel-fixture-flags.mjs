import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { build } from "vite";
import { pluginPanelNativeFixtureDefines, repositoryRoot } from "./probe-plugin-panel-native.mjs";

const guardModule = JSON.stringify(`${repositoryRoot}/src/lib/pluginDialogBridge.ts`);
const bridgeModule = JSON.stringify(`${repositoryRoot}/src/lib/pluginNativeDialogBridge.ts`);
const controllerModule = JSON.stringify(`${repositoryRoot}/src/lib/pluginDialogsController.ts`);
const pageModule = JSON.stringify(`${repositoryRoot}/src/lib/pluginPageDocument.ts`);
const entryId = `${repositoryRoot}/virtual-native-panel-flags.ts`;
const entry = `
import { pluginDialogSmokeGuardEnabled } from ${guardModule};
import { createPluginNativeDialogBridge } from ${bridgeModule};
import { createPluginDialogsController } from ${controllerModule};
import { pluginPageDocumentModeEnabled } from ${pageModule};
globalThis.runNativePanelFlagProbe = async () => {
  const calls = [], transportCalls = [], permissionRequests = [];
  const endpoint = access => 'http://127.0.0.1:12345/dialog/' + (access === 'open' ? 'a' : 'b').repeat(64);
  const invoke = async (command, args) => {
    calls.push({ command, access: args?.access, requestPermission: args?.requestPermission });
    if (command === 'prepare_plugin_dialogs') return args.requestPermission
      ? { permission_required: true, runId: 'run-' + args.access, tool: 'tool-' + args.access }
      : { unavailable: true, usage: 'detected' };
    if (command === 'get_task_run') {
      const access = args.id.slice(4);
      return { id: args.id, capabilityId: 'tool-' + access, initiator: { clientId: 'atools-ui' },
        status: 'succeeded', output: { sessionId: 'session-' + access } };
    }
    if (command === 'get_plugin_dialog_session') {
      const access = args.sessionId.slice(8);
      return { endpoint: endpoint(access), access };
    }
    if (command === 'close_plugin_dialogs') return;
    throw Error('Unexpected synthetic command: ' + command);
  };
  const controller = createPluginDialogsController(invoke, 'synthetic-plugin', () => true, () => {}, undefined, async () => {});
  const configuration = await controller.prepare();
  const blocked = pluginDialogSmokeGuardEnabled();
  const transport = (endpoint, payload) => {
    transportCalls.push(JSON.parse(payload).method);
    return { ok: true, result: { canceled: false, paths: ['/private/synthetic-selection'] } };
  };
  const bridge = createPluginNativeDialogBridge(configuration, access => permissionRequests.push(access), blocked,
    { sync: transport, async: async (...args) => transport(...args) });
  const results = [];
  for (const invoke of [() => bridge.showOpenDialog({ properties: ['openDirectory'] }),
    () => bridge.electron.showSaveDialog({ defaultPath: '/private/synthetic-output.png' })]) {
    try { results.push({ result: await invoke() }); }
    catch (error) { results.push({ error: error.code }); }
  }
  await controller.close();
  return { blocked, pageDocumentMode:pluginPageDocumentModeEnabled(), calls, transportCalls, permissionRequests, results, sessions: configuration.sessions };
};`;

const previous = new Map(["VITE_ATOOLS_DESKTOP_SMOKE", "VITE_ATOOLS_NATIVE_DIALOG_ACCEPTANCE", "VITE_ATOOLS_PLUGIN_PAGE_DOCUMENT",
  "VITE_ATOOLS_WEB_STORAGE_ACCEPTANCE"]
  .map(name => [name, process.env[name]]));
const expectedCommands = ["open", "save"].flatMap(access => [
  { command: "prepare_plugin_dialogs", access, requestPermission: false },
  { command: "prepare_plugin_dialogs", access, requestPermission: true },
  { command: "get_task_run" }, { command: "get_plugin_dialog_session" },
]).concat({ command: "close_plugin_dialogs" });

try {
  assert.throws(()=>pluginPanelNativeFixtureDefines(false,true),/dedicated native dialog fixture/);
  process.env.VITE_ATOOLS_WEB_STORAGE_ACCEPTANCE="true";
  assert.throws(()=>pluginPanelNativeFixtureDefines(true,false,true),/isolated from dialog and page-document/);
  assert.equal(pluginPanelNativeFixtureDefines(false,false,true)["import.meta.env.VITE_ATOOLS_WEB_STORAGE_ACCEPTANCE"],JSON.stringify("true"),
    "Only the explicit web-storage scenario enables its compile-time fixture switch");
  for (const [dialogAcceptance,pageDocument] of [[false,false],[true,false],[true,true]]) {
    // Conflicting inherited values must not change either fixture mode.
    process.env.VITE_ATOOLS_DESKTOP_SMOKE = "0";
    process.env.VITE_ATOOLS_NATIVE_DIALOG_ACCEPTANCE = dialogAcceptance ? "false" : "true";
    process.env.VITE_ATOOLS_PLUGIN_PAGE_DOCUMENT=pageDocument?"false":"true";
    const define = pluginPanelNativeFixtureDefines(dialogAcceptance,pageDocument);
    assert.equal(define["import.meta.env.VITE_ATOOLS_DESKTOP_SMOKE"], JSON.stringify("true"));
    assert.equal(define["import.meta.env.VITE_ATOOLS_NATIVE_DIALOG_ACCEPTANCE"], JSON.stringify(String(dialogAcceptance)));
    assert.equal(define["import.meta.env.VITE_ATOOLS_PLUGIN_PAGE_DOCUMENT"],JSON.stringify(String(pageDocument)));
    assert.equal(define["import.meta.env.VITE_ATOOLS_WEB_STORAGE_ACCEPTANCE"],JSON.stringify("false"),
      "Inherited Web Storage settings cannot leak into another native scenario");
    const result = await build({ configFile: false, logLevel: "error", root: repositoryRoot, define,
      plugins: [{ name: "synthetic-native-panel-flags", resolveId: id => id === entryId ? id : null,
        load: id => id === entryId ? entry : null }],
      build: { write: false, minify: "esbuild", target: "safari14", lib: {
        entry: entryId, formats: ["iife"], name: "SyntheticNativePanelFlags" } } });
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(item => item.output)
      .find(item => item.type === "chunk");
    assert.ok(chunk, "Synthetic fixture must produce a JavaScript chunk");
    const context = vm.createContext({ crypto: { randomUUID }, TextEncoder, console });
    vm.runInContext(chunk.code, context);
    const actual = JSON.parse(JSON.stringify(await context.runNativePanelFlagProbe()));
    assert.equal(actual.blocked, !dialogAcceptance);
    assert.equal(actual.pageDocumentMode,pageDocument,"Only the explicit dedicated fixture flag enables the actual production document-mode function");
    assert.deepEqual(actual.calls, expectedCommands,
      "Both modes must execute preparation, permission task observation, session lookup and close");
    assert.deepEqual(actual.sessions, { open: "session-open", save: "session-save" });
    assert.deepEqual(actual.permissionRequests, []);
    if (dialogAcceptance) {
      assert.deepEqual(actual.transportCalls, ["showOpenDialog", "showSaveDialog"]);
      assert.deepEqual(actual.results, [{ result: ["/private/synthetic-selection"] },
        { result: { canceled: false, filePath: "/private/synthetic-selection" } }]);
    } else {
      assert.deepEqual(actual.transportCalls, []);
      assert.deepEqual(actual.results, [{ error: "ERR_ATOOLS_DIALOG_SMOKE_BLOCKED" }, { error: "ERR_ATOOLS_DIALOG_SMOKE_BLOCKED" }]);
    }
  }
  console.log("Native panel fixture flags passed: explicit smoke/acceptance/document values override inherited values; ordinary and acceptance runs remain opaque by default; document mode requires dedicated acceptance; preparation/session flow stays active");
} finally {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
