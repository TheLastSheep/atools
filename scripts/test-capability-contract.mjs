import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [core, commands, mcp, tauri, desktopSmoke, types, panel, packageSource] = await Promise.all([
  readFile(new URL("crates/atools-core/src/capability.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("crates/atools-core/src/mcp.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/desktop_smoke.rs", root), "utf8"),
  readFile(new URL("src/lib/types.ts", root), "utf8"),
  readFile(new URL("src/components/AgentPanel.svelte", root), "utf8"),
  readFile(new URL("package.json", root), "utf8"),
]);
const packageJson = JSON.parse(packageSource);

for (const field of [
  "pub id: String",
  "pub name: String",
  "pub description: String",
  "pub source: CapabilitySource",
  "pub input_schema: Value",
  "pub output_schema: Option<Value>",
  "pub permission_scopes: Vec<String>",
  "pub human_invocable: bool",
  "pub agent_invocable: bool",
  "pub executor: CapabilityExecutor",
  "pub availability: CapabilityAvailability",
  "pub version: String",
  "pub compatibility: CapabilityCompatibility",
]) {
  assert.ok(core.includes(field), `Capability contract should contain ${field}`);
}

assert.match(core, /pub enum CapabilitySourceKind[\s\S]*BuiltinTool[\s\S]*PluginTool[\s\S]*PluginFeature[\s\S]*Skill[\s\S]*ExternalMcp/);
assert.match(core, /pub fn capability_catalog\(/);
assert.match(core, /pub fn redacted_text_copy\(/);
assert.match(core, /plugin\.feature\.\{\}/);
assert.match(core, /"compress_images" \| "ocr_image" \| "open_or_reveal_path" \| "open_url"/);
assert.match(commands, /pub fn list_capabilities\(/);
assert.match(tauri, /commands::list_capabilities/);
assert.match(mcp, /CAPABILITIES_RESOURCE_URI: &str = "atools:\/\/capabilities"/);
assert.match(mcp, /"kind": "atools_capabilities"/);
assert.match(desktopSmoke, /"uri": "atools:\/\/capabilities"/);
assert.match(desktopSmoke, /capability_text\.contains\("agentInvocable"\)/);
assert.match(types, /export type Capability = \{/);
assert.match(panel, /invoke<Capability\[\]>\("list_capabilities"\)/);
assert.match(panel, /<h3>能力目录<\/h3>/);
assert.equal(
  packageJson.scripts["test:capability-contract"],
  "node scripts/test-capability-contract.mjs",
);
