import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const script = await import(pathToFileURL(new URL("smoke-tauri-desktop.mjs", import.meta.url).pathname).href);

const output = [
  "vite ready",
  "ATools MCP server listening on 127.0.0.1:17321",
  'ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true,"shell_target_checked":true,"context_bridge_checked":true,"browser_context_checked":true,"finder_context_checked":true,"shell_show_item_error_checked":true,"copied_files_read_checked":true,"screen_capture_guard_checked":true,"native_error_checked":true,"copy_file_error_checked":true,"copy_image_error_checked":true,"calculator_search_enter_checked":true,"timestamp_search_enter_checked":true},"plugin_panel_render_smoke":{"reported":true,"sample_plugin_id":"timestamp","sample_feature_code":"timestamp","main_url":"index.html","plugin_path_exists":true,"fs_load":true,"iframe_srcdoc_loaded":true,"iframe_src_empty":true,"load_error_empty":true,"iframe_srcdoc_bytes":128,"expected_samples":2,"reported_samples":2,"rendered_samples":2,"external_plan_expected_samples":1,"external_plan_rendered_samples":1,"sample_plugin_ids":["timestamp","alpha-ready"],"bridge_probe_expected_samples":2,"bridge_probe_reported_samples":2,"bridge_probe_passed_samples":2,"bridge_probe_checks":10,"bridge_probe_passed_checks":10,"bridge_probe_failed_ids":[],"native_method_probe_expected_samples":2,"native_method_probe_reported_samples":2,"native_method_probe_passed_samples":2,"native_method_probe_checks":8,"native_method_probe_passed_checks":8,"native_method_probe_failed_ids":[],"browser_window_probe_expected_samples":1,"browser_window_probe_reported_samples":1,"browser_window_probe_passed_samples":1,"browser_window_probe_checks":9,"browser_window_probe_passed_checks":9,"browser_window_probe_failed_ids":[],"browser_window_created":true,"browser_window_child_origin_opaque":true,"browser_window_self_tauri_unavailable":true,"browser_window_parent_tauri_unavailable":true,"browser_window_parent_document_blocked":true,"browser_window_send_to_parent_checked":true,"browser_window_execute_javascript_checked":true,"browser_window_ipc_roundtrip_checked":true,"browser_window_cleanup_checked":true,"timestamp_subinput_checked":true,"error":null},"ztools_external_activation_smoke":{"plan_path":"/tmp/plan.json","planned_samples":1,"imported_samples":1,"activated_samples":1,"ui_actions_checked":1,"plugin_panel_fs_load_checked":1,"assertions_checked":1,"cleanup_verified":1,"skipped_samples":0,"sample_plugin_ids":["alpha-ready"],"error":null},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_label":"打开 Terminal","sample_has_icon":true}}',
  "after line",
].join("\n");

function mutateSmokeOutput(mutator) {
  const prefix = "ATOOLS_DESKTOP_SMOKE ";
  const lines = output.split("\n");
  const index = lines.findIndex((line) => line.startsWith(prefix));
  const snapshot = JSON.parse(lines[index].slice(prefix.length));
  mutator(snapshot);
  lines[index] = `${prefix}${JSON.stringify(snapshot)}`;
  return lines.join("\n");
}

const parsed = script.parseSmokeOutput(output);
assert.equal(parsed.status, "ok");
assert.equal(parsed.main_window, true);
assert.equal(parsed.mcp_ready, true);
assert.equal(parsed.agent_tools_count, 8);
assert.equal(parsed.permission_smoke.permission_required, true);
assert.equal(parsed.permission_smoke.pending_request_created, true);
assert.equal(parsed.permission_smoke.audit_denied_recorded, true);
assert.equal(parsed.permission_smoke.pending_request_dismissed, true);
assert.equal(parsed.permission_smoke.scope_deny_overrides_developer, true);
assert.equal(parsed.permission_smoke.scope_deny_audit_recorded, true);
assert.equal(parsed.permission_smoke.tool_toggle_persisted, true);
assert.equal(parsed.permission_smoke.tool_toggle_restored, true);
assert.equal(parsed.permission_smoke.cleanup_deleted_audits, 2);
assert.equal(parsed.data_debug_smoke.runtime_diagnostics_ready, true);
assert.equal(parsed.data_debug_smoke.clipboard_export_json_valid, true);
assert.equal(parsed.data_debug_smoke.audit_export_jsonl_valid, true);
assert.equal(parsed.data_debug_smoke.audit_filtered_export_checked, true);
assert.equal(parsed.data_debug_smoke.audit_filtered_export_count_checked, true);
assert.equal(parsed.data_debug_smoke.crash_log_readable, true);
assert.equal(parsed.data_debug_smoke.mcp_status_consistent, true);
assert.equal(parsed.data_debug_smoke.mcp_ping_ok, true);
assert.equal(parsed.data_debug_smoke.mcp_initialized_notification_ok, true);
assert.equal(parsed.data_debug_smoke.mcp_discovery_lists_ok, true);
assert.equal(parsed.data_debug_smoke.mcp_resources_ok, true);
assert.equal(parsed.data_debug_smoke.mcp_prompts_ok, true);
assert.equal(parsed.data_debug_smoke.mcp_batch_ok, true);
assert.equal(parsed.data_debug_smoke.mcp_notification_ok, true);
assert.equal(parsed.system_settings_smoke.main_window_centered, true);
assert.equal(parsed.system_settings_smoke.hotkey_old_unregistered, true);
assert.equal(parsed.system_settings_smoke.hotkey_reregistered, true);
assert.equal(parsed.system_settings_smoke.tray_visibility_applied, true);
assert.equal(parsed.system_settings_smoke.tray_visibility_toggled, true);
assert.equal(parsed.system_settings_smoke.launch_agent_plist_valid, true);
assert.equal(parsed.system_settings_smoke.launch_agent_write_checked, true);
assert.equal(parsed.system_settings_smoke.launch_agent_cleanup_checked, true);
assert.equal(parsed.system_settings_smoke.floating_ball_window, true);
assert.equal(parsed.system_settings_smoke.super_panel_window, true);
assert.equal(parsed.system_settings_smoke.settings_preserved, true);
assert.equal(parsed.plugin_runtime_smoke.feature_activated, true);
assert.equal(parsed.plugin_runtime_smoke.sample_plugin_id, "timestamp");
assert.equal(parsed.plugin_runtime_smoke.sample_plugin_name, "时间戳");
assert.equal(parsed.plugin_runtime_smoke.sample_feature_code, "timestamp");
assert.equal(parsed.plugin_runtime_smoke.main_url, "index.html");
assert.equal(parsed.plugin_runtime_smoke.main_exists, true);
assert.equal(parsed.plugin_runtime_smoke.plugin_path_exists, true);
assert.equal(parsed.plugin_runtime_smoke.expand_height_valid, true);
assert.equal(parsed.plugin_runtime_smoke.preload_checked, true);
assert.equal(parsed.plugin_runtime_smoke.data_bridge_checked, true);
assert.equal(parsed.plugin_runtime_smoke.data_roundtrip_checked, true);
assert.equal(parsed.plugin_runtime_smoke.bulk_docs_checked, true);
assert.equal(parsed.plugin_runtime_smoke.attachment_checked, true);
assert.equal(parsed.plugin_runtime_smoke.data_cleanup_checked, true);
assert.equal(parsed.plugin_runtime_smoke.native_bridge_checked, true);
assert.equal(parsed.plugin_runtime_smoke.dialog_guard_checked, true);
assert.equal(parsed.plugin_runtime_smoke.system_path_checked, true);
assert.equal(parsed.plugin_runtime_smoke.shell_target_checked, true);
assert.equal(parsed.plugin_runtime_smoke.context_bridge_checked, true);
assert.equal(parsed.plugin_runtime_smoke.browser_context_checked, true);
assert.equal(parsed.plugin_runtime_smoke.finder_context_checked, true);
assert.equal(parsed.plugin_runtime_smoke.shell_show_item_error_checked, true);
assert.equal(parsed.plugin_runtime_smoke.copied_files_read_checked, true);
assert.equal(parsed.plugin_runtime_smoke.screen_capture_guard_checked, true);
assert.equal(parsed.plugin_runtime_smoke.native_error_checked, true);
assert.equal(parsed.plugin_runtime_smoke.copy_file_error_checked, true);
assert.equal(parsed.plugin_runtime_smoke.copy_image_error_checked, true);
assert.equal(parsed.plugin_runtime_smoke.calculator_search_enter_checked, true);
assert.equal(parsed.plugin_runtime_smoke.timestamp_search_enter_checked, true);
assert.equal(parsed.plugin_panel_render_smoke.reported, true);
assert.equal(parsed.plugin_panel_render_smoke.sample_plugin_id, "timestamp");
assert.equal(parsed.plugin_panel_render_smoke.sample_feature_code, "timestamp");
assert.equal(parsed.plugin_panel_render_smoke.main_url, "index.html");
assert.equal(parsed.plugin_panel_render_smoke.plugin_path_exists, true);
assert.equal(parsed.plugin_panel_render_smoke.fs_load, true);
assert.equal(parsed.plugin_panel_render_smoke.iframe_srcdoc_loaded, true);
assert.equal(parsed.plugin_panel_render_smoke.iframe_src_empty, true);
assert.equal(parsed.plugin_panel_render_smoke.load_error_empty, true);
assert.equal(parsed.plugin_panel_render_smoke.iframe_srcdoc_bytes, 128);
assert.equal(parsed.plugin_panel_render_smoke.expected_samples, 2);
assert.equal(parsed.plugin_panel_render_smoke.reported_samples, 2);
assert.equal(parsed.plugin_panel_render_smoke.rendered_samples, 2);
assert.equal(parsed.plugin_panel_render_smoke.external_plan_expected_samples, 1);
assert.equal(parsed.plugin_panel_render_smoke.external_plan_rendered_samples, 1);
assert.deepEqual(parsed.plugin_panel_render_smoke.sample_plugin_ids, ["timestamp", "alpha-ready"]);
assert.equal(parsed.plugin_panel_render_smoke.bridge_probe_expected_samples, 2);
assert.equal(parsed.plugin_panel_render_smoke.bridge_probe_reported_samples, 2);
assert.equal(parsed.plugin_panel_render_smoke.bridge_probe_passed_samples, 2);
assert.equal(parsed.plugin_panel_render_smoke.bridge_probe_checks, 10);
assert.equal(parsed.plugin_panel_render_smoke.bridge_probe_passed_checks, 10);
assert.deepEqual(parsed.plugin_panel_render_smoke.bridge_probe_failed_ids, []);
assert.equal(parsed.plugin_panel_render_smoke.native_method_probe_expected_samples, 2);
assert.equal(parsed.plugin_panel_render_smoke.native_method_probe_reported_samples, 2);
assert.equal(parsed.plugin_panel_render_smoke.native_method_probe_passed_samples, 2);
assert.equal(parsed.plugin_panel_render_smoke.native_method_probe_checks, 8);
assert.equal(parsed.plugin_panel_render_smoke.native_method_probe_passed_checks, 8);
assert.deepEqual(parsed.plugin_panel_render_smoke.native_method_probe_failed_ids, []);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_probe_expected_samples, 1);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_probe_reported_samples, 1);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_probe_passed_samples, 1);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_probe_checks, 9);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_probe_passed_checks, 9);
assert.deepEqual(parsed.plugin_panel_render_smoke.browser_window_probe_failed_ids, []);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_created, true);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_child_origin_opaque, true);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_self_tauri_unavailable, true);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_parent_tauri_unavailable, true);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_parent_document_blocked, true);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_send_to_parent_checked, true);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_execute_javascript_checked, true);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_ipc_roundtrip_checked, true);
assert.equal(parsed.plugin_panel_render_smoke.browser_window_cleanup_checked, true);
assert.equal(parsed.plugin_panel_render_smoke.timestamp_subinput_checked, true);
assert.equal(parsed.ztools_external_activation_smoke.plugin_panel_fs_load_checked, 1);
assert.equal(parsed.local_app_search.query, "com apple terminal");
assert.equal(parsed.local_app_search.icon_count, 1);
assert.equal(parsed.local_app_search.sample_has_icon, true);

assert.throws(() => script.parseSmokeOutput("no smoke line"), /Missing ATOOLS_DESKTOP_SMOKE/);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /permission_smoke/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /data_debug_smoke/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true,"shell_target_checked":true,"context_bridge_checked":true,"browser_context_checked":true,"finder_context_checked":true,"shell_show_item_error_checked":true,"copied_files_read_checked":true,"screen_capture_guard_checked":true,"native_error_checked":true,"copy_file_error_checked":true,"copy_image_error_checked":true,"calculator_search_enter_checked":true,"timestamp_search_enter_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /permission_smoke.scope_deny_audit_recorded/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true,"shell_target_checked":true,"context_bridge_checked":true,"browser_context_checked":true,"finder_context_checked":true,"shell_show_item_error_checked":true,"copied_files_read_checked":true,"screen_capture_guard_checked":true,"native_error_checked":true,"copy_file_error_checked":true,"copy_image_error_checked":true,"calculator_search_enter_checked":true,"timestamp_search_enter_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /permission_smoke.tool_toggle_restored/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /system_settings_smoke/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /mcp_initialized_notification_ok/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"mcp_discovery_lists_ok":true', "")),
  /mcp_discovery_lists_ok/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"mcp_resources_ok":true', "")),
  /mcp_resources_ok/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"mcp_prompts_ok":true', "")),
  /mcp_prompts_ok/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"launch_agent_write_checked":true', "")),
  /system_settings_smoke.launch_agent_write_checked/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"launch_agent_cleanup_checked":true', "")),
  /system_settings_smoke.launch_agent_cleanup_checked/
);
for (const key of [
  "main_window_centered",
  "hotkey_reregistered",
  "launch_agent_write_checked",
]) {
  const falseOutput = output.replace(`"${key}":true`, `"${key}":false`);
  assert.notEqual(falseOutput, output, `fixture must include system_settings_smoke.${key}`);
  assert.throws(
    () => script.parseSmokeOutput(falseOutput),
    new RegExp(`system_settings_smoke\\.${key}.*expected true`, "i")
  );
}
for (const [section, key] of [
  ["permission_smoke", "permission_required"],
  ["data_debug_smoke", "mcp_batch_ok"],
  ["plugin_runtime_smoke", "data_cleanup_checked"],
  ["plugin_panel_render_smoke", "iframe_srcdoc_loaded"],
]) {
  const falseOutput = output.replace(`"${key}":true`, `"${key}":false`);
  assert.notEqual(falseOutput, output, `fixture must include ${section}.${key}`);
  assert.throws(
    () => script.parseSmokeOutput(falseOutput),
    new RegExp(`${section}\\.${key}.*expected true`, "i")
  );
}
assert.throws(
  () => script.parseSmokeOutput(output.replace('"system_settings_smoke":{"main_window_centered":true,', '"system_settings_smoke":{')),
  /system_settings_smoke.main_window_centered/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"hotkey_old_unregistered":true', "")),
  /system_settings_smoke.hotkey_old_unregistered/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"tray_visibility_toggled":true', "")),
  /system_settings_smoke.tray_visibility_toggled/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"mcp_batch_ok":true', "")),
  /mcp_batch_ok/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"mcp_notification_ok":true', "")),
  /mcp_notification_ok/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /plugin_runtime_smoke/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true,"shell_target_checked":true,"context_bridge_checked":true,"browser_context_checked":true,"finder_context_checked":true,"shell_show_item_error_checked":true,"copied_files_read_checked":true,"screen_capture_guard_checked":true,"native_error_checked":true,"copy_file_error_checked":true,"copy_image_error_checked":true,"calculator_search_enter_checked":true,"timestamp_search_enter_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /data_debug_smoke.audit_filtered_export_count_checked/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"preload_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /plugin_runtime_smoke.expand_height_valid/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /plugin_runtime_smoke.data_cleanup_checked/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /plugin_runtime_smoke.shell_target_checked/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace('"dialog_guard_checked":true,', "")),
  /plugin_runtime_smoke.dialog_guard_checked/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"plugin_panel_fs_load_checked":1', "")),
  /ztools_external_activation_smoke.plugin_panel_fs_load_checked/
);
assert.throws(
  () => script.parseSmokeOutput(mutateSmokeOutput((snapshot) => {
    delete snapshot.plugin_panel_render_smoke;
  })),
  /plugin_panel_render_smoke/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"iframe_srcdoc_loaded":true', "")),
  /plugin_panel_render_smoke.iframe_srcdoc_loaded/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"external_plan_rendered_samples":1', "")),
  /plugin_panel_render_smoke.external_plan_rendered_samples/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"bridge_probe_passed_samples":2', "")),
  /plugin_panel_render_smoke.bridge_probe_passed_samples/
);
assert.throws(
  () => script.parseSmokeOutput(output.replace(',"native_method_probe_passed_samples":2', "")),
  /plugin_panel_render_smoke.native_method_probe_passed_samples/
);

const browserWindowProbeRequiredFields = [
  "browser_window_probe_expected_samples",
  "browser_window_probe_reported_samples",
  "browser_window_probe_passed_samples",
  "browser_window_probe_checks",
  "browser_window_probe_passed_checks",
  "browser_window_probe_failed_ids",
];
for (const field of browserWindowProbeRequiredFields) {
  assert.throws(
    () => script.parseSmokeOutput(mutateSmokeOutput((snapshot) => {
      delete snapshot.plugin_panel_render_smoke[field];
    })),
    new RegExp(`plugin_panel_render_smoke\\.${field}`),
  );
}

const browserWindowProbeTrueFields = [
  "browser_window_created",
  "browser_window_child_origin_opaque",
  "browser_window_self_tauri_unavailable",
  "browser_window_parent_tauri_unavailable",
  "browser_window_parent_document_blocked",
  "browser_window_send_to_parent_checked",
  "browser_window_execute_javascript_checked",
  "browser_window_ipc_roundtrip_checked",
  "browser_window_cleanup_checked",
];
for (const field of browserWindowProbeTrueFields) {
  assert.throws(
    () => script.parseSmokeOutput(mutateSmokeOutput((snapshot) => {
      snapshot.plugin_panel_render_smoke[field] = false;
    })),
    new RegExp(`plugin_panel_render_smoke\\.${field}`),
  );
  assert.throws(
    () => script.parseSmokeOutput(mutateSmokeOutput((snapshot) => {
      snapshot.plugin_panel_render_smoke[field] = "true";
    })),
    new RegExp(`plugin_panel_render_smoke\\.${field}`),
    `${field} must remain a strict boolean true contract`,
  );
}
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true,"shell_target_checked":true,"context_bridge_checked":true,"browser_context_checked":true,"finder_context_checked":true,"shell_show_item_error_checked":true,"copied_files_read_checked":true,"screen_capture_guard_checked":true,"native_error_checked":true,"copy_file_error_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /plugin_runtime_smoke.copy_image_error_checked/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true,"shell_target_checked":true,"context_bridge_checked":true,"browser_context_checked":true,"native_error_checked":true,"copy_file_error_checked":true,"copy_image_error_checked":true,"calculator_search_enter_checked":true,"timestamp_search_enter_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /plugin_runtime_smoke.finder_context_checked/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true,"shell_target_checked":true,"context_bridge_checked":true,"browser_context_checked":true,"finder_context_checked":true,"native_error_checked":true,"copy_file_error_checked":true,"copy_image_error_checked":true,"calculator_search_enter_checked":true,"timestamp_search_enter_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /plugin_runtime_smoke.shell_show_item_error_checked/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true,"shell_target_checked":true,"context_bridge_checked":true,"browser_context_checked":true,"finder_context_checked":true,"shell_show_item_error_checked":true,"native_error_checked":true,"copy_file_error_checked":true,"copy_image_error_checked":true,"calculator_search_enter_checked":true,"timestamp_search_enter_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /plugin_runtime_smoke.copied_files_read_checked/
);
assert.throws(
  () => script.parseSmokeOutput('ATOOLS_DESKTOP_SMOKE {"status":"ok","main_window":true,"settings_window":true,"mcp_ready":true,"agent_tools_count":8,"permission_smoke":{"permission_required":true,"pending_request_created":true,"audit_denied_recorded":true,"pending_request_dismissed":true,"scope_deny_overrides_developer":true,"scope_deny_audit_recorded":true,"tool_toggle_persisted":true,"tool_toggle_restored":true,"cleanup_deleted_audits":2},"data_debug_smoke":{"runtime_diagnostics_ready":true,"clipboard_export_json_valid":true,"audit_export_jsonl_valid":true,"audit_filtered_export_checked":true,"audit_filtered_export_count_checked":true,"crash_log_readable":true,"mcp_status_consistent":true,"mcp_ping_ok":true,"mcp_initialized_notification_ok":true,"mcp_discovery_lists_ok":true,"mcp_resources_ok":true,"mcp_prompts_ok":true,"mcp_batch_ok":true,"mcp_notification_ok":true},"system_settings_smoke":{"main_window_centered":true,"hotkey_reregistered":true,"hotkey_old_unregistered":true,"tray_visibility_applied":true,"tray_visibility_toggled":true,"launch_agent_plist_valid":true,"launch_agent_write_checked":true,"launch_agent_cleanup_checked":true,"floating_ball_window":true,"super_panel_window":true,"settings_preserved":true},"plugin_runtime_smoke":{"feature_activated":true,"sample_plugin_id":"timestamp","sample_plugin_name":"时间戳","sample_feature_code":"timestamp","main_url":"index.html","main_exists":true,"plugin_path_exists":true,"expand_height_valid":true,"preload_checked":true,"data_bridge_checked":true,"data_roundtrip_checked":true,"bulk_docs_checked":true,"attachment_checked":true,"data_cleanup_checked":true,"native_bridge_checked":true,"dialog_guard_checked":true,"system_path_checked":true,"shell_target_checked":true,"context_bridge_checked":true,"browser_context_checked":true,"finder_context_checked":true,"shell_show_item_error_checked":true,"copied_files_read_checked":true,"native_error_checked":true,"copy_file_error_checked":true,"copy_image_error_checked":true,"calculator_search_enter_checked":true,"timestamp_search_enter_checked":true},"local_app_search":{"query":"com apple terminal","result_count":1,"icon_count":1,"sample_has_icon":true}}'),
  /plugin_runtime_smoke.screen_capture_guard_checked/
);
assert.equal(script.desktopSmokeEnv({ FOO: "bar" }).ATOOLS_DESKTOP_SMOKE, "1");
assert.equal(script.desktopSmokeEnv({ FOO: "bar" }).FOO, "bar");

const command = script.desktopSmokeCommand([]);
assert.equal(command.command, "pnpm");
assert.deepEqual(command.args, ["tauri", "dev"]);

const custom = script.desktopSmokeCommand(["--", "--features", "custom-protocol"]);
assert.deepEqual(custom.args, ["tauri", "dev", "--features", "custom-protocol"]);

const groupSignals = [];
const groupChild = { pid: 42, kill: () => assert.fail("group kill should not fall back") };
assert.equal(
  script.terminateChildProcessTree(groupChild, "SIGTERM", {
    platform: "darwin",
    killProcess: (pid, signal) => groupSignals.push([pid, signal]),
  }),
  "group",
);
assert.deepEqual(groupSignals, [[-42, "SIGTERM"]]);

const childSignals = [];
const directChild = { pid: 42, kill: (signal) => childSignals.push(signal) };
assert.equal(
  script.terminateChildProcessTree(directChild, "SIGKILL", {
    platform: "win32",
    killProcess: () => assert.fail("Windows should not signal a Unix process group"),
  }),
  "child",
);
assert.deepEqual(childSignals, ["SIGKILL"]);

const fallbackSignals = [];
assert.equal(
  script.terminateChildProcessTree(
    { pid: 42, kill: (signal) => fallbackSignals.push(signal) },
    "SIGTERM",
    {
      platform: "darwin",
      killProcess: () => {
        throw new Error("process group already exited");
      },
    },
  ),
  "child",
);
assert.deepEqual(fallbackSignals, ["SIGTERM"]);

const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
for (const windowConfig of tauriConfig.app.windows) {
  if (windowConfig.visible === false) {
    assert.notEqual(
      windowConfig.focus,
      true,
      `hidden startup window ${windowConfig.label} must not request focus`
    );
  }
}

const defaultCapability = JSON.parse(await readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
const fsScope = defaultCapability.permissions.find((permission) => {
  return permission && typeof permission === "object" && permission.identifier === "fs:scope";
});
assert.ok(fsScope, "default capability should define an fs:scope");
assert.ok(
  fsScope.allow.some((entry) => entry.path === "/tmp/atools-ztools-plugin-smoke/**"),
  "desktop smoke external PluginPanel render needs read access to the temporary activation install root"
);

const shellExecutePermission = defaultCapability.permissions.find((permission) => {
  return permission && typeof permission === "object" && permission.identifier === "shell:allow-execute";
});
assert.ok(shellExecutePermission, "default capability should scope shell:allow-execute");
const osascriptScope = shellExecutePermission.allow.find((entry) => entry.name === "osascript");
assert.ok(osascriptScope, "PluginPanel context and shell bridges need a scoped osascript command");
assert.equal(osascriptScope.cmd, "osascript");
assert.deepEqual(
  osascriptScope.args,
  ["-e", { validator: "(?s).+" }],
  "osascript scope should allow only non-empty AppleScript passed through -e"
);
