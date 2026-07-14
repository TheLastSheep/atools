import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const agentTools = await readFile(new URL("src-tauri/src/agent_tools.rs", root), "utf8");
const agentToolTests = await readFile(new URL("src-tauri/tests/agent_tools_tests.rs", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");

const callStart = agentTools.indexOf("pub async fn call_tool_with_audit");
assert.notEqual(callStart, -1, "call_tool_with_audit should exist");
const callEnd = agentTools.indexOf("\nasync fn execute_agent_tool", callStart);
assert.notEqual(callEnd, -1, "call_tool_with_audit should end before execute_agent_tool");
const callBody = agentTools.slice(callStart, callEnd);
assert.ok(callBody.includes("AuditLogEntry::new(client_id, tool_name, arguments, status)"), "successful calls should audit original tool arguments");
assert.ok(callBody.includes(".with_output(output.clone())"), "successful calls should audit tool output");
assert.ok(callBody.includes("db.insert_audit_entry(&entry)"), "successful calls should persist the audit entry");

const askStart = agentTools.indexOf("pub async fn ask_ai_model");
assert.notEqual(askStart, -1, "ask_ai_model should exist");
const askEnd = agentTools.indexOf("\nfn ai_chat_completions_url", askStart);
assert.notEqual(askEnd, -1, "ask_ai_model should end before URL helper");
const askBody = agentTools.slice(askStart, askEnd);
assert.ok(askBody.includes('"text": text'), "ask_ai_model output should expose assistant text");
assert.ok(askBody.includes('"model": config.model'), "ask_ai_model output should expose model name");
assert.equal(askBody.includes('"api_key"'), false, "ask_ai_model output should not expose API key");
assert.equal(askBody.includes('"apiKey"'), false, "ask_ai_model output should not expose API key aliases");

const auditTestStart = agentToolTests.indexOf("async fn ask_ai_model_success_audit_keeps_prompt_and_output_without_api_key()");
assert.notEqual(auditTestStart, -1, "Rust tests should cover successful ask_ai_model audit redaction");
const auditTestEnd = agentToolTests.indexOf("\n#[", auditTestStart + 1);
const auditTestBody = agentToolTests.slice(auditTestStart, auditTestEnd);
assert.ok(auditTestBody.includes('"prompt": "Summarize clipboard notes for audit."'), "audit test should use a visible prompt");
assert.ok(auditTestBody.includes("local audit summary"), "audit test should use a visible model output");
assert.ok(auditTestBody.includes("sk-agent-audit-secret"), "audit test should use a concrete secret sentinel");
assert.ok(auditTestBody.includes("AuditLogEntry::new"), "audit test should persist an audit entry");
assert.ok(auditTestBody.includes(".with_output(output)"), "audit test should persist model output");
assert.ok(auditTestBody.includes("db.insert_audit_entry(&entry)"), "audit test should save the audit entry");
assert.ok(auditTestBody.includes("db.list_audit_entries(1)"), "audit test should read persisted audit data");
assert.ok(auditTestBody.includes('audit.input["prompt"]'), "audit test should verify prompt visibility");
assert.ok(auditTestBody.includes('audit.output["text"]'), "audit test should verify model output visibility");
assert.ok(auditTestBody.includes("!audit_json.contains(\"sk-agent-audit-secret\")"), "audit test should verify API key redaction");
assert.ok(auditTestBody.includes("!audit_json.to_ascii_lowercase().contains(\"api_key\")"), "audit test should verify API key field redaction");

const checkedRow = "- [x] `ask_ai_model` 调用成功后审计记录可见 prompt 和模型输出，但不展示 AI API Key。";
assert.ok(smokeChecklist.includes(checkedRow), "macOS smoke checklist should mark ask_ai_model audit redaction complete");
