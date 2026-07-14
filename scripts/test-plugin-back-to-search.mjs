import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

const [appSource, pluginPanelSource, smokeChecklist] = await Promise.all([
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);

assert.match(
  pluginPanelSource,
  /<button class="back-btn" onclick=\{closePluginPanel\} title="返回">/,
  "PluginPanel back button should close through the lifecycle-aware close helper",
);
assert.match(
  pluginPanelSource,
  /function closePluginPanel\(\) \{\s*dispatchPluginOutEvent\(false\);\s*onclose\(\);/s,
  "PluginPanel back close should dispatch onPluginOut before handing control back to App",
);

const returnToSearchMatch = appSource.match(/async function returnPluginToSearch\(\) \{([\s\S]*?)\n  \}/);
assert.ok(returnToSearchMatch, "App should centralize plugin back-to-search state reset in returnPluginToSearch()");
const returnToSearchBody = returnToSearchMatch[1];

[
  "activePlugin = null;",
  'activePanel = "home";',
  'query = "";',
  "results = [];",
  "pastedItems = [];",
  "selectedIndex = 0;",
  'remoteSearchStatus = "idle";',
  'searchError = "";',
  "await resetPalette();",
  "focusSearch();",
].forEach((snippet) => {
  assert.ok(
    returnToSearchBody.includes(snippet),
    `returnPluginToSearch() should include: ${snippet}`,
  );
});

assert.match(
  appSource,
  /function pluginPanelProps\(action: FeatureAction\) \{[\s\S]*onclose:\s*returnPluginToSearch,/,
  "PluginPanel onclose should be wired to the plugin back-to-search helper",
);
assert.match(
  appSource,
  /async function onEscape\(\) \{\s*if \(activePlugin\) \{\s*await returnPluginToSearch\(\);\s*\}/,
  "Escape from plugin mode should share the same back-to-search reset path",
);

assert.ok(
  smokeChecklist.includes("- [x] 插件内点击返回后回到搜索。"),
  "macOS smoke checklist should mark plugin back-to-search behavior complete",
);
