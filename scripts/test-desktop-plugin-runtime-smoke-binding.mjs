import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const smokeScript = await import(pathToFileURL(new URL("smoke-tauri-desktop.mjs", import.meta.url).pathname).href);

const [appSource, desktopSmokeSource, smokeChecklist, defaultCapability] = await Promise.all([
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("src-tauri/src/desktop_smoke.rs", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
  readFile(new URL("src-tauri/capabilities/default.json", root), "utf8").then(JSON.parse),
]);

const fsScope = defaultCapability.permissions.find((permission) => permission.identifier === "fs:scope");
assert.ok(fsScope, "default capability should declare its filesystem scope");
assert.ok(
  fsScope.allow.some((entry) => entry.path === "$DESKTOP/**/.worktrees/**"),
  "desktop smoke should be able to load plugin files from a hidden Git worktree",
);

function sourceSliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `source should include ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `source should include ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

const previewInitMatch = appSource.match(/function initialPluginHostSmokeAction\(\): FeatureAction \| null \{([\s\S]*?)\n  \}/);
assert.ok(previewInitMatch, "App should keep Web preview plugin-host smoke behind initialPluginHostSmokeAction()");
const previewInitBody = previewInitMatch[1];
assert.ok(
  previewInitBody.includes('if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window) return null;'),
  "Web preview smoke should never override the real desktop plugin runtime",
);
assert.ok(
  previewInitBody.includes('if (!params.has("pluginHostSmoke")) return null;'),
  "Plain ?parity=1 Web preview should not synthesize or search real plugins",
);
assert.equal(
  /invoke<[^>]+>\("search_features"|invoke\("search_features"|activate_feature/.test(previewInitBody),
  false,
  "Web preview plugin-host bootstrap must not call real plugin search or activation",
);

assert.match(
  desktopSmokeSource,
  /&& plugin_runtime_smoke\.ok\(\)\s*&& plugin_panel_render_smoke\.ok\(\)/,
  'Desktop smoke status="ok" should require both real plugin activation and PluginPanel render smoke',
);
const pluginRuntimeImpl = sourceSliceBetween(
  desktopSmokeSource,
  "impl PluginRuntimeSmokeSummary",
  "#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct PluginPanelRenderSmokeSummary",
);
const pluginPanelRenderImpl = sourceSliceBetween(
  desktopSmokeSource,
  "impl PluginPanelRenderSmokeSummary",
  "#[derive(Debug, Clone, Deserialize)]\n#[serde(rename_all = \"camelCase\")]",
);
assert.match(
  pluginRuntimeImpl,
  /pub fn ok\(&self\) -> bool \{[\s\S]*self\.feature_activated[\s\S]*self\.main_exists[\s\S]*self\.plugin_path_exists[\s\S]*self\.timestamp_search_enter_checked[\s\S]*self\.error\.is_none\(\)/,
  "PluginRuntimeSmokeSummary::ok should prove activate_feature, plugin files, search-enter coverage, and no error",
);
assert.match(
  pluginPanelRenderImpl,
  /pub fn ok\(&self\) -> bool \{[\s\S]*self\.reported[\s\S]*self\.fs_load[\s\S]*self\.iframe_srcdoc_loaded[\s\S]*self\.rendered_samples == self\.expected_samples[\s\S]*self\.timestamp_subinput_checked[\s\S]*self\.error\.is_none\(\)/,
  "PluginPanelRenderSmokeSummary::ok should prove filesystem render, srcdoc load, full sample coverage, timestamp subInput, and no error",
);

const snapshot = {
  status: "ok",
  main_window: true,
  settings_window: true,
  mcp_ready: true,
  agent_tools_count: 8,
  permission_smoke: {
    permission_required: true,
    pending_request_created: true,
    audit_denied_recorded: true,
    pending_request_dismissed: true,
    scope_deny_overrides_developer: true,
    scope_deny_audit_recorded: true,
    tool_toggle_persisted: true,
    tool_toggle_restored: true,
    cleanup_deleted_audits: 2,
  },
  data_debug_smoke: {
    runtime_diagnostics_ready: true,
    clipboard_export_json_valid: true,
    audit_export_jsonl_valid: true,
    audit_filtered_export_checked: true,
    audit_filtered_export_count_checked: true,
    crash_log_readable: true,
    mcp_status_consistent: true,
    mcp_ping_ok: true,
    mcp_initialized_notification_ok: true,
    mcp_discovery_lists_ok: true,
    mcp_resources_ok: true,
    mcp_prompts_ok: true,
    mcp_batch_ok: true,
    mcp_notification_ok: true,
  },
  system_settings_smoke: {
    main_window_centered: true,
    hotkey_reregistered: true,
    hotkey_old_unregistered: true,
    tray_visibility_applied: true,
    tray_visibility_toggled: true,
    launch_agent_plist_valid: true,
    launch_agent_write_checked: true,
    launch_agent_file_write_checked: true,
    launch_agent_file_cleanup_checked: true,
    launch_agent_cleanup_checked: true,
    floating_ball_window: true,
    super_panel_window: true,
    settings_preserved: true,
  },
  plugin_runtime_smoke: {
    feature_activated: true,
    sample_plugin_id: "timestamp",
    sample_plugin_name: "时间戳",
    sample_feature_code: "timestamp",
    main_url: "index.html",
    main_exists: true,
    plugin_path_exists: true,
    expand_height_valid: true,
    preload_checked: true,
    data_bridge_checked: true,
    data_roundtrip_checked: true,
    bulk_docs_checked: true,
    attachment_checked: true,
    data_cleanup_checked: true,
    native_bridge_checked: true,
    dialog_guard_checked: true,
    system_path_checked: true,
    shell_target_checked: true,
    context_bridge_checked: true,
    browser_context_checked: true,
    finder_context_checked: true,
    shell_show_item_error_checked: true,
    copied_files_read_checked: true,
    screen_capture_guard_checked: true,
    native_error_checked: true,
    copy_file_error_checked: true,
    copy_image_error_checked: true,
    calculator_search_enter_checked: true,
    timestamp_search_enter_checked: true,
  },
  plugin_panel_render_smoke: {
    reported: true,
    sample_plugin_id: "timestamp",
    sample_feature_code: "timestamp",
    main_url: "index.html",
    plugin_path_exists: true,
    fs_load: true,
    iframe_srcdoc_loaded: true,
    iframe_src_empty: true,
    load_error_empty: true,
    iframe_srcdoc_bytes: 128,
    expected_samples: 1,
    reported_samples: 1,
    rendered_samples: 1,
    external_plan_expected_samples: 0,
    external_plan_rendered_samples: 0,
    sample_plugin_ids: ["timestamp"],
    bridge_probe_expected_samples: 1,
    bridge_probe_reported_samples: 1,
    bridge_probe_passed_samples: 1,
    bridge_probe_checks: 5,
    bridge_probe_passed_checks: 5,
    bridge_probe_failed_ids: [],
    native_method_probe_expected_samples: 1,
    native_method_probe_reported_samples: 1,
    native_method_probe_passed_samples: 1,
    native_method_probe_checks: 4,
    native_method_probe_passed_checks: 4,
    native_method_probe_failed_ids: [],
    browser_window_probe_expected_samples: 1,
    browser_window_probe_reported_samples: 1,
    browser_window_probe_passed_samples: 1,
    browser_window_probe_checks: 9,
    browser_window_probe_passed_checks: 9,
    browser_window_probe_failed_ids: [],
    browser_window_created: true,
    browser_window_child_origin_opaque: true,
    browser_window_self_tauri_unavailable: true,
    browser_window_parent_tauri_unavailable: true,
    browser_window_parent_document_blocked: true,
    browser_window_send_to_parent_checked: true,
    browser_window_execute_javascript_checked: true,
    browser_window_ipc_roundtrip_checked: true,
    browser_window_cleanup_checked: true,
    timestamp_subinput_checked: true,
    error: null,
  },
  ztools_external_activation_smoke: {
    planned_samples: 1,
    imported_samples: 1,
    activated_samples: 1,
    ui_actions_checked: 1,
    plugin_panel_fs_load_checked: 1,
    assertions_checked: 1,
    cleanup_verified: 1,
    skipped_samples: 0,
    sample_plugin_ids: ["alpha-ready"],
  },
  local_app_search: {
    query: "com apple terminal",
    result_count: 1,
    icon_count: 1,
    sample_label: "打开 Terminal",
    sample_has_icon: true,
  },
};

const output = `ATOOLS_DESKTOP_SMOKE ${JSON.stringify(snapshot)}`;
const parsed = smokeScript.parseSmokeOutput(output);
assert.equal(parsed.plugin_runtime_smoke.feature_activated, true);
assert.equal(parsed.plugin_panel_render_smoke.fs_load, true);
assert.equal(parsed.plugin_panel_render_smoke.iframe_srcdoc_loaded, true);

for (const key of ["plugin_runtime_smoke", "plugin_panel_render_smoke"]) {
  const withoutKey = JSON.parse(JSON.stringify(snapshot));
  delete withoutKey[key];
  assert.throws(
    () => smokeScript.parseSmokeOutput(`ATOOLS_DESKTOP_SMOKE ${JSON.stringify(withoutKey)}`),
    new RegExp(key),
    `desktop smoke parser should reject missing ${key}`,
  );
}

for (const [section, key] of [
  ["plugin_runtime_smoke", "feature_activated"],
  ["plugin_runtime_smoke", "plugin_path_exists"],
  ["plugin_panel_render_smoke", "fs_load"],
  ["plugin_panel_render_smoke", "iframe_srcdoc_loaded"],
]) {
  const withoutField = JSON.parse(JSON.stringify(snapshot));
  delete withoutField[section][key];
  assert.throws(
    () => smokeScript.parseSmokeOutput(`ATOOLS_DESKTOP_SMOKE ${JSON.stringify(withoutField)}`),
    new RegExp(`${section}\\.${key}`),
    `desktop smoke parser should reject missing ${section}.${key}`,
  );
}

assert.ok(
  smokeChecklist.includes("- [x] Web 预览 `?parity=1` 不搜索真实插件；真实 `activate_feature` 插件运行态必须在桌面端验证，并由 `pnpm smoke:tauri-desktop` 自动检查至少一个已索引插件入口及其真实 Tauri PluginPanel FS render 回传。"),
  "macOS smoke checklist should mark desktop plugin runtime smoke binding complete",
);
