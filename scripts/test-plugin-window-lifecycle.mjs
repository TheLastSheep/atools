import assert from "node:assert/strict";
import { loadProductionPluginBridgeTemplate, readPanelHostSource } from "./lib/plugin-panel-source-test-adapter.mjs";

const root = new URL("../", import.meta.url);
const messageHandlers = await readPanelHostSource(root, "src/lib/pluginPanelMessageHandlers.ts");
const bridgeTemplate = await loadProductionPluginBridgeTemplate(root);

assert.match(
  bridgeTemplate,
  /hideMainWindow:\s*function\(isRestorePreWindow\)/,
  "utools.hideMainWindow should accept the restore-window compatibility argument",
);
assert.match(
  bridgeTemplate,
  /showMainWindow:\s*function\(\)/,
  "utools.showMainWindow should be exposed",
);
assert.match(
  bridgeTemplate,
  /__ipc_main_window__/,
  "main-window lifecycle calls should notify the host",
);
assert.match(
  bridgeTemplate,
  /action:\s*'hide'/,
  "hideMainWindow should send an explicit hide action",
);
assert.match(
  bridgeTemplate,
  /action:\s*'show'/,
  "showMainWindow should send an explicit show action",
);
assert.match(
  bridgeTemplate,
  /restorePreviousWindow:\s*isRestorePreWindow !== false/,
  "hideMainWindow should preserve the uTools restore-window default",
);
assert.match(
  messageHandlers,
  /function handleMainWindowLifecycle/,
  "Plugin message handler should receive lifecycle messages",
);
assert.match(
  messageHandlers,
  /context\.invoke\("hide_main_window"/,
  "host hide action should call the native hide_main_window command",
);
assert.match(
  messageHandlers,
  /context\.invoke\("show_main_window"/,
  "host show action should call the native show_main_window command",
);
assert.doesNotMatch(
  bridgeTemplate,
  /hideMainWindow:\s*function\(\)\s*\{\s*window\.parent\.postMessage\(\{\s*__ipc_close__:\s*true\s*\}[^}]+return Promise\.resolve\(null\);?\s*\}/,
  "hideMainWindow must not use the old close-only null-resolution path",
);
