import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pluginRoot = new URL("resources/plugins/builtin/http-client/", root);
const [manifestText, indexHtml, commands, appLib, pluginPanel, invokePolicy] = await Promise.all([
  readFile(new URL("plugin.json", pluginRoot), "utf8"),
  readFile(new URL("index.html", pluginRoot), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/lib/pluginInvokePolicy.ts", root), "utf8"),
]);
const manifest = JSON.parse(manifestText);

assert.equal(manifest.name, "http-client");
assert.equal(manifest.main, "index.html");
assert.deepEqual(manifest.permissions, ["network.http"]);
assert.equal(manifest.features[0].code, "http-client");
await access(new URL(manifest.logo, pluginRoot));

assert.match(indexHtml, /window\.utools\.network\.request/);
assert.match(indexHtml, /follow_redirects/);
assert.match(indexHtml, /max_response_bytes/);
assert.match(commands, /pub async fn perform_native_http_request/);
assert.match(commands, /plugin\.http\.request/);
assert.match(commands, /NATIVE_HTTP_MAX_REQUEST_BODY_BYTES/);
assert.match(commands, /NATIVE_HTTP_MAX_RESPONSE_BYTES/);
assert.match(commands, /HTTP redirect limit exceeded/);
assert.match(appLib, /commands::perform_native_http_request/);
assert.match(pluginPanel, /case 'performNativeHttpRequest':/);
assert.match(pluginPanel, /case "performNativeHttpRequest":/);
assert.match(pluginPanel, /request: function\(options\)/);
assert.match(invokePolicy, /performNativeHttpRequest: "network\.http"/);
