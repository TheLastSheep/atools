import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");

assert.doesNotMatch(
  componentSource,
  /subInputFocus:\s*function\(\)\s*\{\s*return Promise\.resolve\(null\);\s*\}/,
  "subInputFocus must not silently resolve without notifying the host",
);
assert.doesNotMatch(
  componentSource,
  /subInputBlur:\s*function\(\)\s*\{\s*return Promise\.resolve\(null\);\s*\}/,
  "subInputBlur must not silently resolve without notifying the host",
);
assert.match(componentSource, /__ipc_subinput_focus__/, "plugin iframe bridge should post focus/blur messages");
assert.match(componentSource, /subInputFocus:\s*function\(\)/, "utools.subInputFocus should be exposed");
assert.match(componentSource, /subInputBlur:\s*function\(\)/, "utools.subInputBlur should be exposed");
assert.match(componentSource, /subInputRef\?\.focus\(\)/, "host should focus the rendered subInput element");
assert.match(componentSource, /subInputRef\?\.blur\(\)/, "host should blur the rendered subInput element");
