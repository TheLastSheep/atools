import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const panel = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
const agentTools = await readFile(new URL("src-tauri/src/agent_tools.rs", root), "utf8");
const agentToolTests = await readFile(new URL("src-tauri/tests/agent_tools_tests.rs", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");

function assertOrder(source, labels) {
  let cursor = -1;
  for (const label of labels) {
    const next = source.indexOf(label, cursor + 1);
    assert.notEqual(next, -1, `expected to find ${label}`);
    assert.ok(next > cursor, `expected ${label} after previous marker`);
    cursor = next;
  }
}

const builtinStart = agentTools.indexOf("pub fn builtin_tool_registry() -> ToolRegistry");
assert.notEqual(builtinStart, -1, "agent_tools should define builtin_tool_registry");
const builtinEnd = agentTools.indexOf("\npub fn sync_builtin_tools", builtinStart);
assert.notEqual(builtinEnd, -1, "builtin_tool_registry should end before sync_builtin_tools");
const builtinBody = agentTools.slice(builtinStart, builtinEnd);
const expectedTools = [
  "ask_ai_model",
  "compress_images",
  "find_local_files",
  "get_current_context",
  "ocr_image",
  "open_or_reveal_path",
  "rename_files",
  "search_clipboard",
];

assertOrder(builtinBody, [
  "ask_ai_model_tool()",
  "compress_images_tool()",
  "find_local_files_tool()",
  "get_current_context_tool()",
  "ocr_image_tool()",
  "open_or_reveal_path_tool()",
  "rename_files_tool()",
  "search_clipboard_tool()",
]);

const registryTestStart = agentToolTests.indexOf("fn builtin_registry_contains_agent_whitelist()");
assert.notEqual(registryTestStart, -1, "agent tool tests should cover the built-in whitelist");
const registryTestEnd = agentToolTests.indexOf("\n#[", registryTestStart + 1);
const registryTestBody = agentToolTests.slice(registryTestStart, registryTestEnd);
for (const tool of expectedTools) {
  assert.ok(registryTestBody.includes(`"${tool}"`), `registry test should assert ${tool}`);
}
assert.ok(registryTestBody.includes("assert_eq!"), "registry test should assert the exact tool list");

assert.ok(panel.includes('invoke<ToolDefinition[]>("list_agent_tools")'), "Settings MCP page should load all agent tools");
assert.ok(panel.includes("agentTools = tools"), "Settings MCP page should store loaded agent tools");
assert.ok(panel.includes("<h3>工具开关</h3>"), "Settings MCP page should render the tool whitelist section");
assert.ok(panel.includes("{#each agentTools as tool}"), "Settings MCP page should render every loaded tool");
assert.ok(panel.includes("<span>{tool.name}</span>"), "Settings MCP page should show each tool name");
assert.ok(panel.includes('{tool.description || "无描述"} · {tool.scopes.join(", ")}'), "Settings MCP page should show description and scopes");
assert.ok(panel.includes("checked={tool.enabled}"), "Settings MCP page should show enabled state");
assert.ok(panel.includes("toggleAgentTool(tool"), "Settings MCP page should let users toggle tools");

const checkedRow = "- [x] 工具白名单至少显示默认 8 个内置工具，并包含 `ask_ai_model`。";
assert.ok(smokeChecklist.includes(checkedRow), "macOS smoke checklist should mark Settings MCP tool whitelist complete");
