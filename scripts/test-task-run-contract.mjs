import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [model, database, tools, commands, appLib, types, agentPanel, settingsPanel] = await Promise.all([
  readFile(new URL("crates/atools-core/src/task_run.rs", root), "utf8"),
  readFile(new URL("crates/atools-core/src/db.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/agent_tools.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/lib/types.ts", root), "utf8"),
  readFile(new URL("src/components/AgentPanel.svelte", root), "utf8"),
  readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
]);

for (const status of ["Created", "AwaitingPermission", "Running", "Partial", "Succeeded", "Failed", "Cancelled"]) {
  assert.match(model, new RegExp(`\\b${status},`), `TaskRun must include ${status}`);
}
for (const field of ["capability_id", "initiator", "artifacts", "warnings", "errors", "actions", "memory_ids", "validation"]) {
  assert.match(model, new RegExp(`pub ${field}:`), `TaskRun must persist ${field}`);
}

assert.match(database, /CREATE TABLE IF NOT EXISTS task_runs/);
assert.match(database, /pub fn upsert_task_run/);
assert.match(database, /pub fn get_task_run/);
assert.match(database, /pub fn list_task_runs/);

for (const field of ["runId", "status", "summary", "metrics", "artifacts", "validation", "resultUrl"]) {
  assert.ok(tools.includes(`"${field}"`), `MCP TaskRun envelope must include ${field}`);
}
assert.match(tools, /TaskRunStatus::AwaitingPermission/);
assert.match(tools, /TaskRunStatus::Succeeded/);
assert.match(tools, /TaskRunStatus::Failed/);
assert.match(tools, /TaskRunStatus::Cancelled/);
assert.match(commands, /pub fn list_task_runs/);
assert.match(commands, /pub fn get_task_run/);
assert.match(commands, /pub fn cancel_task_run/);
assert.match(appLib, /commands::list_task_runs/);
assert.match(appLib, /commands::get_task_run/);
assert.match(appLib, /commands::cancel_task_run/);
assert.match(types, /export type TaskRun =/);
assert.match(types, /run_id\?: string \| null/);
assert.match(agentPanel, /runId: request\.run_id/);
assert.match(settingsPanel, /runId: request\.run_id/);
assert.match(agentPanel, /<h3>结果中心<\/h3>/);
assert.match(agentPanel, /invoke<TaskRun\[]>\("list_task_runs"/);
assert.match(agentPanel, /invoke\("cancel_task_run"/);
assert.match(agentPanel, /function retryTaskRun\(run: TaskRun\)/);
assert.match(agentPanel, /run\.validation\.summary/);
assert.match(agentPanel, /run\.artifacts as artifact/);
