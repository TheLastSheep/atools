import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");

assert.doesNotMatch(
  componentSource,
  /simulateKeyboardTap:\s*function\(\)\s*\{\s*return Promise\.resolve\(null\);\s*\}/,
  "simulateKeyboardTap must not silently resolve without a bridge result",
);
assert.match(
  componentSource,
  /simulateKeyboardTap:\s*function\((?:key|key,\s*modifiers)/,
  "simulateKeyboardTap should accept keyboard arguments",
);
assert.match(
  componentSource,
  /_nativeCall\('simulateKeyboardTap'/,
  "simulateKeyboardTap should route through the native bridge",
);
assert.match(
  componentSource,
  /case "simulateKeyboardTap":/,
  "host should return a method-scoped simulateKeyboardTap result",
);
assert.match(
  componentSource,
  /simulateKeyboardTap unsupported/,
  "simulateKeyboardTap unsupported errors should include the API name",
);
