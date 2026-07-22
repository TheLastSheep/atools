import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [commands, history, homePanel, tauriConfigText] = await Promise.all([
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src/lib/commandHistory.ts", root), "utf8"),
  readFile(new URL("src/components/HomePanel.svelte", root), "utf8"),
  readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
]);
const tauriConfig = JSON.parse(tauriConfigText);

assert.match(
  commands,
  /\.or_else\(\s*\|\|\s*plugin\.and_then\(\|plugin\| plugin\.manifest\.logo\.as_deref\(\)\)\)/,
  "Search results should fall back from a feature icon to the imported plugin logo",
);
assert.match(commands, /value\.starts_with\("data:"\)/, "Self-contained feature icons should not require plugin metadata");
assert.match(commands, /resolved[\s\S]*?\.canonicalize\(\)/, "Relative plugin icons should become canonical local paths");
assert.match(history, /icon: result\.icon\?\.trim\(\) \|\| ""/, "Command history should retain resolved plugin icons");
assert.match(history, /icon: entry\.icon \|\| null/, "Home commands should receive persisted plugin icons");
assert.match(homePanel, /resultIconSrc\(icon, hasTauriAssetRuntime\(\), convertFileSrc\)/, "Home should convert local icon paths through the Tauri asset protocol");
assert.match(homePanel, /<img src=\{source\} alt="" \/>/, "Home should render the original icon when available");
assert.equal(tauriConfig.app.security.assetProtocol?.enable, true, "The Tauri asset protocol must be enabled for imported local logos");
assert.deepEqual(
  tauriConfig.app.security.assetProtocol?.scope,
  [
    "$HOME/.atools/plugins/**",
    "$HOME/.atools/pasteboard/blobs/**",
    "$RESOURCE/plugins/builtin/**",
  ],
  "Local asset access must stay restricted to imported plugins, Paste blobs, and bundled plugins",
);
