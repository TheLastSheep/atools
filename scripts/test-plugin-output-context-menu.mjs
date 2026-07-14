import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertCheckedChecklistRow } from "./chrome-cdp-smoke-utils.mjs";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const checklistSource = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
const checklistRow = "插件 output 行右键会打开 `复制结果` 菜单；按 `Esc` 只关闭该菜单，不退出插件态，点击菜单项应复制当前行结果并显示既有复制反馈。";

assert.match(
  componentSource,
  /type OutputContextMenuState/,
  "PluginPanel should model output context-menu state",
);
assert.match(
  componentSource,
  /let outputContextMenu = \$state/,
  "PluginPanel should track the active output context menu",
);
assert.match(
  componentSource,
  /function copyPluginOutputItem\(idx: number\)/,
  "Plugin output copy should be centralized for click, Enter, and context menu",
);
assert.match(
  componentSource,
  /const copiedItem = \{ title: "已复制", description: item\.data, data: item\.data \};/,
  "Plugin output copy should keep copied data in the local feedback row",
);
assert.match(
  componentSource,
  /pluginItems = \[copiedItem\];/,
  "Plugin output copy should show the copied feedback row locally",
);
assert.match(
  componentSource,
  /pluginItems = \[copiedItem\];\n\s+selectedIndex = 0;/,
  "Plugin output copy should keep the copied feedback row selected",
);
assert.match(
  componentSource,
  /function writePluginOutputText\(text: string\)/,
  "Plugin output copy should wrap clipboard writes for Browser and Tauri fallback paths",
);
assert.match(
  componentSource,
  /function openOutputContextMenu\(e: MouseEvent,\s*idx: number\)/,
  "Plugin output rows should open a context menu on right click",
);
assert.match(
  componentSource,
  /function copyOutputContextMenuItem\(\)/,
  "Plugin output context menu should copy the active row",
);
assert.match(
  componentSource,
  /oncontextmenu=\{\(event\) => openOutputContextMenu\(event,\s*i\)\}/,
  "Plugin output rows should wire right-click to the context menu",
);
assert.match(
  componentSource,
  /class="plugin-output-menu"/,
  "PluginPanel should render a plugin output context menu",
);
assert.match(
  componentSource,
  />复制结果</,
  "Plugin output context menu should expose a copy command",
);
assert.match(
  componentSource,
  /onOutputContextMenuKeydown = \(event: KeyboardEvent\) => handlePluginPanelKeydown\(event\)/,
  "PluginPanel should close the context menu from Escape",
);
assert.match(
  componentSource,
  /handlePluginPanelKeydown[\s\S]*e\.stopPropagation\(\)/,
  "Escape closing the output context menu should not bubble to App and close the plugin",
);
assert.match(
  componentSource,
  /handlePluginPanelKeydown[\s\S]*e\.stopImmediatePropagation\(\)/,
  "Escape closing the output context menu should stop other window keydown listeners",
);
assert.match(
  componentSource,
  /window\.addEventListener\("keydown",[\s\S]*capture:\s*true/,
  "PluginPanel should intercept output-menu Escape during the capture phase",
);
assertCheckedChecklistRow(checklistSource, checklistRow);
