import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const panel = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
const agentTools = await readFile(new URL("src-tauri/src/agent_tools.rs", root), "utf8");
const agentToolTests = await readFile(new URL("src-tauri/tests/agent_tools_tests.rs", root), "utf8");
const coreAgent = await readFile(new URL("crates/atools-core/src/agent.rs", root), "utf8");
const coreAgentTests = await readFile(new URL("crates/atools-core/tests/agent_tests.rs", root), "utf8");
const mcp = await readFile(new URL("crates/atools-core/src/mcp.rs", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");

assert.ok(panel.includes('invoke<ToolDefinition[]>("list_agent_tools")'), "Settings should load all Agent tools");
assert.ok(panel.includes("{#each agentTools as tool}"), "Settings should render plugin tools returned by list_agent_tools");
assert.ok(panel.includes("<span>{tool.name}</span>"), "Settings should show normalized plugin tool names");
assert.ok(panel.includes("checked={tool.enabled}"), "Settings should show plugin tool default-off state");
assert.ok(panel.includes("toggleAgentTool(tool"), "Settings should allow users to enable plugin tools");

assert.ok(agentTools.includes(".filter(|plugin| plugin.enabled)"), "plugin tool sync should only read enabled plugins");
assert.ok(agentTools.includes(".flat_map(|plugin| plugin_manifest_tool_definitions(&plugin))"));
assert.ok(agentTools.includes('Some(format!("plugin_{}_{}", plugin, tool))'), "plugin tools should use plugin_<plugin>_<tool> names");
assert.ok(agentTools.includes("enabled_by_default: false"), "plugin manifest tools should default off");
assert.ok(agentTools.includes("enabled: false"), "plugin manifest tools should not enter MCP until enabled");
assert.ok(agentTools.includes('db.delete_agent_tools_by_source_except("plugin", &names)'), "disabled/uninstalled plugin tools should be removed");

const pluginSyncTestStart = agentToolTests.indexOf("fn plugin_manifest_tools_sync_to_agent_whitelist_disabled_by_default()");
assert.notEqual(pluginSyncTestStart, -1, "Rust tests should cover plugin tool sync");
const pluginSyncTestEnd = agentToolTests.indexOf("\n#[", pluginSyncTestStart + 1);
const pluginSyncTestBody = agentToolTests.slice(pluginSyncTestStart, pluginSyncTestEnd);
assert.ok(pluginSyncTestBody.includes('"plugin_clipboard_plus_search_history"'));
assert.ok(pluginSyncTestBody.includes('assert_eq!(plugin_tool.source, "plugin")'));
assert.ok(pluginSyncTestBody.includes('assert_eq!(plugin_tool.plugin_id.as_deref(), Some("clipboard-plus"))'));
assert.ok(pluginSyncTestBody.includes("assert!(!plugin_tool.enabled_by_default)"));
assert.ok(pluginSyncTestBody.includes("assert!(!plugin_tool.enabled)"));

const pluginExposureTestStart = agentToolTests.indexOf("fn enabled_tool_registry_includes_plugin_tool_only_after_user_enables_it()");
assert.notEqual(pluginExposureTestStart, -1, "Rust tests should cover user-enabled plugin tool exposure");
const pluginExposureTestEnd = agentToolTests.indexOf("\n#[", pluginExposureTestStart + 1);
const pluginExposureTestBody = agentToolTests.slice(pluginExposureTestStart, pluginExposureTestEnd);
assert.ok(pluginExposureTestBody.includes('.get("plugin_clipboard_plus_search_history")'));
assert.ok(pluginExposureTestBody.includes('db.set_agent_tool_enabled("plugin_clipboard_plus_search_history", true)'));
assert.ok(pluginExposureTestBody.includes("sample_plugin_with_manifest_tool(false)"));
assert.ok(pluginExposureTestBody.includes('tool.name != "plugin_clipboard_plus_search_history"'));

const listEnabledStart = coreAgent.indexOf("pub fn list_enabled(&self) -> Vec<ToolDefinition>");
assert.notEqual(listEnabledStart, -1, "ToolRegistry should expose list_enabled");
const listEnabledEnd = coreAgent.indexOf("\n    }", listEnabledStart);
const listEnabledBody = coreAgent.slice(listEnabledStart, listEnabledEnd);
assert.ok(listEnabledBody.includes(".filter(|tool| tool.enabled)"));
assert.equal(listEnabledBody.includes("enabled_by_default && tool.enabled"), false, "MCP list should include user-enabled plugin tools");

assert.ok(mcp.includes('"tools/list"'), "MCP should implement tools/list");
assert.ok(mcp.includes(".list_enabled()"), "MCP tools/list should use the enabled registry view");

const mcpPluginTestStart = coreAgentTests.indexOf("fn mcp_tools_list_includes_user_enabled_plugin_tools()");
assert.notEqual(mcpPluginTestStart, -1, "Core MCP tests should cover user-enabled plugin tools/list");
const mcpPluginTestEnd = coreAgentTests.indexOf("\n#[", mcpPluginTestStart + 1);
const mcpPluginTestBody = coreAgentTests.slice(mcpPluginTestStart, mcpPluginTestEnd);
assert.ok(mcpPluginTestBody.includes("plugin_tool.enabled_by_default = false"));
assert.ok(mcpPluginTestBody.includes("plugin_tool.enabled = true"));
assert.ok(mcpPluginTestBody.includes('"tools/list"'));
assert.ok(mcpPluginTestBody.includes('"plugin_clipboard_plus_search_history"'));

const checkedRow = "- [x] 已启用插件的 manifest `tools` 会以 `plugin_<plugin>_<tool>` 形式出现在工具白名单中，默认关闭；用户打开后才进入 MCP `tools/list`，插件禁用或卸载后对应工具会从白名单移除。";
assert.ok(smokeChecklist.includes(checkedRow), "macOS smoke checklist should mark plugin manifest tool whitelist behavior complete");
