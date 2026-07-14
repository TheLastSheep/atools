import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");

assert.match(
  componentSource,
  /hideMainWindow:\s*function\(isRestorePreWindow\)/,
  "utools.hideMainWindow should accept the restore-window compatibility argument",
);
assert.match(
  componentSource,
  /showMainWindow:\s*function\(\)/,
  "utools.showMainWindow should be exposed",
);
assert.match(
  componentSource,
  /__ipc_main_window__/,
  "main-window lifecycle calls should notify the host",
);
assert.match(
  componentSource,
  /action:\s*'hide'/,
  "hideMainWindow should send an explicit hide action",
);
assert.match(
  componentSource,
  /action:\s*'show'/,
  "showMainWindow should send an explicit show action",
);
assert.match(
  componentSource,
  /restorePreviousWindow:\s*isRestorePreWindow !== false/,
  "hideMainWindow should preserve the uTools restore-window default",
);
assert.match(
  componentSource,
  /function handleMainWindowLifecycle/,
  "PluginPanel should handle lifecycle messages in the host",
);
assert.match(
  componentSource,
  /invoke\("hide_main_window"/,
  "host hide action should call the native hide_main_window command",
);
assert.match(
  componentSource,
  /invoke\("show_main_window"/,
  "host show action should call the native show_main_window command",
);
assert.doesNotMatch(
  componentSource,
  /hideMainWindow:\s*function\(\)\s*\{\s*window\.parent\.postMessage\(\{\s*__ipc_close__:\s*true\s*\}[^}]+return Promise\.resolve\(null\);?\s*\}/,
  "hideMainWindow must not use the old close-only null-resolution path",
);
