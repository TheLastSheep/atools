import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-webdav-settings-overview-"));
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

  assert.equal(typeof mod.webdavOverviewCards, "function", "webdavSyncView should expose WebDAV overview cards");

  const readyCards = mod.webdavOverviewCards({
    enabled: true,
    configReady: true,
    hasTauriRuntime: true,
    remotePath: "/ATools",
    scopes: ["设置", "插件数据"],
    statusLabel: "已同步",
    hasPassword: true,
    lastSync: {
      status: "ok",
      remote_path: "/ATools",
      files_uploaded: [
        { name: "manifest.json", url: "https://dav.example.com/ATools/manifest.json", bytes: 48, status: 201 },
      ],
      uploaded_bytes: 48,
      remote_manifest_verified: true,
      remote_manifest_bytes: 28,
      duration_ms: 300,
    },
    lastPreview: null,
    lastRestorePlan: null,
  });

  assert.deepEqual(readyCards.map((card) => card.label), [
    "连接配置",
    "远端目录",
    "同步范围",
    "最近结果",
  ]);
  assert.equal(readyCards.find((card) => card.label === "连接配置")?.value, "已启用");
  assert.match(readyCards.find((card) => card.label === "连接配置")?.detail ?? "", /密码或 Token 仅本机保存/);
  assert.equal(readyCards.find((card) => card.label === "远端目录")?.value, "/ATools");
  assert.equal(readyCards.find((card) => card.label === "同步范围")?.value, "2 项");
  assert.match(readyCards.find((card) => card.label === "同步范围")?.detail ?? "", /设置 \/ 插件数据/);
  assert.equal(readyCards.find((card) => card.label === "最近结果")?.value, "已同步");
  assert.match(readyCards.find((card) => card.label === "最近结果")?.detail ?? "", /manifest 已验证/);

  const incompleteCards = mod.webdavOverviewCards({
    enabled: false,
    configReady: false,
    hasTauriRuntime: true,
    remotePath: "",
    scopes: [],
    statusLabel: "配置不完整",
    hasPassword: false,
    lastSync: null,
    lastPreview: null,
    lastRestorePlan: null,
  });
  assert.equal(incompleteCards.find((card) => card.label === "连接配置")?.value, "配置不完整");
  assert.equal(incompleteCards.find((card) => card.label === "连接配置")?.tone, "warning");
  assert.equal(incompleteCards.find((card) => card.label === "同步范围")?.value, "未选择");

  const previewCards = mod.webdavOverviewCards({
    enabled: true,
    configReady: true,
    hasTauriRuntime: false,
    remotePath: "/ATools",
    scopes: ["设置"],
    statusLabel: "已启用",
    hasPassword: true,
    lastSync: null,
    lastPreview: null,
    lastRestorePlan: null,
  });
  assert.equal(previewCards.find((card) => card.label === "连接配置")?.value, "桌面端同步");
  assert.equal(previewCards.find((card) => card.label === "连接配置")?.tone, "desktop");

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  const smokeChecklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  const settingRestoreConfirm = panel.indexOf('title: "恢复 WebDAV 设置"');
  const settingRestoreInvoke = panel.indexOf('invoke<WebdavSettingsRestoreResult>("restore_webdav_settings"');
  const clipboardRestoreConfirm = panel.indexOf('title: "导入剪贴板历史"');
  const clipboardRestoreInvoke = panel.indexOf('invoke<WebdavClipboardRestoreResult>("restore_webdav_clipboard_history"');
  const pluginRestoreConfirm = panel.indexOf('title: mode === "append_missing" ? "导入插件数据" : "覆盖插件数据冲突"');
  const pluginRestoreInvoke = panel.indexOf('invoke<WebdavPluginDataRestoreResult>("restore_webdav_plugin_data"');
  assert.ok(panel.includes("WebDAV 概览"), "WebDAV page should render an overview section");
  assert.ok(panel.includes("webdavOverviewCards"), "WebDAV page should use the shared overview model");
  assert.ok(panel.includes("连接配置"), "WebDAV page should expose connection state");
  assert.ok(panel.includes("远端目录"), "WebDAV page should expose remote path state");
  assert.ok(panel.includes("同步范围"), "WebDAV page should expose sync scope state");
  assert.ok(panel.includes("最近结果"), "WebDAV page should expose recent operation state");
  assert.ok(panel.includes('aria-label="WebDAV 服务器地址"'), "WebDAV page should render the server URL field");
  assert.ok(panel.includes('aria-label="WebDAV 用户名"'), "WebDAV page should render the username field");
  assert.ok(panel.includes('aria-label="WebDAV 密码或 Token"'), "WebDAV page should render the password/token field");
  assert.ok(panel.includes('aria-label="WebDAV 远端目录"'), "WebDAV page should render the remote path field");
  assert.ok(panel.includes("同步设置"), "WebDAV page should expose settings sync scope");
  assert.ok(panel.includes("同步插件数据"), "WebDAV page should expose plugin data sync scope");
  assert.ok(panel.includes("同步剪贴板历史"), "WebDAV page should expose clipboard sync scope");
  assert.ok(panel.includes('checked={webdavEnabled && webdavConfigReady()}'), "WebDAV enable switch should stay unchecked until the config is valid");
  assert.ok(panel.includes('disabled={!webdavConfigReady()}'), "WebDAV enable switch should be disabled until the config is valid");
  assert.ok(panel.includes('parsed.protocol === "http:" || parsed.protocol === "https:"'), "WebDAV config should only accept http/https URLs");
  assert.ok(panel.includes("密码或 Token 仅本机保存"), "WebDAV page should explain local credential storage");
  assert.ok(panel.includes("检查远端备份只读取 manifest"), "WebDAV page should explain preview safety");
  assert.ok(panel.includes("远端脱敏字段保持本机原值"), "WebDAV settings restore result should explain redacted secrets are kept local");
  assert.ok(panel.includes("不会清空、覆盖或上传当前系统剪贴板"), "WebDAV clipboard import result should explain append-only behavior");
  assert.ok(panel.includes("<SettingsConfirmDialog"), "Settings page should use the embedded confirm dialog component");
  assert.ok(settingRestoreConfirm >= 0, "WebDAV settings restore should open an embedded confirmation before invoking native restore");
  assert.ok(settingRestoreInvoke > settingRestoreConfirm, "WebDAV settings restore should invoke native restore only after confirmation");
  assert.ok(panel.includes("已取消恢复设置"), "WebDAV settings restore should leave local settings untouched after cancel");
  assert.ok(clipboardRestoreConfirm >= 0, "WebDAV clipboard import should open an embedded confirmation before invoking native import");
  assert.ok(clipboardRestoreInvoke > clipboardRestoreConfirm, "WebDAV clipboard import should invoke native import only after confirmation");
  assert.ok(panel.includes("已取消导入剪贴板历史"), "WebDAV clipboard import should leave local history untouched after cancel");
  assert.ok(pluginRestoreConfirm >= 0, "WebDAV plugin data import should open an embedded confirmation before invoking native import");
  assert.ok(pluginRestoreInvoke > pluginRestoreConfirm, "WebDAV plugin data import should invoke native import only after confirmation");
  assert.ok(panel.includes("已取消导入插件数据"), "WebDAV plugin data import should leave local plugin data untouched after cancel");
  assert.ok(panel.includes("restoreWebdavPluginData"), "WebDAV page should expose plugin data restore action");
  assert.ok(panel.includes("导入插件数据"), "WebDAV page should render a plugin data import button");
  assert.ok(panel.includes("覆盖冲突数据"), "WebDAV page should render an explicit conflict overwrite button");
  assert.ok(panel.includes("覆盖选中冲突"), "WebDAV page should render a selected conflict overwrite button");
  assert.ok(panel.includes("插件数据冲突选择"), "WebDAV page should render per-document plugin conflict selection");
  assert.ok(panel.includes("selectedConflictDocuments"), "WebDAV page should pass selected conflict documents to the native command");
  assert.ok(panel.includes('invoke<WebdavPluginDataRestoreResult>("restore_webdav_plugin_data"'), "WebDAV page should call the native plugin data restore command");
  assert.ok(panel.includes('mode: "overwrite_conflicts"'), "WebDAV page should pass overwrite mode only for the explicit conflict overwrite action");
  assert.ok(panel.includes('mode: "overwrite_selected_conflicts"'), "WebDAV page should pass selected overwrite mode only for selected conflict action");
  assert.ok(panel.includes("冲突文档会跳过"), "WebDAV page should explain plugin data conflict handling");
  assert.ok(panel.includes("同 ID 冲突文档会被远端覆盖"), "WebDAV page should explain overwrite conflict handling");
  assert.ok(
    smokeChecklist.includes("- [x] 设置页 `WebDAV 同步` 不是占位页，显示 WebDAV 服务器地址、用户名、密码/Token、远端目录、同步范围和同步状态。"),
    "macOS smoke checklist should mark the WebDAV settings page complete",
  );
  assert.ok(
    smokeChecklist.includes("- [x] `WebDAV 同步` 空配置时启用开关禁用且未选中；填写合法 http/https 地址和用户名后才允许启用。"),
    "macOS smoke checklist should mark the WebDAV enable gate complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
