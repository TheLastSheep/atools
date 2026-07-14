import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-data-settings-overview-"));
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

  assert.equal(typeof mod.dataOverviewCards, "function", "settingsPages should expose data overview cards");
  const cards = mod.dataOverviewCards({
    settingsStatusLabel: "已保存",
    commandHistoryCount: 3,
    commandHistoryTopLabel: "GitHub",
    clipboardHistoryCount: 12,
    auditCount: 5,
    pluginCount: 2,
    pluginDataDocuments: 7,
    hasTauriRuntime: true,
  });

  assert.deepEqual(cards.map((card) => card.label), [
    "设置数据",
    "最近使用",
    "剪贴板历史",
    "审计记录",
    "插件数据",
  ]);
  assert.equal(cards.find((card) => card.label === "最近使用")?.value, "3 条");
  assert.match(cards.find((card) => card.label === "最近使用")?.detail ?? "", /GitHub/);
  assert.equal(cards.find((card) => card.label === "剪贴板历史")?.value, "12 条");
  assert.match(cards.find((card) => card.label === "剪贴板历史")?.detail ?? "", /Agent 可检索/);
  assert.match(cards.find((card) => card.label === "审计记录")?.detail ?? "", /保留策略/);
  assert.match(cards.find((card) => card.label === "审计记录")?.detail ?? "", /归档/);
  assert.equal(cards.find((card) => card.label === "插件数据")?.value, "7 条文档");

  assert.equal(typeof mod.auditRetentionPolicyRows, "function", "settingsPages should expose audit retention policy rows");
  const retentionRows = mod.auditRetentionPolicyRows({
    retentionDays: 90,
    keepLatest: 1000,
    auditCount: 1234,
    hasTauriRuntime: true,
  });
  assert.deepEqual(retentionRows.map((row) => row.label), ["保留时间", "数量上限", "当前状态"]);
  assert.equal(retentionRows.find((row) => row.label === "保留时间")?.value, "90 天");
  assert.equal(retentionRows.find((row) => row.label === "数量上限")?.value, "1000 条");
  assert.match(retentionRows.find((row) => row.label === "当前状态")?.detail ?? "", /可清理超出策略的旧审计/);

  const previewCards = mod.dataOverviewCards({
    settingsStatusLabel: "浏览器预览",
    commandHistoryCount: 0,
    commandHistoryTopLabel: "",
    clipboardHistoryCount: 0,
    auditCount: 0,
    pluginCount: 0,
    pluginDataDocuments: 0,
    hasTauriRuntime: false,
  });
  assert.equal(previewCards.find((card) => card.label === "剪贴板历史")?.value, "桌面端读取");
  assert.equal(previewCards.find((card) => card.label === "审计记录")?.value, "桌面端读取");

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  assert.ok(panel.includes("数据概览"), "Data page should render a data overview section");
  assert.ok(panel.includes("本地隐私边界"), "Data page should explain the local privacy boundary");
  assert.ok(panel.includes("Agent 只能通过授权工具读取"), "Data page should explain Agent access constraints");
  assert.ok(panel.includes("dataOverviewCards"), "Data page should use the shared data overview model");
  assert.ok(panel.includes("审计保留策略"), "Data page should render audit retention policy");
  assert.ok(panel.includes("pruneAuditEntries"), "Data page should expose an audit retention cleanup action");
  assert.ok(panel.includes('invoke<number>("prune_audit_entries"'), "Data page should call the native audit prune command");
  assert.ok(panel.includes("archiveAudits"), "Data page should expose an audit archive action");
  assert.ok(panel.includes("归档到文件"), "Data page should render an audit archive button");
  assert.ok(panel.includes("atools-audit-archive"), "Data page should use a recognizable audit archive file name");
  assert.ok(panel.includes('invoke<AuditArchiveResult>("archive_audit_entries_jsonl"'), "Data page should call the native audit archive command");

  const checkedRows = [
    "- [x] 设置页 `我的数据` 首屏显示 `数据概览`，包含设置数据、最近使用、剪贴板历史、审计记录、插件数据 5 张概览卡。",
    "- [x] 设置页 `我的数据` 显示 `本地隐私边界`，明确这些数据默认保存在本机，且 `Agent 只能通过授权工具读取` 并写入本地审计。",
    "- [x] 设置页 `我的数据` 显示 `审计数据概览`；无审计时显示空状态，有记录时显示状态分布、Top 工具/客户端、最近记录和异常记录。",
  ];
  for (const row of checkedRows) {
    assert.ok(smokeChecklist.includes(row), `macOS smoke checklist should mark complete: ${row}`);
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
