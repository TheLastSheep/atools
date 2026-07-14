import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
const systemPanelSource = await readFile(new URL("src/components/SystemPanel.svelte", root), "utf8");

assert.match(
  source,
  /function hasTauriRuntime\(\) \{[\s\S]*?__TAURI_INTERNALS__[\s\S]*?typeof runtime\?\.invoke === "function"[\s\S]*?\}/,
  "SettingsPanel should treat Tauri as available only when the runtime invoke function exists",
);
assert.doesNotMatch(
  source,
  /function hasTauriRuntime\(\) \{\s*return "__TAURI_INTERNALS__" in window;\s*\}/,
  "SettingsPanel should not use a key-exists-only Tauri runtime guard",
);
assert.match(
  source,
  /catch \(error\) \{\s*pluginsStatus = hasTauriRuntime\(\) \? String\(error\) : "Tauri 运行时未连接，已安装插件需在桌面应用中查看";\s*\}/,
  "Installed plugin refresh should not surface raw Tauri invoke TypeError in browser preview",
);

assert.match(
  systemPanelSource,
  /function hasTauriRuntime\(\) \{[\s\S]*?__TAURI_INTERNALS__[\s\S]*?typeof runtime\?\.invoke === "function"[\s\S]*?\}/,
  "SystemPanel plugin shortcut should use the same invoke-based Tauri runtime guard",
);
assert.match(
  systemPanelSource,
  /if \(!hasTauriRuntime\(\)\) \{[\s\S]*?pluginError = "Tauri 运行时未连接，已安装插件需在桌面应用中查看";[\s\S]*?return;[\s\S]*?\}/,
  "SystemPanel plugin shortcut should show a preview-safe unavailable state before list_plugins",
);
assert.match(
  systemPanelSource,
  /catch \(e\) \{[\s\S]*?pluginError = hasTauriRuntime\(\) \? String\(e\) : "Tauri 运行时未连接，已安装插件需在桌面应用中查看";[\s\S]*?\}/,
  "SystemPanel plugin shortcut should not surface raw invoke TypeError in browser preview",
);
