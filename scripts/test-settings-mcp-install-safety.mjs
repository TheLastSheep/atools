import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const panel = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
const commands = await readFile(new URL("src-tauri/src/commands.rs", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");

function assertOrder(source, labels) {
  let cursor = -1;
  for (const label of labels) {
    const next = source.indexOf(label, cursor + 1);
    assert.notEqual(next, -1, `expected to find ${label}`);
    assert.ok(next > cursor, `expected ${label} after the previous marker`);
    cursor = next;
  }
}

const installStart = panel.indexOf("async function installMcpTemplate(template: McpClientTemplate)");
assert.notEqual(installStart, -1, "SettingsPanel should define installMcpTemplate");
const installEnd = panel.indexOf("\n  async function copyHttpMcpUrl()", installStart);
assert.notEqual(installEnd, -1, "SettingsPanel installMcpTemplate body should end before copyHttpMcpUrl");
const installBody = panel.slice(installStart, installEnd);

assertOrder(installBody, [
  "mcpClientSuggestedTargetPath(template, { homePath })",
  "saveDialog({",
  'title: "选择或新建 MCP 配置 JSON"',
  "defaultPath",
  'filters: [{ name: "JSON", extensions: ["json"] }]',
  "if (!targetPath)",
  'mcpPageStatus = "已取消合并"',
  "return;",
  'invoke<McpClientConfigInstallResult>("install_mcp_client_config"',
  "targetPath",
  "config: template.config",
  'serverName: "atools"',
  "confirmed: true",
  "mcpClientInstallResultText(template, result)",
  "catch (error)",
  "mcpPageStatus = String(error)",
]);

const mergeTestStart = commands.indexOf("fn mcp_client_config_merge_preserves_existing_servers_and_replaces_atools()");
assert.notEqual(mergeTestStart, -1, "Rust tests should cover safe merge preservation");
const mergeTestEnd = commands.indexOf("\n    #[test]", mergeTestStart + 1);
const mergeTestBody = commands.slice(mergeTestStart, mergeTestEnd);
assert.ok(mergeTestBody.includes('merged["theme"]'), "merge should preserve top-level fields");
assert.ok(mergeTestBody.includes('merged["mcpServers"]["other"]["command"]'), "merge should preserve other mcpServers");
assert.ok(
  mergeTestBody.includes('merged["mcpServers"]["atools"].get("command").is_none()'),
  "merge should replace the stale atools server entry"
);

const invalidJsonTestStart = commands.indexOf("fn mcp_client_config_write_rejects_invalid_existing_json_without_overwrite()");
assert.notEqual(invalidJsonTestStart, -1, "Rust tests should reject invalid existing JSON");
const invalidJsonTestEnd = commands.indexOf("\n    #[test]", invalidJsonTestStart + 1);
const invalidJsonTestBody = commands.slice(invalidJsonTestStart, invalidJsonTestEnd);
assert.ok(invalidJsonTestBody.includes("not valid JSON"), "invalid JSON error should be explicit");
assert.ok(invalidJsonTestBody.includes("assert_eq!(std::fs::read_to_string(&target).unwrap(), original)"));
assert.ok(invalidJsonTestBody.includes("assert_eq!(backups, 0)"), "invalid JSON should not create backup side effects");

const nonObjectTestStart = commands.indexOf("fn mcp_client_config_write_rejects_non_object_mcp_servers_without_overwrite()");
assert.notEqual(nonObjectTestStart, -1, "Rust tests should reject non-object mcpServers");
const nonObjectTestEnd = commands.indexOf("\n    #[test]", nonObjectTestStart + 1);
const nonObjectTestBody = commands.slice(nonObjectTestStart, nonObjectTestEnd);
assert.ok(nonObjectTestBody.includes("Existing mcpServers must be a JSON object"));
assert.ok(nonObjectTestBody.includes("assert_eq!(std::fs::read_to_string(&target).unwrap(), original)"));
assert.ok(nonObjectTestBody.includes("assert_eq!(backups, 0)"), "non-object mcpServers should not create backup side effects");

assert.ok(commands.includes("serde_json::from_str::<serde_json::Value>(text)"));
assert.ok(commands.includes("merge_mcp_client_config(existing, config, &server_name)?"));
assert.ok(
  commands.indexOf("serde_json::from_str::<serde_json::Value>(text)") <
    commands.indexOf("let backup_path = if existed && changed"),
  "existing JSON should be parsed and merged before backup/write side effects"
);
assert.ok(
  commands.indexOf("merge_mcp_client_config(existing, config, &server_name)?") <
    commands.indexOf("let backup_path = if existed && changed"),
  "mcpServers shape should be validated before backup/write side effects"
);

const checkedRow = "- [x] 设置页 `MCP 服务` 的配置合并写入必须保留其他 `mcpServers` 和顶层字段；遇到无效 JSON 或非对象 `mcpServers` 时显示错误，不覆盖原文件。";
assert.ok(smokeChecklist.includes(checkedRow), "macOS smoke checklist should mark Settings MCP config merge safety complete");
