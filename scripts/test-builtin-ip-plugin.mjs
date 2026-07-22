import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pluginRoot = new URL("resources/plugins/builtin/ip/", root);
const [manifestText, indexHtml, commands, appLib, pluginPanel, invokePolicy] = await Promise.all([
  readFile(new URL("plugin.json", pluginRoot), "utf8"),
  readFile(new URL("index.html", pluginRoot), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/lib/pluginInvokePolicy.ts", root), "utf8"),
]);
const manifest = JSON.parse(manifestText);

assert.equal(manifest.name, "ip");
assert.equal(manifest.main, "index.html");
assert.equal(manifest.preload, undefined);
assert.deepEqual(manifest.permissions, ["network.read"]);
assert.equal(manifest.features[0].code, "ip");
await access(new URL(manifest.main, pluginRoot));
await access(new URL(manifest.logo, pluginRoot));

assert.match(indexHtml, /window\.utools\.network\.ipSnapshot\(\)/);
assert.match(indexHtml, /snapshot\.primary_ipv4/);
assert.match(indexHtml, /snapshot\.addresses/);
assert.doesNotMatch(indexHtml, /fetch\(|XMLHttpRequest|https?:\/\//);
assert.match(commands, /pub async fn native_ip_snapshot/);
assert.match(commands, /get_if_addrs::get_if_addrs\(\)/);
assert.match(commands, /spawn_blocking\(native_ip_snapshot_inner\)/);
assert.match(appLib, /commands::native_ip_snapshot/);
assert.match(pluginPanel, /case "getNativeIpSnapshot":/);
assert.match(pluginPanel, /invoke\("native_ip_snapshot"\)/);
assert.match(pluginPanel, /ipSnapshot: function\(\) \{ return _nativeCall\('getNativeIpSnapshot'\); \}/);
assert.match(invokePolicy, /getNativeIpSnapshot: "network\.read"/);
