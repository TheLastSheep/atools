import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [models, handler, wrapper, quickJsBridge, quickJsRuntime, tauriProviders, tauriLib, commands, types, pluginPanel, cargo, settingsPages, settingsPanel] = await Promise.all([
  readFile(new URL("crates/atools-core/src/models.rs", root), "utf8"),
  readFile(new URL("crates/atools-api-shim/src/handler.rs", root), "utf8"),
  readFile(new URL("crates/atools-api-shim/src/handler_wrapper.rs", root), "utf8"),
  readFile(new URL("crates/atools-plugin/src/bridge.rs", root), "utf8"),
  readFile(new URL("crates/atools-plugin/src/runtime.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/providers.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src/lib/types.ts", root), "utf8"),
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("crates/atools-api-shim/Cargo.toml", root), "utf8"),
  readFile(new URL("src/lib/settingsPages.ts", root), "utf8"),
  readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
]);

assert.match(models, /pub providers: HashMap<String, ProviderManifest>/);
assert.match(models, /pub struct ProviderManifest[\s\S]*#\[serde\(rename = "type"\)\][\s\S]*pub type_: String/);
assert.match(commands, /plugin_providers: plugin\.manifest\.providers\.clone\(\)/);
assert.match(types, /plugin_providers\?: Record<string/);

assert.match(handler, /"providers\.getProviders"/);
assert.match(handler, /"providers\.getDefault"/);
assert.match(handler, /"providers\.setDefault"/);
assert.match(handler, /"providers\.invoke"/);
assert.match(handler, /pub async fn invoke_provider/);
assert.match(handler, /providers\.default\.\{provider_type\}/);
assert.match(handler, /format!\("plugin:\{plugin_name\}:\{key\}"\)/);
assert.match(handler, /pub source: String/);
assert.match(handler, /pub plugin_name: String/);
assert.match(handler, /____callProvider____/);
assert.match(handler, /__atools_declared_provider_keys__/);
assert.match(handler, /PROVIDER_INPUT_MAX_BYTES/);
assert.match(handler, /PROVIDER_FETCH_MAX_BYTES/);
assert.match(handler, /response[\s\S]*\.chunk\(\)/);
assert.match(wrapper, /from_shared\(handler: Arc<ApiHandler>\)/);
assert.match(cargo, /reqwest = \{ version = "0\.12"[\s\S]*"stream"/);

assert.match(quickJsBridge, /registerProvider: function\(key, handler\)/);
assert.match(quickJsBridge, /Provider is not declared in plugin\.json/);
assert.match(quickJsBridge, /getProviders: function\(type\)/);
assert.match(quickJsBridge, /getDefaultProvider: function\(type\)/);
assert.match(quickJsBridge, /invokeProvider: function\(type, input, providerId\)/);
assert.match(quickJsBridge, /options\.providerId \|\| null/);
assert.match(quickJsBridge, /translate: function\(text, options\)/);
assert.match(quickJsBridge, /ocr: function\(image, options\)/);
assert.match(quickJsBridge, /globalThis\.____callProvider____/);
assert.match(quickJsBridge, /globalThis\.fetch = function\(url, options\)/);
assert.match(quickJsRuntime, /recv\(command_rx\)[\s\S]*WorkerCommand::CallFunction/);
assert.match(quickJsRuntime, /shutdown_requested/);

assert.match(pluginPanel, /var _atoolsDeclaredProviders = null;/);
assert.match(pluginPanel, /Provider is not declared in plugin\.json/);
assert.match(pluginPanel, /registerProvider: _registerProvider/);
assert.match(pluginPanel, /providersGetProviders/);
assert.match(pluginPanel, /providersGetDefault/);
assert.match(pluginPanel, /providersSetDefault/);
assert.match(pluginPanel, /providersInvoke/);
assert.match(pluginPanel, /options\.providerId \|\| null/);
assert.match(pluginPanel, /invoke\("invoke_plugin_provider"/);

assert.match(tauriProviders, /pub fn list_plugin_providers/);
assert.match(tauriProviders, /pub fn get_default_plugin_provider/);
assert.match(tauriProviders, /pub fn set_default_plugin_provider/);
assert.match(tauriProviders, /pub async fn invoke_plugin_provider/);
assert.match(tauriLib, /ApiHandlerWrapper::from_shared\(api_handler\.clone\(\)\)/);
assert.match(tauriLib, /api_handler\.attach_runtime\(&plugin_runtime\)/);
assert.match(tauriLib, /providers::invoke_plugin_provider/);
assert.match(settingsPages, /\| "providers"/);
assert.match(settingsPages, /label: "能力提供商"/);
assert.match(settingsPanel, /activeMenu === "providers"/);
assert.match(settingsPanel, /set_default_plugin_provider/);
assert.match(settingsPanel, /设为默认/);
