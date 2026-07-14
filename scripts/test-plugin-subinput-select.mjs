import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");

assert.match(
  componentSource,
  /subInputSelect:\s*function\(\)/,
  "utools.subInputSelect should be exposed",
);
assert.match(
  componentSource,
  /__ipc_subinput_focus__:\s*true,\s*action:\s*'select'/,
  "subInputSelect should notify the host with an explicit select action",
);
assert.match(
  componentSource,
  /subInputRef\?\.select\(\)/,
  "host should select the rendered SubInput text",
);
assert.match(
  componentSource,
  /const shouldSelect = data\.action === "select"/,
  "host should distinguish select from plain focus",
);
assert.doesNotMatch(
  componentSource,
  /subInputSelect:\s*function\(\)\s*\{\s*return Promise\.resolve\(null\);\s*\}/,
  "subInputSelect must not silently resolve without selecting text",
);
assert.match(
  capabilitySource,
  /"subInputSelect"/,
  "shared capability inventory should include subInputSelect",
);
