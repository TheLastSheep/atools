import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const app = await readFile(new URL("src/App.svelte", root), "utf8");
const settings = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
const agentPanel = await readFile(new URL("src/components/AgentPanel.svelte", root), "utf8");
const tools = await readFile(new URL("src-tauri/src/agent_tools.rs", root), "utf8");
const commands = await readFile(new URL("src-tauri/src/commands.rs", root), "utf8");

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

for (const surface of [app, settings, agentPanel]) {
  assert.match(surface, /await invoke\("copy_text", \{ text \}\)/);
}
const copyCommand = commands.slice(
  commands.indexOf("pub async fn copy_text"),
  commands.indexOf("pub async fn show_notification"),
);
assert.match(copyCommand, /TaskRun::new\(\s*"copy_text"/);
assert.match(copyCommand, /"contentRedacted": true/);
assert.match(copyCommand, /"characterCount": character_count/);
assert.match(copyCommand, /"byteCount": byte_count/);
assert.doesNotMatch(copyCommand, /"text": text/);
assert.match(copyCommand, /Clipboard write completed; text content was not persisted/);
assert.match(app, /const priorCopyRunIds = new Set\(/);
assert.match(app, /run\.capabilityId === "copy_text" && !priorCopyRunIds\.has\(run\.id\)/);
assert.match(app, /const isMainWindow = [^;]+window\.location\.hash === ""/);
assert.match(app, /if \(isMainWindow\) \{\s*void runReleaseSmokeSequence\(\);\s*\}/);
