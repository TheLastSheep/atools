import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const panel = await Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0"));
const agentTools = await readFile(new URL("src-tauri/src/agent_tools.rs", root), "utf8");
const agentToolTests = await readFile(new URL("src-tauri/tests/agent_tools_tests.rs", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");

assert.ok(panel.includes('invoke<ToolDefinition[]>("list_agent_tools")'), "Settings should load Agent tools");
assert.ok(panel.includes("{#each agentTools as tool}"), "Settings should render every Agent tool row");
assert.ok(panel.includes("<span>{tool.name}</span>"), "Settings should display ask_ai_model by tool name");
assert.ok(panel.includes('{tool.description || "无描述"} · {tool.scopes.join(", ")}'), "Settings should display ask_ai_model scopes");
assert.ok(panel.includes("待确认请求"), "Settings should render pending permission requests");
assert.ok(panel.includes("mcpPendingRequestRows"), "Settings should model pending permission requests");
assert.ok(panel.includes("允许一次"), "Settings should let users allow a pending ask_ai_model request once");
assert.ok(panel.includes("允许并记住"), "Settings should let users remember a pending ask_ai_model grant");
assert.ok(panel.includes("dismiss_pending_agent_request"), "Settings should let users reject pending requests");

const askToolStart = agentTools.indexOf('tool(\n        "ask_ai_model"');
assert.notEqual(askToolStart, -1, "ask_ai_model tool definition should exist");
const askToolEnd = agentTools.indexOf("\n}\n\nfn find_local_files_tool", askToolStart);
assert.notEqual(askToolEnd, -1, "ask_ai_model definition should end before find_local_files");
const askToolBody = agentTools.slice(askToolStart, askToolEnd);
assert.ok(askToolBody.includes("vec![PermissionScope::Network]"), "ask_ai_model should declare network scope");

const permissionStart = agentTools.indexOf("pub fn permission_decision_for_tool");
assert.notEqual(permissionStart, -1, "permission_decision_for_tool should exist");
const permissionEnd = agentTools.indexOf("\nfn tool_has_denied_scope", permissionStart);
const permissionBody = agentTools.slice(permissionStart, permissionEnd);
assert.ok(permissionBody.includes(".unwrap_or(PermissionMode::Conservative)"), "permission mode should default to conservative");
assert.ok(permissionBody.includes("Ok(PermissionDecision::Confirm)"), "ungranted conservative calls should require confirmation");

const callStart = agentTools.indexOf("pub async fn call_tool_with_audit");
assert.notEqual(callStart, -1, "call_tool_with_audit should exist");
const callEnd = agentTools.indexOf("\nasync fn execute_agent_tool", callStart);
const callBody = agentTools.slice(callStart, callEnd);
assert.ok(callBody.includes("matches!(permission, PermissionDecision::Confirm) && !confirmed"));
assert.ok(callBody.includes("build_pending_agent_tool_request"));
assert.ok(callBody.includes('app.emit("agent-permission-request"'));
assert.ok(callBody.includes("permission_required_payload(&pending)"), "unconfirmed ask_ai_model should return permission_required payload");
assert.ok(callBody.indexOf("matches!(permission, PermissionDecision::Confirm) && !confirmed") < callBody.indexOf("execute_agent_tool("), "permission confirmation should happen before tool execution");

const askPermissionTestStart = agentToolTests.indexOf("fn ask_ai_model_requires_network_scope_confirmation_in_conservative_mode()");
assert.notEqual(askPermissionTestStart, -1, "Rust tests should cover ask_ai_model conservative confirmation");
const askPermissionTestEnd = agentToolTests.indexOf("\n#[", askPermissionTestStart + 1);
const askPermissionTestBody = agentToolTests.slice(askPermissionTestStart, askPermissionTestEnd);
assert.ok(askPermissionTestBody.includes('"ask_ai_model"'));
assert.ok(askPermissionTestBody.includes("PermissionScope::Network"));
assert.ok(askPermissionTestBody.includes("PermissionDecision::Confirm"));
assert.ok(askPermissionTestBody.includes('"permission_required"'));
assert.ok(askPermissionTestBody.includes('"network"'));

const checkedRow = "- [x] `ask_ai_model` 显示 `network` scope；保守确认模式下调用会先进入权限确认，不应静默发送 prompt。";
assert.ok(smokeChecklist.includes(checkedRow), "macOS smoke checklist should mark ask_ai_model permission behavior complete");
