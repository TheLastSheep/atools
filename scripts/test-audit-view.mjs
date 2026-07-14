import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-audit-view-"));
const outFile = join(outDir, "auditView.mjs");

try {
  const sourcePath = new URL("src/lib/auditView.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  const audit = {
    id: "audit-1",
    timestamp: "2026-06-02T02:00:00.000Z",
    client_id: "codex",
    tool_name: "rename_files",
    input: {
      dryRun: false,
      paths: ["/Users/harris/Downloads/a.pdf", "/Users/harris/Downloads/b.pdf"],
      options: {
        outputPath: "~/Documents/Invoices",
      },
    },
    output: {
      renamed: 2,
      files: ["/Users/harris/Documents/Invoices/a.pdf"],
    },
    status: "success",
    duration_ms: 128.4,
    error: null,
  };

  assert.deepEqual(mod.auditStatusMeta(audit), {
    label: "已完成",
    tone: "success",
  });
  assert.equal(mod.auditDurationLabel(audit.duration_ms), "128ms");
  assert.deepEqual(mod.auditSummaryRows(audit).map((row) => row.label), ["客户端", "工具", "状态", "耗时", "时间"]);
  assert.deepEqual(mod.auditPathSummaries(audit), [
    "/Users/harris/Downloads/a.pdf",
    "/Users/harris/Downloads/b.pdf",
    "~/Documents/Invoices",
    "/Users/harris/Documents/Invoices/a.pdf",
  ]);
  assert.equal(mod.auditPreview(audit.input).includes("paths"), true);
  assert.equal(mod.auditPreview("permission denied"), "permission denied");
  assert.equal(mod.auditDetailValue(null, "无输出"), "无输出");

  const denied = {
    ...audit,
    id: "audit-2",
    status: "denied",
    duration_ms: 1,
    output: null,
    error: "user denied",
  };
  assert.deepEqual(mod.auditStatusMeta(denied), {
    label: "已拒绝",
    tone: "denied",
  });
  assert.equal(mod.auditPreview(denied.error), "user denied");

  const failed = { ...audit, id: "audit-3", status: "error", error: "permission denied" };
  assert.deepEqual(mod.auditStatusMeta(failed), {
    label: "失败",
    tone: "error",
  });

  const confirmedRename = {
    ...audit,
    id: "audit-4",
    status: "confirmed",
    input: {
      dry_run: false,
      operations: [
        {
          source: "/Users/harris/Downloads/invoice.pdf",
          target: "/Users/harris/Documents/Invoices/invoice.pdf",
        },
      ],
    },
    output: {
      operations: [
        {
          source: "/Users/harris/Downloads/invoice.pdf",
          target: "/Users/harris/Documents/Invoices/invoice.pdf",
          status: "renamed",
        },
      ],
    },
    duration_ms: 42,
    error: null,
  };
  const confirmedReplay = mod.auditReplaySummary(confirmedRename);
  assert.equal(confirmedReplay.permissionLabel, "用户确认执行");
  assert.equal(confirmedReplay.executionMode, "已执行");
  assert.equal(confirmedReplay.sideEffectLabel, "有本地副作用");
  assert.equal(confirmedReplay.pathChanges.length, 1);
  assert.deepEqual(confirmedReplay.pathChanges[0], {
    action: "重命名",
    source: "/Users/harris/Downloads/invoice.pdf",
    target: "/Users/harris/Documents/Invoices/invoice.pdf",
    status: "renamed",
  });
  assert.deepEqual(confirmedReplay.steps.map((step) => step.label), [
    "客户端请求",
    "权限结果",
    "执行模式",
    "本地副作用",
    "执行结果",
  ]);
  const confirmedDiff = mod.auditSideEffectDiff(confirmedRename);
  assert.equal(confirmedDiff.summary, "已执行 1 项本地副作用");
  assert.deepEqual(confirmedDiff.rows, [
    {
      action: "重命名",
      before: "/Users/harris/Downloads/invoice.pdf",
      after: "/Users/harris/Documents/Invoices/invoice.pdf",
      status: "renamed",
      tone: "success",
      detail: "用户确认执行",
    },
  ]);

  const dryRunRename = {
    ...confirmedRename,
    id: "audit-5",
    status: "denied",
    input: { ...confirmedRename.input, dry_run: true },
    output: null,
    error: "Permission confirmation required",
  };
  const dryRunReplay = mod.auditReplaySummary(dryRunRename);
  assert.equal(dryRunReplay.permissionLabel, "已拒绝");
  assert.equal(dryRunReplay.executionMode, "dry-run 预览");
  assert.equal(dryRunReplay.sideEffectLabel, "未执行本地修改");
  assert.equal(dryRunReplay.pathChanges.length, 1);
  assert.equal(dryRunReplay.steps.at(-1).label, "执行结果");
  assert.equal(dryRunReplay.steps.at(-1).tone, "denied");
  const dryRunDiff = mod.auditSideEffectDiff(dryRunRename);
  assert.equal(dryRunDiff.summary, "计划 1 项，未执行本地修改");
  assert.equal(dryRunDiff.rows[0].tone, "pending");
  assert.equal(dryRunDiff.rows[0].detail, "dry-run 预览");

  const openPath = {
    ...audit,
    id: "audit-6",
    tool_name: "open_or_reveal_path",
    status: "allowed",
    input: { path: "/Applications/Terminal.app", reveal: true },
    output: { ok: true, path: "/Applications/Terminal.app", reveal: true },
    error: null,
  };
  const openReplay = mod.auditReplaySummary(openPath);
  assert.equal(openReplay.permissionLabel, "策略允许执行");
  assert.deepEqual(openReplay.pathChanges, [
    {
      action: "打开或显示",
      source: "",
      target: "/Applications/Terminal.app",
      status: "ok",
    },
  ]);

  const compressedImages = {
    ...audit,
    id: "audit-10",
    tool_name: "compress_images",
    status: "allowed",
    input: { paths: ["/Users/harris/Desktop/a.png"], output_dir: "/Users/harris/Desktop/out" },
    output: {
      items: [
        {
          input: "/Users/harris/Desktop/a.png",
          output: "/Users/harris/Desktop/out/compressed-a.png",
          status: "compressed",
          original_size: 1000,
          output_size: 420,
        },
      ],
    },
    error: null,
  };
  const imageDiff = mod.auditSideEffectDiff(compressedImages);
  assert.equal(imageDiff.summary, "已执行 1 项本地副作用");
  assert.deepEqual(imageDiff.rows, [
    {
      action: "压缩图片",
      before: "/Users/harris/Desktop/a.png",
      after: "/Users/harris/Desktop/out/compressed-a.png",
      status: "compressed",
      tone: "success",
      detail: "1000B -> 420B，减少 58%",
    },
  ]);

  const targetUnmetImages = {
    ...audit,
    id: "audit-11",
    tool_name: "compress_images",
    status: "allowed",
    input: { paths: ["/Users/harris/Desktop/b.png"], output_dir: "/Users/harris/Desktop/out", max_bytes: 500 },
    output: {
      items: [
        {
          input: "/Users/harris/Desktop/b.png",
          output: "/Users/harris/Desktop/out/compressed-b.png",
          status: "target_unmet",
          original_size: 2000,
          output_size: 760,
          target_size: 500,
          target_met: false,
          target_reason: "Could not reach max_bytes target 500; smallest output is 760 bytes",
        },
      ],
    },
    error: null,
  };
  const targetUnmetDiff = mod.auditSideEffectDiff(targetUnmetImages);
  assert.equal(targetUnmetDiff.summary, "未达标 1 项本地副作用");
  assert.deepEqual(targetUnmetDiff.rows, [
    {
      action: "压缩图片",
      before: "/Users/harris/Desktop/b.png",
      after: "/Users/harris/Desktop/out/compressed-b.png",
      status: "target_unmet",
      tone: "error",
      detail: "2.0KB -> 760B，减少 62%，目标 500B 未达标",
    },
  ]);

  const auditEntries = [
    confirmedRename,
    {
      ...audit,
      id: "audit-7",
      client_id: "claude",
      tool_name: "find_local_files",
      status: "denied",
      input: { root: "/Users/harris/Downloads", query: "invoice" },
      output: null,
      error: "Permission confirmation required",
    },
    {
      ...audit,
      id: "audit-8",
      client_id: "cursor",
      tool_name: "ocr_image",
      status: "error",
      input: { path: "/Users/harris/Desktop/receipt.png" },
      output: null,
      error: "Local OCR service is unavailable",
    },
    {
      ...audit,
      id: "audit-9",
      client_id: "codex",
      tool_name: "search_clipboard",
      status: "allowed",
      input: { query: "api key" },
      output: { items: [{ text: "api key copied last week" }] },
      error: null,
    },
  ];
  const filterOptions = mod.auditFilterOptions(auditEntries);
  assert.deepEqual(filterOptions.toolNames, [
    "find_local_files",
    "ocr_image",
    "rename_files",
    "search_clipboard",
  ]);
  assert.deepEqual(filterOptions.clientIds, ["claude", "codex", "cursor"]);
  assert.deepEqual(filterOptions.statusCounts, {
    all: 4,
    success: 2,
    denied: 1,
    error: 1,
    pending: 0,
    unknown: 0,
  });

  assert.deepEqual(
    mod.filterAuditEntries(auditEntries, {
      query: "invoice",
      status: "success",
      toolName: "rename_files",
      clientId: "codex",
    }).map((entry) => entry.id),
    ["audit-4"],
  );
  assert.deepEqual(
    mod.filterAuditEntries(auditEntries, { query: "ocr service", status: "error" }).map((entry) => entry.id),
    ["audit-8"],
  );
  assert.deepEqual(
    mod.filterAuditEntries(auditEntries, { query: "permission", status: "denied" }).map((entry) => entry.id),
    ["audit-7"],
  );
  assert.deepEqual(
    mod.filterAuditEntries(auditEntries, { query: "/Users/harris/Desktop/receipt.png" }).map((entry) => entry.id),
    ["audit-8"],
  );
  assert.deepEqual(
    mod.filterAuditEntries(auditEntries, { query: "api key", toolName: "search_clipboard", clientId: "codex" }).map((entry) => entry.id),
    ["audit-9"],
  );
  assert.deepEqual(
    mod.filterAuditEntries(auditEntries, { query: "not-present-in-audit" }).map((entry) => entry.id),
    [],
  );
  assert.equal(
    mod.auditFilterSummary(auditEntries, [auditEntries[0]], {
      query: "invoice",
      status: "success",
      toolName: "rename_files",
      clientId: "codex",
    }),
    "显示 1 / 4 条审计 · 4 个筛选条件",
  );

  const overview = mod.auditDataOverview(auditEntries);
  assert.equal(overview.totalLabel, "共 4 条审计记录");
  assert.deepEqual(overview.statusRows, [
    { label: "成功", value: "2 条", tone: "success" },
    { label: "拒绝", value: "1 条", tone: "denied" },
    { label: "失败", value: "1 条", tone: "error" },
    { label: "待确认", value: "0 条", tone: "pending" },
    { label: "未知", value: "0 条", tone: "unknown" },
  ]);
  assert.deepEqual(overview.toolRows, [
    { label: "find_local_files", value: "1 条" },
    { label: "ocr_image", value: "1 条" },
    { label: "rename_files", value: "1 条" },
  ]);
  assert.deepEqual(overview.clientRows, [
    { label: "codex", value: "2 条" },
    { label: "claude", value: "1 条" },
    { label: "cursor", value: "1 条" },
  ]);
  assert.deepEqual(overview.recentRows.map((row) => row.label), [
    "rename_files",
    "find_local_files",
    "ocr_image",
    "search_clipboard",
  ]);
  assert.deepEqual(overview.errorRows.map((row) => row.label), ["find_local_files", "ocr_image"]);
  assert.equal(overview.errorRows[0].detail, "Permission confirmation required");
  assert.equal(mod.auditDataOverview([]).totalLabel, "暂无审计记录");

  const agentPanel = await readFile(new URL("../src/components/AgentPanel.svelte", import.meta.url), "utf8");
  assert.ok(agentPanel.includes('placeholder="工具、客户端、路径、错误、参数"'), "Agent audit search should explain searchable fields");
  assert.ok(agentPanel.includes("没有匹配的审计记录"), "Agent audit list should render an empty result state");
  assert.ok(agentPanel.includes("{auditSummaryText} · 已加载 {audits.length} / {auditTotal} 条"), "Agent audit list should render filter summary and loaded count");
  assert.ok(agentPanel.includes("<h4>回放摘要</h4>"), "Agent audit detail should render replay summary");
  assert.ok(agentPanel.includes("<span>权限结果</span>"), "Replay summary should show permission result");
  assert.ok(agentPanel.includes("<span>执行模式</span>"), "Replay summary should show execution mode");
  assert.ok(agentPanel.includes("<span>本地副作用</span>"), "Replay summary should show local side-effect result");
  assert.ok(agentPanel.includes("<h4>副作用 diff</h4>"), "Agent audit detail should render side-effect diff");
  assert.ok(agentPanel.includes("side-effect-diff-row"), "Side-effect diff should render row-level before/after entries");
  assert.ok(agentPanel.includes("<h4>路径副作用</h4>"), "Agent audit detail should render path side effects");
  assert.ok(agentPanel.includes("path-change-row"), "Path side effects should render source/target/status rows");
  assert.ok(agentPanel.includes(".side-effect-diff-row code"), "Side-effect path cells should have dedicated wrapping styles");
  assert.ok(agentPanel.includes(".path-change-row code"), "Path side-effect cells should have dedicated wrapping styles");
  assert.match(agentPanel, /\.side-effect-diff-row code\s*\{[\s\S]*?overflow-wrap: anywhere;/, "Side-effect diff path cells should wrap long paths");
  assert.match(agentPanel, /\.path-change-row code\s*\{[\s\S]*?overflow-wrap: anywhere;/, "Path side-effect cells should wrap long paths");

  const agentTools = await readFile(new URL("../src-tauri/src/agent_tools.rs", import.meta.url), "utf8");
  assert.ok(agentTools.includes('"format": output_format.as_str()'), "compress_images output should include item format");
  assert.ok(agentTools.includes('"original_size": original_size'), "compress_images output should include original size");
  assert.ok(agentTools.includes('"output_size": output_size'), "compress_images output should include output size");
  assert.ok(agentTools.includes('"target_size": max_bytes'), "compress_images output should include target size");
  assert.ok(agentTools.includes('"target_met": target_met'), "compress_images output should include target hit state");
  assert.ok(agentTools.includes('"compression_ratio": compression_ratio(original_size, output_size)'), "compress_images output should include compression ratio");
  assert.ok(agentTools.includes('"target_unmet"'), "compress_images should report target_unmet when max_bytes is not reached");
  assert.ok(agentTools.includes('CompressionImageFormat::Webp => write_webp_output(&input, &output, max_width)?'), "compress_images should route webp format to WebP encoding");
  assert.ok(agentTools.includes('format!("compressed-{}.webp", stem)'), "compress_images webp output should use compressed-<stem>.webp");
  assert.ok(agentTools.includes("WebPEncoder::new_lossless"), "compress_images webp encoding should be lossless");

  const agentToolTests = await readFile(new URL("../src-tauri/tests/agent_tools_tests.rs", import.meta.url), "utf8");
  const webpTestStart = agentToolTests.indexOf("fn compress_images_writes_webp_output_when_requested");
  assert.notEqual(webpTestStart, -1, "WebP compression should have a Rust regression test");
  const webpTestEnd = agentToolTests.indexOf("\n#[test]", webpTestStart + 1);
  const webpTest = agentToolTests.slice(webpTestStart, webpTestEnd === -1 ? undefined : webpTestEnd);
  assert.ok(webpTest.includes('assert_eq!(item["format"], "webp")'), "WebP regression should assert item format");
  assert.ok(webpTest.includes('assert!(output_path.ends_with("compressed-pixel.webp"))'), "WebP regression should assert output filename");
  assert.ok(webpTest.includes('assert_eq!(&bytes[0..4], b"RIFF")'), "WebP regression should assert RIFF magic");
  assert.ok(webpTest.includes('assert_eq!(&bytes[8..12], b"WEBP")'), "WebP regression should assert WEBP magic");
  assert.ok(webpTest.includes('assert!(item["original_size"].as_u64().unwrap() > 0)'), "WebP regression should assert original size");
  assert.ok(webpTest.includes('assert!(item["output_size"].as_u64().unwrap() > 0)'), "WebP regression should assert output size");
  assert.ok(agentToolTests.includes("compress_images_reports_unmet_size_target_without_claiming_success"), "max_bytes target miss should have a Rust regression test");

  const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assert.ok(
    checklist.includes("- [x] 审计列表支持按关键字、状态、工具、客户端筛选；筛选摘要显示当前匹配数量。"),
    "macOS smoke checklist should mark audit filters and summary complete",
  );
  assert.ok(
    checklist.includes("- [x] 搜索路径、错误文案或参数片段时能命中对应审计；没有匹配时显示空结果提示。"),
    "macOS smoke checklist should mark audit search hit and empty-state verification complete",
  );
  assert.ok(
    checklist.includes("- [x] 展开审计记录后显示 `回放摘要`，包含权限结果、执行模式、本地副作用、执行结果。"),
    "macOS smoke checklist should mark audit replay summary complete",
  );
  assert.ok(
    checklist.includes("- [x] `rename_files`、`compress_images` 审计详情显示 `副作用 diff`，能看出执行/计划状态和 before -> after。"),
    "macOS smoke checklist should mark audit side-effect diff complete",
  );
  assert.ok(
    checklist.includes("- [x] 图片压缩审计的 `副作用 diff` 显示原始大小、输出大小和减少比例。"),
    "macOS smoke checklist should mark image side-effect size diff complete",
  );
  assert.ok(
    checklist.includes("- [x] `compress_images` 传入 `max_bytes` 时返回 `target_size`、`target_met`、`compression_ratio`；未达标时状态为 `target_unmet`，审计 `副作用 diff` 显示目标未达标。"),
    "macOS smoke checklist should mark image compression target details complete",
  );
  assert.ok(
    checklist.includes('- [x] `compress_images` 传入 `format:"webp"` 时输出 `compressed-<stem>.webp`，结果项包含 `format:"webp"`、WebP 文件魔数和原始/输出大小；当前 WebP 为 lossless 编码，不做有损质量调节。'),
    "macOS smoke checklist should mark WebP compression details complete",
  );
  assert.ok(
    checklist.includes("- [x] `rename_files` / `compress_images` / `open_or_reveal_path` 记录在详情中显示 `路径副作用`，源路径、目标路径和状态不被截断到不可读。"),
    "macOS smoke checklist should mark path side-effect details complete",
  );
  assert.ok(
    checklist.includes("- [x] `rename_files` 等带 `dry_run=true` 的调用显示 `dry-run 预览`，不会被误标成直接执行。"),
    "macOS smoke checklist should mark dry-run audit execution mode complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
