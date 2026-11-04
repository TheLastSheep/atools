import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [model, memory, database, tools, commands, mcpServer, desktopSmoke, mcpDocs, appLib, types, agentPanel, settingsPanel] = await Promise.all([
  readFile(new URL("crates/atools-core/src/task_run.rs", root), "utf8"),
  readFile(new URL("crates/atools-core/src/memory.rs", root), "utf8"),
  readFile(new URL("crates/atools-core/src/db.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/agent_tools.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/mcp_server.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/desktop_smoke.rs", root), "utf8"),
  readFile(new URL("docs/agent-mcp-client.md", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/lib/types.ts", root), "utf8"),
  Promise.all([
    readFile(new URL("src/components/AgentPanel.svelte", root), "utf8"),
    readFile(new URL("src/components/AgentCapabilitySkillMemorySection.svelte", root), "utf8"),
    readFile(new URL("src/components/AgentResultCenterSection.svelte", root), "utf8"),
    readFile(new URL("src/lib/agentPanelHelpers.ts", root), "utf8"),
  ]).then((parts) => parts.join("\n")),
  Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0")),
]);

for (const status of ["Created", "AwaitingPermission", "Running", "Partial", "Succeeded", "Failed", "Cancelled"]) {
  assert.match(model, new RegExp(`\\b${status},`), `TaskRun must include ${status}`);
}
for (const field of ["capability_id", "initiator", "artifacts", "warnings", "errors", "actions", "memory_ids", "validation"]) {
  assert.match(model, new RegExp(`pub ${field}:`), `TaskRun must persist ${field}`);
}
assert.match(model, /pub fn can_transition_to\(self, next: Self\) -> bool/);
assert.match(model, /pub struct InvalidTaskRunTransition/);
assert.match(model, /if !self\.status\.can_transition_to\(status\)/);
assert.match(model, /Self::Partial \| Self::Failed => next == Self::Running/);
assert.match(model, /Self::Succeeded \| Self::Cancelled => false/);

assert.match(database, /CREATE TABLE IF NOT EXISTS task_runs/);
assert.match(database, /pub fn upsert_task_run/);
assert.match(database, /pub fn get_task_run/);
assert.match(database, /pub fn list_task_runs/);
assert.match(memory, /pub struct MemoryItem/);
assert.match(memory, /pub enum MemoryApproval/);
assert.match(memory, /pub fn validate_memory_content/);
assert.match(memory, /pub fn apply_memory_defaults/);
assert.match(database, /CREATE TABLE IF NOT EXISTS memory_items/);
assert.match(database, /pub fn find_memory_items/);
assert.match(database, /pub fn record_memory_use/);

for (const field of ["runId", "status", "summary", "metrics", "artifacts", "validation", "resultUrl"]) {
  assert.ok(tools.includes(`"${field}"`), `MCP TaskRun envelope must include ${field}`);
}
assert.match(tools, /TaskRunStatus::AwaitingPermission/);
assert.match(tools, /TaskRunStatus::Succeeded/);
assert.match(tools, /TaskRunStatus::Failed/);
assert.match(tools, /TaskRunStatus::Cancelled/);
assert.match(tools, /fn structured_result_task_status/);
assert.match(tools, /code: "item_failed"/);
assert.match(tools, /retryable: true/);
assert.match(tools, /"status": "failed"/);
assert.match(commands, /pub fn list_task_runs/);
assert.match(commands, /pub fn get_task_run/);
assert.match(commands, /pub fn cancel_task_run/);
assert.match(commands, /pub fn start_agent_tool/);
assert.match(commands, /active_task_runs[\s\S]*abort_handle/);
assert.match(commands, /TaskRunStatus::Running[\s\S]*cancellable background executor/);
assert.match(commands, /retry_of: Option<String>/);
assert.match(commands, /run\.retry_of = Some\(previous_id\)/);
assert.match(commands, /pub\(crate\) fn start_agent_tool_background/);
assert.match(commands, /pub\(crate\) fn cancel_task_run_by_id/);
assert.match(mcpServer, /"tasks\/get" \| "tasks\/result" \| "tasks\/cancel"/);
assert.match(mcpServer, /"taskSupport": "optional"/);
assert.match(mcpServer, /"io\.modelcontextprotocol\/related-task"/);
assert.match(mcpServer, /start_agent_tool_background/);
assert.match(mcpServer, /cancel_task_run_by_id/);
assert.match(mcpServer, /while !current\.status\.is_terminal\(\)/);
assert.match(mcpServer, /TaskRunStatus::AwaitingPermission => "input_required"/);
assert.match(mcpServer, /TaskRunStatus::Partial \| TaskRunStatus::Succeeded => "completed"/);
assert.match(desktopSmoke, /fn run_mcp_tasks_smoke/);
assert.match(desktopSmoke, /pub mcp_tasks_ok: bool/);
assert.match(desktopSmoke, /"method": "tasks\/get"/);
assert.match(desktopSmoke, /"method": "tasks\/cancel"/);
assert.match(desktopSmoke, /"method": "tasks\/result"/);
for (const method of ["tasks/get", "tasks/result", "tasks/cancel"]) {
  assert.ok(mcpDocs.includes(`\`${method}\``), `MCP client docs must describe ${method}`);
}
assert.match(commands, /pub fn activate_feature[\s\S]*TaskRun::new/);
assert.match(commands, /TaskRunInitiator::human/);
assert.match(commands, /plugin\.feature\.\{code\}/);
assert.match(commands, /pub fn create_memory_item/);
assert.match(commands, /pub fn update_memory_item/);
assert.match(commands, /pub fn set_memory_item_enabled/);
assert.match(commands, /pub fn delete_memory_item/);
assert.match(commands, /pub fn export_memory_items_json/);
assert.match(commands, /pub fn clear_memory_items/);
assert.match(appLib, /commands::list_task_runs/);
assert.match(appLib, /commands::get_task_run/);
assert.match(appLib, /commands::cancel_task_run/);
assert.match(appLib, /commands::start_agent_tool/);
assert.match(appLib, /commands::list_memory_items/);
assert.match(appLib, /commands::create_memory_item/);
assert.match(types, /export type TaskRun =/);
assert.match(types, /export type MemoryItem =/);
assert.match(types, /run_id\?: string \| null/);
assert.match(agentPanel, /runId: request\.run_id/);
assert.match(settingsPanel, /runId: request\.run_id/);
assert.match(agentPanel, /<h3>结果中心<\/h3>/);
assert.match(agentPanel, /invoke<TaskRun\[]>\("list_task_runs"/);
assert.match(agentPanel, /invoke\("cancel_task_run"/);
assert.match(agentPanel, /function retryTaskRun\(run: TaskRun,/);
assert.match(agentPanel, /function failedItemRetryArguments\(run: TaskRun\)/);
assert.match(agentPanel, /candidate\.status === "failed"/);
assert.match(agentPanel, /failedRetryArguments \? "重试失败项" : "重试"/);
assert.match(agentPanel, /invoke<TaskRun>\("start_agent_tool"/);
assert.match(agentPanel, /retryOf: run\.id/);
assert.match(agentPanel, /listen\("task-run-updated"/);
assert.match(agentPanel, /run\.status === "running"/);
assert.match(agentPanel, /function saveTaskRunAsRecipe\(run: TaskRun\)/);
assert.match(agentPanel, /sourceRunId: run\.id/);
assert.match(agentPanel, /run\.validation\.summary/);
assert.match(agentPanel, /run\.artifacts as artifact/);
assert.match(agentPanel, /<h3>执行记忆<\/h3>/);
assert.match(agentPanel, /invoke<MemoryItem\[]>\("list_memory_items"/);
assert.match(agentPanel, /invoke<MemoryItem>\("create_memory_item"/);
assert.match(agentPanel, /invoke\("set_memory_item_enabled"/);
assert.match(agentPanel, /invoke\("delete_memory_item"/);
assert.match(agentPanel, /invoke<string>\("export_memory_items_json"/);
