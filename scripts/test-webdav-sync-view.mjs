import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-webdav-sync-view-"));
const outFile = join(outDir, "webdavSyncView.mjs");

try {
  const sourcePath = new URL("src/lib/webdavSyncView.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");

  function assertSmokeItemChecked(text) {
    assert.ok(
      smokeChecklist.includes(`- [x] ${text}`),
      `macOS smoke checklist should mark WebDAV item complete: ${text}`,
    );
  }

  assert.deepEqual(mod.webdavSyncButtonState({
    hasTauriRuntime: false,
    enabled: true,
    configReady: true,
    syncing: false,
  }), {
    disabled: true,
    label: "立即同步",
    reason: "需在桌面应用中同步",
  });

  assert.deepEqual(mod.webdavSyncButtonState({
    hasTauriRuntime: true,
    enabled: false,
    configReady: true,
    syncing: false,
  }), {
    disabled: true,
    label: "立即同步",
    reason: "请先启用 WebDAV 配置",
  });

  assert.deepEqual(mod.webdavSyncButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: true,
  }), {
    disabled: true,
    label: "同步中...",
    reason: "正在上传 WebDAV 备份",
  });

  assert.deepEqual(mod.webdavSyncButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
  }), {
    disabled: false,
    label: "立即同步",
    reason: "上传设置、插件数据和剪贴板历史到 WebDAV",
  });

  const rows = mod.webdavSyncRows({
    configReady: true,
    remotePath: "/ATools",
    scopes: ["设置", "插件数据"],
    summary: {
      status: "ok",
      remote_path: "/ATools",
      files_uploaded: [
        { name: "manifest.json", url: "https://dav.example.com/ATools/manifest.json", bytes: 48, status: 201 },
        { name: "settings.json", url: "https://dav.example.com/ATools/settings.json", bytes: 72, status: 201 },
      ],
      uploaded_bytes: 120,
      remote_manifest_verified: true,
      remote_manifest_bytes: 28,
      duration_ms: 300,
    },
  });
  assert.equal(rows.find((row) => row.label === "执行能力")?.value, "已接入 WebDAV 上传校验");
  assert.equal(rows.find((row) => row.label === "上传文件")?.value, "2 个 / 120 bytes");
  assert.equal(rows.find((row) => row.label === "远端 manifest")?.value, "已验证 / 28 bytes");
  assert.equal(rows.find((row) => row.label === "耗时")?.value, "300 ms");

  assert.deepEqual(mod.webdavPreviewButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
  }), {
    disabled: false,
    label: "检查远端备份",
    reason: "下载 manifest 并预览远端备份内容",
  });

  assert.deepEqual(mod.webdavPreviewButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: true,
  }), {
    disabled: true,
    label: "检查中...",
    reason: "正在读取远端备份",
  });

  assert.deepEqual(mod.webdavPreviewButtonState({
    hasTauriRuntime: false,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
  }), {
    disabled: true,
    label: "检查远端备份",
    reason: "需在桌面应用中检查",
  });

  const previewRows = mod.webdavPreviewRows({
    status: "ok",
    remote_path: "/ATools",
    manifest_kind: "atools-webdav-sync",
    exported_at: "2026-06-02T18:00:00Z",
    files: [
      {
        name: "settings.json",
        url: "https://dav.example.com/ATools/settings.json",
        declared_bytes: 42,
        downloaded_bytes: 52,
        summary: "设置备份 · 2 项",
      },
      {
        name: "plugin-data.json",
        url: "https://dav.example.com/ATools/plugin-data.json",
        declared_bytes: 88,
        downloaded_bytes: 43,
        summary: "插件数据 · 1 个插件",
      },
    ],
    duration_ms: 240,
  });
  assert.equal(previewRows[0].label, "远端备份");
  assert.equal(previewRows[0].value, "atools-webdav-sync · 2026-06-02T18:00:00Z");
  assert.equal(previewRows.find((row) => row.label === "文件")?.value, "2 个");
  assert.equal(previewRows.find((row) => row.label === "settings.json")?.value, "设置备份 · 2 项 · 52 bytes");
  assert.equal(previewRows.find((row) => row.label === "plugin-data.json")?.value, "插件数据 · 1 个插件 · 43 bytes");

  assert.deepEqual(mod.webdavRestorePlanButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
  }), {
    disabled: false,
    label: "生成恢复计划",
    reason: "只生成本机与远端差异，不会写入本机数据",
  });

  assert.deepEqual(mod.webdavRestorePlanButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: true,
  }), {
    disabled: true,
    label: "生成中...",
    reason: "正在比较本机与远端备份",
  });

  assert.deepEqual(mod.webdavRestorePlanButtonState({
    hasTauriRuntime: false,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
  }), {
    disabled: true,
    label: "生成恢复计划",
    reason: "需在桌面应用中生成",
  });

  const restorePlanRows = mod.webdavRestorePlanRows({
    status: "ready",
    remote_path: "/ATools",
    manifest_kind: "atools-webdav-sync",
    exported_at: "2026-06-02T18:30:00Z",
    items: [
      {
        scope: "settings",
        file_name: "settings.json",
        action: "would_update",
        local_summary: "设置备份 · 3 项",
        remote_summary: "设置备份 · 3 项",
        changed_keys: ["hotkey"],
        skipped_keys: ["webdavPassword"],
        high_risk: false,
      },
      {
        scope: "clipboard",
        file_name: "clipboard-history.json",
        action: "would_replace",
        local_summary: "剪贴板历史 · 1 条",
        remote_summary: "剪贴板历史 · 2 条",
        changed_keys: [],
        skipped_keys: [],
        high_risk: true,
      },
    ],
    duration_ms: 360,
  });
  assert.equal(restorePlanRows[0].label, "恢复计划");
  assert.equal(restorePlanRows[0].value, "atools-webdav-sync · 2026-06-02T18:30:00Z");
  assert.equal(restorePlanRows.find((row) => row.label === "settings")?.value, "将更新 · hotkey · 跳过 webdavPassword");
  assert.equal(restorePlanRows.find((row) => row.label === "clipboard")?.value, "将替换 · 剪贴板历史 · 1 条 -> 剪贴板历史 · 2 条 · 高风险");

  assert.deepEqual(mod.webdavSettingsRestoreButtonState({
    hasTauriRuntime: false,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "settings", action: "would_update", changed_keys: ["hotkey"], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "恢复设置",
    reason: "需在桌面应用中恢复",
  });

  assert.deepEqual(mod.webdavSettingsRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "settings", action: "unchanged", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "恢复设置",
    reason: "远端设置与本机一致",
  });

  assert.deepEqual(mod.webdavSettingsRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "settings", action: "would_update", changed_keys: ["hotkey"], skipped_keys: ["webdavPassword"] }],
      duration_ms: 20,
    },
  }), {
    disabled: false,
    label: "恢复设置",
    reason: "仅恢复设置项，插件数据和剪贴板不会写入",
  });

  assert.deepEqual(mod.webdavSettingsRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: true,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "settings", action: "would_update", changed_keys: ["hotkey"], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "恢复中...",
    reason: "正在恢复 WebDAV 设置",
  });

  assert.deepEqual(mod.webdavPluginDataRestoreButtonState({
    hasTauriRuntime: false,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "plugins", action: "would_replace", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "导入插件数据",
    reason: "需在桌面应用中导入插件数据",
  });

  assert.deepEqual(mod.webdavPluginDataRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: null,
  }), {
    disabled: true,
    label: "导入插件数据",
    reason: "请先生成恢复计划",
  });

  assert.deepEqual(mod.webdavPluginDataRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "plugins", action: "unchanged", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "导入插件数据",
    reason: "远端插件数据与本机一致",
  });

  assert.deepEqual(mod.webdavPluginDataRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "plugins", action: "would_replace", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: false,
    label: "导入插件数据",
    reason: "追加导入远端插件文档，冲突文档会跳过",
  });

  assert.deepEqual(mod.webdavPluginDataRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: true,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "plugins", action: "would_replace", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "导入中...",
    reason: "正在导入 WebDAV 插件数据",
  });

  assert.deepEqual(mod.webdavPluginDataOverwriteButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "plugins", action: "would_replace", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: false,
    label: "覆盖冲突数据",
    reason: "用远端同 ID 文档覆盖本机冲突文档",
  });

  assert.deepEqual(mod.webdavPluginDataOverwriteButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: true,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "plugins", action: "would_replace", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "覆盖中...",
    reason: "正在覆盖 WebDAV 插件数据冲突",
  });

  assert.deepEqual(mod.webdavPluginDataSelectedOverwriteButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    selectedConflicts: 0,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{
        scope: "plugins",
        action: "would_replace",
        changed_keys: [],
        skipped_keys: [],
        plugin_conflicts: [
          { plugin_id: "plugin-json", plugin_name: "JSON", doc_id: "conflict-a", local_summary: "local", remote_summary: "remote" },
        ],
      }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "覆盖选中冲突",
    reason: "请先选择要覆盖的冲突文档",
  });

  assert.deepEqual(mod.webdavPluginDataSelectedOverwriteButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    selectedConflicts: 1,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{
        scope: "plugins",
        action: "would_replace",
        changed_keys: [],
        skipped_keys: [],
        plugin_conflicts: [
          { plugin_id: "plugin-json", plugin_name: "JSON", doc_id: "conflict-a", local_summary: "local", remote_summary: "remote" },
        ],
      }],
      duration_ms: 20,
    },
  }), {
    disabled: false,
    label: "覆盖选中冲突",
    reason: "只覆盖已勾选的 1 条插件数据冲突",
  });

  const conflictPlanRows = mod.webdavRestorePlanRows({
    status: "ready",
    remote_path: "/ATools",
    manifest_kind: "atools-webdav-sync",
    exported_at: "2026-06-03T10:30:00Z",
    duration_ms: 42,
    items: [{
      scope: "plugins",
      file_name: "plugin-data.json",
      action: "would_replace",
      local_summary: "插件数据 · 1 个插件",
      remote_summary: "插件数据 · 1 个插件",
      changed_keys: [],
      skipped_keys: [],
      high_risk: true,
      plugin_conflicts: [
        { plugin_id: "plugin-json", plugin_name: "JSON", doc_id: "conflict-a", local_summary: "local", remote_summary: "remote" },
        { plugin_id: "plugin-json", plugin_name: "JSON", doc_id: "conflict-b", local_summary: "local", remote_summary: "remote" },
      ],
    }],
  });
  assert.match(conflictPlanRows.find((row) => row.label === "plugins")?.value ?? "", /冲突 2 条/);

  const pluginDataRows = mod.webdavPluginDataRestoreRows({
    status: "imported",
    remote_path: "/ATools",
    manifest_kind: "atools-webdav-sync",
    exported_at: "2026-06-03T10:30:00Z",
    remote_plugins: 3,
    remote_documents: 8,
    imported_documents: 5,
    overwritten_documents: 2,
    skipped_documents: 3,
    conflict_documents: 2,
    unchanged_documents: 1,
    missing_plugins: 1,
    duration_ms: 260,
  });
  assert.equal(pluginDataRows[0].label, "插件数据导入");
  assert.equal(pluginDataRows[0].value, "atools-webdav-sync · 2026-06-03T10:30:00Z");
  assert.equal(pluginDataRows.find((row) => row.label === "远端插件")?.value, "3 个");
  assert.equal(pluginDataRows.find((row) => row.label === "远端文档")?.value, "8 条");
  assert.equal(pluginDataRows.find((row) => row.label === "已导入")?.value, "5 条");
  assert.equal(pluginDataRows.find((row) => row.label === "已覆盖")?.value, "2 条");
  assert.equal(pluginDataRows.find((row) => row.label === "已跳过")?.value, "3 条");
  assert.equal(pluginDataRows.find((row) => row.label === "冲突文档")?.value, "2 条");
  assert.equal(pluginDataRows.find((row) => row.label === "缺失插件")?.value, "1 个");
  assert.equal(pluginDataRows.find((row) => row.label === "导入耗时")?.value, "260 ms");

  const restoredRows = mod.webdavSettingsRestoreRows({
    status: "applied",
    remote_path: "/ATools",
    manifest_kind: "atools-webdav-sync",
    exported_at: "2026-06-03T10:00:00Z",
    applied_keys: ["hotkey", "theme"],
    skipped_keys: ["webdavPassword"],
    merged_settings: { hotkey: "Command+Space", theme: "dark" },
    duration_ms: 280,
  });
  assert.equal(restoredRows[0].label, "设置恢复");
  assert.equal(restoredRows[0].value, "atools-webdav-sync · 2026-06-03T10:00:00Z");
  assert.equal(restoredRows.find((row) => row.label === "已恢复")?.value, "hotkey、theme");
  assert.equal(restoredRows.find((row) => row.label === "已跳过")?.value, "webdavPassword");
  assert.equal(restoredRows.find((row) => row.label === "恢复耗时")?.value, "280 ms");

  assert.deepEqual(mod.webdavClipboardRestoreButtonState({
    hasTauriRuntime: false,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "clipboard", action: "would_replace", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "导入剪贴板",
    reason: "需在桌面应用中导入剪贴板历史",
  });

  assert.deepEqual(mod.webdavClipboardRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: null,
  }), {
    disabled: true,
    label: "导入剪贴板",
    reason: "请先生成恢复计划",
  });

  assert.deepEqual(mod.webdavClipboardRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "clipboard", action: "unchanged", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "导入剪贴板",
    reason: "远端剪贴板历史与本机一致",
  });

  assert.deepEqual(mod.webdavClipboardRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: false,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "clipboard", action: "would_replace", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: false,
    label: "导入剪贴板",
    reason: "追加导入远端剪贴板历史，不会清空本机历史",
  });

  assert.deepEqual(mod.webdavClipboardRestoreButtonState({
    hasTauriRuntime: true,
    enabled: true,
    configReady: true,
    syncing: false,
    previewing: false,
    planning: false,
    restoring: true,
    plan: {
      status: "ready",
      remote_path: "/ATools",
      items: [{ scope: "clipboard", action: "would_replace", changed_keys: [], skipped_keys: [] }],
      duration_ms: 20,
    },
  }), {
    disabled: true,
    label: "导入中...",
    reason: "正在导入 WebDAV 剪贴板历史",
  });

  const clipboardRows = mod.webdavClipboardRestoreRows({
    status: "imported",
    remote_path: "/ATools",
    manifest_kind: "atools-webdav-sync",
    exported_at: "2026-06-03T11:00:00Z",
    remote_entries: 5,
    imported_entries: 3,
    skipped_entries: 2,
    duration_ms: 320,
  });
  assert.equal(clipboardRows[0].label, "剪贴板导入");
  assert.equal(clipboardRows[0].value, "atools-webdav-sync · 2026-06-03T11:00:00Z");
  assert.equal(clipboardRows.find((row) => row.label === "远端条目")?.value, "5 条");
  assert.equal(clipboardRows.find((row) => row.label === "已导入")?.value, "3 条");
  assert.equal(clipboardRows.find((row) => row.label === "已跳过")?.value, "2 条");
  assert.equal(clipboardRows.find((row) => row.label === "导入耗时")?.value, "320 ms");

  [
    "Web 预览下 `WebDAV 同步` 的 `立即同步` 按钮保持禁用，并提示需在桌面应用中同步。",
    "Web 预览下 `WebDAV 同步` 的 `检查远端备份` 按钮保持禁用，并提示需在桌面应用中检查。",
    "Web 预览下 `WebDAV 同步` 的 `生成恢复计划` 按钮保持禁用，并提示需在桌面应用中生成。",
    "Web 预览下 `WebDAV 同步` 的 `恢复设置` 按钮保持禁用，并提示需在桌面应用中恢复。",
    "Web 预览下 `WebDAV 同步` 的 `导入剪贴板` 按钮保持禁用，并提示需在桌面应用中导入剪贴板历史。",
    "桌面端配置完整且启用后，`WebDAV 同步` 的 `立即同步` 会上传所选范围的远端备份，并显示上传文件数、远端 manifest 校验和耗时。",
    "桌面端配置完整且启用后，`检查远端备份` 只读取远端 manifest 和文件摘要，并显示远端备份类型、导出时间、文件数量和摘要。",
    "桌面端配置完整且启用后，`生成恢复计划` 会比较本机与远端备份，显示设置变更 key、跳过的脱敏密钥、插件/剪贴板替换摘要和高风险标记。",
    "桌面端生成包含设置变更的恢复计划后，`恢复设置` 会弹出确认；确认后只恢复 `settings.json` 中未脱敏的设置项，`<redacted>` 字段保持本机原值，并显示已恢复/已跳过 key。",
    "桌面端生成包含剪贴板差异的恢复计划后，`导入剪贴板` 会弹出确认；确认后只追加导入本机缺失的文本历史，不清空、不覆盖现有剪贴板历史，并显示远端/已导入/已跳过条目数。",
    "WebDAV 恢复设置、导入剪贴板和导入插件数据确认均复用设置页内嵌确认弹窗；确认前不会执行本地写入，取消后不会改变设置、剪贴板历史或插件数据。",
    "`WebDAV 同步` 当前已支持远端备份上传、manifest 读取校验、远端备份预览、恢复计划 diff 预览、设置恢复确认流、剪贴板历史追加导入、插件数据追加导入、插件数据冲突覆盖导入和逐文档冲突选择；远端覆盖本机全部数据仍未接入。",
  ].forEach(assertSmokeItemChecked);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
