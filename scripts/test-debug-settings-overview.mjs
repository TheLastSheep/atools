import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-debug-settings-overview-"));
const outFile = join(outDir, "debugDiagnostics.mjs");

try {
  const sourcePath = new URL("src/lib/debugDiagnostics.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");

  assert.equal(typeof mod.debugOverviewCards, "function", "debugDiagnostics should expose debug overview cards");

  const cards = mod.debugOverviewCards({
    hasTauriRuntime: true,
    runtime: {
      runtime: "Tauri WebView",
      platform: "macos",
      arch: "aarch64",
      debug: true,
      base_dir: "/Users/harris/.atools",
      db_path: "/Users/harris/.atools/data.db",
      plugins_dir: "/Users/harris/.atools/plugins",
      plugin_count: 18,
      feature_count: 42,
      agent_tool_count: 8,
      enabled_agent_tool_count: 8,
      mcp_enabled: true,
      mcp_bind: "127.0.0.1:54164",
      mcp_token: "secret-token",
      active_plugin: "",
      recent_events: [
        { timestamp: "2026-06-02T00:00:00Z", level: "info", message: "started" },
        { timestamp: "2026-06-02T00:01:00Z", level: "error", message: "failed" },
      ],
    },
    mcpStatus: { enabled: true, bind: "127.0.0.1:54164", token: "secret-token" },
    audits: [
      {
        id: "ok",
        timestamp: "2026-06-02T00:00:00Z",
        client_id: "codex",
        tool_name: "search_clipboard",
        input: {},
        output: {},
        status: "success",
        duration_ms: 10,
      },
      {
        id: "deny",
        timestamp: "2026-06-02T00:01:00Z",
        client_id: "codex",
        tool_name: "rename_files",
        input: {},
        output: null,
        status: "denied",
        duration_ms: 20,
      },
    ],
    crashLogs: [
      { timestamp: "2026-06-02T00:02:00Z", message: "panic", location: "src/lib.rs:42", raw: "panic" },
    ],
  });

  assert.deepEqual(cards.map((card) => card.label), [
    "桌面运行时",
    "MCP 服务",
    "审计异常",
    "崩溃日志",
  ]);
  assert.equal(cards.find((card) => card.label === "桌面运行时")?.value, "Tauri WebView / macos-aarch64");
  assert.match(cards.find((card) => card.label === "桌面运行时")?.detail ?? "", /1 条错误事件/);
  assert.equal(cards.find((card) => card.label === "桌面运行时")?.tone, "error");
  assert.equal(cards.find((card) => card.label === "MCP 服务")?.value, "运行中");
  assert.equal(cards.find((card) => card.label === "MCP 服务")?.detail.includes("secret-token"), false);
  assert.equal(cards.find((card) => card.label === "审计异常")?.value, "1 条");
  assert.equal(cards.find((card) => card.label === "审计异常")?.tone, "warning");
  assert.equal(cards.find((card) => card.label === "崩溃日志")?.value, "1 条");
  assert.equal(cards.find((card) => card.label === "崩溃日志")?.tone, "error");

  const previewCards = mod.debugOverviewCards({
    hasTauriRuntime: false,
    runtime: null,
    mcpStatus: null,
    audits: [],
    crashLogs: [],
  });
  assert.equal(previewCards.find((card) => card.label === "桌面运行时")?.value, "浏览器预览");
  assert.equal(previewCards.find((card) => card.label === "MCP 服务")?.value, "桌面端读取");
  assert.equal(previewCards.find((card) => card.label === "审计异常")?.value, "桌面端读取");

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  assert.ok(panel.includes("诊断概览"), "Debug page should render an overview section");
  assert.ok(panel.includes("debugOverviewCards"), "Debug page should use the shared debug overview model");
  assert.ok(panel.includes("环境信息"), "Debug page should expose browser/runtime environment rows");
  assert.ok(panel.includes("桌面运行时"), "Debug page should expose runtime state");
  assert.ok(panel.includes("桌面运行状态"), "Debug page should render desktop runtime diagnostics");
  assert.ok(panel.includes("本地配置状态"), "Debug page should render local configuration diagnostics");
  assert.ok(panel.includes("MCP 服务"), "Debug page should expose MCP state");
  assert.ok(panel.includes("MCP 状态"), "Debug page should render MCP service status");
  assert.ok(panel.includes("审计异常"), "Debug page should expose audit state");
  assert.ok(panel.includes("最近审计错误"), "Debug page should render recent audit errors");
  assert.ok(panel.includes("崩溃日志"), "Debug page should expose crash state");
  assert.ok(panel.includes("脱敏诊断包不会包含 MCP token、AI API Key 或 WebDAV 密码"), "Debug page should explain diagnostic redaction");
  assert.ok(panel.includes("<button class=\"plain-button\" onclick={copyDebugInfo}>复制信息</button>"), "Debug page should wire copy info to the diagnostic bundle action");
  assert.ok(panel.includes("copyText(diagnosticBundleText(currentDiagnosticBundle()))"), "Debug copy info should copy the redacted diagnostic bundle");
  assert.match(
    panel,
    /\.debug-overview-card strong\s*\{[^}]*color:\s*currentColor/s,
    "Debug overview card values should inherit the active theme text color",
  );
  assert.ok(
    smokeChecklist.includes("- [x] 设置页 `调试日志` 不是占位页，显示运行环境、桌面运行状态、本地配置状态、MCP 状态、崩溃日志和最近审计错误。"),
    "macOS smoke checklist should mark the Debug Log page complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
