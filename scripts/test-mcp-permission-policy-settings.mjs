import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-mcp-permission-policy-settings-"));
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

  assert.equal(typeof mod.mcpScopePolicyRows, "function", "settingsPages should expose MCP scope policy rows");

  const rows = mod.mcpScopePolicyRows([
    {
      scope: "file_write",
      label: "文件写",
      description: "允许写入、移动或删除本地文件",
      decision: "deny",
      high_risk: true,
    },
    {
      scope: "clipboard_read",
      label: "剪贴板读",
      description: "读取本地剪贴板历史",
      decision: "confirm",
      high_risk: false,
    },
  ]);

  assert.deepEqual(rows.map((row) => row.scope), ["file_write", "clipboard_read"]);
  assert.equal(rows[0].riskLabel, "高风险");
  assert.equal(rows[0].decisionLabel, "阻断");
  assert.equal(rows[0].blocked, true);
  assert.equal(rows[1].riskLabel, "普通");
  assert.equal(rows[1].decisionLabel, "确认");
  assert.equal(rows[1].blocked, false);

  const allScopeRows = mod.mcpScopePolicyRows([
    { scope: "clipboard_read", label: "读取剪贴板", description: "read clipboard", decision: "confirm", high_risk: false },
    { scope: "clipboard_write", label: "写入剪贴板", description: "write clipboard", decision: "confirm", high_risk: false },
    { scope: "file_read", label: "读取文件", description: "read files", decision: "confirm", high_risk: false },
    { scope: "file_write", label: "修改文件", description: "write files", decision: "deny", high_risk: true },
    { scope: "network", label: "网络访问", description: "network", decision: "deny", high_risk: true },
    { scope: "shell", label: "执行命令", description: "shell", decision: "deny", high_risk: true },
    { scope: "screenshot", label: "截图/OCR", description: "screen", decision: "deny", high_risk: true },
    { scope: "browser_context", label: "浏览器上下文", description: "browser context", decision: "confirm", high_risk: false },
    { scope: "plugin_data", label: "插件数据", description: "plugin data", decision: "confirm", high_risk: false },
    { scope: "system_settings", label: "系统设置", description: "system settings", decision: "deny", high_risk: true },
  ]);
  assert.deepEqual(allScopeRows.map((row) => row.scope), [
    "clipboard_read",
    "clipboard_write",
    "file_read",
    "file_write",
    "network",
    "shell",
    "screenshot",
    "browser_context",
    "plugin_data",
    "system_settings",
  ]);
  assert.equal(allScopeRows.filter((row) => row.riskLabel === "高风险").length, 5);
  assert.equal(allScopeRows.filter((row) => row.blocked).length, 5);
  assert.equal(allScopeRows.find((row) => row.scope === "system_settings")?.decisionLabel, "阻断");

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  assert.ok(panel.includes("权限策略"), "MCP page should render a permission policy section");
  assert.ok(panel.includes("权限模式"), "MCP page should render a permission mode control");
  assert.ok(panel.includes("mcpScopePolicyRows"), "MCP page should use the shared scope policy row model");
  assert.ok(panel.includes("set_permission_mode"), "MCP page should persist permission mode changes");
  assert.ok(panel.includes("set_agent_scope_policy"), "MCP page should persist scope policy changes");
  assert.ok(panel.includes("高风险"), "MCP page should expose high-risk scope labels");
  assert.ok(panel.includes("阻断"), "MCP page should expose deny policy controls");
  assert.ok(panel.includes('<option value="confirm">确认</option>'), "MCP page should allow restoring scope policies to confirm");
  assert.ok(panel.includes('<option value="deny">阻断</option>'), "MCP page should allow blocking high-risk scopes");

  const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assert.ok(
    checklist.includes("- [x] 权限区显示所有 scope，支持将高风险 scope 设为 `阻断`，再恢复为 `确认`。"),
    "macOS smoke checklist should mark all-scope policy deny/confirm verification complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
