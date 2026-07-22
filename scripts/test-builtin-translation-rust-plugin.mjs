import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pluginRoot = new URL("resources/plugins/builtin/translation/", root);
const [manifestText, indexHtml, commands, appLib, panel, policy] = await Promise.all([
  readFile(new URL("plugin.json", pluginRoot), "utf8"),
  readFile(new URL("index.html", pluginRoot), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/lib/pluginInvokePolicy.ts", root), "utf8"),
]);
const manifest = JSON.parse(manifestText);

assert.equal(manifest.name, "翻译");
assert.equal(manifest.main, "index.html");
assert.deepEqual(manifest.permissions, ["translation.request", "clipboard.write", "notification"]);
assert.equal(manifest.features[0].code, "翻译");
await access(new URL(manifest.logo, pluginRoot));

assert.match(indexHtml, /window\.utools\.translation\.translate/);
assert.match(indexHtml, /文本将发送至 Google 翻译/);
assert.doesNotMatch(indexHtml, /fetch\s*\(/);
assert.doesNotMatch(indexHtml, /translate\.googleapis\.com/);
assert.match(commands, /pub async fn translate_native_text/);
assert.match(commands, /\.post\(endpoint\)[\s\S]*?\.form\(/);
assert.match(commands, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
assert.match(commands, /NATIVE_TRANSLATION_MAX_RESPONSE_BYTES/);
assert.match(commands, /saved_network_proxy_url/);
assert.match(commands, /"textRedacted": true/);
assert.match(commands, /"translationRedacted": true/);
assert.match(appLib, /commands::translate_native_text/);
assert.match(panel, /case 'translateNativeText':[\s\S]*?translation\.request/);
assert.match(panel, /translation:\s*\{[\s\S]*?_nativeCall\('translateNativeText'/);
assert.match(panel, /case "translateNativeText":[\s\S]*?invoke\("translate_native_text"/);
assert.match(policy, /translateNativeText: "translation\.request"/);
