import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-mcp-audit-settings-"));
const outFile = join(outDir, "settingsPages.mjs");

try {
  const sourcePath = new URL("src/lib/settingsPages.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.equal(typeof mod.mcpAuditRows, "function", "settingsPages should expose MCP audit rows");

  const rows = mod.mcpAuditRows([
    {
      id: "audit-1",
      timestamp: "2026-06-03T07:20:00Z",
      client_id: "codex",
      tool_name: "rename_files",
      input: { dry_run: true, files: ["/tmp/a.txt"] },
      output: { planned: 1 },
      status: "success",
      duration_ms: 42.4,
      error: null,
    },
    {
      id: "audit-2",
      timestamp: "2026-06-03T07:21:00Z",
      client_id: "claude-code",
      tool_name: "open_or_reveal_path",
      input: { path: "/tmp/a.txt" },
      output: null,
      status: "denied",
      duration_ms: 1,
      error: "user denied",
    },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].toolName, "rename_files");
  assert.equal(rows[0].clientId, "codex");
  assert.equal(rows[0].statusLabel, "已完成");
  assert.equal(rows[0].tone, "success");
  assert.equal(rows[0].durationLabel, "42ms");
  assert.match(rows[0].preview, /planned/);
  assert.equal(rows[1].statusLabel, "已拒绝");
  assert.equal(rows[1].tone, "denied");
  assert.match(rows[1].preview, /user denied/);

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  assert.ok(panel.includes("最近调用审计"), "MCP page should render recent audit section");
  assert.ok(panel.includes("mcpAuditRows"), "MCP page should use the shared audit row model");
  assert.ok(panel.includes("list_audit_entries"), "MCP page should load recent audit entries");
  assert.ok(panel.includes("打开我的数据"), "MCP page should link to the full data/audit page");
  assert.ok(panel.includes("mcpAuditListRows"), "MCP page should expose audit rows to the template");

  const agentPanel = await readFile(new URL("../src/components/AgentPanel.svelte", import.meta.url), "utf8");
  assert.ok(agentPanel.includes("query_audit_entries_page"), "Agent panel should use paged audit query");
  assert.ok(agentPanel.includes("auditTotal"), "Agent panel should track audit total count");
  assert.ok(agentPanel.includes("loadMoreAudits"), "Agent panel should expose a load-more audit action");
  assert.ok(agentPanel.includes("auditFilterKey"), "Agent panel should react to audit filter changes");
  assert.ok(agentPanel.includes("reloadAuditsForFilters"), "Agent panel should reload the first audit page when filters change");
  assert.ok(agentPanel.includes("加载更多"), "Agent panel should render a load-more button");
  assert.ok(agentPanel.includes("applyAuditPage(await queryAuditPage(audits.length), true)"), "Agent panel should append the next audit page without clearing current rows");
  assert.ok(agentPanel.includes("auditBackendQuery(auditPageLimit, offset)"), "Agent panel should keep current backend filters when loading more audit rows");
  assert.ok(agentPanel.includes("query: normalizedFilterValue(auditQuery)"), "Agent audit backend query should include keyword filters");
  assert.ok(agentPanel.includes("status: normalizedFilterValue(auditStatusFilter)"), "Agent audit backend query should include status filters");
  assert.ok(agentPanel.includes("tool_name: normalizedFilterValue(auditToolFilter)"), "Agent audit backend query should include tool filters");
  assert.ok(agentPanel.includes("client_id: normalizedFilterValue(auditClientFilter)"), "Agent audit backend query should include client filters");
  const auditSection = agentPanel.slice(agentPanel.indexOf("<h3>审计回放</h3>"));
  assert.match(auditSection, /onclick=\{reloadAuditsForFilters\}>刷新<\/button>/, "Agent audit section should refresh the current filtered audit page");
  assert.match(auditSection, /onclick=\{exportAudits\}>导出<\/button>/, "Agent audit section should export audit JSONL");
  assert.match(auditSection, /disabled=\{busyKey === "audit:clear"\} onclick=\{clearAudits\}>清空<\/button>/, "Agent audit section should disable clear while clearing audit entries");
  assert.ok(agentPanel.includes("export_audit_entries_jsonl_filtered"), "Agent audit export should use the filtered JSONL backend command");
  assert.ok(agentPanel.includes("copyText(jsonl)"), "Agent audit export should copy JSONL to the clipboard fallback helper");
  assert.ok(agentPanel.includes("已复制 ${count} 条 JSONL"), "Agent audit export should report copied JSONL count");
  assert.ok(agentPanel.includes("当前筛选"), "Agent audit export should label filtered exports");
  assert.ok(agentPanel.includes("clear_audit_entries"), "Agent audit clear should call the native clear command");
  assert.ok(agentPanel.includes('busyKey = "audit:clear"'), "Agent audit clear should expose a busy state");
  assert.ok(agentPanel.includes("已清空 ${count} 条审计记录"), "Agent audit clear should report the cleared audit count");

  const commands = await readFile(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");
  assert.ok(commands.includes("pub fn clear_audit_entries"), "Tauri commands should expose audit clearing");
  assert.ok(commands.includes("pub fn export_audit_entries_jsonl_filtered"), "Tauri commands should expose filtered audit JSONL export");

  const coreDb = await readFile(new URL("../crates/atools-core/src/db.rs", import.meta.url), "utf8");
  assert.ok(coreDb.includes("pub fn clear_audit_entries"), "core database should support audit clearing");
  assert.ok(coreDb.includes("pub fn export_audit_entries_jsonl_filtered"), "core database should support filtered audit JSONL export");

  const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assert.ok(
    checklist.includes("- [x] 审计列表可刷新、清空、导出 JSONL 到剪贴板。"),
    "macOS smoke checklist should mark audit refresh/clear/copy JSONL verification complete",
  );
  assert.ok(
    checklist.includes("- [x] 审计列表显示 `已加载 x / y 条`；当匹配审计超过首屏页大小时显示 `加载更多`，点击后追加下一页且不清空当前筛选。"),
    "macOS smoke checklist should mark audit loaded-count and load-more verification complete",
  );
  assert.ok(
    checklist.includes("- [x] 审计列表设置关键字/状态/工具/客户端筛选后，点击“导出”只导出当前筛选结果，成功提示包含“当前筛选”。"),
    "macOS smoke checklist should mark filtered audit export verification complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
