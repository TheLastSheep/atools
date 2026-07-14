import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const checklist = readFileSync("docs/macos-smoke-checklist.md", "utf8");

const requiredCheckedRows = [
  "`status` 为 `ok`。",
  "`plugin_panel_render_smoke.reported` 为 `true`。",
  "`plugin_panel_render_smoke.plugin_path_exists`、`fs_load`、`iframe_srcdoc_loaded`、`iframe_src_empty`、`load_error_empty` 均为 `true`",
  "标准 smoke 当前基线为 `expected_samples >= 1`、`reported_samples == expected_samples`、`rendered_samples == expected_samples`",
  "标准 smoke iframe bridge probe 当前基线为 `bridge_probe_reported_samples == expected_samples`",
  "标准 smoke iframe native/system method probe 当前基线为 `native_method_probe_reported_samples == expected_samples`",
  "该 smoke 由前端在 `VITE_ATOOLS_DESKTOP_SMOKE=1` 下调用",
  "`PluginPanel` 的 smoke bridge probe wait budget 应根据最终 `srcdoc` 字节数计算，避免 5MB 级真实入口被固定低 timeout 误判；预算下限为 12s，上限为 20s。",
  "该 smoke 证明真实 Tauri 前端 PluginPanel 的 FS `srcdoc` 加载路径",
  "桌面 smoke 的 `system_settings_smoke` 会观测主窗口几何居中、事务性切换并恢复呼出快捷键、按当前设置重放托盘可见性、校验 LaunchAgent plist、仅在系统临时目录写入/删除自启 plist",
  "权限模式默认是 `保守确认`。",
  "将 `执行命令(shell)` 设为阻断后，`open_or_reveal_path` 即使在开发者宽松模式下也被拒绝并写入 denied audit。",
  "工具开关能保存。",
  "`get_current_context` 返回 `browser_url` 字段；若当前没有受支持的前台浏览器 URL",
  "`get_current_context` 返回 `finder_path` 字段；其语义应与 `read_current_folder_path` 命令层 bridge 一致",
  "`保守确认` 模式下调用需要权限的工具时，能创建 pending request，并在拒绝/关闭后写入 denied audit。",
  "当前基线为 10 planned samples、61 launchable、64 blocked skipped、10 ready plans、0 risk plans。",
  "当前 10 个计划样本均有 text trigger",
  "每个 plan item 都应包含 `install`、`enable`、`activation`、`assertions`、`cleanup`",
  "`ztools-developer-plugin/ui.router` 在 plan 中保留 activation 覆盖",
  "`status` 为 `ok`。",
  "`ztools_external_activation_smoke.plan_path` 解析到 repo 根目录下的 `output/ztools-plugin-activation-plan.json`",
  "当前基线为 10 planned、9 imported、9 activated、9 ui actions checked、9 PluginPanel FS load specs checked、9 assertions checked、9 cleanup verified、1 skipped、`error:null`。",
  "同一次 smoke 的 `plugin_panel_render_smoke` 覆盖当前可安全渲染外部 plan action 队列；当前基线为 `expected_samples:8`、`reported_samples:8`、`rendered_samples:8`",
  "同一次 smoke 的 iframe bridge probe 当前基线为 `bridge_probe_expected_samples:8`",
  "同一次 smoke 的 iframe native/system method probe 当前基线为 `native_method_probe_expected_samples:8`",
  "同一次 smoke 日志不应出现 `Scoped command osascript not found`",
  "`ui_actions_checked` 验证 `activate_feature_inner` 返回了 `PluginPanel` 可用的 `FeatureAction`",
  "`plugin_panel_fs_load_checked` 验证真实导入插件的 `FeatureAction` 可形成 `PluginPanel.loadPluginHtml()`",
  "skipped 样本来自 feature code 已归属现有插件",
  "标准 `pnpm smoke:tauri-desktop` 不设置 `ATOOLS_ZTOOLS_ACTIVATION_PLAN` 时仍应通过",
  "该 smoke 覆盖外部插件导入、feature 激活查找、真实 PluginPanel FS load spec",
  "设置 `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json` 时，该 smoke 应切到外部 plan render 队列；当前基线为 8/8 external plan render samples",
  "搜索 `计算` 或 `calculator`，能进入计算器插件。",
  "搜索 `时间戳`，进入后出现 subInput。",
];

for (const row of requiredCheckedRows) {
  assert.match(
    checklist,
    new RegExp(`^- \\[x\\] ${escapeRegExp(row)}`, "m"),
    `Expected checked macOS smoke checklist row containing: ${row}`,
  );
}

for (const snippet of [
  '"floating_ball_window": true',
  '"super_panel_window": true',
  '"launch_agent_write_checked": true',
  '"launch_agent_cleanup_checked": true',
  '"calculator_search_enter_checked": true',
  '"timestamp_search_enter_checked": true',
  "`plugin_panel_render_smoke.timestamp_subinput_checked:true`",
  "2026-07-10T13:20:34Z",
  "BrowserWindow 隔离 probe 基线为 1/1/1 samples、9/9 checks",
  "browser_window_cleanup_checked:true",
]) {
  assert.ok(
    checklist.includes(snippet),
    `Expected system_settings_smoke sample to include ${snippet}`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
