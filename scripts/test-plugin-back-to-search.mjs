import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

const [appSource, pluginPanelSource, navigationSource, returnContextSource, smokeChecklist] = await Promise.all([
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/components/PluginNavigationBar.svelte", root), "utf8"),
  readFile(new URL("src/lib/launcherReturnContext.ts", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);

const navigation = pluginPanelSource.match(/<PluginNavigationBar\b[\s\S]*?\/>/)?.[0];
assert.ok(navigation, "PluginPanel should render the shared plugin navigation");
assert.match(navigation, /onreturn=\{closePluginPanel\}/,
  "Plugin navigation should delegate returns to the lifecycle-aware close helper");
assert.match(navigationSource, /<button\b[^>]*class="back-btn"[^>]*onclick=\{onreturn\}/,
  "The shared navigation back button should invoke its supplied onreturn callback");
assert.match(navigationSource, /case "return":\s*onreturn\(\);/,
  "Keyboard return should invoke the same navigation callback");
const closePanel = pluginPanelSource.match(/function closePluginPanel\(\) \{([\s\S]*?)\n  \}/)?.[1];
assert.ok(closePanel, "PluginPanel should keep one lifecycle-aware close helper");
const outIndex = closePanel.indexOf("dispatchPluginOutEvent(false);");
const closeIndex = closePanel.indexOf("onclose();");
assert.ok(outIndex >= 0 && closeIndex > outIndex,
  "PluginPanel back close should dispatch onPluginOut before handing control back to App");
for (const snippet of ["const generation = ++pluginLoadGeneration;", "activePluginRuntime?.close();", "activeHostClipboard?.close();", "await workersStopped;"]) {
  const index = closePanel.indexOf(snippet);
  assert.ok(index >= 0 && index < closeIndex, `PluginPanel should invalidate and release its runtime before returning: ${snippet}`);
}

const returnToSearchMatch = appSource.match(/async function returnPluginToSearch\([^)]*\) \{([\s\S]*?)\n  \}/);
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
assert.match(returnToSearchBody, /requestId !== pluginReturnRequestId[\s\S]*pluginCodeLifecycle\.isCurrent\(focusActivation\)[\s\S]*focusSearch\(\);/,
  "A delayed return must not focus over a newer query, plugin, or page");
assert.match(returnToSearchBody, /launcherReturnContext\.consume\(\)/,
  "Returning from a committed ordinary search should consume its in-memory query and selection snapshot");
assert.match(returnToSearchBody, /onQueryChange\(returnContext\.query\)/,
  "Returning should rerun the query instead of reusing old result objects");
assert.match(returnToSearchBody, /resolveSearchSelection\(launcherResults, returnContext\.selection\)/,
  "A refreshed result list should restore selection by plugin and feature identity");
assert.match(returnToSearchBody, /selectedIndex = resolveSearchSelection\(launcherResults, returnContext\.selection\);\s*focusSearch\(\);\s*void restoreSearch\.catch/,
  "Restored search should focus synchronously before remote results settle and never refocus afterward");
assert.match(appSource, /onCommitted: \(\) => \{[\s\S]*launcherReturnContext\.capture/,
  "Only a current committed ordinary plugin search may create a return snapshot");
assert.match(appSource, /if \(!options\.preserveLauncherReturnContext\) launcherReturnContext\.clear\(\);\s*activePlugin = action;/,
  "A successful top-level plugin commit should clear stale search context before becoming active");
assert.match(appSource, /async function handlePluginRedirect\([\s\S]*?preserveLauncherReturnContext: true/,
  "Nested plugin redirects should explicitly preserve the original search context");
assert.match(returnToSearchBody, /if \(codeChanged\) launcherReturnContext\.clear\(\);/,
  "Plugin invalidation recovery should clear stale context without rerunning the old query");
assert.match(returnContextSource, /consume\(\): LauncherReturnContext \| null[\s\S]*context = null/,
  "Return context is ephemeral and consumed exactly once");

assert.match(
  appSource,
  /function pluginPanelProps\(action: FeatureAction\) \{[\s\S]*onclose:\s*returnPluginToSearch,/,
  "PluginPanel onclose should be wired to the plugin back-to-search helper",
);
assert.match(
  appSource,
  /async function onEscape\(\) \{\s*tabTargetController\.cancel\(\);\s*if \(activePlugin\) \{\s*if \(!appSettings\.pluginEscapeToSearch\) return;\s*await returnPluginToSearch\(\);\s*\}/,
  "Escape from plugin mode should share the same back-to-search reset path",
);

assert.ok(
  smokeChecklist.includes("- [x] 插件内点击返回后回到搜索。"),
  "macOS smoke checklist should mark plugin back-to-search behavior complete",
);
