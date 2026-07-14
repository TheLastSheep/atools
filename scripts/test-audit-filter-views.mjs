import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-audit-filter-views-"));
const outFile = join(outDir, "auditFilterViews.mjs");

try {
  const sourcePath = new URL("src/lib/auditFilterViews.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.equal(mod.AUDIT_FILTER_VIEWS_STORAGE_KEY, "atools:audit-filter-views");

  const filters = {
    query: " permission denied ",
    status: "denied",
    toolName: " open_or_reveal_path ",
    clientId: " codex ",
  };

  assert.deepEqual(mod.normalizeAuditFilterViewFilters(filters), {
    query: "permission denied",
    status: "denied",
    toolName: "open_or_reveal_path",
    clientId: "codex",
  });
  assert.equal(
    mod.auditFilterViewLabel(filters),
    "搜索: permission denied · 状态: denied · 工具: open_or_reveal_path · 客户端: codex",
  );
  assert.equal(mod.auditFilterViewLabel({}), "全部审计");

  const created = mod.upsertAuditFilterView([], {
    label: " Denied opens ",
    filters,
    updatedAt: "2026-06-03T09:00:00Z",
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].label, "Denied opens");
  assert.equal(created[0].updatedAt, "2026-06-03T09:00:00Z");
  assert.deepEqual(created[0].filters, mod.normalizeAuditFilterViewFilters(filters));

  const updated = mod.upsertAuditFilterView(created, {
    label: "Denied opens",
    filters: { ...filters, query: "invoice" },
    updatedAt: "2026-06-03T09:10:00Z",
  });
  assert.equal(updated.length, 1, "same label should replace the saved view");
  assert.equal(updated[0].id, created[0].id);
  assert.equal(updated[0].filters.query, "invoice");
  assert.equal(updated[0].updatedAt, "2026-06-03T09:10:00Z");

  assert.deepEqual(mod.removeAuditFilterView(updated, updated[0].id), []);

  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  mod.saveAuditFilterViews([
    ...updated,
    { id: "", label: "", filters: { status: "all" }, updatedAt: "" },
  ]);
  assert.equal(storage.has(mod.AUDIT_FILTER_VIEWS_STORAGE_KEY), true);
  assert.deepEqual(mod.loadAuditFilterViews(), updated);

  const agentPanel = await readFile(new URL("../src/components/AgentPanel.svelte", import.meta.url), "utf8");
  assert.ok(agentPanel.includes("loadAuditFilterViews"), "Agent panel should load saved audit filter views");
  assert.ok(agentPanel.includes("saveCurrentAuditFilterView"), "Agent panel should save the current audit filter view");
  assert.ok(agentPanel.includes("applyAuditFilterView"), "Agent panel should apply a saved audit filter view");
  assert.ok(agentPanel.includes("deleteAuditFilterView"), "Agent panel should delete saved audit filter views");
  assert.ok(agentPanel.includes("保存视图"), "Agent panel should render a save-view action");
  assert.ok(agentPanel.includes("已保存视图"), "Agent panel should render saved-view controls");
  const emptyAuditIndex = agentPanel.indexOf("{#if audits.length === 0}");
  const emptyAuditCloseIndex = agentPanel.indexOf("{/if}", emptyAuditIndex);
  const filtersIndex = agentPanel.indexOf('<div class="audit-filters">');
  assert.ok(emptyAuditIndex > -1, "Agent panel should render a no-audit empty state");
  assert.ok(
    filtersIndex > emptyAuditCloseIndex,
    "Agent panel should keep audit filters visible even when there are no audit rows",
  );

  const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assert.ok(
    checklist.includes("- [x] 审计筛选可保存为命名视图；选择已保存视图后可应用 query/status/tool/client，删除后不再出现在 `已保存视图` 下拉，刷新页面后保存结果仍保留。"),
    "macOS smoke checklist should mark saved audit filter views complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
