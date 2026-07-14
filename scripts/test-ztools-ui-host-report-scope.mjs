import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCheckedChecklistRow } from "./chrome-cdp-smoke-utils.mjs";

const reportUrl = new URL("../output/ztools-plugin-ui-host-smoke-report.json", import.meta.url);
const screenshotManifestUrl = new URL("../output/ztools-ui-host-screenshot-captures/manifest.json", import.meta.url);
const fixtureRootUrl = new URL("../output/ztools-ui-host-real-entry-fixtures/", import.meta.url);
const fixtureRootPath = fileURLToPath(fixtureRootUrl);
const checklistUrl = new URL("../docs/macos-smoke-checklist.md", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);

const expectedBridgeProbeIds = [
  "plugin-enter-event",
  "plugin-ready-event",
  "utools-bridge-present",
  "ztools-alias-present",
  "iframe-dom-identity",
];

const expectedBridgeApiProbeIds = [
  "fixture-bridge-get-path",
  "fixture-bridge-context",
  "fixture-bridge-db-storage",
  "fixture-bridge-db-all-docs",
  "fixture-bridge-app-identity",
  "fixture-bridge-system-flags",
  "fixture-bridge-preload-ky",
  "fixture-bridge-services",
  "fixture-bridge-web-storage",
];

const expectedChecklistRow = "该 report 是外部插件 UI host 自动化 fixture，并已覆盖最小 externalPlan 探针回传、真实入口 HTML readiness/hash 基线、本地脚本/样式依赖 readiness/hash 基线、CSS `@import`/`url()` 字体资产复制、生成 fixture 的首样本浏览器渲染、10 个 standalone fixture 的 matrix 生命周期/bridge/identity/bridge API 脚本错误检查、首个 generated fixture 通过 Web preview `PluginPanel` iframe `src` 加载，以及 10 个 generated fixture 通过 Web preview PluginPanel matrix 回传 `passed=15/15` 且 Browser console 0 warn/error；仍不代表真实 Tauri FS 导入插件、真实第三方入口逐插件视觉截图和真实 native bridge probe 回放已完成。";

const report = JSON.parse(await readFile(reportUrl, "utf8"));
const screenshotManifest = JSON.parse(await readFile(screenshotManifestUrl, "utf8"));

assert.deepEqual(report.summary, {
  planned_samples: 10,
  ui_host_samples: 10,
  desktop_action_fixtures: 10,
  web_preview_actions: 10,
  iframe_ready_checks: 10,
  screenshot_viewport_checks: 20,
  bridge_probe_checks: 50,
  real_entry_html_checks: 10,
  real_entry_html_ready: 10,
  real_entry_html_missing: 0,
  real_entry_html_bytes: 42501,
  real_entry_resource_checks: 27,
  real_entry_resource_ready: 27,
  real_entry_resource_missing: 0,
  real_entry_resource_bytes: 1970144,
  real_entry_fixture_count: 10,
  real_entry_fixture_bytes: 2152915,
  real_entry_fixture_matrix_count: 10,
  real_entry_fixture_matrix_bytes: 13082,
  real_entry_plugin_panel_checks: 10,
  real_entry_plugin_panel_ready: 10,
  real_entry_plugin_panel_matrix_count: 10,
  real_entry_plugin_panel_matrix_bytes: 28331,
  real_entry_fixture_bridge_api_probe_checks: 90,
  real_entry_fixture_runtime_support_files: 77,
  real_entry_fixture_runtime_support_bytes: 4735659,
  preload_expected_samples: 2,
  permission_scoped_samples: 0,
  skipped_samples: 0,
});

assert.equal(report.ui_host_smoke_plans.length, 10);
assert.equal(report.real_entry_fixture_matrix.status, "ready");
assert.equal(report.real_entry_fixture_matrix.fixture_count, 10);
assert.match(report.real_entry_fixture_matrix.sha256, /^[a-f0-9]{64}$/);
assert.equal(report.real_entry_plugin_panel_matrix.status, "ready");
assert.equal(report.real_entry_plugin_panel_matrix.panel_count, 10);
assert.equal(report.real_entry_plugin_panel_matrix.browser_url, "http://127.0.0.1:1434/plugin-panel-matrix.html");
assert.match(report.real_entry_plugin_panel_matrix.sha256, /^[a-f0-9]{64}$/);

const fixtureMatrixHtml = await readFile(report.real_entry_fixture_matrix.path, "utf8");
assert.match(fixtureMatrixHtml, /data-atools-real-entry-fixture-matrix/, "standalone matrix should expose a DOM marker");
assert.match(fixtureMatrixHtml, /window\.__atoolsRealEntryFixtureMatrix/, "standalone matrix should expose browser aggregate state");
assert.match(fixtureMatrixHtml, /bridgeApi=.+\/.+/, "standalone matrix should render bridge API probe counts");

const pluginPanelMatrixHtml = await readFile(report.real_entry_plugin_panel_matrix.path, "utf8");
assert.match(pluginPanelMatrixHtml, /data-atools-real-entry-plugin-panel-matrix/, "PluginPanel matrix should expose a DOM marker");
assert.match(pluginPanelMatrixHtml, /__atools_plugin_panel_real_entry_probe__/, "PluginPanel matrix should consume app-level probe messages");
assert.match(pluginPanelMatrixHtml, /messages=/, "PluginPanel matrix should surface fixture error diagnostics");
assert.match(pluginPanelMatrixHtml, /pluginHostSmoke=externalPlan/, "PluginPanel matrix should load Web preview PluginPanel URLs");

for (const relativePath of [
  "fonts/clear-sans.css",
  "fonts/ClearSans-Regular-webfont.woff",
  "fonts/fontawesome-webfont.woff2",
  "fonts/fontawesome-webfont.ttf",
]) {
  const path = join(fixtureRootPath, relativePath);
  const info = await stat(path);
  assert.ok(info.size > 0, `${relativePath} should be copied as browser-resolved CSS/font support`);
}

for (const plan of report.ui_host_smoke_plans) {
  assert.equal(plan.runtime_status, "ready", `${plan.plugin_id} should be ready in the source activation plan`);
  assert.equal(plan.desktop_action.plugin_id, plan.plugin_id);
  assert.equal(plan.desktop_action.plugin_path, `/tmp/atools-ztools-plugin-smoke/${plan.plugin_id}`);
  assert.equal(plan.web_preview.mode, "externalPlan");
  assert.match(plan.web_preview.url, /pluginHostSmoke=externalPlan/);
  assert.match(plan.web_preview.url, /pluginHostSmokeAction=/);

  const decodedWebAction = decodeActionParam(plan.web_preview.url);
  assert.equal(decodedWebAction.plugin_path, "__atools_plugin_host_preview__");
  assert.equal("iframeSrc" in decodedWebAction.payload, false, `${plan.plugin_id} externalPlan should not load real HTML by URL`);
  assert.match(decodedWebAction.payload.srcdoc, /data-ztools-ui-host-smoke="true"/);
  assert.match(decodedWebAction.payload.srcdoc, /__atools_ui_host_probe_result__/);

  assert.equal(plan.iframe_ready.expected, true);
  assert.equal(plan.iframe_ready.ready_event, "atools-plugin-ready");
  assert.equal(plan.iframe_ready.host_body_mode, "iframe");
  assert.deepEqual(plan.bridge_probes.map((probe) => probe.id), expectedBridgeProbeIds);
  assert.deepEqual(plan.screenshot_viewports.map((viewport) => viewport.name), ["desktop", "compact"]);

  assert.equal(plan.real_entry_html.status, "ready");
  assert.ok(plan.real_entry_html.bytes > 0);
  assert.match(plan.real_entry_html.sha256, /^[a-f0-9]{64}$/);
  assert.ok(plan.real_entry_html.html_path.startsWith("/Users/harris/Desktop/ZTools-plugins/plugins/"));

  assert.equal(plan.real_entry_resources.status, "ready");
  assert.equal(plan.real_entry_resources.missing_resources, 0);
  for (const resource of [...plan.real_entry_resources.scripts, ...plan.real_entry_resources.stylesheets]) {
    assert.ok(resource.bytes > 0, `${plan.plugin_id} ${resource.url} should have byte evidence`);
    assert.match(resource.sha256, /^[a-f0-9]{64}$/);
    assert.ok(resource.path.startsWith("/Users/harris/Desktop/ZTools-plugins/plugins/"));
  }

  assert.equal(plan.real_entry_fixture.status, "ready");
  assert.match(plan.real_entry_fixture.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.real_entry_fixture.bridge_api_probe_ids, expectedBridgeApiProbeIds);
  assert.ok(plan.real_entry_fixture.runtime_support_files >= 0);
  assert.ok(plan.real_entry_fixture.runtime_support_bytes >= 0);

  const fixtureHtml = await readFile(plan.real_entry_fixture.path, "utf8");
  assert.match(fixtureHtml, /data-atools-real-entry-fixture/, `${plan.plugin_id} fixture should expose fixture marker`);
  assert.match(fixtureHtml, /async function runBridgeApiProbes/, `${plan.plugin_id} fixture should replay bridge API probes`);
  assert.match(fixtureHtml, /data-atools-real-entry-bridge-api-passed/, `${plan.plugin_id} fixture should expose bridge API pass count`);

  assert.equal(plan.real_entry_plugin_panel.status, "ready");
  assert.equal(plan.real_entry_plugin_panel.fixture_path, plan.real_entry_fixture.path);
  assert.equal(plan.real_entry_plugin_panel.fixture_url, `http://127.0.0.1:1434/${plan.real_entry_fixture.relative_path}`);
  const decodedPanelAction = decodeActionParam(plan.real_entry_plugin_panel.url);
  assert.equal(decodedPanelAction.payload.iframeSrc, plan.real_entry_plugin_panel.fixture_url);
  assert.equal("srcdoc" in decodedPanelAction.payload, false, `${plan.plugin_id} PluginPanel fixture should use iframe src`);
}

assert.equal(screenshotManifest.status, "ready");
assert.equal(screenshotManifest.expected_count, 20);
assert.equal(screenshotManifest.captured_count, 20);
assert.equal(screenshotManifest.console_issues.length, 0);
assert.deepEqual(
  [...new Set(screenshotManifest.captures.map((capture) => capture.plugin_id))],
  report.ui_host_smoke_plans.map((plan) => plan.plugin_id),
);

const checklist = await readFile(checklistUrl, "utf8");
assertCheckedChecklistRow(checklist, expectedChecklistRow);

const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
assert.equal(
  packageJson.scripts["test:ztools-ui-host-report-scope"],
  "node scripts/test-ztools-ui-host-report-scope.mjs",
);

function decodeActionParam(url) {
  const parsed = new URL(url);
  const encoded = parsed.searchParams.get("pluginHostSmokeAction");
  assert.ok(encoded, "preview URL should include an encoded action fixture");
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}
