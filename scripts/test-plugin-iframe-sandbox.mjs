import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");

assert.match(
  componentSource,
  /const PLUGIN_IFRAME_SANDBOX = "allow-scripts allow-popups"/,
  "main plugin iframe should use an isolated sandbox token string without same-origin access",
);
assert.match(
  componentSource,
  /const PLUGIN_BROWSER_WINDOW_IFRAME_SANDBOX = "allow-scripts allow-popups"/,
  "BrowserWindow child iframe should use the same opaque sandbox boundary as the main plugin iframe",
);
assert.match(
  componentSource,
  /sandbox=\{PLUGIN_IFRAME_SANDBOX\}/,
  "main plugin iframe should use the isolated sandbox constant",
);
assert.match(
  componentSource,
  /sandbox=\{PLUGIN_BROWSER_WINDOW_IFRAME_SANDBOX\}/,
  "BrowserWindow child iframe should use the explicit compatibility sandbox constant",
);
assert.doesNotMatch(
  componentSource,
  /<iframe[\s\S]*?title="Plugin"[\s\S]*?allow-same-origin/,
  "main plugin iframe sandbox must not grant allow-same-origin",
);
assert.doesNotMatch(
  componentSource,
  /allow-same-origin/,
  "neither the main nor hosted BrowserWindow iframe may regain same-origin DOM access",
);
assert.match(
  componentSource,
  /function postPluginLifecycleEvent/,
  "plugin lifecycle dispatch should use postMessage so sandboxed frames do not need same-origin DOM access",
);
assert.doesNotMatch(
  componentSource,
  /new pluginWindow\.CustomEvent/,
  "PluginPanel should not construct CustomEvent through iframe contentWindow after sandbox isolation",
);
assert.match(
  componentSource,
  /function clearMainPluginSelection/,
  "PluginPanel should isolate best-effort selection clearing for opaque main plugin iframes",
);
assert.doesNotMatch(
  componentSource,
  /function stopPluginFindInPage[\s\S]*?iframeRef\?\.contentWindow\?\.getSelection\?\.\(\)\?\.removeAllRanges/,
  "PluginPanel should not directly read main iframe selection without a sandbox-safe guard",
);
assert.match(
  componentSource,
  /function runPluginFindInPage[\s\S]*?catch \(err\)[\s\S]*?findInPage unavailable/,
  "PluginPanel should treat main iframe findInPage as best-effort after sandbox isolation",
);
