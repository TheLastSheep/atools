import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const panel = await readFile(new URL("src/components/AgentPanel.svelte", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
const outDir = await mkdtemp(join(root.pathname, ".tmp-agent-panel-mcp-config-"));
const outFile = join(outDir, "mcpClientConfig.mjs");

try {
  const sourcePath = new URL("src/lib/mcpClientConfig.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);
  const mod = await import(pathToFileURL(outFile).href);
  const templates = mod.mcpClientTemplates({
    status: { enabled: true, bind: "127.0.0.1:54556", token: "local-token" },
    appCommand: "/Applications/ATools.app/Contents/MacOS/ATools",
    homePath: "/Users/alice",
  });

  assert.deepEqual(
    templates.map((template) => template.label),
    ["通用 HTTP MCP", "通用 stdio proxy", "Claude Desktop / Claude Code", "Cursor"],
    "shared MCP templates should include the four AgentPanel client options"
  );
  assert.equal(
    mod.mcpClientSuggestedTargetPath(templates[2], { homePath: "/Users/alice" }),
    "/Users/alice/Library/Application Support/Claude/claude_desktop_config.json",
    "Claude template should suggest the known Claude Desktop target path"
  );
  assert.equal(
    mod.mcpClientSuggestedTargetPath(templates[3], { homePath: "/Users/alice" }),
    "/Users/alice/.cursor/mcp.json",
    "Cursor template should suggest the known Cursor target path"
  );

  assert.ok(panel.includes("mcpConnectionView"), "AgentPanel should use the shared MCP connection view model");
  assert.ok(panel.includes("mcpView.httpUrl"), "AgentPanel should render the MCP bind/http URL");
  assert.ok(panel.includes("mcpView.tokenLabel"), "AgentPanel should render a masked MCP token label");
  assert.ok(panel.includes("mcpView.recommendedTransport"), "AgentPanel should render the recommended transport");
  assert.ok(panel.includes("mcpView.securityHint"), "AgentPanel should render token safety guidance");
  assert.ok(panel.includes("copyHttpMcpConfig"), "AgentPanel should expose HTTP MCP config copy");
  assert.ok(panel.includes("copyStdioMcpConfig"), "AgentPanel should expose stdio MCP config copy");
  assert.ok(panel.includes("复制 HTTP 配置"), "AgentPanel should render the HTTP copy button");
  assert.ok(panel.includes("复制 stdio 配置"), "AgentPanel should render the stdio copy button");
  assert.ok(panel.includes("mcpClientTemplates({ status })"), "AgentPanel should use the shared MCP client templates");
  assert.ok(panel.includes("mcpClientInstallPlan(template"), "AgentPanel should render a client install plan for each template");
  assert.ok(panel.includes("installPlan.targetPath"), "AgentPanel should render each template target path");
  assert.ok(panel.includes("installPlan.suggestedTargetPath"), "AgentPanel should render each template suggested target path");
  assert.ok(panel.includes("installPlan.steps"), "AgentPanel should render merge steps for each template");
  assert.ok(panel.includes("installPlan.writeStateLabel"), "AgentPanel should render safe-merge state");
  assert.ok(panel.includes("installPlan.writeActionLabel"), "AgentPanel should render merge-to-file action labels");
  assert.ok(panel.includes("installMcpTemplate(template)"), "AgentPanel should expose merge-to-file actions");
  assert.ok(panel.includes("copyMcpTemplate(template)"), "AgentPanel should expose per-template copy actions");
  assert.ok(panel.includes("saveDialog({"), "AgentPanel merge action should prompt for a target JSON file");
  assert.ok(panel.includes("mcpClientSuggestedTargetPath(template"), "AgentPanel should default file selection to known target paths");

  const checkedRows = [
    "- [x] Agent/MCP 页面显示 MCP bind 地址、脱敏 token、推荐连接方式和 token 安全提示，不直接展示完整 token。",
    "- [x] Agent/MCP 页面可复制 HTTP MCP 配置和 stdio proxy 配置。",
    "- [x] Agent/MCP 页面可分别复制 `通用 HTTP MCP`、`通用 stdio proxy`、`Claude Desktop / Claude Code`、`Cursor` 模板。",
    "- [x] Agent/MCP 页面每个客户端模板显示目标配置位置、合并步骤和 `可安全合并` 状态，并提供 `复制` 与 `合并到文件...` 操作。",
    "- [x] Agent/MCP 页面已知客户端模板显示建议目标路径：Claude Desktop 为 `~/Library/Application Support/Claude/claude_desktop_config.json`，Cursor 全局配置为 `~/.cursor/mcp.json`。",
  ];

  for (const row of checkedRows) {
    assert.ok(smokeChecklist.includes(row), `macOS smoke checklist should mark complete: ${row}`);
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
