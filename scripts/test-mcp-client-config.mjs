import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-mcp-client-config-"));
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

  const status = {
    enabled: true,
    bind: "127.0.0.1:54556",
    token: "local-token",
  };

  assert.equal(mod.mcpHttpUrl(status), "http://127.0.0.1:54556/mcp");
  assert.equal(mod.mcpHttpUrl(null), null);
  assert.equal(mod.maskMcpToken("local-token"), "local-…oken");
  assert.equal(mod.maskMcpToken("abcd"), "••••");
  assert.equal(mod.maskMcpToken(""), "未启动");
  assert.deepEqual(mod.mcpConnectionView(status), {
    statusLabel: "运行中",
    statusTone: "ready",
    httpUrl: "http://127.0.0.1:54556/mcp",
    tokenLabel: "local-…oken",
    tokenAvailable: true,
    recommendedTransport: "http",
    securityHint: "Token 已隐藏；复制 HTTP 配置会包含 Bearer token。",
  });
  assert.deepEqual(mod.mcpConnectionView({ ...status, token: "" }), {
    statusLabel: "等待 token",
    statusTone: "warning",
    httpUrl: "未启动",
    tokenLabel: "未启动",
    tokenAvailable: false,
    recommendedTransport: "stdio",
    securityHint: "HTTP MCP 未就绪；可复制 stdio proxy 配置。",
  });
  assert.deepEqual(mod.mcpConnectionView(null), {
    statusLabel: "未启动",
    statusTone: "offline",
    httpUrl: "未启动",
    tokenLabel: "未启动",
    tokenAvailable: false,
    recommendedTransport: "stdio",
    securityHint: "HTTP MCP 未就绪；可复制 stdio proxy 配置。",
  });

  assert.deepEqual(mod.mcpHttpClientConfig(status), {
    mcpServers: {
      atools: {
        url: "http://127.0.0.1:54556/mcp",
        headers: {
          Authorization: "Bearer local-token",
        },
      },
    },
  });

  assert.deepEqual(mod.mcpStdioClientConfig({ appCommand: "/Applications/ATools.app/Contents/MacOS/ATools" }), {
    mcpServers: {
      atools: {
        command: "/Applications/ATools.app/Contents/MacOS/ATools",
        args: ["--mcp-stdio"],
      },
    },
  });

  assert.equal(
    mod.mcpClientConfig({ status, appCommand: "/fallback" }).mcpServers.atools.url,
    "http://127.0.0.1:54556/mcp"
  );
  assert.equal(
    mod.mcpClientConfig({ status: null, appCommand: "/fallback" }).mcpServers.atools.command,
    "/fallback"
  );
  assert.equal(
    mod.mcpClientConfig({ status: { ...status, token: "" }, appCommand: "/fallback" }).mcpServers.atools.command,
    "/fallback"
  );

  const text = mod.mcpClientConfigText(mod.mcpHttpClientConfig(status));
  assert.equal(text.includes('"Authorization": "Bearer local-token"'), true);
  assert.equal(text.endsWith("\n"), false);

  const templates = mod.mcpClientTemplates({ status, appCommand: "/Applications/ATools.app/Contents/MacOS/ATools" });
  assert.deepEqual(
    templates.map((template) => template.id),
    ["atools-http", "atools-stdio", "claude-desktop", "cursor"]
  );
  assert.equal(templates[0].transport, "http");
  assert.equal(templates[1].transport, "stdio");
  assert.equal(templates[2].config.mcpServers.atools.command, "/Applications/ATools.app/Contents/MacOS/ATools");
  assert.equal(templates[3].config.mcpServers.atools.url, "http://127.0.0.1:54556/mcp");

  const mergedConfig = mod.mergeMcpClientConfig(
    {
      version: 1,
      mcpServers: {
        atools: { command: "/old" },
        existing: { command: "/keep", args: ["--keep"] },
      },
    },
    templates[0].config
  );
  assert.equal(mergedConfig.version, 1);
  assert.deepEqual(mergedConfig.mcpServers.existing, { command: "/keep", args: ["--keep"] });
  assert.deepEqual(mergedConfig.mcpServers.atools, templates[0].config.mcpServers.atools);
  assert.throws(
    () => mod.mergeMcpClientConfig({ mcpServers: [] }, templates[0].config),
    /Existing mcpServers must be a JSON object/
  );
  assert.equal(
    mod.mcpClientSuggestedTargetPath(templates[0], { homePath: "/Users/alice" }),
    "mcp.json"
  );
  assert.equal(
    mod.mcpClientSuggestedTargetPath(templates[2], { homePath: "/Users/alice/" }),
    "/Users/alice/Library/Application Support/Claude/claude_desktop_config.json"
  );
  assert.equal(
    mod.mcpClientSuggestedTargetPath(templates[3], { homePath: "/Users/alice" }),
    "/Users/alice/.cursor/mcp.json"
  );
  assert.equal(
    mod.mcpClientSuggestedTargetPath(templates[3], { homePath: "" }),
    "mcp.json"
  );

  const installPlans = mod.mcpClientInstallPlans({
    status,
    appCommand: "/Applications/ATools.app/Contents/MacOS/ATools",
    homePath: "/Users/alice",
  });
  assert.deepEqual(
    installPlans.map((plan) => plan.templateId),
    templates.map((template) => template.id)
  );
  assert.equal(installPlans.every((plan) => plan.writeAvailable === true), true);
  assert.equal(installPlans.every((plan) => plan.writeReason.includes("写入前会备份")), true);

  const httpPlan = installPlans.find((plan) => plan.templateId === "atools-http");
  assert.equal(httpPlan.targetLabel, "支持 HTTP MCP 的客户端配置");
  assert.equal(httpPlan.targetPath, "客户端 MCP 设置");
  assert.equal(httpPlan.suggestedTargetPath, "mcp.json");
  assert.equal(httpPlan.steps.some((step) => step.includes("选择目标配置 JSON")), true);
  assert.equal(httpPlan.steps.some((step) => step.includes("Authorization Bearer token")), true);

  const stdioPlan = installPlans.find((plan) => plan.templateId === "atools-stdio");
  assert.equal(stdioPlan.targetLabel, "支持 stdio MCP 的客户端配置");
  assert.equal(stdioPlan.suggestedTargetPath, "mcp.json");
  assert.equal(stdioPlan.steps.some((step) => step.includes("--mcp-stdio")), true);

  const claudePlan = installPlans.find((plan) => plan.templateId === "claude-desktop");
  assert.equal(claudePlan.targetLabel, "Claude Desktop / Claude Code MCP 配置");
  assert.equal(claudePlan.suggestedTargetPath, "/Users/alice/Library/Application Support/Claude/claude_desktop_config.json");
  assert.equal(claudePlan.targetPath.includes("~/.claude.json"), true);
  assert.equal(claudePlan.targetPath.includes(".mcp.json"), true);
  assert.equal(claudePlan.steps.some((step) => step.includes("合并 mcpServers.atools")), true);
  assert.equal(claudePlan.steps.some((step) => step.includes("重启或刷新 Claude")), true);

  const cursorPlan = installPlans.find((plan) => plan.templateId === "cursor");
  assert.equal(cursorPlan.targetLabel, "Cursor MCP 配置");
  assert.equal(cursorPlan.suggestedTargetPath, "/Users/alice/.cursor/mcp.json");
  assert.equal(cursorPlan.targetPath.includes("~/.cursor/mcp.json"), true);
  assert.equal(cursorPlan.targetPath.includes(".cursor/mcp.json"), true);
  assert.equal(cursorPlan.steps.some((step) => step.includes("合并 mcpServers.atools")), true);

  const claudeText = mod.mcpClientTemplateText(templates[2]);
  assert.equal(claudeText.includes('"mcpServers"'), true);
  assert.equal(claudeText.includes('"--mcp-stdio"'), true);
  const fallbackTemplates = mod.mcpClientTemplates({ status: { ...status, token: "" }, appCommand: "/fallback" });
  assert.equal(fallbackTemplates.find((template) => template.id === "cursor").transport, "stdio");
  assert.equal(fallbackTemplates.find((template) => template.id === "cursor").config.mcpServers.atools.command, "/fallback");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
