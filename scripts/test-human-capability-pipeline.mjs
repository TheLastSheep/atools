import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const app = await readFile(new URL("src/App.svelte", root), "utf8");
const settings = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
const tools = await readFile(new URL("src-tauri/src/agent_tools.rs", root), "utf8");

assert.doesNotMatch(app, /invoke\("shell_open", \{ url: resolvedPath \}\)/);
assert.doesNotMatch(app, /invoke\("shell_open", \{ url: path \}\)/);
assert.doesNotMatch(app, /openExternal\(url\)/);
assert.match(
  app,
  /callAgentToolFromUi\("open_or_reveal_path", \{ path: resolvedPath, reveal: false \}, true\)/,
);
assert.match(
  app,
  /callAgentToolFromUi\("open_or_reveal_path", \{ path, reveal: false \}, true\)/,
);
assert.match(app, /callAgentToolFromUi\("open_url", \{ url \}, true\)/);
assert.match(app, /clientId: "atools-ui",[\s\S]*?confirmed,/);
assert.doesNotMatch(settings, /invoke\("shell_open"/);
assert.match(settings, /callHumanCapability\("open_url", \{ url \}\)/);
assert.match(settings, /callHumanCapability\("open_or_reveal_path", \{ path: resolvedPath, reveal: false \}\)/);
assert.match(settings, /clientId: "atools-ui",[\s\S]*?confirmed: true/);

assert.match(tools, /open_url_tool\(\)/);
assert.match(tools, /"open_url" => open_url\(app, arguments\)/);
assert.match(tools, /TaskRunInitiator::human\(Some\(client_id\.to_string\(\)\)\)/);
assert.match(tools, /if !matches!\(parsed\.scheme\(\), "http" \| "https"\)/);
assert.match(tools, /kind: ArtifactKind::Url/);
