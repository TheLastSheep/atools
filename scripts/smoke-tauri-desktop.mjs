import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const SMOKE_PREFIX = "ATOOLS_DESKTOP_SMOKE ";

export function parseSmokeOutput(output) {
  const line = output
    .split(/\r?\n/)
    .find((item) => item.startsWith(SMOKE_PREFIX));
  if (!line) {
    throw new Error("Missing ATOOLS_DESKTOP_SMOKE output line");
  }
  const snapshot = JSON.parse(line.slice(SMOKE_PREFIX.length));
  validateSmokeSnapshot(snapshot);
  return snapshot;
}

function requireTrueFields(sectionName, section, keys) {
  for (const key of keys) {
    if (section[key] !== true) {
      throw new Error(
        `Invalid ${sectionName}.${key} in ATOOLS_DESKTOP_SMOKE output: expected true`
      );
    }
  }
}

function validateSmokeSnapshot(snapshot) {
  if (!snapshot.permission_smoke || typeof snapshot.permission_smoke !== "object") {
    throw new Error("Missing permission_smoke in ATOOLS_DESKTOP_SMOKE output");
  }
  const permissionRequired = [
    "permission_required",
    "pending_request_created",
    "audit_denied_recorded",
    "pending_request_dismissed",
    "scope_deny_overrides_developer",
    "scope_deny_audit_recorded",
    "tool_toggle_persisted",
    "tool_toggle_restored",
  ];
  requireTrueFields("permission_smoke", snapshot.permission_smoke, permissionRequired);
  if (!("cleanup_deleted_audits" in snapshot.permission_smoke)) {
    throw new Error(
      "Missing permission_smoke.cleanup_deleted_audits in ATOOLS_DESKTOP_SMOKE output"
    );
  }
  if (!snapshot.data_debug_smoke || typeof snapshot.data_debug_smoke !== "object") {
    throw new Error("Missing data_debug_smoke in ATOOLS_DESKTOP_SMOKE output");
  }
  const dataDebugRequired = [
    "runtime_diagnostics_ready",
    "clipboard_export_json_valid",
    "audit_export_jsonl_valid",
    "audit_filtered_export_checked",
    "audit_filtered_export_count_checked",
    "crash_log_readable",
    "mcp_status_consistent",
    "mcp_ping_ok",
    "mcp_initialized_notification_ok",
    "mcp_discovery_lists_ok",
    "mcp_resources_ok",
    "mcp_prompts_ok",
    "mcp_batch_ok",
    "mcp_notification_ok",
  ];
  requireTrueFields("data_debug_smoke", snapshot.data_debug_smoke, dataDebugRequired);
  if (!snapshot.system_settings_smoke || typeof snapshot.system_settings_smoke !== "object") {
    throw new Error("Missing system_settings_smoke in ATOOLS_DESKTOP_SMOKE output");
  }
  const systemSettingsRequired = [
    "main_window_centered",
    "hotkey_old_unregistered",
    "hotkey_reregistered",
    "tray_visibility_applied",
    "tray_visibility_toggled",
    "launch_agent_plist_valid",
    "launch_agent_write_checked",
    "launch_agent_cleanup_checked",
    "floating_ball_window",
    "super_panel_window",
    "settings_preserved",
  ];
  requireTrueFields(
    "system_settings_smoke",
    snapshot.system_settings_smoke,
    systemSettingsRequired
  );
  if (!snapshot.plugin_runtime_smoke || typeof snapshot.plugin_runtime_smoke !== "object") {
    throw new Error("Missing plugin_runtime_smoke in ATOOLS_DESKTOP_SMOKE output");
  }
  const pluginRuntimeValueRequired = [
    "sample_plugin_id",
    "sample_plugin_name",
    "sample_feature_code",
    "main_url",
  ];
  for (const key of pluginRuntimeValueRequired) {
    if (!(key in snapshot.plugin_runtime_smoke)) {
      throw new Error(`Missing plugin_runtime_smoke.${key} in ATOOLS_DESKTOP_SMOKE output`);
    }
  }
  const pluginRuntimeRequired = [
    "feature_activated",
    "main_exists",
    "plugin_path_exists",
    "expand_height_valid",
    "preload_checked",
    "data_bridge_checked",
    "data_roundtrip_checked",
    "bulk_docs_checked",
    "attachment_checked",
    "data_cleanup_checked",
    "native_bridge_checked",
    "dialog_guard_checked",
    "system_path_checked",
    "shell_target_checked",
    "context_bridge_checked",
    "browser_context_checked",
    "finder_context_checked",
    "shell_show_item_error_checked",
    "copied_files_read_checked",
    "screen_capture_guard_checked",
    "native_error_checked",
    "copy_file_error_checked",
    "copy_image_error_checked",
    "calculator_search_enter_checked",
    "timestamp_search_enter_checked",
  ];
  requireTrueFields("plugin_runtime_smoke", snapshot.plugin_runtime_smoke, pluginRuntimeRequired);
  if (!snapshot.plugin_panel_render_smoke || typeof snapshot.plugin_panel_render_smoke !== "object") {
    throw new Error("Missing plugin_panel_render_smoke in ATOOLS_DESKTOP_SMOKE output");
  }
  const pluginPanelRenderTrueRequired = [
    "reported",
    "plugin_path_exists",
    "fs_load",
    "iframe_srcdoc_loaded",
    "iframe_src_empty",
    "load_error_empty",
    "browser_window_created",
    "browser_window_child_origin_opaque",
    "browser_window_self_tauri_unavailable",
    "browser_window_parent_tauri_unavailable",
    "browser_window_parent_document_blocked",
    "browser_window_send_to_parent_checked",
    "browser_window_execute_javascript_checked",
    "browser_window_ipc_roundtrip_checked",
    "browser_window_cleanup_checked",
    "timestamp_subinput_checked",
  ];
  requireTrueFields(
    "plugin_panel_render_smoke",
    snapshot.plugin_panel_render_smoke,
    pluginPanelRenderTrueRequired
  );
  const pluginPanelRenderRequired = [
    "sample_plugin_id",
    "sample_feature_code",
    "main_url",
    "iframe_srcdoc_bytes",
    "expected_samples",
    "reported_samples",
    "rendered_samples",
    "external_plan_expected_samples",
    "external_plan_rendered_samples",
    "sample_plugin_ids",
    "bridge_probe_expected_samples",
    "bridge_probe_reported_samples",
    "bridge_probe_passed_samples",
    "bridge_probe_checks",
    "bridge_probe_passed_checks",
    "bridge_probe_failed_ids",
    "native_method_probe_expected_samples",
    "native_method_probe_reported_samples",
    "native_method_probe_passed_samples",
    "native_method_probe_checks",
    "native_method_probe_passed_checks",
    "native_method_probe_failed_ids",
    "browser_window_probe_expected_samples",
    "browser_window_probe_reported_samples",
    "browser_window_probe_passed_samples",
    "browser_window_probe_checks",
    "browser_window_probe_passed_checks",
    "browser_window_probe_failed_ids",
  ];
  for (const key of pluginPanelRenderRequired) {
    if (!(key in snapshot.plugin_panel_render_smoke)) {
      throw new Error(`Missing plugin_panel_render_smoke.${key} in ATOOLS_DESKTOP_SMOKE output`);
    }
  }
  if (!snapshot.ztools_external_activation_smoke || typeof snapshot.ztools_external_activation_smoke !== "object") {
    throw new Error("Missing ztools_external_activation_smoke in ATOOLS_DESKTOP_SMOKE output");
  }
  const ztoolsExternalActivationRequired = [
    "planned_samples",
    "imported_samples",
    "activated_samples",
    "ui_actions_checked",
    "plugin_panel_fs_load_checked",
    "assertions_checked",
    "cleanup_verified",
    "skipped_samples",
    "sample_plugin_ids",
  ];
  for (const key of ztoolsExternalActivationRequired) {
    if (!(key in snapshot.ztools_external_activation_smoke)) {
      throw new Error(`Missing ztools_external_activation_smoke.${key} in ATOOLS_DESKTOP_SMOKE output`);
    }
  }
}

export function desktopSmokeEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    ATOOLS_DESKTOP_SMOKE: "1",
    VITE_ATOOLS_DESKTOP_SMOKE: "1",
  };
}

export function desktopSmokeCommand(args) {
  const separator = args.indexOf("--");
  const passThrough = separator >= 0 ? args.slice(separator + 1) : args;
  return {
    command: "pnpm",
    args: ["tauri", "dev", ...passThrough],
  };
}

export async function runDesktopSmoke(args = process.argv.slice(2), options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? process.env.ATOOLS_DESKTOP_SMOKE_TIMEOUT_MS ?? 60000);
  const { command, args: commandArgs } = desktopSmokeCommand(args);
  const env = desktopSmokeEnv(options.env ?? process.env);
  let output = "";

  const child = spawn(command, commandArgs, {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timeout);

  const snapshot = parseSmokeOutput(output);
  if (snapshot.status !== "ok" || exitCode !== 0) {
    throw new Error(`Desktop smoke failed: status=${snapshot.status} exit=${exitCode}`);
  }
  return snapshot;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDesktopSmoke()
    .then((snapshot) => {
      console.log(`Desktop smoke passed: ${snapshot.mcp_bind}`);
    })
    .catch((error) => {
      console.error(error.message || String(error));
      process.exitCode = 1;
    });
}
