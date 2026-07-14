import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-web-quick-open-overview-"));
const outFile = join(outDir, "webQuickOpen.mjs");

try {
  const matchSourcePath = new URL("src/lib/searchMatch.ts", root).pathname;
  const matchSource = await readFile(matchSourcePath, "utf8");
  const transformedMatch = await transformWithEsbuild(matchSource, matchSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "searchMatch.mjs"), transformedMatch.code);

  const sourcePath = new URL("src/lib/webQuickOpen.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code.replaceAll('from "./searchMatch";', 'from "./searchMatch.mjs";'));

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");

  assert.equal(typeof mod.webQuickOpenOverviewCards, "function", "webQuickOpen should expose overview cards");
  assert.deepEqual(
    mod.DEFAULT_WEB_QUICK_OPEN_ENTRIES.map((entry) => entry.name),
    ["Google", "GitHub", "NPM"],
    "Web quick-open defaults should include the expected Google/GitHub/NPM cards",
  );

  const cards = mod.webQuickOpenOverviewCards({
    entries: [
      { id: "g", name: "Google", keyword: "g", template: "https://google.com/search?q={query}", enabled: true },
      { id: "docs", name: "Docs", keyword: "docs", template: "https://example.com/docs", enabled: true },
      { id: "gh", name: "GitHub", keyword: "gh", template: "https://github.com/search?q={query}", enabled: false },
    ],
    statusLabel: "已保存网页快开",
  });

  assert.deepEqual(cards.map((card) => card.label), [
    "快开入口",
    "搜索模板",
    "固定网址",
    "保存状态",
  ]);
  assert.equal(cards.find((card) => card.label === "快开入口")?.value, "2/3 启用");
  assert.match(cards.find((card) => card.label === "快开入口")?.detail ?? "", /1 个停用/);
  assert.equal(cards.find((card) => card.label === "快开入口")?.tone, "ready");
  assert.equal(cards.find((card) => card.label === "搜索模板")?.value, "2 个");
  assert.match(cards.find((card) => card.label === "搜索模板")?.detail ?? "", /g rust/);
  assert.equal(cards.find((card) => card.label === "固定网址")?.value, "1 个");
  assert.match(cards.find((card) => card.label === "固定网址")?.detail ?? "", /docs/);
  assert.equal(cards.find((card) => card.label === "保存状态")?.value, "已保存网页快开");
  assert.match(cards.find((card) => card.label === "保存状态")?.detail ?? "", /只保存在本机/);
  assert.equal(cards.find((card) => card.label === "保存状态")?.tone, "private");

  const disabledCards = mod.webQuickOpenOverviewCards({
    entries: [
      { id: "off", name: "Off", keyword: "off", template: "https://example.com", enabled: false },
    ],
    statusLabel: "",
  });
  assert.equal(disabledCards.find((card) => card.label === "快开入口")?.value, "0/1 启用");
  assert.equal(disabledCards.find((card) => card.label === "快开入口")?.tone, "warning");
  assert.equal(disabledCards.find((card) => card.label === "搜索模板")?.value, "0 个");
  assert.equal(disabledCards.find((card) => card.label === "搜索模板")?.tone, "warning");

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  assert.ok(panel.includes("webQuickOpenOverviewCards"), "Web quick-open page should use the shared overview model");
  assert.ok(panel.includes("网页快开概览"), "Web quick-open page should render an overview section first");
  assert.ok(panel.includes("快开配置"), "Web quick-open page should move entry cards under a configuration section");
  assert.ok(panel.includes("名称、关键字和 URL 模板只保存在本机"), "Web quick-open page should state the local data boundary");
  assert.match(panel, /class="web-quick-overview-grid"/);
  assert.match(panel, /class="web-quick-overview-card"/);
  assert.match(panel, /class="web-quick-keyword-chip"/, "Web quick-open cards should expose keyword chips");
  assert.match(panel, /class="web-quick-preview-url"/, "Web quick-open cards should expose URL previews");
  assert.match(panel, /class="web-quick-card-actions"/, "Web quick-open cards should expose row actions");
  assert.match(panel, /\.web-quick-preview-url\s*\{[^}]*overflow-wrap:\s*anywhere/s, "Web quick-open URL previews should wrap long URLs");
  assert.match(panel, /\.web-quick-preview-url\s*\{[^}]*word-break:\s*break-word/s, "Web quick-open URL previews should avoid horizontal overflow");
  assert.ok(
    smokeChecklist.includes("- [x] 设置页 `网页快开` 以卡片列表展示 Google/GitHub/NPM 等默认项，卡片包含启停、关键字 chip、URL 预览和 `编辑` / `预览` / `删除` 操作，页面无横向溢出。"),
    "macOS smoke checklist should mark the Web quick-open card list complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
