import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pluginRoot = new URL("resources/plugins/builtin/process-manager/", root);
const [manifestText, indexHtml, commands, appLib, pluginPanel, invokePolicy] = await Promise.all([
  readFile(new URL("plugin.json", pluginRoot), "utf8"),
  readFile(new URL("index.html", pluginRoot), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/lib/pluginInvokePolicy.ts", root), "utf8"),
]);
const manifest = JSON.parse(manifestText);

assert.equal(manifest.name, "process-manager");
assert.equal(manifest.main, "index.html");
assert.deepEqual(manifest.permissions, ["process.read", "process.terminate"]);
assert.equal(manifest.features[0].code, "process-manager");
await access(new URL(manifest.logo, pluginRoot));

assert.match(indexHtml, /window\.utools\.processes\.list/);
assert.match(indexHtml, /window\.utools\.processes\.terminate\(process\.pid, true\)/);
assert.match(indexHtml, /role="dialog" aria-modal="true"/);
assert.doesNotMatch(indexHtml, /window\.confirm|confirm\(/);
assert.match(commands, /pub async fn list_native_processes/);
assert.match(commands, /pub async fn terminate_native_process/);
assert.match(commands, /Process termination requires explicit confirmation/);
assert.match(commands, /Protected process cannot be terminated/);
assert.match(commands, /plugin\.process\.terminate/);
assert.match(appLib, /commands::list_native_processes/);
assert.match(appLib, /commands::terminate_native_process/);
assert.match(pluginPanel, /case "listNativeProcesses":/);
assert.match(pluginPanel, /case "terminateNativeProcess":/);
assert.match(pluginPanel, /processes:\s*\{/);
assert.match(invokePolicy, /listNativeProcesses: "process\.read"/);
assert.match(invokePolicy, /terminateNativeProcess: "process\.terminate"/);
