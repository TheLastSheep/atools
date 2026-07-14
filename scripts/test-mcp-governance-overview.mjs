import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-mcp-governance-overview-"));
const outFile = join(outDir, "settingsPages.mjs");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");

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

  assert.equal(typeof mod.mcpGovernanceOverview, "function", "settingsPages should expose MCP governance overview");

  const overview = mod.mcpGovernanceOverview({
    tools: [
      { name: "search_clipboard", enabled: true, scopes: ["clipboard:read"] },
      { name: "rename_files", enabled: false, scopes: ["file:write"] },
      { name: "ask_ai_model", enabled: true, scopes: ["network"] },
    ],
    scopePolicies: [
      { scope: "clipboard:read", label: "剪贴板读", decision: "confirm", high_risk: false },
      { scope: "file:write", label: "文件写", decision: "deny", high_risk: true },
      { scope: "network", label: "网络", decision: "confirm", high_risk: true },
    ],
    pendingRequestCount: 2,
    permissionMode: "conservative",
    hasTauriRuntime: true,
  });

  assert.deepEqual(overview.cards.map((card) => card.label), [
    "工具白名单",
    "默认权限",
    "高风险 Scope",
    "待确认请求",
  ]);
  assert.equal(overview.cards.find((card) => card.label === "工具白名单")?.value, "2/3 启用");
  assert.equal(overview.cards.find((card) => card.label === "默认权限")?.value, "保守确认");
  assert.equal(overview.cards.find((card) => card.label === "高风险 Scope")?.value, "2 个");
  assert.match(overview.cards.find((card) => card.label === "高风险 Scope")?.detail ?? "", /1 个已阻断/);
  assert.equal(overview.cards.find((card) => card.label === "待确认请求")?.value, "2 条");
  assert.match(overview.auditChain, /本地审计链路/);
  assert.match(overview.auditChain, /副作用/);

  const preview = mod.mcpGovernanceOverview({
    tools: [],
    scopePolicies: [],
    pendingRequestCount: 0,
    permissionMode: "developer",
    hasTauriRuntime: false,
  });
  assert.equal(preview.cards.find((card) => card.label === "工具白名单")?.value, "桌面端读取");
  assert.equal(preview.cards.find((card) => card.label === "默认权限")?.value, "开发者宽松");
  assert.match(preview.auditChain, /桌面应用中查看/);

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  assert.ok(panel.includes("MCP 治理概览"), "MCP page should render a governance overview section");
  assert.ok(panel.includes("mcpGovernanceOverview"), "MCP page should use the shared governance model");
  assert.ok(panel.includes("mcp-governance-card"), "MCP page should render governance cards");
  assert.ok(panel.includes("governance.cards"), "MCP page should render cards from the shared model");
  assert.ok(panel.includes("governance.auditChain"), "MCP page should render the shared audit-chain summary");
  assert.ok(panel.includes("MCP 服务"), "MCP page should render service status and client config sections");
  assert.ok(panel.includes("mcpConnection().tokenLabel"), "MCP page should render a masked token instead of the raw token");
  assert.ok(panel.includes("mcpConnection().securityHint"), "MCP page should render a token safety hint");
  assert.ok(panel.includes("mcpConnection().recommendedTransport"), "MCP page should render a recommended transport");
  assert.ok(panel.includes("客户端模板"), "MCP page should render client templates");
  assert.ok(panel.includes("mcpTemplates()"), "MCP page should render shared MCP client templates");
  assert.ok(panel.includes("mcpInstallPlan(template)"), "MCP page should render target path and merge steps for each template");
  assert.ok(panel.includes("installPlan.writeStateLabel"), "MCP page should render safe merge state labels");
  assert.ok(panel.includes("installPlan.writeActionLabel"), "MCP page should render merge-to-file actions");
  assert.ok(panel.includes("installMcpTemplate(template)"), "MCP page should expose safe merge actions");
  assert.ok(panel.includes("copyMcpTemplate(template)"), "MCP page should expose per-template copy actions");
  assert.ok(panel.includes("权限策略"), "MCP page should render permission policy section");
  assert.ok(panel.includes("mcpScopeRows()"), "MCP page should render all scope policy rows");
  assert.ok(panel.includes("待确认请求"), "MCP page should render pending request section");
  assert.ok(panel.includes("允许一次"), "MCP page should expose allow-once actions");
  assert.ok(panel.includes("允许并记住"), "MCP page should expose allow-and-remember actions");
  assert.ok(panel.includes("持久授权"), "MCP page should render persistent grant section");
  assert.ok(panel.includes("撤销"), "MCP page should expose revoke actions");
  assert.ok(panel.includes("最近调用审计"), "MCP page should render recent audit section");
  assert.ok(panel.includes("打开我的数据"), "MCP page should link to the full data page");

  const checkedRows = [
    "- [x] 设置页 `MCP 服务` 显示脱敏 token、推荐连接方式和 token 安全提示，可复制 MCP 客户端配置。",
    "- [x] 设置页 `MCP 服务` 首屏显示 `MCP 治理概览`，包含 `工具白名单`、`默认权限`、`高风险 Scope`、`待确认请求` 4 张概览卡。",
    "- [x] 设置页 `MCP 服务` 显示 `本地审计链路`，明确 Agent 工具调用会经过权限策略并记录输入输出、权限结果、路径和副作用。",
    "- [x] 设置页 `MCP 服务` 显示 `权限策略`，包含 `权限模式` 下拉和全部 scope 策略行。",
    "- [x] 设置页 `MCP 服务` 的 scope 策略行显示 scope 名称、说明、scope code、`高风险` 标记，以及 `确认` / `阻断` 控制；切换后概览中的高风险阻断数量同步变化。",
    "- [x] 设置页 `MCP 服务` 显示 `待确认请求`，保守确认模式下 pending request 可在这里 `允许一次`、`允许并记住` 或 `拒绝`。",
    "- [x] 设置页 `MCP 服务` 显示 `持久授权`，允许查看客户端/工具授权，并支持 `撤销`。",
    "- [x] 设置页 `MCP 服务` 显示 `最近调用审计`，最近 MCP/Agent 调用记录展示工具、客户端、状态、耗时和简短结果/错误预览。",
    "- [x] 设置页 `MCP 服务` 的 `最近调用审计` 提供 `打开我的数据`，可跳转到完整本地数据/审计概览。",
    "- [x] 设置页 `MCP 服务` 可分别复制上述客户端模板。",
    "- [x] 设置页 `MCP 服务` 每个客户端模板显示目标配置位置、合并步骤和 `可安全合并` 状态，并提供 `复制` 与 `合并到文件...` 操作。",
    "- [x] 设置页 `MCP 服务` 已知客户端模板显示建议目标路径，并在桌面端文件选择器中默认指向该路径。",
  ];
  for (const row of checkedRows) {
    assert.ok(smokeChecklist.includes(row), `macOS smoke checklist should mark complete: ${row}`);
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
