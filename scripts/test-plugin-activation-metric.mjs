import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readLauncherOwnerSource, readPanelHostSource } from "./lib/plugin-panel-source-test-adapter.mjs";

const root = new URL("../", import.meta.url);
const session = await readLauncherOwnerSource(root, "src/lib/launcherPluginSessionController.ts");
const windowController = await readLauncherOwnerSource(root, "src/lib/launcherPluginWindowController.ts");
const runtimeHost = await readLauncherOwnerSource(root, "src/lib/launcherWindowRuntimeHost.ts");
const orchestration = await readLauncherOwnerSource(root, "src/lib/desktopSmokeOrchestration.ts");
const panel = await readPanelHostSource(root, "src/components/PluginPanel.svelte");
const frameMount = await readPanelHostSource(root, "src/lib/pluginPanelFrameMount.ts");
const loadController = await readPanelHostSource(root, "src/lib/pluginPanelLoadController.ts");
const state = await readFile(new URL("src-tauri/src/state.rs", root), "utf8");
const commands = await readFile(new URL("src-tauri/src/commands.rs", root), "utf8");
const benchmark = await readFile(new URL("scripts/benchmark-macos-runtime.mjs", root), "utf8");

assert.match(frameMount, /node\.addEventListener\("load", reportReady\)/);
assert.match(loadController, /await ports\.waitForHostPaint\(\);[\s\S]*?ports\.reportPluginReady\(\);/);
assert.match(loadController, /await ports\.onLoadError\?\.\(e\)/);
assert.match(panel, /onLoadError: error => onloaderror\?\.\(error\)/);
assert.match(panel, /pluginReadyReported \|\| \(!iframeSrc && !iframeSrcDoc\)/);
assert.match(panel, /browserWindowPanelState\.sources/);
assert.match(panel, /createPluginPanelFrameMountHost\(/);
assert.match(frameMount, /createPluginPanelFrameMounts\(ports: PluginPanelFrameMountPorts\)/);
assert.match(frameMount, /registerFrame\(\{ kind: "main" \}, node\.contentWindow, true, loaded\)/);
assert.match(panel, /Promise\.resolve\(onready\?\.\(\)\)/);

assert.match(session, /waitForPluginActivation\(action\.feature_code, activationStartedAt/);
assert.match(windowController, /onloaderror: error => ports\.onLoadError\(/);
assert.match(runtimeHost, /onLoadError: error => ports\.pluginSession\.cancelPluginActivationWaiter\(error\)/);
assert.match(orchestration, /invoke<SearchResult\[]>\("search_features"/);
assert.match(orchestration, /ports\.activateFeature\(pluginCandidate\.code, null/);
assert.match(orchestration, /plugin_activation_feature: pluginActivationFeature/);
assert.match(orchestration, /plugin_activation_ms: pluginActivationMs/);

assert.match(state, /pub plugin_activation_feature: Option<String>/);
assert.match(state, /pub plugin_activation_ms: Option<f64>/);
assert.match(commands, /Plugin activation duration must be a positive finite number/);

assert.match(benchmark, /plugin_activation_ms: distribution/);
assert.match(benchmark, /plugin activation P99/);
assert.match(benchmark, /schema_version: 5/);
