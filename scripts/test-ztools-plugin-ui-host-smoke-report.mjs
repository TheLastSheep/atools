import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = new URL("../", import.meta.url);
const fixtureRoot = await mkdtemp(join(root.pathname, ".tmp-ztools-ui-host-smoke-"));

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function writePlugin(dirName, manifest, files = {}) {
  const dir = join(fixtureRoot, dirName);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "plugin.json"), manifest);
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return dir;
}

function decodeActionParam(url) {
  const parsed = new URL(url);
  const encoded = parsed.searchParams.get("pluginHostSmokeAction");
  assert.ok(encoded, "preview URL should include an encoded action fixture");
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

try {
  let mod;
  try {
    mod = await import("./ztools-plugin-ui-host-smoke-report.mjs");
  } catch {
    assert.fail("ztools-plugin-ui-host-smoke-report.mjs should export the UI host smoke report builder");
  }

  const alphaPath = await writePlugin(
    "alpha-ready",
    {
      name: "alpha ready!",
      title: "Alpha Ready",
      version: "1.0.0",
      main: "index.html",
      preload: "preload.js",
      permissions: ["clipboard", "window", "clipboard", ""],
      pluginSetting: { height: 760 },
      platform: ["darwin"],
      features: [{ code: "alpha-open", explain: "Alpha Open", cmds: ["alpha"] }],
    },
    {
      "index.html": "<main>alpha</main><script src=\"app.js\"></script>",
      "preload.js": "window.alphaPreload = true;",
      "app.js": "window.utools?.showNotification?.('alpha');",
    },
  );

  const betaPath = await writePlugin(
    "beta-ready",
    {
      name: "beta-ready",
      title: "Beta Ready",
      version: "1.0.0",
      main: "ui/main.html",
      platform: ["darwin"],
      features: [{ code: "beta-open", explain: "Beta Open", cmds: ["beta"] }],
    },
    {
      "ui/main.html": "<html><head><link rel=\"stylesheet\" href=\"style.css\"></head><body><main>beta</main><script type=\"module\" src=\"main.js\"></script></body></html>",
      "ui/style.css": "@import url('fonts/clear-sans.css'); body { color: #111; } .icon { font-family: Beta; src: url('fonts/beta.woff2?cache=1'); }",
      "ui/main.js": "import('./chunk.js'); window.ztools?.dbStorage?.getItem?.('beta');",
      "ui/chunk.js": "window.betaChunkLoaded = true;",
      "ui/fonts/clear-sans.css": "@font-face { font-family: ClearSans; src: url('./clear-sans.woff'); }",
      "ui/fonts/clear-sans.woff": "clear-sans-font",
      "ui/fonts/beta.woff2": "beta-font",
      "json/map_input.json": "{\"ok\":true}",
    },
  );

  const alphaHtml = "<main>alpha</main><script src=\"app.js\"></script>";
  const alphaScript = "window.utools?.showNotification?.('alpha');";
  const betaHtml = "<html><head><link rel=\"stylesheet\" href=\"style.css\"></head><body><main>beta</main><script type=\"module\" src=\"main.js\"></script></body></html>";
  const betaStylesheet = "@import url('fonts/clear-sans.css'); body { color: #111; } .icon { font-family: Beta; src: url('fonts/beta.woff2?cache=1'); }";
  const betaScript = "import('./chunk.js'); window.ztools?.dbStorage?.getItem?.('beta');";

  const activationPlan = {
    generated_at: "2026-06-05T00:00:00.000Z",
    source: fixtureRoot,
    install_root: "/tmp/atools-ui-host-smoke",
    summary: { planned_samples: 2 },
    activation_plans: [
      {
        order: 1,
        name: "alpha ready!",
        title: "Alpha Ready",
        runtime_status: "ready",
        source_path: alphaPath,
        expected_install_id: "alpha-ready",
        install: {
          source_path: alphaPath,
          install_root: "/tmp/atools-ui-host-smoke",
          expected_plugin_id: "alpha-ready",
        },
        activation: {
          feature_code: "alpha-open",
          feature_label: "Alpha Open",
          trigger_type: "text",
          query: "alpha",
        },
        assertions: { entry_resources_ok: true },
        risks: [],
      },
      {
        order: 2,
        name: "beta-ready",
        title: "Beta Ready",
        runtime_status: "ready",
        source_path: betaPath,
        expected_install_id: "beta-ready",
        install: {
          source_path: betaPath,
          install_root: "/tmp/atools-ui-host-smoke",
          expected_plugin_id: "beta-ready",
        },
        activation: {
          feature_code: "beta-open",
          feature_label: "Beta Open",
          trigger_type: "text",
          query: "beta",
        },
        assertions: { entry_resources_ok: true },
        risks: [],
      },
    ],
  };
  const planPath = join(fixtureRoot, "activation-plan.json");
  await writeJson(planPath, activationPlan);

  const report = await mod.buildZToolsPluginUiHostSmokeReport(planPath, {
    generatedAt: "2026-06-05T00:30:00.000Z",
    baseUrl: "http://127.0.0.1:1420/",
    fixtureOutputDir: join(fixtureRoot, "real-entry-fixtures"),
    fixtureBaseUrl: "http://127.0.0.1:1431/fixtures/",
  });
  const generatedAlphaFixture = await readFile(report.ui_host_smoke_plans[0].real_entry_fixture.path, "utf8");
  assert.match(generatedAlphaFixture, /__atoolsNativeWorker/, "real-entry fixtures should install the opaque-origin Worker compatibility wrapper");
  assert.ok(report.summary.real_entry_fixture_bytes > Buffer.byteLength(alphaHtml) + Buffer.byteLength(betaHtml));
  assert.equal(report.summary.real_entry_fixture_matrix_count, 2);
  assert.ok(report.summary.real_entry_fixture_matrix_bytes > 0);
  assert.equal(report.summary.real_entry_plugin_panel_matrix_count, 2);
  assert.ok(report.summary.real_entry_plugin_panel_matrix_bytes > 0);
  assert.equal(report.summary.real_entry_fixture_bridge_api_probe_checks, expectedBridgeApiProbeIds.length * 2);
  assert.ok(report.summary.real_entry_fixture_runtime_support_files >= 2);
  assert.ok(report.summary.real_entry_fixture_runtime_support_bytes > 0);

  assert.equal(report.generated_at, "2026-06-05T00:30:00.000Z");
  assert.equal(report.activation_plan_path, planPath);
  assert.deepEqual(report.summary, {
    planned_samples: 2,
    ui_host_samples: 2,
    desktop_action_fixtures: 2,
    web_preview_actions: 2,
    iframe_ready_checks: 2,
    screenshot_viewport_checks: 4,
    bridge_probe_checks: 10,
    real_entry_html_checks: 2,
    real_entry_html_ready: 2,
    real_entry_html_missing: 0,
    real_entry_html_bytes: Buffer.byteLength(alphaHtml) + Buffer.byteLength(betaHtml),
    real_entry_resource_checks: 3,
    real_entry_resource_ready: 3,
    real_entry_resource_missing: 0,
    real_entry_resource_bytes: Buffer.byteLength(alphaScript) + Buffer.byteLength(betaStylesheet) + Buffer.byteLength(betaScript),
    real_entry_fixture_count: 2,
    real_entry_fixture_bytes: report.summary.real_entry_fixture_bytes,
    real_entry_fixture_matrix_count: 2,
    real_entry_fixture_matrix_bytes: report.summary.real_entry_fixture_matrix_bytes,
    real_entry_plugin_panel_checks: 2,
    real_entry_plugin_panel_ready: 2,
    real_entry_plugin_panel_matrix_count: 2,
    real_entry_plugin_panel_matrix_bytes: report.summary.real_entry_plugin_panel_matrix_bytes,
    real_entry_fixture_bridge_api_probe_checks: expectedBridgeApiProbeIds.length * 2,
    real_entry_fixture_runtime_support_files: report.summary.real_entry_fixture_runtime_support_files,
    real_entry_fixture_runtime_support_bytes: report.summary.real_entry_fixture_runtime_support_bytes,
    preload_expected_samples: 1,
    permission_scoped_samples: 1,
    skipped_samples: 0,
  });
  assert.equal(report.real_entry_fixture_matrix.status, "ready");
  assert.equal(report.real_entry_fixture_matrix.fixture_count, 2);
  assert.match(report.real_entry_fixture_matrix.path, /real-entry-fixtures\/index\.html$/);
  assert.match(report.real_entry_fixture_matrix.url, /^file:\/\//);
  assert.ok(report.real_entry_fixture_matrix.bytes > 0);
  assert.match(report.real_entry_fixture_matrix.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.real_entry_plugin_panel_matrix.status, "ready");
  assert.equal(report.real_entry_plugin_panel_matrix.panel_count, 2);
  assert.match(report.real_entry_plugin_panel_matrix.path, /real-entry-fixtures\/plugin-panel-matrix\.html$/);
  assert.match(report.real_entry_plugin_panel_matrix.url, /^file:\/\//);
  assert.equal(report.real_entry_plugin_panel_matrix.browser_url, "http://127.0.0.1:1431/fixtures/plugin-panel-matrix.html");
  assert.ok(report.real_entry_plugin_panel_matrix.bytes > 0);
  assert.match(report.real_entry_plugin_panel_matrix.sha256, /^[a-f0-9]{64}$/);

  const alpha = report.ui_host_smoke_plans[0];
  assert.equal(alpha.plugin_id, "alpha-ready");
  assert.equal(alpha.desktop_action.plugin_name, "Alpha Ready");
  assert.equal(alpha.desktop_action.main_url, "index.html");
  assert.equal(alpha.desktop_action.plugin_path, "/tmp/atools-ui-host-smoke/alpha-ready");
  assert.equal(alpha.desktop_action.preload_path, "/tmp/atools-ui-host-smoke/alpha-ready/preload.js");
  assert.equal(alpha.desktop_action.expand_height, 541);
  assert.deepEqual(alpha.desktop_action.plugin_permissions, ["clipboard", "window"]);
  assert.deepEqual(alpha.real_entry_html, {
    expected: true,
    status: "ready",
    main_url: "index.html",
    html_path: join(alphaPath, "index.html"),
    entry_directory: alphaPath,
    relative_entry_directory: ".",
    bytes: Buffer.byteLength(alphaHtml),
    sha256: sha256(alphaHtml),
    resource_signals: {
      script_src_count: 1,
      module_script_count: 0,
      inline_script_count: 0,
      stylesheet_link_count: 0,
      image_reference_count: 0,
      bridge_reference: false,
    },
  });
  assert.deepEqual(alpha.real_entry_resources, {
    expected: true,
    status: "ready",
    total_resources: 1,
    ready_resources: 1,
    missing_resources: 0,
    bytes: Buffer.byteLength(alphaScript),
    scripts: [
      {
        kind: "script",
        url: "app.js",
        path: join(alphaPath, "app.js"),
        module: false,
        bytes: Buffer.byteLength(alphaScript),
        sha256: sha256(alphaScript),
      },
    ],
    stylesheets: [],
    missing: [],
  });
  assert.equal(alpha.real_entry_fixture.status, "ready");
  assert.equal(alpha.real_entry_fixture.inlined_scripts, 1);
  assert.equal(alpha.real_entry_fixture.inlined_stylesheets, 0);
  assert.match(alpha.real_entry_fixture.path, /real-entry-fixtures\/001-alpha-ready-alpha-open\.html$/);
  assert.match(alpha.real_entry_fixture.url, /^file:\/\//);
  assert.ok(alpha.real_entry_fixture.bytes > Buffer.byteLength(alphaHtml) + Buffer.byteLength(alphaScript));
  assert.match(alpha.real_entry_fixture.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(alpha.real_entry_fixture.bridge_api_probe_ids, expectedBridgeApiProbeIds);
  const alphaFixtureHtml = await readFile(alpha.real_entry_fixture.path, "utf8");
  assert.match(alphaFixtureHtml, /data-atools-real-entry-fixture-bridge/, "fixture should inject a minimal host bridge before plugin code");
  assert.match(alphaFixtureHtml, /data-atools-real-entry-bridge-present/, "fixture should expose a DOM-readable bridge-present marker");
  assert.match(alphaFixtureHtml, /data-atools-real-entry-error-messages/, "fixture should expose DOM-readable error messages");
  assert.match(alphaFixtureHtml, /getPath:\s*function/, "fixture bridge should provide sync path values for real plugins");
  assert.match(alphaFixtureHtml, /getContext:\s*function/, "fixture bridge should provide a stable plugin context object");
  assert.match(alphaFixtureHtml, /dbBridge\.promises = dbBridge/, "fixture bridge should expose db.promises for common plugin data reads");
  assert.match(alphaFixtureHtml, /pluginEnterParams/, "fixture context should include the common pluginEnterParams shape");
  assert.match(alphaFixtureHtml, /callback\(fixtureContext\)/, "onPluginEnter should pass context instead of a raw DOM event");
  assert.match(alphaFixtureHtml, /window\.services = window\.services \|\|/, "fixture bridge should provide common preload service stubs");
  assert.match(alphaFixtureHtml, /formatMybatisLog:\s*function/, "fixture services should include SQL formatter stubs");
  assert.match(alphaFixtureHtml, /create:\s*function/, "fixture preload ky stub should include ky.create");
  assert.match(alphaFixtureHtml, /function allDocsResult/, "fixture bridge should return an iterable allDocs result");
  assert.match(alphaFixtureHtml, /function safeStorage/, "fixture bridge should provide storage stubs for sandboxed iframe plugins");
  assert.match(alphaFixtureHtml, /installStorageStub\('localStorage'\)/, "fixture bridge should replace inaccessible localStorage");
  assert.match(alphaFixtureHtml, /installStorageStub\('sessionStorage'\)/, "fixture bridge should replace inaccessible sessionStorage");
  assert.match(alphaFixtureHtml, /once: function\(event, listener\)/, "fixture process bridge should support preload loaded listeners");
  assert.match(alphaFixtureHtml, /desktopCaptureSources:\s*function/, "fixture bridge should return iterable desktop capture sources");
  assert.match(alphaFixtureHtml, /window\.fetch = function/, "fixture bridge should provide deterministic offline responses for external activation requests");
  assert.match(alphaFixtureHtml, /window\.global = window\.global \|\| window/, "fixture bridge should expose the CommonJS global alias");
  assert.match(alphaFixtureHtml, /async function runBridgeApiProbes/, "fixture bridge should execute bridge API probes in-browser");
  assert.match(alphaFixtureHtml, /fixture-bridge-db-storage/, "fixture bridge should probe dbStorage compatibility");
  assert.match(alphaFixtureHtml, /fixture-bridge-web-storage/, "fixture bridge should probe sandbox-safe web storage compatibility");
  assert.match(alphaFixtureHtml, /data-atools-real-entry-bridge-api-passed/, "fixture bridge should expose DOM-readable bridge API pass count");
  assert.match(alphaFixtureHtml, /data-atools-inlined-script-src="app\.js"/, "fixture should inline local entry scripts");
  assert.match(alphaFixtureHtml, /window\.utools\?\.showNotification/, "fixture should include real plugin script contents");
  assert.doesNotMatch(alphaFixtureHtml, /<script\s+src="app\.js"/, "fixture should not leave local script src unresolved");
  assert.match(alphaFixtureHtml, /real-entry-fixture-ready/, "fixture should post named readiness probe results for PluginPanel");
  assert.match(alphaFixtureHtml, /real-entry-fixture-errors/, "fixture should post named script-error probe results for PluginPanel");
  assert.equal(alpha.real_entry_plugin_panel.status, "ready");
  assert.equal(alpha.real_entry_plugin_panel.fixture_path, alpha.real_entry_fixture.path);
  assert.equal(alpha.real_entry_plugin_panel.fixture_url, "http://127.0.0.1:1431/fixtures/001-alpha-ready-alpha-open.html");
  assert.match(alpha.real_entry_plugin_panel.url, /pluginHostSmoke=externalPlan/);
  assert.deepEqual(alpha.real_entry_plugin_panel.probe_ids, [
    "plugin-panel-iframe-src",
    "real-entry-fixture-ready",
    "real-entry-fixture-errors",
  ]);
  const decodedAlphaPanel = decodeActionParam(alpha.real_entry_plugin_panel.url);
  assert.equal(decodedAlphaPanel.plugin_id, "alpha-ready");
  assert.equal(decodedAlphaPanel.plugin_path, "__atools_plugin_host_preview__");
  assert.equal(decodedAlphaPanel.payload.iframeSrc, "http://127.0.0.1:1431/fixtures/001-alpha-ready-alpha-open.html");
  assert.equal(decodedAlphaPanel.payload.subInputValue, "alpha");
  assert.equal(decodedAlphaPanel.payload.realEntryFixture, true);
  assert.equal("srcdoc" in decodedAlphaPanel.payload, false, "real fixture PluginPanel URL should load the generated fixture URL instead of embedding srcdoc");
  assert.deepEqual(alpha.bridge_probes.map((probe) => probe.id), [
    "plugin-enter-event",
    "plugin-ready-event",
    "utools-bridge-present",
    "ztools-alias-present",
    "iframe-dom-identity",
  ]);
  assert.deepEqual(alpha.screenshot_viewports.map((viewport) => [viewport.name, viewport.width, viewport.height]), [
    ["desktop", 1280, 820],
    ["compact", 390, 800],
  ]);
  assert.equal(alpha.web_preview.mode, "externalPlan");
  assert.match(alpha.web_preview.url, /pluginHostSmoke=externalPlan/);
  assert.match(alpha.web_preview.url, /pluginHostSmokeAction=/);
  assert.equal(alpha.web_preview.expected_dom.plugin_id_attribute, "alpha-ready");
  assert.equal(alpha.web_preview.expected_dom.feature_code_attribute, "alpha-open");

  const decodedAlpha = decodeActionParam(alpha.web_preview.url);
  assert.equal(decodedAlpha.plugin_id, "alpha-ready");
  assert.equal(decodedAlpha.plugin_path, "__atools_plugin_host_preview__");
  assert.equal(decodedAlpha.payload.subInputValue, "alpha");
  assert.match(decodedAlpha.payload.srcdoc, /data-external-plugin-id="alpha-ready"/);
  assert.match(decodedAlpha.payload.srcdoc, /data-external-feature-code="alpha-open"/);
  assert.match(decodedAlpha.payload.srcdoc, /__atools_ui_host_probe_result__/, "externalPlan preview should post UI host probe results back to PluginPanel");
  assert.match(decodedAlpha.payload.srcdoc, /probeResults/, "externalPlan preview should collect named probe result details");
  assert.doesNotMatch(decodedAlpha.payload.srcdoc, /<main>alpha<\/main>/, "preview fixture should not copy third-party plugin HTML");

  const beta = report.ui_host_smoke_plans[1];
  assert.equal(beta.desktop_action.main_url, "ui/main.html");
  assert.equal(beta.desktop_action.preload_path, null);
  assert.equal(beta.desktop_action.expand_height, 541);
  assert.deepEqual(beta.desktop_action.plugin_permissions, []);
  assert.deepEqual(beta.real_entry_html, {
    expected: true,
    status: "ready",
    main_url: "ui/main.html",
    html_path: join(betaPath, "ui/main.html"),
    entry_directory: join(betaPath, "ui"),
    relative_entry_directory: "ui",
    bytes: Buffer.byteLength(betaHtml),
    sha256: sha256(betaHtml),
    resource_signals: {
      script_src_count: 1,
      module_script_count: 1,
      inline_script_count: 0,
      stylesheet_link_count: 1,
      image_reference_count: 0,
      bridge_reference: false,
    },
  });
  assert.deepEqual(beta.real_entry_resources, {
    expected: true,
    status: "ready",
    total_resources: 2,
    ready_resources: 2,
    missing_resources: 0,
    bytes: Buffer.byteLength(betaStylesheet) + Buffer.byteLength(betaScript),
    scripts: [
      {
        kind: "script",
        url: "main.js",
        path: join(betaPath, "ui/main.js"),
        module: true,
        bytes: Buffer.byteLength(betaScript),
        sha256: sha256(betaScript),
      },
    ],
    stylesheets: [
      {
        kind: "stylesheet",
        url: "style.css",
        path: join(betaPath, "ui/style.css"),
        bytes: Buffer.byteLength(betaStylesheet),
        sha256: sha256(betaStylesheet),
      },
    ],
    missing: [],
  });
  assert.equal(beta.real_entry_fixture.status, "ready");
  assert.equal(beta.real_entry_fixture.inlined_scripts, 1);
  assert.equal(beta.real_entry_fixture.inlined_stylesheets, 1);
  assert.ok(beta.real_entry_fixture.runtime_support_files >= 2);
  assert.match(beta.real_entry_fixture.path, /real-entry-fixtures\/002-beta-ready-beta-open\.html$/);
  const betaFixtureHtml = await readFile(beta.real_entry_fixture.path, "utf8");
  assert.match(betaFixtureHtml, /data-atools-inlined-stylesheet-href="style\.css"/, "fixture should inline local stylesheets");
  assert.match(betaFixtureHtml, /body \{ color: #111; \}/, "fixture should include stylesheet contents");
  assert.match(betaFixtureHtml, /type="module"[^>]*data-atools-inlined-script-src="main\.js"/, "fixture should preserve module script type while inlining");
  const betaChunkFixture = await readFile(join(fixtureRoot, "real-entry-fixtures", "chunk.js"), "utf8");
  assert.match(betaChunkFixture, /window\.betaChunkLoaded = true/, "fixture output should copy sibling dynamic import chunks");
  const betaImportedFontCss = await readFile(join(fixtureRoot, "real-entry-fixtures", "fonts", "clear-sans.css"), "utf8");
  assert.match(betaImportedFontCss, /font-family: ClearSans/, "fixture output should copy CSS @import dependencies into browser-resolved paths");
  const betaImportedFontFile = await readFile(join(fixtureRoot, "real-entry-fixtures", "fonts", "clear-sans.woff"), "utf8");
  assert.equal(betaImportedFontFile, "clear-sans-font", "fixture output should copy font files referenced by imported CSS");
  const betaDirectFontFile = await readFile(join(fixtureRoot, "real-entry-fixtures", "fonts", "beta.woff2"), "utf8");
  assert.equal(betaDirectFontFile, "beta-font", "fixture output should copy font files referenced by inlined entry CSS");
  const betaJsonFixture = await readFile(join(fixtureRoot, "real-entry-fixtures", "json", "map_input.json"), "utf8");
  assert.equal(betaJsonFixture, "{\"ok\":true}", "fixture output should copy root JSON resources for runtime ajax reads");
  assert.equal(beta.real_entry_plugin_panel.status, "ready");
  assert.equal(beta.real_entry_plugin_panel.fixture_url, "http://127.0.0.1:1431/fixtures/002-beta-ready-beta-open.html");
  const matrixHtml = await readFile(report.real_entry_fixture_matrix.path, "utf8");
  assert.match(matrixHtml, /data-atools-real-entry-fixture-matrix/, "matrix should expose a DOM-readable matrix marker");
  assert.match(matrixHtml, /window\.__atoolsRealEntryFixtureMatrix/, "matrix should expose browser-readable aggregate state");
  assert.match(matrixHtml, /__atools_real_entry_fixture_probe__/, "matrix should consume fixture probe postMessages");
  assert.match(matrixHtml, /001-alpha-ready-alpha-open\.html/, "matrix should load the alpha fixture");
  assert.match(matrixHtml, /002-beta-ready-beta-open\.html/, "matrix should load the beta fixture");
  assert.match(matrixHtml, /data-fixture-plugin-id="alpha-ready"/, "matrix should render per-fixture plugin identity");
  assert.match(matrixHtml, /data-fixture-feature-code="beta-open"/, "matrix should render per-fixture feature identity");
  assert.match(matrixHtml, /bridgeApiPassed/, "matrix should aggregate bridge API probe pass counts");
  assert.match(matrixHtml, /bridgeApi=/, "matrix should render bridge API probe counts per fixture");
  const pluginPanelMatrixHtml = await readFile(report.real_entry_plugin_panel_matrix.path, "utf8");
  assert.match(pluginPanelMatrixHtml, /data-atools-real-entry-plugin-panel-matrix/, "PluginPanel matrix should expose a DOM-readable marker");
  assert.match(pluginPanelMatrixHtml, /__atools_plugin_panel_real_entry_probe__/, "PluginPanel matrix should consume app-level real-entry probe messages");
  assert.match(pluginPanelMatrixHtml, /errorMessages/, "PluginPanel matrix should store forwarded fixture error messages");
  assert.match(pluginPanelMatrixHtml, /messages=/, "PluginPanel matrix should render forwarded fixture error messages for diagnostics");
  assert.match(pluginPanelMatrixHtml, /data-panel-plugin-id="alpha-ready"/, "PluginPanel matrix should render per-plugin identity");
  assert.match(pluginPanelMatrixHtml, /data-panel-feature-code="beta-open"/, "PluginPanel matrix should render per-feature identity");
  assert.match(pluginPanelMatrixHtml, /pluginHostSmoke=externalPlan/, "PluginPanel matrix should load app preview URLs");
  assert.match(pluginPanelMatrixHtml, /data-atools-real-entry-plugin-panel-matrix-expected-count="2"/, "PluginPanel matrix should expose expected count");

  const outputPath = join(fixtureRoot, "ui-host-smoke-report.json");
  await mod.writeZToolsPluginUiHostSmokeReport(report, outputPath);
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written.summary.ui_host_samples, 2);
  assert.equal(written.ui_host_smoke_plans[0].real_entry_html.status, "ready");
  assert.equal(written.ui_host_smoke_plans[1].real_entry_resources.ready_resources, 2);
  assert.equal(written.ui_host_smoke_plans[0].real_entry_fixture.status, "ready");
  assert.equal(written.ui_host_smoke_plans[0].real_entry_plugin_panel.status, "ready");
  assert.equal(written.real_entry_fixture_matrix.fixture_count, 2);
  assert.equal(written.real_entry_plugin_panel_matrix.panel_count, 2);

  const [appSource, packageSource] = await Promise.all([
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);
  assert.match(appSource, /pluginHostSmoke\s*===\s*"externalPlan"/, "Web preview should expose external activation-plan smoke mode");
  assert.match(appSource, /pluginHostSmokeAction/, "Web preview should read encoded external plan action fixtures");
  assert.match(appSource, /TextDecoder/, "Web preview should decode UTF-8 base64url action fixtures without mojibake");
  assert.match(packageSource, /test:ztools-plugin-ui-host-smoke-report/, "package scripts should expose the UI host report test");
  assert.match(packageSource, /report:ztools-ui-host-smoke/, "package scripts should expose the UI host report generator");

  const realReport = JSON.parse(await readFile(new URL("../output/ztools-plugin-ui-host-smoke-report.json", import.meta.url), "utf8"));
  assert.deepEqual(realReport.summary, {
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
  assert.equal(realReport.ui_host_smoke_plans.length, 10);
  assert.equal(realReport.real_entry_fixture_matrix.status, "ready");
  assert.equal(realReport.real_entry_fixture_matrix.fixture_count, 10);
  assert.equal(realReport.real_entry_plugin_panel_matrix.status, "ready");
  assert.equal(realReport.real_entry_plugin_panel_matrix.panel_count, 10);

  const firstRealPlan = realReport.ui_host_smoke_plans[0];
  const decodedRealAction = decodeActionParam(firstRealPlan.web_preview.url);
  assert.equal(decodedRealAction.plugin_name, "计算稿纸", "externalPlan action should preserve Chinese plugin names");
  assert.equal(decodedRealAction.payload.subInputValue, "计算稿纸", "externalPlan action should preserve Chinese trigger text");
  assert.match(decodedRealAction.payload.srcdoc, /__atools_ui_host_probe_result__/, "externalPlan srcdoc should post UI host probe results");
  assert.doesNotMatch(firstRealPlan.web_preview.url, /%E8|%e8/, "externalPlan action should be base64url encoded rather than mojibake-prone query text");
  for (const plan of realReport.ui_host_smoke_plans) {
    assert.equal(plan.desktop_action.plugin_path, `/tmp/atools-ztools-plugin-smoke/${plan.plugin_id}`);
    assert.match(plan.web_preview.url, /pluginHostSmoke=externalPlan/);
    assert.match(plan.web_preview.url, /pluginHostSmokeAction=/);
    const decodedWebAction = decodeActionParam(plan.web_preview.url);
    assert.equal(decodedWebAction.plugin_path, "__atools_plugin_host_preview__");
    assert.equal("iframeSrc" in decodedWebAction.payload, false, "externalPlan Web preview should not load real third-party HTML by URL");
    assert.match(decodedWebAction.payload.srcdoc, /data-ztools-ui-host-smoke="true"/, "externalPlan Web preview should use a synthetic smoke srcdoc");
    assert.match(decodedWebAction.payload.srcdoc, /__atools_ui_host_probe_result__/, "externalPlan Web preview should post UI host probe results");
    assert.equal(plan.iframe_ready.expected, true);
    assert.equal(plan.iframe_ready.ready_event, "atools-plugin-ready");
    assert.equal(plan.iframe_ready.host_body_mode, "iframe");
    assert.deepEqual(plan.screenshot_viewports.map((viewport) => viewport.name), ["desktop", "compact"]);
    assert.equal(plan.bridge_probes.length, 5);
    assert.equal(plan.real_entry_html.status, "ready");
    assert.ok(plan.real_entry_html.html_path.startsWith("/Users/harris/Desktop/ZTools-plugins/plugins/"));
    assert.match(plan.real_entry_html.sha256, /^[a-f0-9]{64}$/);
    assert.equal(plan.real_entry_resources.status, "ready");
    assert.equal(plan.real_entry_resources.missing_resources, 0);
    assert.equal(plan.real_entry_fixture.status, "ready");
    assert.match(plan.real_entry_fixture.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(plan.real_entry_fixture.bridge_api_probe_ids, expectedBridgeApiProbeIds);
    assert.equal(plan.real_entry_plugin_panel.status, "ready");
    assert.equal(plan.real_entry_plugin_panel.fixture_path, plan.real_entry_fixture.path);
    assert.equal(plan.real_entry_plugin_panel.fixture_url, `http://127.0.0.1:1434/${plan.real_entry_fixture.relative_path}`);
    const decodedPanelAction = decodeActionParam(plan.real_entry_plugin_panel.url);
    assert.equal(decodedPanelAction.payload.iframeSrc, plan.real_entry_plugin_panel.fixture_url);
    assert.equal("srcdoc" in decodedPanelAction.payload, false, "real fixture PluginPanel URL should not copy third-party HTML into srcdoc");
  }

  const checklist = checklistSection(
    await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8"),
    "真实 ZTools 外部插件 UI host smoke report：",
    "内置插件检查：",
  );
  for (const row of [
    "报告能成功生成 JSON。",
    "当前基线为 10 planned、10 UI host samples、10 desktop action fixtures、10 Web preview actions、10 iframe-ready checks、20 screenshot viewport checks、50 bridge probes、10 real entry HTML checks、10 real entry HTML ready、0 real entry HTML missing、42501 real entry HTML bytes、27 real entry resource checks、27 real entry resources ready、0 real entry resources missing、1970144 real entry resource bytes、10 real entry fixtures generated、2152915 real entry fixture bytes、10 real entry fixture matrix count、13082 real entry fixture matrix bytes、10 real entry PluginPanel checks、10 real entry PluginPanel ready、10 real entry PluginPanel matrix count、28331 real entry PluginPanel matrix bytes、90 real entry fixture bridge API probe checks、77 runtime support files、4735659 runtime support bytes、2 preload expected、0 skipped。",
    "每个 plan item 都应包含 desktop `FeatureAction` fixture、`pluginHostSmoke=externalPlan` Web preview URL、iframe-ready expectation、screenshot viewports 和 bridge probes。",
    "每个 plan item 都应包含 `real_entry_html`，记录真实 `manifest.main` 的 status、absolute `html_path`、entry directory、byte size、SHA-256 和 resource signals；该字段不得把第三方 HTML 内容复制进 Web preview URL。",
    "每个 plan item 都应包含 `real_entry_resources`，记录本地 entry script/stylesheet 的 ready/missing counts、absolute path、byte size、SHA-256 和 script `module` 标记；HTTP(S)、data、protocol-relative 和 hash-only URL 不应算作本地缺失。",
    "每个 plan item 都应包含 `real_entry_fixture`，记录生成 fixture 的 status、path、file URL、byte size、SHA-256、inlined script/stylesheet counts、probe ids、bridge API probe ids、runtime support file count 和 runtime support byte count。",
    "每个 plan item 都应包含 `real_entry_plugin_panel`，记录通过 Web preview `PluginPanel` 加载该 fixture 的 status、app preview URL、fixture path、fixture URL、probe ids 和 expected DOM；当传入 `--fixture-base-url` 时，preview action payload 应使用 `iframeSrc` 指向本地 HTTP fixture URL，且不应把真实第三方 HTML 复制进 `srcdoc`。",
    "报告顶层应包含 `real_entry_fixture_matrix`，记录 matrix harness 的 status、path、file URL、byte size、SHA-256 和 fixture count；summary 应包含 `real_entry_fixture_matrix_count`、`real_entry_fixture_matrix_bytes`、`real_entry_fixture_bridge_api_probe_checks`、`real_entry_fixture_runtime_support_files` 和 `real_entry_fixture_runtime_support_bytes`。",
    "报告顶层应包含 `real_entry_plugin_panel_matrix`，记录 PluginPanel matrix harness 的 status、path、file URL、browser URL、byte size、SHA-256 和 panel count；summary 应包含 `real_entry_plugin_panel_matrix_count` 和 `real_entry_plugin_panel_matrix_bytes`。",
    "Web preview URL 的 `pluginHostSmokeAction` 必须用 UTF-8 解码，中文插件名和触发词不能出现 mojibake。",
  ]) {
    assertCheckedChecklistRow(checklist, row);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

function assertCheckedChecklistRow(checklist, row) {
  assert.match(
    checklist,
    new RegExp(`^- \\[x\\] ${escapeRegExp(row)}`, "m"),
    `Expected checked macOS smoke checklist row containing: ${row}`,
  );
}

function checklistSection(checklist, startTitle, endTitle) {
  const start = checklist.indexOf(startTitle);
  assert.notEqual(start, -1, `Expected checklist section: ${startTitle}`);
  const end = checklist.indexOf(endTitle, start + startTitle.length);
  assert.notEqual(end, -1, `Expected checklist section end: ${endTitle}`);
  return checklist.slice(start, end);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
