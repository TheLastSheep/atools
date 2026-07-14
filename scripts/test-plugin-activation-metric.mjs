import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const app = await readFile(new URL("src/App.svelte", root), "utf8");
const panel = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const state = await readFile(new URL("src-tauri/src/state.rs", root), "utf8");
const commands = await readFile(new URL("src-tauri/src/commands.rs", root), "utf8");
const benchmark = await readFile(new URL("scripts/benchmark-macos-runtime.mjs", root), "utf8");

assert.match(panel, /__atools_plugin_ready__: true/);
assert.match(panel, /pluginId: __PLUGIN_ID__/);
assert.match(panel, /featureCode: __FEATURE_CODE__/);
assert.match(panel, /sourceIdentity\.kind !== "main"/);
assert.match(panel, /data\.pluginId === action\.plugin_id/);
assert.match(panel, /data\.featureCode === action\.feature_code/);
assert.match(panel, /Promise\.resolve\(onready\?\.\(\)\)/);

assert.match(app, /waitForPluginActivation\(action\.feature_code, activationStartedAt/);
assert.match(app, /invoke<SearchResult\[]>\("search_features"/);
assert.match(app, /activateFeature\(pluginCandidate\.code, null/);
assert.match(app, /plugin_activation_feature: pluginActivationFeature/);
assert.match(app, /plugin_activation_ms: pluginActivationMs/);

assert.match(state, /pub plugin_activation_feature: Option<String>/);
assert.match(state, /pub plugin_activation_ms: Option<f64>/);
assert.match(commands, /Plugin activation duration must be a positive finite number/);

assert.match(benchmark, /plugin_activation_ms: distribution/);
assert.match(benchmark, /plugin activation P99/);
assert.match(benchmark, /schema_version: 3/);
