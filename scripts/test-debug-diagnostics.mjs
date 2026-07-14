import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-debug-diagnostics-"));
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

  const diagnostics = mod.localDataDiagnostics({
    aliases: [
      { id: "a", alias: "cfg", targetCode: "system:settings", enabled: true },
      { id: "b", alias: "off", targetCode: "system:mcp", enabled: false },
    ],
    history: [
      {
        code: "system:settings",
        label: "设置",
        explain: "打开工具设置",
        plugin_id: "system",
        plugin_name: "ATools",
        input: "sz",
        usedAt: "2026-06-02T01:00:00.000Z",
        useCount: 3,
      },
    ],
    localLaunchEntries: [
      { id: "desktop", name: "桌面", keyword: "desktop", path: "~/Desktop", kind: "folder", enabled: true },
      { id: "old", name: "旧路径", keyword: "old", path: "~/Old", kind: "folder", enabled: false },
    ],
    webQuickOpenEntries: [
      { id: "google", name: "Google", keyword: "g", template: "https://google.com?q={query}", enabled: true },
      { id: "off", name: "Disabled", keyword: "off", template: "https://example.com?q={query}", enabled: false },
    ],
    settings: {
      hotkey: "Option+Z",
      theme: "system",
      primaryColor: "purple",
      searchMode: "aggregate",
    },
  });

  assert.deepEqual(diagnostics.map((row) => row.label), [
    "自定义别名",
    "最近使用",
    "本地启动",
    "网页快开",
    "主题",
    "呼出快捷键",
    "搜索模式",
  ]);
  assert.equal(diagnostics[0].value, "2 条 / 1 条启用");
  assert.equal(diagnostics[1].value, "1 条 / 设置");
  assert.equal(diagnostics[2].value, "2 项 / 1 项启用");
  assert.equal(diagnostics[3].value, "2 项 / 1 项启用");

  const auditErrors = mod.auditErrorSummaries([
    {
      id: "ok",
      timestamp: "2026-06-02T00:00:00.000Z",
      client_id: "codex",
      tool_name: "search_clipboard",
      input: {},
      output: {},
      status: "success",
      duration_ms: 10,
    },
    {
      id: "fail",
      timestamp: "2026-06-02T00:01:00.000Z",
      client_id: "claude",
      tool_name: "rename_files",
      input: { paths: ["/tmp/a.txt"] },
      output: null,
      status: "error",
      duration_ms: 42,
      error: "permission denied",
    },
    {
      id: "deny",
      timestamp: "2026-06-02T00:02:00.000Z",
      client_id: "",
      tool_name: "compress_images",
      input: {},
      output: null,
      status: "denied",
      duration_ms: 1,
    },
  ], 1);

  assert.equal(auditErrors.length, 1);
  assert.deepEqual(auditErrors[0], {
    id: "deny",
    toolName: "compress_images",
    clientId: "unknown",
    timestamp: "2026-06-02T00:02:00.000Z",
    status: "denied",
    message: "denied",
    duration: "1ms",
  });

  const runtimeRows = mod.runtimeDiagnosticRows({
    runtime: "Tauri WebView",
    platform: "macos",
    arch: "aarch64",
    debug: true,
    base_dir: "/Users/harris/.atools",
    db_path: "/Users/harris/.atools/data.db",
    plugins_dir: "/Users/harris/.atools/plugins",
    plugin_count: 18,
    feature_count: 42,
    agent_tool_count: 7,
    enabled_agent_tool_count: 6,
    mcp_enabled: true,
    mcp_bind: "127.0.0.1:17321",
    mcp_token: "secret-token",
    active_plugin: "json-viewer",
    recent_events: [
      { timestamp: "2026-06-02T00:03:00.000Z", level: "info", message: "ATools started" },
      { timestamp: "2026-06-02T00:04:00.000Z", level: "error", message: "Failed to load builtin plugin" },
    ],
  });

  assert.deepEqual(runtimeRows.map((row) => row.label), [
    "桌面运行时",
    "数据目录",
    "数据库",
    "插件目录",
    "插件/指令",
    "Agent 工具",
    "MCP 服务",
    "当前插件",
    "最近主进程事件",
  ]);
  assert.equal(runtimeRows[0].value, "Tauri WebView / macos-aarch64");
  assert.equal(runtimeRows[4].value, "18 插件 / 42 指令");
  assert.equal(runtimeRows[5].value, "7 工具 / 6 启用");
  assert.equal(runtimeRows[6].value, "运行中 / 127.0.0.1:17321");
  assert.equal(runtimeRows[6].detail.includes("secret-token"), false);
  assert.equal(runtimeRows[8].tone, "error");

  const crashRows = mod.crashLogSummaries([
    {
      timestamp: "2026-06-02T13:00:00Z",
      message: "panic payload",
      location: "src/lib.rs:42",
      raw: "[2026-06-02T13:00:00Z] panic: panic payload at src/lib.rs:42",
    },
  ]);
  assert.equal(crashRows.length, 1);
  assert.equal(crashRows[0].title, "2026-06-02T13:00:00Z");
  assert.equal(crashRows[0].detail, "panic payload · src/lib.rs:42");
  assert.equal(crashRows[0].raw.includes("panic payload"), true);

  const diagnosticBundle = mod.buildDiagnosticBundle({
    generatedAt: "2026-06-02T12:00:00.000Z",
    aliases: [
      { id: "a", alias: "cfg", targetCode: "system:settings", enabled: true },
      { id: "b", alias: "off", targetCode: "system:mcp", enabled: false },
    ],
    history: [
      {
        code: "system:settings",
        label: "设置",
        explain: "打开工具设置",
        plugin_id: "system",
        plugin_name: "ATools",
        input: "sz",
        usedAt: "2026-06-02T01:00:00.000Z",
        useCount: 3,
      },
    ],
    localLaunchEntries: [
      { id: "desktop", name: "桌面", keyword: "desktop", path: "~/Desktop", kind: "folder", enabled: true },
    ],
    webQuickOpenEntries: [
      { id: "google", name: "Google", keyword: "g", template: "https://google.com?q={query}", enabled: true },
    ],
    settings: {
      hotkey: "Option+Z",
      launchAtLogin: true,
      showTrayIcon: false,
      theme: "dark",
      primaryColor: "green",
      searchMode: "aggregate",
      clipboardRetentionDays: 90,
      aiProvider: "openai",
      aiBaseUrl: "https://api.openai.com/v1",
      aiDefaultModel: "gpt-4.1-mini",
      aiApiKey: "sk-secret-key",
      proxyEnabled: true,
      proxyUrl: "http://user:pass@127.0.0.1:7890",
      webdavEnabled: true,
      webdavUrl: "https://dav.example.com",
      webdavUsername: "harris",
      webdavPassword: "dav-secret",
    },
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
      agent_tool_count: 7,
      enabled_agent_tool_count: 6,
      mcp_enabled: true,
      mcp_bind: "127.0.0.1:17321",
      active_plugin: "",
      recent_events: [
        { timestamp: "2026-06-02T00:03:00.000Z", level: "info", message: "ATools started" },
        { timestamp: "2026-06-02T00:04:00.000Z", level: "error", message: "Failed to load builtin plugin" },
      ],
    },
    mcpStatus: {
      enabled: true,
      bind: "127.0.0.1:17321",
      token: "secret-token",
    },
    audits: [
      {
        id: "audit-ok",
        timestamp: "2026-06-02T00:00:00.000Z",
        client_id: "codex",
        tool_name: "search_clipboard",
        input: {},
        output: {},
        status: "success",
        duration_ms: 10,
      },
      {
        id: "audit-denied",
        timestamp: "2026-06-02T00:02:00.000Z",
        client_id: "claude",
        tool_name: "rename_files",
        input: { paths: ["/tmp/a.txt"] },
        output: null,
        status: "denied",
        duration_ms: 1,
      },
      {
        id: "audit-error",
        timestamp: "2026-06-02T00:03:00.000Z",
        client_id: "cursor",
        tool_name: "ocr_image",
        input: {},
        output: null,
        status: "error",
        duration_ms: 30,
        error: "OCR service unavailable",
      },
    ],
    clipboardHistoryCount: 4,
    pluginDataSummary: [
      { plugin: { id: "json", name: "JSON 工具", version: "1.0.0" }, documents: 2 },
    ],
    crashLogs: [
      {
        timestamp: "2026-06-02T13:00:00Z",
        message: "panic payload",
        location: "src/lib.rs:42",
        raw: "[2026-06-02T13:00:00Z] panic: panic payload at src/lib.rs:42",
      },
    ],
  });

  assert.equal(diagnosticBundle.kind, "atools_diagnostic_bundle");
  assert.equal(diagnosticBundle.generatedAt, "2026-06-02T12:00:00.000Z");
  assert.equal(diagnosticBundle.runtime.connected, true);
  assert.equal(diagnosticBundle.runtime.mcp.enabled, true);
  assert.equal(diagnosticBundle.localData.aliases.total, 2);
  assert.equal(diagnosticBundle.localData.aliases.enabled, 1);
  assert.equal(diagnosticBundle.localData.clipboardHistory.total, 4);
  assert.equal(diagnosticBundle.localData.pluginData.documents, 2);
  assert.equal(diagnosticBundle.audits.denied, 1);
  assert.equal(diagnosticBundle.audits.error, 1);
  assert.equal(diagnosticBundle.crashes.total, 1);
  assert.equal(diagnosticBundle.settings.aiApiKey, "<redacted>");
  assert.equal(diagnosticBundle.settings.proxyEnabled, true);
  assert.equal(diagnosticBundle.settings.proxyUrl, "<redacted>");
  assert.equal(diagnosticBundle.settings.webdavPassword, "<redacted>");
  assert.ok(diagnosticBundle.warnings.includes("主进程最近有错误事件"));
  assert.ok(diagnosticBundle.warnings.includes("最近审计有 2 条拒绝/失败"));
  assert.ok(diagnosticBundle.warnings.includes("存在 1 条崩溃日志"));

  const diagnosticText = mod.diagnosticBundleText(diagnosticBundle);
  assert.equal(diagnosticText.includes("atools_diagnostic_bundle"), true);
  assert.equal(diagnosticText.includes("secret-token"), false);
  assert.equal(diagnosticText.includes("sk-secret-key"), false);
  assert.equal(diagnosticText.includes("dav-secret"), false);
  assert.equal(diagnosticText.includes("user:pass"), false);
  assert.ok(
    smokeChecklist.includes("- [x] `调试日志` 中点击 `复制信息` 后复制的是 `atools_diagnostic_bundle` 脱敏诊断包，不包含 MCP token、AI API Key、WebDAV 密码等敏感字段。"),
    "macOS smoke checklist should mark the Debug Log copy-info diagnostic bundle complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
