import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const panel = await Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0"));
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
  "open_url",
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
  "open_url_tool()",
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

const checkedRow = "- [x] 工具白名单至少显示默认 9 个内置工具，并包含 `ask_ai_model`。";
assert.ok(smokeChecklist.includes(checkedRow), "macOS smoke checklist should mark Settings MCP tool whitelist complete");
