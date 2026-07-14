import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const panel = await readFile(new URL("src/components/AgentPanel.svelte", root), "utf8");
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
assert.notEqual(installStart, -1, "AgentPanel should define installMcpTemplate");
const installEnd = panel.indexOf("\n  function mcpTemplates()", installStart);
assert.notEqual(installEnd, -1, "AgentPanel installMcpTemplate body should end before mcpTemplates");
const installBody = panel.slice(installStart, installEnd);

assertOrder(installBody, [
  "mcpClientSuggestedTargetPath(template, { homePath })",
  "saveDialog({",
  'title: "选择或新建 MCP 配置 JSON"',
  "defaultPath",
  'filters: [{ name: "JSON", extensions: ["json"] }]',
  "if (!targetPath)",
  'mcpCopyStatus = "已取消合并"',
  "return;",
  'invoke<McpClientConfigInstallResult>("install_mcp_client_config"',
  "targetPath",
  "config: template.config",
  'serverName: "atools"',
  "confirmed: true",
]);

const writeTestStart = commands.indexOf("fn mcp_client_config_write_requires_confirmation_and_backs_up_existing_file()");
assert.notEqual(writeTestStart, -1, "Rust tests should cover confirmed writes and backup behavior");
const writeTestEnd = commands.indexOf("\n    #[test]", writeTestStart + 1);
const writeTestBody = commands.slice(writeTestStart, writeTestEnd);
assert.ok(writeTestBody.includes("write_mcp_client_config_file(&target, desired.clone(), \"atools\", false).unwrap_err()"));
assert.ok(writeTestBody.includes("assert!(!target.exists())"), "cancel/unconfirmed path should not create target config");
assert.ok(writeTestBody.includes("backup_path.expect(\"backup path\")"), "existing config writes should expose backup path");
assert.ok(writeTestBody.includes("std::path::Path::new(&backup_path).is_file()"), "backup path should point to a real file");
assert.ok(writeTestBody.includes('written["mcpServers"]["other"]["command"]'), "write should preserve other mcpServers");
assert.ok(writeTestBody.includes('written["mcpServers"]["atools"]["args"]'), "write should replace or add only mcpServers.atools");

const mergeTestStart = commands.indexOf("fn mcp_client_config_merge_preserves_existing_servers_and_replaces_atools()");
assert.notEqual(mergeTestStart, -1, "Rust tests should cover merge shape");
const mergeTestEnd = commands.indexOf("\n    #[test]", mergeTestStart + 1);
const mergeTestBody = commands.slice(mergeTestStart, mergeTestEnd);
assert.ok(mergeTestBody.includes('merged["theme"]'), "merge should preserve top-level fields");
assert.ok(mergeTestBody.includes('merged["mcpServers"]["other"]["command"]'), "merge should preserve other MCP servers");
assert.ok(
  mergeTestBody.includes('merged["mcpServers"]["atools"].get("command").is_none()'),
  "merge should replace stale atools server entries"
);

assert.ok(commands.includes("if !confirmed"), "write implementation should require explicit confirmation");
assert.ok(commands.includes("Existing MCP client config must be a JSON object"));
assert.ok(commands.includes("Existing mcpServers must be a JSON object"));
assert.ok(commands.includes('servers.insert(server_name, desired_server)'), "merge should only replace the named server");
assert.ok(commands.includes(".atools-backup-"), "existing file writes should create an atools backup path");
assert.ok(commands.includes("std::fs::copy(target_path, &backup)"), "existing file writes should copy the backup before writing");

const checkedRow = "- [x] Agent/MCP 页面点击 `合并到文件...` 必须先弹出目标 JSON 文件选择；取消选择时不写入，选择已有 JSON 时写入前生成同目录 `*.atools-backup-*`，且只替换或新增 `mcpServers.atools`。";
assert.ok(smokeChecklist.includes(checkedRow), "macOS smoke checklist should mark AgentPanel MCP merge-to-file behavior complete");
