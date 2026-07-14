use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use atools_core::agent::{AuditLogEntry, AuditLogQuery, AuditStatus, PermissionDecision};
use atools_core::db::Database;
use atools_core::models::Document;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;

use crate::commands::{FeatureAction, SearchResult};
use crate::mcp_server::McpServerStatus;

const SMOKE_ENV: &str = "ATOOLS_DESKTOP_SMOKE";
const SMOKE_PREFIX: &str = "ATOOLS_DESKTOP_SMOKE ";
const ZTOOLS_ACTIVATION_PLAN_ENV: &str = "ATOOLS_ZTOOLS_ACTIVATION_PLAN";
const LOCAL_APP_SMOKE_QUERY: &str = "com apple terminal";
const PERMISSION_SMOKE_TOOL: &str = "find_local_files";
const SMOKE_MAX_PLUGIN_WINDOW_HEIGHT: u32 = 541;
const PLUGIN_PANEL_RENDER_SMOKE_POLL_MS: u64 = 100;
const PLUGIN_PANEL_RENDER_SMOKE_STANDARD_WAIT_ATTEMPTS: usize = 300;
const PLUGIN_PANEL_RENDER_SMOKE_EXTERNAL_PLAN_WAIT_ATTEMPTS: usize = 1200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopSmokeSnapshot {
    pub status: String,
    pub main_window: bool,
    pub settings_window: bool,
    pub mcp_ready: bool,
    pub mcp_bind: Option<String>,
    pub agent_tools_count: usize,
    pub enabled_agent_tools: Vec<String>,
    pub plugin_count: usize,
    pub audit_entries_count: usize,
    pub permission_mode: String,
    pub runtime_events_count: usize,
    pub permission_smoke: PermissionSmokeSummary,
    pub data_debug_smoke: DataDebugSmokeSummary,
    pub system_settings_smoke: SystemSettingsSmokeSummary,
    pub plugin_runtime_smoke: PluginRuntimeSmokeSummary,
    pub plugin_panel_render_smoke: PluginPanelRenderSmokeSummary,
    pub ztools_external_activation_smoke: ZToolsExternalActivationSmokeSummary,
    pub local_app_search: LocalAppSmokeSummary,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionSmokeSummary {
    pub client_id: String,
    pub tool_name: String,
    pub permission_required: bool,
    pub pending_request_created: bool,
    pub audit_denied_recorded: bool,
    pub pending_request_dismissed: bool,
    pub scope_deny_overrides_developer: bool,
    pub scope_deny_audit_recorded: bool,
    pub tool_toggle_persisted: bool,
    pub tool_toggle_restored: bool,
    pub cleanup_deleted_audits: usize,
    pub error: Option<String>,
}

impl PermissionSmokeSummary {
    pub fn skipped(error: impl Into<String>) -> Self {
        Self {
            client_id: "atools-desktop-smoke".to_string(),
            tool_name: PERMISSION_SMOKE_TOOL.to_string(),
            permission_required: false,
            pending_request_created: false,
            audit_denied_recorded: false,
            pending_request_dismissed: false,
            scope_deny_overrides_developer: false,
            scope_deny_audit_recorded: false,
            tool_toggle_persisted: false,
            tool_toggle_restored: false,
            cleanup_deleted_audits: 0,
            error: Some(error.into()),
        }
    }

    pub fn ok(&self) -> bool {
        self.permission_required
            && self.pending_request_created
            && self.audit_denied_recorded
            && self.pending_request_dismissed
            && self.scope_deny_overrides_developer
            && self.scope_deny_audit_recorded
            && self.tool_toggle_persisted
            && self.tool_toggle_restored
            && self.cleanup_deleted_audits >= 2
            && self.error.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataDebugSmokeSummary {
    pub runtime_diagnostics_ready: bool,
    pub clipboard_export_json_valid: bool,
    pub audit_export_jsonl_valid: bool,
    pub audit_filtered_export_checked: bool,
    pub audit_filtered_export_count_checked: bool,
    pub crash_log_readable: bool,
    pub mcp_status_consistent: bool,
    pub mcp_ping_ok: bool,
    pub mcp_initialized_notification_ok: bool,
    pub mcp_discovery_lists_ok: bool,
    pub mcp_resources_ok: bool,
    pub mcp_prompts_ok: bool,
    pub mcp_batch_ok: bool,
    pub mcp_notification_ok: bool,
    pub error: Option<String>,
}

impl DataDebugSmokeSummary {
    pub fn skipped(error: impl Into<String>) -> Self {
        Self {
            runtime_diagnostics_ready: false,
            clipboard_export_json_valid: false,
            audit_export_jsonl_valid: false,
            audit_filtered_export_checked: false,
            audit_filtered_export_count_checked: false,
            crash_log_readable: false,
            mcp_status_consistent: false,
            mcp_ping_ok: false,
            mcp_initialized_notification_ok: false,
            mcp_discovery_lists_ok: false,
            mcp_resources_ok: false,
            mcp_prompts_ok: false,
            mcp_batch_ok: false,
            mcp_notification_ok: false,
            error: Some(error.into()),
        }
    }

    pub fn ok(&self) -> bool {
        self.runtime_diagnostics_ready
            && self.clipboard_export_json_valid
            && self.audit_export_jsonl_valid
            && self.audit_filtered_export_checked
            && self.audit_filtered_export_count_checked
            && self.crash_log_readable
            && self.mcp_status_consistent
            && self.mcp_ping_ok
            && self.mcp_initialized_notification_ok
            && self.mcp_discovery_lists_ok
            && self.mcp_resources_ok
            && self.mcp_prompts_ok
            && self.mcp_batch_ok
            && self.mcp_notification_ok
            && self.error.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSettingsSmokeSummary {
    pub main_window_centered: bool,
    pub hotkey_reregistered: bool,
    pub hotkey_old_unregistered: bool,
    pub tray_visibility_applied: bool,
    pub tray_visibility_toggled: bool,
    pub launch_agent_plist_valid: bool,
    pub launch_agent_write_checked: bool,
    pub launch_agent_cleanup_checked: bool,
    pub floating_ball_window: bool,
    pub super_panel_window: bool,
    pub settings_preserved: bool,
    pub error: Option<String>,
}

impl SystemSettingsSmokeSummary {
    pub fn skipped(error: impl Into<String>) -> Self {
        Self {
            main_window_centered: false,
            hotkey_reregistered: false,
            hotkey_old_unregistered: false,
            tray_visibility_applied: false,
            tray_visibility_toggled: false,
            launch_agent_plist_valid: false,
            launch_agent_write_checked: false,
            launch_agent_cleanup_checked: false,
            floating_ball_window: false,
            super_panel_window: false,
            settings_preserved: false,
            error: Some(error.into()),
        }
    }

    pub fn ok(&self) -> bool {
        self.main_window_centered
            && self.hotkey_old_unregistered
            && self.hotkey_reregistered
            && self.tray_visibility_applied
            && self.tray_visibility_toggled
            && self.launch_agent_plist_valid
            && self.launch_agent_write_checked
            && self.launch_agent_cleanup_checked
            && self.floating_ball_window
            && self.super_panel_window
            && self.settings_preserved
            && self.error.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalAppSmokeSummary {
    pub query: String,
    pub result_count: usize,
    pub icon_count: usize,
    pub sample_label: Option<String>,
    pub sample_has_icon: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRuntimeSmokeSummary {
    pub feature_activated: bool,
    pub sample_plugin_id: String,
    pub sample_plugin_name: String,
    pub sample_feature_code: String,
    pub main_url: String,
    pub main_exists: bool,
    pub plugin_path_exists: bool,
    pub expand_height_valid: bool,
    pub preload_checked: bool,
    pub data_bridge_checked: bool,
    pub data_roundtrip_checked: bool,
    pub bulk_docs_checked: bool,
    pub attachment_checked: bool,
    pub data_cleanup_checked: bool,
    pub native_bridge_checked: bool,
    pub dialog_guard_checked: bool,
    pub system_path_checked: bool,
    pub shell_target_checked: bool,
    pub context_bridge_checked: bool,
    pub browser_context_checked: bool,
    pub finder_context_checked: bool,
    pub shell_show_item_error_checked: bool,
    pub copied_files_read_checked: bool,
    pub screen_capture_guard_checked: bool,
    pub native_error_checked: bool,
    pub copy_file_error_checked: bool,
    pub copy_image_error_checked: bool,
    pub calculator_search_enter_checked: bool,
    pub timestamp_search_enter_checked: bool,
    pub error: Option<String>,
}

impl PluginRuntimeSmokeSummary {
    pub fn skipped(error: impl Into<String>) -> Self {
        Self {
            feature_activated: false,
            sample_plugin_id: String::new(),
            sample_plugin_name: String::new(),
            sample_feature_code: String::new(),
            main_url: String::new(),
            main_exists: false,
            plugin_path_exists: false,
            expand_height_valid: false,
            preload_checked: false,
            data_bridge_checked: false,
            data_roundtrip_checked: false,
            bulk_docs_checked: false,
            attachment_checked: false,
            data_cleanup_checked: false,
            native_bridge_checked: false,
            dialog_guard_checked: false,
            system_path_checked: false,
            shell_target_checked: false,
            context_bridge_checked: false,
            browser_context_checked: false,
            finder_context_checked: false,
            shell_show_item_error_checked: false,
            copied_files_read_checked: false,
            screen_capture_guard_checked: false,
            native_error_checked: false,
            copy_file_error_checked: false,
            copy_image_error_checked: false,
            calculator_search_enter_checked: false,
            timestamp_search_enter_checked: false,
            error: Some(error.into()),
        }
    }

    pub fn ok(&self) -> bool {
        self.feature_activated
            && !self.sample_plugin_id.is_empty()
            && !self.sample_plugin_name.is_empty()
            && !self.sample_feature_code.is_empty()
            && !self.main_url.is_empty()
            && self.main_exists
            && self.plugin_path_exists
            && self.expand_height_valid
            && self.preload_checked
            && self.data_bridge_checked
            && self.data_roundtrip_checked
            && self.bulk_docs_checked
            && self.attachment_checked
            && self.data_cleanup_checked
            && self.native_bridge_checked
            && self.dialog_guard_checked
            && self.system_path_checked
            && self.shell_target_checked
            && self.context_bridge_checked
            && self.browser_context_checked
            && self.finder_context_checked
            && self.shell_show_item_error_checked
            && self.copied_files_read_checked
            && self.screen_capture_guard_checked
            && self.native_error_checked
            && self.copy_file_error_checked
            && self.copy_image_error_checked
            && self.calculator_search_enter_checked
            && self.timestamp_search_enter_checked
            && self.error.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginPanelRenderSmokeSummary {
    pub reported: bool,
    pub sample_plugin_id: String,
    pub sample_feature_code: String,
    pub main_url: String,
    pub plugin_path_exists: bool,
    pub fs_load: bool,
    pub iframe_srcdoc_loaded: bool,
    pub iframe_src_empty: bool,
    pub load_error_empty: bool,
    pub iframe_srcdoc_bytes: usize,
    pub expected_samples: usize,
    pub reported_samples: usize,
    pub rendered_samples: usize,
    pub external_plan_expected_samples: usize,
    pub external_plan_rendered_samples: usize,
    pub sample_plugin_ids: Vec<String>,
    pub bridge_probe_expected_samples: usize,
    pub bridge_probe_reported_samples: usize,
    pub bridge_probe_passed_samples: usize,
    pub bridge_probe_checks: usize,
    pub bridge_probe_passed_checks: usize,
    pub bridge_probe_failed_ids: Vec<String>,
    pub native_method_probe_expected_samples: usize,
    pub native_method_probe_reported_samples: usize,
    pub native_method_probe_passed_samples: usize,
    pub native_method_probe_checks: usize,
    pub native_method_probe_passed_checks: usize,
    pub native_method_probe_failed_ids: Vec<String>,
    pub browser_window_probe_expected_samples: usize,
    pub browser_window_probe_reported_samples: usize,
    pub browser_window_probe_passed_samples: usize,
    pub browser_window_probe_checks: usize,
    pub browser_window_probe_passed_checks: usize,
    pub browser_window_probe_failed_ids: Vec<String>,
    pub browser_window_created: bool,
    pub browser_window_child_origin_opaque: bool,
    pub browser_window_self_tauri_unavailable: bool,
    pub browser_window_parent_tauri_unavailable: bool,
    pub browser_window_parent_document_blocked: bool,
    pub browser_window_send_to_parent_checked: bool,
    pub browser_window_execute_javascript_checked: bool,
    pub browser_window_ipc_roundtrip_checked: bool,
    pub browser_window_cleanup_checked: bool,
    pub timestamp_subinput_checked: bool,
    pub error: Option<String>,
}

impl PluginPanelRenderSmokeSummary {
    pub fn skipped(error: impl Into<String>) -> Self {
        Self {
            reported: false,
            sample_plugin_id: String::new(),
            sample_feature_code: String::new(),
            main_url: String::new(),
            plugin_path_exists: false,
            fs_load: false,
            iframe_srcdoc_loaded: false,
            iframe_src_empty: false,
            load_error_empty: false,
            iframe_srcdoc_bytes: 0,
            expected_samples: 0,
            reported_samples: 0,
            rendered_samples: 0,
            external_plan_expected_samples: 0,
            external_plan_rendered_samples: 0,
            sample_plugin_ids: Vec::new(),
            bridge_probe_expected_samples: 0,
            bridge_probe_reported_samples: 0,
            bridge_probe_passed_samples: 0,
            bridge_probe_checks: 0,
            bridge_probe_passed_checks: 0,
            bridge_probe_failed_ids: Vec::new(),
            native_method_probe_expected_samples: 0,
            native_method_probe_reported_samples: 0,
            native_method_probe_passed_samples: 0,
            native_method_probe_checks: 0,
            native_method_probe_passed_checks: 0,
            native_method_probe_failed_ids: Vec::new(),
            browser_window_probe_expected_samples: 0,
            browser_window_probe_reported_samples: 0,
            browser_window_probe_passed_samples: 0,
            browser_window_probe_checks: 0,
            browser_window_probe_passed_checks: 0,
            browser_window_probe_failed_ids: Vec::new(),
            browser_window_created: false,
            browser_window_child_origin_opaque: false,
            browser_window_self_tauri_unavailable: false,
            browser_window_parent_tauri_unavailable: false,
            browser_window_parent_document_blocked: false,
            browser_window_send_to_parent_checked: false,
            browser_window_execute_javascript_checked: false,
            browser_window_ipc_roundtrip_checked: false,
            browser_window_cleanup_checked: false,
            timestamp_subinput_checked: false,
            error: Some(error.into()),
        }
    }

    fn from_report(report: PluginPanelRenderSmokeReport) -> Self {
        let sample_plugin_id = report.plugin_id.trim().to_string();
        let sample_feature_code = report.feature_code.trim().to_string();
        let main_url = report.main_url.trim().to_string();
        let subinput_placeholder = report.subinput_placeholder.trim().to_string();
        let plugin_path_exists = Path::new(report.plugin_path.trim()).is_dir();
        let load_error = report.load_error.unwrap_or_default();
        let load_error_empty = load_error.trim().is_empty();
        let iframe_srcdoc_loaded = report.iframe_srcdoc_loaded && report.iframe_srcdoc_bytes > 0;
        let iframe_src_empty = report.iframe_src_empty;
        let fs_load = report.fs_load && plugin_path_exists && !main_url.is_empty();
        let expected_samples = report.expected_samples.max(1);
        let mut sample_plugin_ids = Vec::new();
        if !sample_plugin_id.is_empty() {
            sample_plugin_ids.push(sample_plugin_id.clone());
        }
        let mut errors = Vec::new();
        if sample_plugin_id.is_empty() {
            errors.push("missing plugin id".to_string());
        }
        if sample_feature_code.is_empty() {
            errors.push("missing feature code".to_string());
        }
        if main_url.is_empty() {
            errors.push("missing main url".to_string());
        }
        if report.sample_index >= expected_samples {
            errors.push(format!(
                "sample index {} is outside expected sample count {}",
                report.sample_index, expected_samples
            ));
        }
        if !plugin_path_exists {
            errors.push(format!("plugin path missing: {}", report.plugin_path));
        }
        if !fs_load {
            errors.push("PluginPanel did not use filesystem loading".to_string());
        }
        if !iframe_srcdoc_loaded {
            errors.push("PluginPanel srcdoc was not populated".to_string());
        }
        if !iframe_src_empty {
            errors.push(
                "PluginPanel iframe src should be empty for filesystem srcdoc load".to_string(),
            );
        }
        if !load_error_empty {
            errors.push(load_error);
        }
        let mut bridge_probe_failed_ids = report
            .bridge_probe_failed_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        bridge_probe_failed_ids.sort();
        bridge_probe_failed_ids.dedup();
        let bridge_probe_checks = report.bridge_probe_checks;
        let bridge_probe_passed_checks = report.bridge_probe_passed_checks;
        let bridge_probe_passed = report.bridge_probe_reported
            && report.bridge_probe_passed
            && bridge_probe_checks > 0
            && bridge_probe_passed_checks == bridge_probe_checks
            && bridge_probe_failed_ids.is_empty();
        if !report.bridge_probe_reported {
            errors.push("PluginPanel bridge probe did not report".to_string());
        }
        if bridge_probe_checks == 0 {
            errors.push("PluginPanel bridge probe did not run any checks".to_string());
        }
        if bridge_probe_passed_checks != bridge_probe_checks {
            errors.push(format!(
                "PluginPanel bridge probe passed {}/{} checks",
                bridge_probe_passed_checks, bridge_probe_checks
            ));
        }
        if !bridge_probe_failed_ids.is_empty() {
            errors.push(format!(
                "PluginPanel bridge probe failed: {}",
                bridge_probe_failed_ids.join(",")
            ));
        }
        let mut native_method_probe_failed_ids = report
            .native_method_probe_failed_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        native_method_probe_failed_ids.sort();
        native_method_probe_failed_ids.dedup();
        let native_method_probe_checks = report.native_method_probe_checks;
        let native_method_probe_passed_checks = report.native_method_probe_passed_checks;
        let native_method_probe_passed = report.native_method_probe_reported
            && report.native_method_probe_passed
            && native_method_probe_checks > 0
            && native_method_probe_passed_checks == native_method_probe_checks
            && native_method_probe_failed_ids.is_empty();
        if !report.native_method_probe_reported {
            errors.push("PluginPanel native method probe did not report".to_string());
        }
        if native_method_probe_checks == 0 {
            errors.push("PluginPanel native method probe did not run any checks".to_string());
        }
        if native_method_probe_passed_checks != native_method_probe_checks {
            errors.push(format!(
                "PluginPanel native method probe passed {}/{} checks",
                native_method_probe_passed_checks, native_method_probe_checks
            ));
        }
        if !native_method_probe_failed_ids.is_empty() {
            errors.push(format!(
                "PluginPanel native method probe failed: {}",
                native_method_probe_failed_ids.join(",")
            ));
        }
        let browser_window_probe_expected = report.sample_index == 0;
        if report.browser_window_probe_expected != browser_window_probe_expected {
            errors.push(format!(
                "PluginPanel BrowserWindow probe expected flag was {} for sample {}",
                report.browser_window_probe_expected, report.sample_index
            ));
        }
        let mut browser_window_probe_failed_ids = if browser_window_probe_expected {
            report
                .browser_window_probe_failed_ids
                .into_iter()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        browser_window_probe_failed_ids.sort();
        browser_window_probe_failed_ids.dedup();
        let browser_window_probe_checks = if browser_window_probe_expected {
            report.browser_window_probe_checks
        } else {
            0
        };
        let browser_window_probe_passed_checks = if browser_window_probe_expected {
            report.browser_window_probe_passed_checks
        } else {
            0
        };
        let browser_window_probe_flags_passed = report.browser_window_created
            && report.browser_window_child_origin_opaque
            && report.browser_window_self_tauri_unavailable
            && report.browser_window_parent_tauri_unavailable
            && report.browser_window_parent_document_blocked
            && report.browser_window_send_to_parent_checked
            && report.browser_window_execute_javascript_checked
            && report.browser_window_ipc_roundtrip_checked
            && report.browser_window_cleanup_checked;
        let browser_window_probe_passed = browser_window_probe_expected
            && report.browser_window_probe_reported
            && report.browser_window_probe_passed
            && browser_window_probe_checks == 9
            && browser_window_probe_passed_checks == 9
            && browser_window_probe_failed_ids.is_empty()
            && browser_window_probe_flags_passed;
        if browser_window_probe_expected {
            if !report.browser_window_probe_reported {
                errors.push("PluginPanel BrowserWindow probe did not report".to_string());
            }
            if !report.browser_window_probe_passed {
                errors.push("PluginPanel BrowserWindow probe did not pass".to_string());
            }
            if browser_window_probe_checks != 9 {
                errors.push(format!(
                    "PluginPanel BrowserWindow probe ran {browser_window_probe_checks}/9 checks"
                ));
            }
            if browser_window_probe_passed_checks != 9 {
                errors.push(format!(
                    "PluginPanel BrowserWindow probe passed {browser_window_probe_passed_checks}/9 checks"
                ));
            }
            if !browser_window_probe_failed_ids.is_empty() {
                errors.push(format!(
                    "PluginPanel BrowserWindow probe failed: {}",
                    browser_window_probe_failed_ids.join(",")
                ));
            }
            if !browser_window_probe_flags_passed {
                errors.push("PluginPanel BrowserWindow probe contract was incomplete".to_string());
            }
        }
        let single_error = (!errors.is_empty()).then(|| errors.join("; "));
        let rendered = single_error.is_none()
            && plugin_path_exists
            && fs_load
            && iframe_srcdoc_loaded
            && iframe_src_empty
            && load_error_empty;
        let reported_samples = 1;
        let rendered_samples = usize::from(rendered);
        let external_plan_expected_samples = usize::from(report.external_plan_sample);
        let external_plan_rendered_samples = if report.external_plan_sample && rendered {
            1
        } else {
            0
        };
        let timestamp_subinput_checked = (sample_feature_code == "timestamp"
            || sample_feature_code == "时间戳")
            && report.subinput_visible
            && subinput_placeholder.contains("时间戳");

        Self {
            reported: reported_samples >= expected_samples,
            sample_plugin_id,
            sample_feature_code,
            main_url,
            plugin_path_exists,
            fs_load,
            iframe_srcdoc_loaded,
            iframe_src_empty,
            load_error_empty,
            iframe_srcdoc_bytes: report.iframe_srcdoc_bytes,
            expected_samples,
            reported_samples,
            rendered_samples,
            external_plan_expected_samples,
            external_plan_rendered_samples,
            sample_plugin_ids,
            bridge_probe_expected_samples: expected_samples,
            bridge_probe_reported_samples: usize::from(report.bridge_probe_reported),
            bridge_probe_passed_samples: usize::from(bridge_probe_passed),
            bridge_probe_checks,
            bridge_probe_passed_checks,
            bridge_probe_failed_ids,
            native_method_probe_expected_samples: expected_samples,
            native_method_probe_reported_samples: usize::from(report.native_method_probe_reported),
            native_method_probe_passed_samples: usize::from(native_method_probe_passed),
            native_method_probe_checks,
            native_method_probe_passed_checks,
            native_method_probe_failed_ids,
            browser_window_probe_expected_samples: usize::from(browser_window_probe_expected),
            browser_window_probe_reported_samples: usize::from(
                browser_window_probe_expected && report.browser_window_probe_reported,
            ),
            browser_window_probe_passed_samples: usize::from(browser_window_probe_passed),
            browser_window_probe_checks,
            browser_window_probe_passed_checks,
            browser_window_probe_failed_ids,
            browser_window_created: browser_window_probe_expected && report.browser_window_created,
            browser_window_child_origin_opaque: browser_window_probe_expected
                && report.browser_window_child_origin_opaque,
            browser_window_self_tauri_unavailable: browser_window_probe_expected
                && report.browser_window_self_tauri_unavailable,
            browser_window_parent_tauri_unavailable: browser_window_probe_expected
                && report.browser_window_parent_tauri_unavailable,
            browser_window_parent_document_blocked: browser_window_probe_expected
                && report.browser_window_parent_document_blocked,
            browser_window_send_to_parent_checked: browser_window_probe_expected
                && report.browser_window_send_to_parent_checked,
            browser_window_execute_javascript_checked: browser_window_probe_expected
                && report.browser_window_execute_javascript_checked,
            browser_window_ipc_roundtrip_checked: browser_window_probe_expected
                && report.browser_window_ipc_roundtrip_checked,
            browser_window_cleanup_checked: browser_window_probe_expected
                && report.browser_window_cleanup_checked,
            timestamp_subinput_checked,
            error: single_error,
        }
    }

    fn merge_report(mut self, report: PluginPanelRenderSmokeReport) -> Self {
        let next = Self::from_report(report);
        let already_reported = self
            .sample_plugin_ids
            .iter()
            .any(|plugin_id| plugin_id == &next.sample_plugin_id);
        self.expected_samples = self.expected_samples.max(next.expected_samples).max(1);
        if !already_reported {
            self.reported_samples += next.reported_samples;
            self.rendered_samples += next.rendered_samples;
            self.external_plan_expected_samples += next.external_plan_expected_samples;
            self.external_plan_rendered_samples += next.external_plan_rendered_samples;
            if !next.sample_plugin_id.is_empty() {
                self.sample_plugin_ids.push(next.sample_plugin_id.clone());
            }
            self.bridge_probe_reported_samples += next.bridge_probe_reported_samples;
            self.bridge_probe_passed_samples += next.bridge_probe_passed_samples;
            self.bridge_probe_checks += next.bridge_probe_checks;
            self.bridge_probe_passed_checks += next.bridge_probe_passed_checks;
            for failed_id in next.bridge_probe_failed_ids {
                if !self.bridge_probe_failed_ids.contains(&failed_id) {
                    self.bridge_probe_failed_ids.push(failed_id);
                }
            }
            self.native_method_probe_reported_samples += next.native_method_probe_reported_samples;
            self.native_method_probe_passed_samples += next.native_method_probe_passed_samples;
            self.native_method_probe_checks += next.native_method_probe_checks;
            self.native_method_probe_passed_checks += next.native_method_probe_passed_checks;
            for failed_id in next.native_method_probe_failed_ids {
                if !self.native_method_probe_failed_ids.contains(&failed_id) {
                    self.native_method_probe_failed_ids.push(failed_id);
                }
            }
            if next.browser_window_probe_expected_samples > 0 {
                let already_had_browser_window_probe =
                    self.browser_window_probe_expected_samples > 0;
                self.browser_window_probe_reported_samples +=
                    next.browser_window_probe_reported_samples;
                self.browser_window_probe_passed_samples +=
                    next.browser_window_probe_passed_samples;
                self.browser_window_probe_checks += next.browser_window_probe_checks;
                self.browser_window_probe_passed_checks += next.browser_window_probe_passed_checks;
                for failed_id in next.browser_window_probe_failed_ids {
                    if !self.browser_window_probe_failed_ids.contains(&failed_id) {
                        self.browser_window_probe_failed_ids.push(failed_id);
                    }
                }
                if already_had_browser_window_probe {
                    self.browser_window_created =
                        self.browser_window_created && next.browser_window_created;
                    self.browser_window_child_origin_opaque = self
                        .browser_window_child_origin_opaque
                        && next.browser_window_child_origin_opaque;
                    self.browser_window_self_tauri_unavailable = self
                        .browser_window_self_tauri_unavailable
                        && next.browser_window_self_tauri_unavailable;
                    self.browser_window_parent_tauri_unavailable = self
                        .browser_window_parent_tauri_unavailable
                        && next.browser_window_parent_tauri_unavailable;
                    self.browser_window_parent_document_blocked = self
                        .browser_window_parent_document_blocked
                        && next.browser_window_parent_document_blocked;
                    self.browser_window_send_to_parent_checked = self
                        .browser_window_send_to_parent_checked
                        && next.browser_window_send_to_parent_checked;
                    self.browser_window_execute_javascript_checked = self
                        .browser_window_execute_javascript_checked
                        && next.browser_window_execute_javascript_checked;
                    self.browser_window_ipc_roundtrip_checked = self
                        .browser_window_ipc_roundtrip_checked
                        && next.browser_window_ipc_roundtrip_checked;
                    self.browser_window_cleanup_checked =
                        self.browser_window_cleanup_checked && next.browser_window_cleanup_checked;
                } else {
                    self.browser_window_created = next.browser_window_created;
                    self.browser_window_child_origin_opaque =
                        next.browser_window_child_origin_opaque;
                    self.browser_window_self_tauri_unavailable =
                        next.browser_window_self_tauri_unavailable;
                    self.browser_window_parent_tauri_unavailable =
                        next.browser_window_parent_tauri_unavailable;
                    self.browser_window_parent_document_blocked =
                        next.browser_window_parent_document_blocked;
                    self.browser_window_send_to_parent_checked =
                        next.browser_window_send_to_parent_checked;
                    self.browser_window_execute_javascript_checked =
                        next.browser_window_execute_javascript_checked;
                    self.browser_window_ipc_roundtrip_checked =
                        next.browser_window_ipc_roundtrip_checked;
                    self.browser_window_cleanup_checked = next.browser_window_cleanup_checked;
                }
            }
            self.timestamp_subinput_checked =
                self.timestamp_subinput_checked || next.timestamp_subinput_checked;
        }
        self.bridge_probe_expected_samples = self
            .bridge_probe_expected_samples
            .max(next.bridge_probe_expected_samples)
            .max(1);
        self.native_method_probe_expected_samples = self
            .native_method_probe_expected_samples
            .max(next.native_method_probe_expected_samples)
            .max(1);
        self.browser_window_probe_expected_samples = self
            .browser_window_probe_expected_samples
            .max(next.browser_window_probe_expected_samples);
        self.plugin_path_exists = self.plugin_path_exists && next.plugin_path_exists;
        self.fs_load = self.fs_load && next.fs_load;
        self.iframe_srcdoc_loaded = self.iframe_srcdoc_loaded && next.iframe_srcdoc_loaded;
        self.iframe_src_empty = self.iframe_src_empty && next.iframe_src_empty;
        self.load_error_empty = self.load_error_empty && next.load_error_empty;
        self.iframe_srcdoc_bytes += next.iframe_srcdoc_bytes;
        if let Some(error) = next.error {
            self.error = Some(
                self.error
                    .map(|existing| format!("{existing}; {error}"))
                    .unwrap_or(error),
            );
        }
        self.reported = self.complete();
        self
    }

    fn complete(&self) -> bool {
        self.expected_samples > 0 && self.reported_samples >= self.expected_samples
    }

    fn finalized(mut self) -> Self {
        if self.expected_samples > 0 && self.reported_samples < self.expected_samples {
            let error = format!(
                "PluginPanel render smoke reported {}/{} samples",
                self.reported_samples, self.expected_samples
            );
            self.error = Some(
                self.error
                    .map(|existing| format!("{existing}; {error}"))
                    .unwrap_or(error),
            );
        }
        if self.expected_samples > 0 && self.bridge_probe_reported_samples < self.expected_samples {
            let error = format!(
                "PluginPanel bridge probe reported {}/{} samples",
                self.bridge_probe_reported_samples, self.expected_samples
            );
            self.error = Some(
                self.error
                    .map(|existing| format!("{existing}; {error}"))
                    .unwrap_or(error),
            );
        }
        if self.expected_samples > 0
            && self.native_method_probe_reported_samples < self.expected_samples
        {
            let error = format!(
                "PluginPanel native method probe reported {}/{} samples",
                self.native_method_probe_reported_samples, self.expected_samples
            );
            self.error = Some(
                self.error
                    .map(|existing| format!("{existing}; {error}"))
                    .unwrap_or(error),
            );
        }
        if self.browser_window_probe_expected_samples != 1 {
            let error = format!(
                "PluginPanel BrowserWindow probe expected {} samples instead of 1",
                self.browser_window_probe_expected_samples
            );
            self.error = Some(
                self.error
                    .map(|existing| format!("{existing}; {error}"))
                    .unwrap_or(error),
            );
        } else if self.browser_window_probe_reported_samples < 1 {
            let error = "PluginPanel BrowserWindow probe reported 0/1 samples".to_string();
            self.error = Some(
                self.error
                    .map(|existing| format!("{existing}; {error}"))
                    .unwrap_or(error),
            );
        }
        self.reported = self.complete();
        self
    }

    pub fn ok(&self) -> bool {
        self.reported
            && !self.sample_plugin_id.is_empty()
            && !self.sample_feature_code.is_empty()
            && !self.main_url.is_empty()
            && self.plugin_path_exists
            && self.fs_load
            && self.iframe_srcdoc_loaded
            && self.iframe_src_empty
            && self.load_error_empty
            && self.iframe_srcdoc_bytes > 0
            && self.expected_samples > 0
            && self.reported_samples == self.expected_samples
            && self.rendered_samples == self.expected_samples
            && self.external_plan_rendered_samples == self.external_plan_expected_samples
            && self.sample_plugin_ids.len() == self.reported_samples
            && self.bridge_probe_expected_samples == self.expected_samples
            && self.bridge_probe_reported_samples == self.expected_samples
            && self.bridge_probe_passed_samples == self.expected_samples
            && self.bridge_probe_checks > 0
            && self.bridge_probe_passed_checks == self.bridge_probe_checks
            && self.bridge_probe_failed_ids.is_empty()
            && self.native_method_probe_expected_samples == self.expected_samples
            && self.native_method_probe_reported_samples == self.expected_samples
            && self.native_method_probe_passed_samples == self.expected_samples
            && self.native_method_probe_checks > 0
            && self.native_method_probe_passed_checks == self.native_method_probe_checks
            && self.native_method_probe_failed_ids.is_empty()
            && self.browser_window_probe_expected_samples == 1
            && self.browser_window_probe_reported_samples == 1
            && self.browser_window_probe_passed_samples == 1
            && self.browser_window_probe_checks == 9
            && self.browser_window_probe_passed_checks == 9
            && self.browser_window_probe_failed_ids.is_empty()
            && self.browser_window_created
            && self.browser_window_child_origin_opaque
            && self.browser_window_self_tauri_unavailable
            && self.browser_window_parent_tauri_unavailable
            && self.browser_window_parent_document_blocked
            && self.browser_window_send_to_parent_checked
            && self.browser_window_execute_javascript_checked
            && self.browser_window_ipc_roundtrip_checked
            && self.browser_window_cleanup_checked
            && self.timestamp_subinput_checked
            && self.error.is_none()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPanelRenderSmokeReport {
    pub plugin_id: String,
    pub feature_code: String,
    pub main_url: String,
    pub plugin_path: String,
    pub fs_load: bool,
    pub iframe_srcdoc_loaded: bool,
    pub iframe_src_empty: bool,
    pub load_error: Option<String>,
    pub iframe_srcdoc_bytes: usize,
    pub expected_samples: usize,
    pub sample_index: usize,
    pub external_plan_sample: bool,
    pub bridge_probe_reported: bool,
    pub bridge_probe_passed: bool,
    pub bridge_probe_checks: usize,
    pub bridge_probe_passed_checks: usize,
    pub bridge_probe_failed_ids: Vec<String>,
    pub native_method_probe_reported: bool,
    pub native_method_probe_passed: bool,
    pub native_method_probe_checks: usize,
    pub native_method_probe_passed_checks: usize,
    pub native_method_probe_failed_ids: Vec<String>,
    pub browser_window_probe_expected: bool,
    pub browser_window_probe_reported: bool,
    pub browser_window_probe_passed: bool,
    pub browser_window_probe_checks: usize,
    pub browser_window_probe_passed_checks: usize,
    pub browser_window_probe_failed_ids: Vec<String>,
    pub browser_window_created: bool,
    pub browser_window_child_origin_opaque: bool,
    pub browser_window_self_tauri_unavailable: bool,
    pub browser_window_parent_tauri_unavailable: bool,
    pub browser_window_parent_document_blocked: bool,
    pub browser_window_send_to_parent_checked: bool,
    pub browser_window_execute_javascript_checked: bool,
    pub browser_window_ipc_roundtrip_checked: bool,
    pub browser_window_cleanup_checked: bool,
    pub subinput_visible: bool,
    pub subinput_placeholder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsExternalActivationSmokeSummary {
    pub plan_path: String,
    pub planned_samples: usize,
    pub imported_samples: usize,
    pub activated_samples: usize,
    pub ui_actions_checked: usize,
    pub plugin_panel_fs_load_checked: usize,
    pub assertions_checked: usize,
    pub cleanup_verified: usize,
    pub skipped_samples: usize,
    pub sample_plugin_ids: Vec<String>,
    pub error: Option<String>,
}

impl ZToolsExternalActivationSmokeSummary {
    pub fn skipped() -> Self {
        Self {
            plan_path: String::new(),
            planned_samples: 0,
            imported_samples: 0,
            activated_samples: 0,
            ui_actions_checked: 0,
            plugin_panel_fs_load_checked: 0,
            assertions_checked: 0,
            cleanup_verified: 0,
            skipped_samples: 0,
            sample_plugin_ids: Vec::new(),
            error: None,
        }
    }

    pub fn failed(plan_path: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            plan_path: plan_path.into(),
            planned_samples: 0,
            imported_samples: 0,
            activated_samples: 0,
            ui_actions_checked: 0,
            plugin_panel_fs_load_checked: 0,
            assertions_checked: 0,
            cleanup_verified: 0,
            skipped_samples: 0,
            sample_plugin_ids: Vec::new(),
            error: Some(error.into()),
        }
    }

    pub fn ok(&self) -> bool {
        if self.plan_path.is_empty() {
            return self.error.is_none();
        }
        self.planned_samples > 0
            && self.imported_samples > 0
            && self.imported_samples == self.activated_samples
            && self.imported_samples == self.ui_actions_checked
            && self.imported_samples == self.plugin_panel_fs_load_checked
            && self.imported_samples == self.assertions_checked
            && self.imported_samples == self.cleanup_verified
            && self.error.is_none()
    }
}

#[derive(Debug, Clone)]
struct PluginDataBridgeSmoke {
    data_bridge_checked: bool,
    data_roundtrip_checked: bool,
    bulk_docs_checked: bool,
    attachment_checked: bool,
    data_cleanup_checked: bool,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct PluginNativeBridgeSmoke {
    native_bridge_checked: bool,
    dialog_guard_checked: bool,
    system_path_checked: bool,
    shell_target_checked: bool,
    context_bridge_checked: bool,
    browser_context_checked: bool,
    finder_context_checked: bool,
    shell_show_item_error_checked: bool,
    copied_files_read_checked: bool,
    screen_capture_guard_checked: bool,
    native_error_checked: bool,
    copy_file_error_checked: bool,
    copy_image_error_checked: bool,
    error: Option<String>,
}

pub fn desktop_smoke_enabled() -> bool {
    smoke_env_value_enabled(SMOKE_ENV)
}

#[tauri::command]
pub async fn desktop_smoke_plugin_panel_action(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Option<FeatureAction>, String> {
    Ok(desktop_smoke_plugin_panel_actions(state)
        .await?
        .into_iter()
        .next())
}

#[tauri::command]
pub async fn desktop_smoke_plugin_panel_actions(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<FeatureAction>, String> {
    if !desktop_smoke_enabled() {
        return Ok(Vec::new());
    }

    for _ in 0..50 {
        let actions = build_plugin_panel_render_smoke_actions(&state.db)?;
        if let Some(action) = actions.first() {
            *state.active_plugin.lock() = Some(action.plugin_id.clone());
            return Ok(actions);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    Ok(Vec::new())
}

#[tauri::command]
pub fn report_plugin_panel_render_smoke(
    state: tauri::State<'_, crate::state::AppState>,
    report: PluginPanelRenderSmokeReport,
) -> Result<(), String> {
    if !desktop_smoke_enabled() {
        return Ok(());
    }

    let mut slot = state.plugin_panel_render_smoke.lock();
    let summary = slot
        .take()
        .map(|summary| summary.merge_report(report.clone()))
        .unwrap_or_else(|| PluginPanelRenderSmokeSummary::from_report(report));
    *slot = Some(summary);
    Ok(())
}

fn smoke_env_value_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes")
        })
        .unwrap_or(false)
}

fn plugin_dialog_smoke_guard_checked() -> bool {
    !desktop_smoke_enabled() || smoke_env_value_enabled("VITE_ATOOLS_DESKTOP_SMOKE")
}

fn build_plugin_panel_render_smoke_actions(db: &Database) -> Result<Vec<FeatureAction>, String> {
    let mut actions = Vec::new();
    if let Some(action) = preferred_plugin_panel_render_action(db, &["timestamp", "时间戳"]) {
        push_unique_plugin_panel_action(&mut actions, action);
    }

    if let Some(plan_path) = ztools_activation_plan_path_from_env() {
        for action in build_ztools_activation_plan_render_actions(db, plan_path.as_path())? {
            push_unique_plugin_panel_action(&mut actions, action);
        }
        if !actions.is_empty() {
            return Ok(actions);
        }
    }

    let features = db.all_features().map_err(|error| error.to_string())?;
    for entry in features {
        let action = match crate::commands::activate_feature_inner(db, &entry.code, None) {
            Ok(action) => action,
            Err(_) => continue,
        };
        let plugin_dir = Path::new(action.plugin_path.trim());
        if plugin_dir.is_dir() && plugin_panel_fs_load_spec_ok(&action, plugin_dir) {
            push_unique_plugin_panel_action(&mut actions, action);
            return Ok(actions);
        }
    }
    Ok(actions)
}

fn preferred_plugin_panel_render_action(
    db: &Database,
    feature_codes: &[&str],
) -> Option<FeatureAction> {
    for feature_code in feature_codes {
        let Ok(action) = crate::commands::activate_feature_inner(db, feature_code, None) else {
            continue;
        };
        if action.feature_code != *feature_code {
            continue;
        }
        let plugin_dir = Path::new(action.plugin_path.trim());
        if plugin_dir.is_dir() && plugin_panel_fs_load_spec_ok(&action, plugin_dir) {
            return Some(action);
        }
    }
    None
}

fn push_unique_plugin_panel_action(actions: &mut Vec<FeatureAction>, action: FeatureAction) {
    let duplicate = actions.iter().any(|existing| {
        existing.plugin_id == action.plugin_id && existing.feature_code == action.feature_code
    });
    if !duplicate {
        actions.push(action);
    }
}

fn build_ztools_activation_plan_render_actions(
    db: &Database,
    plan_path: &Path,
) -> Result<Vec<FeatureAction>, String> {
    let text = fs::read_to_string(plan_path)
        .map_err(|error| format!("failed to read activation plan: {error}"))?;
    let report: ZToolsActivationPlanReport = serde_json::from_str(&text)
        .map_err(|error| format!("failed to parse activation plan: {error}"))?;
    let mut actions = Vec::new();

    for plan in report.activation_plans {
        let expected_plugin_id = if plan.expected_install_id.trim().is_empty() {
            plan.install.expected_plugin_id.trim()
        } else {
            plan.expected_install_id.trim()
        };
        if !plan.render_smoke.safe {
            continue;
        }
        let feature_code = plan.activation.feature_code.trim();
        if expected_plugin_id.is_empty() || feature_code.is_empty() {
            continue;
        }
        if let Ok(existing) = db.get_feature(feature_code) {
            if existing.plugin_id != expected_plugin_id {
                continue;
            }
        }

        let install_root = PathBuf::from(plan.install.install_root.trim());
        let source_path = plan.source_path.trim().to_string();
        if source_path.is_empty() || install_root.as_os_str().is_empty() {
            continue;
        }
        if crate::ztools_import::import_ztools_plugins(db, &install_root, &[source_path], true)
            .is_err()
        {
            continue;
        }

        let activation_payload = serde_json::json!({
            "trigger_type": plan.activation.trigger_type,
            "query": plan.activation.query,
            "__atools_desktop_smoke_external_plan": true,
        });
        let Ok(action) =
            crate::commands::activate_feature_inner(db, feature_code, Some(activation_payload))
        else {
            continue;
        };
        let Ok(plugin) = db.get_plugin(expected_plugin_id) else {
            continue;
        };
        let plugin_dir = Path::new(&plugin.path);
        if action.plugin_id == expected_plugin_id
            && action.feature_code == feature_code
            && plugin_panel_fs_load_spec_ok(&action, plugin_dir)
        {
            actions.push(action);
        }
    }

    Ok(actions)
}

fn ztools_activation_plan_path_from_env() -> Option<PathBuf> {
    std::env::var(ZTOOLS_ACTIVATION_PLAN_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
            let repo_root = manifest_dir.parent().unwrap_or(manifest_dir);
            resolve_ztools_activation_plan_path(PathBuf::from(value), &cwd, repo_root)
        })
}

fn resolve_ztools_activation_plan_path(raw: PathBuf, cwd: &Path, repo_root: &Path) -> PathBuf {
    if raw.is_absolute() || raw.is_file() {
        return raw;
    }
    let cwd_path = cwd.join(&raw);
    if cwd_path.is_file() {
        return cwd_path;
    }
    let repo_path = repo_root.join(&raw);
    if repo_path.is_file() {
        return repo_path;
    }
    raw
}

fn plugin_panel_render_smoke_wait_attempts(plan_path: Option<&Path>) -> usize {
    if plan_path.is_some() {
        PLUGIN_PANEL_RENDER_SMOKE_EXTERNAL_PLAN_WAIT_ATTEMPTS
    } else {
        PLUGIN_PANEL_RENDER_SMOKE_STANDARD_WAIT_ATTEMPTS
    }
}

#[allow(clippy::too_many_arguments)] // Snapshot sections mirror independently collected smoke subsystems.
pub fn build_desktop_smoke_snapshot(
    db: &Database,
    main_window: bool,
    settings_window: bool,
    mcp_status: Option<McpServerStatus>,
    runtime_events_count: usize,
    permission_smoke: PermissionSmokeSummary,
    data_debug_smoke: DataDebugSmokeSummary,
    system_settings_smoke: SystemSettingsSmokeSummary,
    plugin_panel_render_smoke: PluginPanelRenderSmokeSummary,
    local_app_search: LocalAppSmokeSummary,
) -> Result<DesktopSmokeSnapshot, String> {
    let tools = db.list_agent_tools().map_err(|e| e.to_string())?;
    let plugins = db.list_plugins().map_err(|e| e.to_string())?;
    let plugin_runtime_smoke = build_plugin_runtime_smoke_summary(db);
    let ztools_external_activation_smoke = build_ztools_external_activation_smoke_summary(
        db,
        ztools_activation_plan_path_from_env().as_deref(),
    );
    let mut enabled_agent_tools = tools
        .iter()
        .filter(|tool| tool.enabled_by_default && tool.enabled)
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    enabled_agent_tools.sort();

    let mcp_ready = mcp_status.as_ref().is_some_and(|status| status.enabled);
    let local_app_ready = local_app_search.result_count > 0 && local_app_search.icon_count > 0;
    let status = if main_window
        && settings_window
        && mcp_ready
        && !enabled_agent_tools.is_empty()
        && local_app_ready
        && permission_smoke.ok()
        && data_debug_smoke.ok()
        && system_settings_smoke.ok()
        && plugin_runtime_smoke.ok()
        && plugin_panel_render_smoke.ok()
        && ztools_external_activation_smoke.ok()
    {
        "ok"
    } else {
        "degraded"
    };

    Ok(DesktopSmokeSnapshot {
        status: status.to_string(),
        main_window,
        settings_window,
        mcp_ready,
        mcp_bind: mcp_status.map(|status| status.bind),
        agent_tools_count: tools.len(),
        enabled_agent_tools,
        plugin_count: plugins.len(),
        audit_entries_count: db
            .list_audit_entries(1000)
            .map_err(|e| e.to_string())?
            .len(),
        permission_mode: db
            .get_setting("agent.permission_mode")
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "conservative".to_string()),
        runtime_events_count,
        permission_smoke,
        data_debug_smoke,
        system_settings_smoke,
        plugin_runtime_smoke,
        plugin_panel_render_smoke,
        ztools_external_activation_smoke,
        local_app_search,
        timestamp: atools_core::utils::now_iso(),
    })
}

#[derive(Debug, Deserialize)]
struct ZToolsActivationPlanReport {
    #[serde(default)]
    activation_plans: Vec<ZToolsActivationPlanItem>,
}

#[derive(Debug, Deserialize)]
struct ZToolsActivationPlanItem {
    #[serde(default)]
    source_path: String,
    #[serde(default)]
    expected_install_id: String,
    #[serde(default)]
    install: ZToolsActivationInstallPlan,
    #[serde(default)]
    activation: ZToolsActivationStepPlan,
    #[serde(default)]
    assertions: ZToolsActivationAssertionPlan,
    #[serde(default)]
    render_smoke: ZToolsActivationRenderSmokePlan,
    #[serde(default)]
    cleanup: ZToolsActivationCleanupPlan,
}

#[derive(Debug, Default, Deserialize)]
struct ZToolsActivationInstallPlan {
    #[serde(default)]
    install_root: String,
    #[serde(default)]
    expected_plugin_id: String,
}

#[derive(Debug, Default, Deserialize)]
struct ZToolsActivationStepPlan {
    #[serde(default)]
    feature_code: String,
    #[serde(default)]
    trigger_type: String,
    #[serde(default)]
    query: String,
}

#[derive(Debug, Default, Deserialize)]
struct ZToolsActivationAssertionPlan {
    #[serde(default)]
    main_exists: bool,
    #[serde(default)]
    preload_checked: bool,
}

#[derive(Debug, Deserialize)]
struct ZToolsActivationRenderSmokePlan {
    #[serde(default = "default_true")]
    safe: bool,
}

impl Default for ZToolsActivationRenderSmokePlan {
    fn default() -> Self {
        Self { safe: true }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
struct ZToolsActivationCleanupPlan {
    #[serde(default)]
    uninstall_plugin_id: String,
    #[serde(default)]
    remove_installed_files: bool,
}

fn plugin_panel_fs_load_spec_ok(action: &FeatureAction, plugin_dir: &Path) -> bool {
    let Ok(plugin_dir) = plugin_dir.canonicalize() else {
        return false;
    };
    let action_plugin_path = Path::new(action.plugin_path.trim());
    let Ok(action_plugin_path) = action_plugin_path.canonicalize() else {
        return false;
    };
    if action_plugin_path != plugin_dir {
        return false;
    }
    if action.payload.get("iframeSrc").is_some() || action.payload.get("srcdoc").is_some() {
        return false;
    }
    let main_url = action.main_url.trim();
    if main_url.is_empty() {
        return false;
    }
    let main_path = Path::new(main_url);
    if main_path.is_absolute() {
        return false;
    }
    if !plugin_panel_fs_file_inside(&plugin_dir, main_path) {
        return false;
    }
    action
        .preload_path
        .as_deref()
        .map(|path| {
            let path = Path::new(path.trim());
            !path.as_os_str().is_empty() && plugin_panel_fs_file_inside(&plugin_dir, path)
        })
        .unwrap_or(true)
}

fn plugin_panel_fs_file_inside(plugin_dir: &Path, path: &Path) -> bool {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        plugin_dir.join(path)
    };
    candidate
        .canonicalize()
        .map(|canonical| canonical.is_file() && canonical.starts_with(plugin_dir))
        .unwrap_or(false)
}

pub fn build_ztools_external_activation_smoke_summary(
    db: &Database,
    plan_path: Option<&Path>,
) -> ZToolsExternalActivationSmokeSummary {
    let Some(plan_path) = plan_path else {
        return ZToolsExternalActivationSmokeSummary::skipped();
    };
    let plan_path_text = plan_path.to_string_lossy().to_string();
    let text = match fs::read_to_string(plan_path) {
        Ok(text) => text,
        Err(error) => {
            return ZToolsExternalActivationSmokeSummary::failed(
                plan_path_text,
                format!("failed to read activation plan: {error}"),
            )
        }
    };
    let report: ZToolsActivationPlanReport = match serde_json::from_str(&text) {
        Ok(report) => report,
        Err(error) => {
            return ZToolsExternalActivationSmokeSummary::failed(
                plan_path_text,
                format!("failed to parse activation plan: {error}"),
            )
        }
    };
    if report.activation_plans.is_empty() {
        return ZToolsExternalActivationSmokeSummary::failed(
            plan_path_text,
            "activation plan has no samples",
        );
    }

    let mut summary = ZToolsExternalActivationSmokeSummary {
        plan_path: plan_path_text,
        planned_samples: report.activation_plans.len(),
        imported_samples: 0,
        activated_samples: 0,
        ui_actions_checked: 0,
        plugin_panel_fs_load_checked: 0,
        assertions_checked: 0,
        cleanup_verified: 0,
        skipped_samples: 0,
        sample_plugin_ids: Vec::new(),
        error: None,
    };
    let mut errors = Vec::new();

    for plan in report.activation_plans {
        let expected_plugin_id = if plan.expected_install_id.trim().is_empty() {
            plan.install.expected_plugin_id.trim()
        } else {
            plan.expected_install_id.trim()
        };
        if expected_plugin_id.is_empty() {
            errors.push("plan sample missing expected plugin id".to_string());
            continue;
        }
        let feature_code = plan.activation.feature_code.trim();
        if feature_code.is_empty() {
            errors.push(format!("{expected_plugin_id}: missing feature code"));
            continue;
        }
        if let Ok(existing) = db.get_feature(feature_code) {
            if existing.plugin_id != expected_plugin_id {
                summary.skipped_samples += 1;
                continue;
            }
        }

        let install_root = PathBuf::from(plan.install.install_root.trim());
        let source_path = plan.source_path.trim().to_string();
        if source_path.is_empty() || install_root.as_os_str().is_empty() {
            errors.push(format!(
                "{expected_plugin_id}: missing source path or install root"
            ));
            continue;
        }

        match crate::ztools_import::import_ztools_plugins(
            db,
            &install_root,
            std::slice::from_ref(&source_path),
            true,
        ) {
            Ok(report) => {
                if !report.imported.iter().any(|id| id == expected_plugin_id) {
                    errors.push(format!(
                        "{expected_plugin_id}: import did not report expected plugin id"
                    ));
                    continue;
                }
                summary.imported_samples += 1;
                summary
                    .sample_plugin_ids
                    .push(expected_plugin_id.to_string());
            }
            Err(error) => {
                errors.push(format!("{expected_plugin_id}: import failed: {error}"));
                continue;
            }
        }

        let activation_payload = serde_json::json!({
            "trigger_type": plan.activation.trigger_type,
            "query": plan.activation.query,
        });
        let action =
            crate::commands::activate_feature_inner(db, feature_code, Some(activation_payload));
        if action
            .as_ref()
            .map(|action| {
                action.plugin_id == expected_plugin_id && action.feature_code == feature_code
            })
            .unwrap_or(false)
        {
            summary.activated_samples += 1;
        } else {
            errors.push(format!(
                "{expected_plugin_id}: feature {feature_code} did not activate"
            ));
        }

        match (db.get_plugin(expected_plugin_id), action) {
            (Ok(plugin), Ok(action)) => {
                let plugin_dir = Path::new(&plugin.path);
                let main_ok = !plan.assertions.main_exists
                    || plugin
                        .manifest
                        .main
                        .as_ref()
                        .is_some_and(|main| plugin_dir.join(main).is_file());
                let preload_ok = !plan.assertions.preload_checked
                    || plugin
                        .manifest
                        .preload
                        .as_ref()
                        .map(|preload| plugin_dir.join(preload).is_file())
                        .unwrap_or(true);
                let action_plugin_path_ok =
                    action.plugin_path == plugin.path && Path::new(&action.plugin_path).is_dir();
                let action_main_ok = !action.main_url.trim().is_empty()
                    && plugin_dir.join(&action.main_url).is_file();
                let action_preload_ok = action
                    .preload_path
                    .as_ref()
                    .map(|path| Path::new(path).is_file())
                    .unwrap_or(true);
                let action_height_ok =
                    (1..=SMOKE_MAX_PLUGIN_WINDOW_HEIGHT).contains(&action.expand_height);
                if action_plugin_path_ok && action_main_ok && action_preload_ok && action_height_ok
                {
                    summary.ui_actions_checked += 1;
                } else {
                    errors.push(format!(
                        "{expected_plugin_id}: FeatureAction UI payload failed"
                    ));
                }
                if plugin_panel_fs_load_spec_ok(&action, plugin_dir) {
                    summary.plugin_panel_fs_load_checked += 1;
                } else {
                    errors.push(format!(
                        "{expected_plugin_id}: PluginPanel FS load spec failed"
                    ));
                }
                if plugin_dir.is_dir() && main_ok && preload_ok {
                    summary.assertions_checked += 1;
                } else {
                    errors.push(format!(
                        "{expected_plugin_id}: path/main/preload assertion failed"
                    ));
                }
            }
            (Err(error), _) => {
                errors.push(format!(
                    "{expected_plugin_id}: imported plugin lookup failed: {error}"
                ));
            }
            (_, Err(error)) => {
                errors.push(format!(
                    "{expected_plugin_id}: activate_feature failed: {error}"
                ));
            }
        }

        let cleanup_plugin_id = if plan.cleanup.uninstall_plugin_id.trim().is_empty() {
            expected_plugin_id
        } else {
            plan.cleanup.uninstall_plugin_id.trim()
        };
        if let Err(error) = db.delete_plugin(cleanup_plugin_id) {
            errors.push(format!(
                "{cleanup_plugin_id}: cleanup delete plugin failed: {error}"
            ));
        }
        let install_dir = install_root.join(expected_plugin_id);
        if plan.cleanup.remove_installed_files && install_dir.exists() {
            if let Err(error) = fs::remove_dir_all(&install_dir) {
                errors.push(format!(
                    "{expected_plugin_id}: cleanup remove installed files failed: {error}"
                ));
            }
        }
        if db.get_plugin(cleanup_plugin_id).is_err() && !install_dir.exists() {
            summary.cleanup_verified += 1;
        } else {
            errors.push(format!("{cleanup_plugin_id}: cleanup verification failed"));
        }
    }

    if !errors.is_empty() {
        summary.error = Some(errors.join("; "));
    }
    summary
}

pub fn build_plugin_runtime_smoke_summary(db: &Database) -> PluginRuntimeSmokeSummary {
    let mut features = match db.all_features() {
        Ok(features) => features,
        Err(error) => return PluginRuntimeSmokeSummary::skipped(error.to_string()),
    };
    if features.is_empty() {
        return PluginRuntimeSmokeSummary::skipped("no indexed plugin features");
    }
    features.sort_by(|left, right| {
        runtime_smoke_feature_rank(left)
            .cmp(&runtime_smoke_feature_rank(right))
            .then_with(|| left.code.cmp(&right.code))
    });

    let calculator_search_enter_checked = plugin_search_enter_checked(
        db,
        &features,
        "calculator",
        &["calc", "计算器"],
        &["calculator", "计算器"],
    ) || plugin_search_enter_checked(
        db,
        &features,
        "计算",
        &["calc", "计算器"],
        &["calculator", "计算器"],
    );
    let timestamp_search_enter_checked = plugin_search_enter_checked(
        db,
        &features,
        "时间戳",
        &["timestamp", "时间戳"],
        &["timestamp", "时间戳"],
    );

    let mut errors = Vec::new();
    let mut fallback_summary = None;
    for entry in features {
        let activated = match db.get_feature(&entry.code) {
            Ok(activated) => activated,
            Err(error) => {
                errors.push(format!("feature {}: {error}", entry.code));
                continue;
            }
        };
        let plugin = match db.get_plugin(&activated.plugin_id) {
            Ok(plugin) => plugin,
            Err(error) => {
                errors.push(format!("plugin {}: {error}", activated.plugin_id));
                continue;
            }
        };

        let main_url = plugin.manifest.main.clone().unwrap_or_default();
        if main_url.trim().is_empty() {
            errors.push(format!("plugin {}: missing main entry", plugin.id));
            continue;
        }

        let plugin_dir = Path::new(&plugin.path);
        let plugin_path_exists = plugin_dir.is_dir();
        let main_exists = plugin_dir.join(&main_url).is_file();
        let preload_checked = plugin
            .manifest
            .preload
            .as_ref()
            .map(|preload| plugin_dir.join(preload).is_file())
            .unwrap_or(true);
        let expand_height =
            smoke_plugin_window_height(plugin.manifest.plugin_setting.as_ref().map(|s| s.height));
        let expand_height_valid = (1..=SMOKE_MAX_PLUGIN_WINDOW_HEIGHT).contains(&expand_height);
        let mut summary_errors = Vec::new();
        if !plugin_path_exists {
            summary_errors.push(format!("plugin path missing: {}", plugin.path));
        }
        if !main_exists {
            summary_errors.push(format!("main entry missing: {}", main_url));
        }
        if !preload_checked {
            if let Some(preload) = &plugin.manifest.preload {
                summary_errors.push(format!("preload missing: {preload}"));
            }
        }
        if !expand_height_valid {
            summary_errors.push(format!("invalid expand height: {expand_height}"));
        }
        let data_bridge = run_plugin_data_bridge_smoke(db, &plugin.id);
        if let Some(error) = &data_bridge.error {
            summary_errors.push(format!("data bridge: {error}"));
        }
        let native_bridge = run_plugin_native_bridge_smoke();
        if let Some(error) = &native_bridge.error {
            summary_errors.push(format!("native bridge: {error}"));
        }
        if !calculator_search_enter_checked {
            summary_errors.push("calculator search did not activate calculator/calc".to_string());
        }
        if !timestamp_search_enter_checked {
            summary_errors
                .push("timestamp search did not activate timestamp/timestamp".to_string());
        }

        let summary = PluginRuntimeSmokeSummary {
            feature_activated: activated.plugin_id == plugin.id && activated.code == entry.code,
            sample_plugin_id: plugin.id,
            sample_plugin_name: plugin.name,
            sample_feature_code: activated.code,
            main_url,
            main_exists,
            plugin_path_exists,
            expand_height_valid,
            preload_checked,
            data_bridge_checked: data_bridge.data_bridge_checked,
            data_roundtrip_checked: data_bridge.data_roundtrip_checked,
            bulk_docs_checked: data_bridge.bulk_docs_checked,
            attachment_checked: data_bridge.attachment_checked,
            data_cleanup_checked: data_bridge.data_cleanup_checked,
            native_bridge_checked: native_bridge.native_bridge_checked,
            dialog_guard_checked: native_bridge.dialog_guard_checked,
            system_path_checked: native_bridge.system_path_checked,
            shell_target_checked: native_bridge.shell_target_checked,
            context_bridge_checked: native_bridge.context_bridge_checked,
            browser_context_checked: native_bridge.browser_context_checked,
            finder_context_checked: native_bridge.finder_context_checked,
            shell_show_item_error_checked: native_bridge.shell_show_item_error_checked,
            copied_files_read_checked: native_bridge.copied_files_read_checked,
            screen_capture_guard_checked: native_bridge.screen_capture_guard_checked,
            native_error_checked: native_bridge.native_error_checked,
            copy_file_error_checked: native_bridge.copy_file_error_checked,
            copy_image_error_checked: native_bridge.copy_image_error_checked,
            calculator_search_enter_checked,
            timestamp_search_enter_checked,
            error: (!summary_errors.is_empty()).then(|| summary_errors.join("; ")),
        };
        if summary.ok() {
            return summary;
        }
        if let Some(error) = &summary.error {
            errors.push(format!("plugin {}: {error}", summary.sample_plugin_id));
        }
        if fallback_summary.is_none() {
            fallback_summary = Some(summary);
        }
    }

    if let Some(summary) = fallback_summary {
        return summary;
    }

    let error = if errors.is_empty() {
        "no plugin with a main entry".to_string()
    } else {
        errors.join("; ")
    };
    PluginRuntimeSmokeSummary::skipped(error)
}

fn runtime_smoke_feature_rank(feature: &atools_core::FeatureEntry) -> u8 {
    if feature.code == "timestamp" || feature.code == "时间戳" {
        0
    } else {
        1
    }
}

fn plugin_search_enter_checked(
    db: &Database,
    features: &[atools_core::FeatureEntry],
    query: &str,
    expected_feature_codes: &[&str],
    expected_plugin_names: &[&str],
) -> bool {
    for result in atools_core::matcher::search_all(features, query)
        .into_iter()
        .filter(|result| expected_feature_codes.contains(&result.feature_code.as_str()))
    {
        let Ok(action) = crate::commands::activate_feature_inner(
            db,
            &result.feature_code,
            Some(json!({
                "trigger_type": "search",
                "query": query,
            })),
        ) else {
            continue;
        };
        let plugin_name_matches = expected_plugin_names.is_empty()
            || expected_plugin_names
                .iter()
                .any(|name| action.plugin_name == *name);
        if !expected_feature_codes.contains(&action.feature_code.as_str())
            || !plugin_name_matches
            || action.main_url.trim().is_empty()
        {
            continue;
        }
        if Path::new(&action.plugin_path)
            .join(action.main_url.trim())
            .is_file()
        {
            return true;
        }
    }
    false
}

fn smoke_plugin_window_height(manifest_height: Option<u32>) -> u32 {
    manifest_height
        .unwrap_or(SMOKE_MAX_PLUGIN_WINDOW_HEIGHT)
        .min(SMOKE_MAX_PLUGIN_WINDOW_HEIGHT)
}

fn run_plugin_data_bridge_smoke(db: &Database, plugin_id: &str) -> PluginDataBridgeSmoke {
    let marker = atools_core::utils::generate_rev();
    let prefix = format!("__atools_desktop_smoke_{marker}");
    let doc_id = format!("{prefix}:doc");
    let bulk_a_id = format!("{prefix}:bulk-a");
    let bulk_b_id = format!("{prefix}:bulk-b");
    let attachment_name = "payload.bin";
    let attachment_payload = format!("plugin-data-smoke:{marker}").into_bytes();
    let mut errors = Vec::new();

    let data_bridge_checked = db.plugin_data_all(plugin_id).is_ok();
    if !data_bridge_checked {
        errors.push("plugin_data_all failed".to_string());
    }

    let doc = Document {
        id: doc_id.clone(),
        rev: None,
        data: json!({
            "kind": "desktop-smoke",
            "marker": marker,
        }),
    };
    let data_roundtrip_checked = db
        .plugin_data_put(plugin_id, &doc)
        .and_then(|_| db.plugin_data_get(plugin_id, &doc_id))
        .map(|stored| {
            stored.is_some_and(|stored| {
                stored.rev.is_some() && stored.data.get("marker") == Some(&json!(marker))
            })
        })
        .unwrap_or_else(|error| {
            errors.push(format!("data roundtrip failed: {error}"));
            false
        });

    let bulk_docs = vec![
        Document {
            id: bulk_a_id.clone(),
            rev: None,
            data: json!({ "kind": "desktop-smoke-bulk", "index": 1 }),
        },
        Document {
            id: bulk_b_id.clone(),
            rev: None,
            data: json!({ "kind": "desktop-smoke-bulk", "index": 2 }),
        },
    ];
    let bulk_docs_checked = db
        .plugin_data_bulk(plugin_id, &bulk_docs)
        .and_then(|_| {
            Ok(db.plugin_data_get(plugin_id, &bulk_a_id)?.is_some()
                && db.plugin_data_get(plugin_id, &bulk_b_id)?.is_some())
        })
        .unwrap_or_else(|error| {
            errors.push(format!("bulkDocs failed: {error}"));
            false
        });

    let attachment_checked = db
        .put_attachment(
            plugin_id,
            &doc_id,
            attachment_name,
            &attachment_payload,
            "application/octet-stream",
        )
        .and_then(|_| db.get_attachment(plugin_id, &doc_id, attachment_name))
        .map(|stored| {
            stored.is_some_and(|(data, content_type)| {
                data == attachment_payload && content_type == "application/octet-stream"
            })
        })
        .unwrap_or_else(|error| {
            errors.push(format!("attachment failed: {error}"));
            false
        });

    let mut cleanup_ok = true;
    if let Err(error) = db.delete_attachment(plugin_id, &doc_id, attachment_name) {
        cleanup_ok = false;
        errors.push(format!("attachment cleanup failed: {error}"));
    }
    for id in [&doc_id, &bulk_a_id, &bulk_b_id] {
        if let Err(error) = db.plugin_data_remove(plugin_id, id) {
            cleanup_ok = false;
            errors.push(format!("document cleanup failed for {id}: {error}"));
        }
    }
    let cleanup_verified = db
        .get_attachment(plugin_id, &doc_id, attachment_name)
        .and_then(|attachment| {
            Ok(attachment.is_none()
                && db.plugin_data_get(plugin_id, &doc_id)?.is_none()
                && db.plugin_data_get(plugin_id, &bulk_a_id)?.is_none()
                && db.plugin_data_get(plugin_id, &bulk_b_id)?.is_none())
        })
        .unwrap_or_else(|error| {
            errors.push(format!("cleanup verification failed: {error}"));
            false
        });
    let data_cleanup_checked = cleanup_ok && cleanup_verified;
    if !data_cleanup_checked {
        errors.push("temporary plugin data cleanup did not verify clean".to_string());
    }

    PluginDataBridgeSmoke {
        data_bridge_checked,
        data_roundtrip_checked,
        bulk_docs_checked,
        attachment_checked,
        data_cleanup_checked,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

fn run_plugin_native_bridge_smoke() -> PluginNativeBridgeSmoke {
    let mut errors = Vec::new();
    let dialog_guard_checked = plugin_dialog_smoke_guard_checked();
    if !dialog_guard_checked {
        errors.push(
            "dialog bridge smoke guard env was not propagated to the plugin host".to_string(),
        );
    }

    let temp_path = crate::commands::system_get_path("temp".to_string());
    let unknown_path = crate::commands::system_get_path("__atools_unknown__".to_string());
    let system_path_checked =
        !temp_path.is_empty() && Path::new(&temp_path).is_dir() && unknown_path.is_empty();
    if !system_path_checked {
        errors.push(
            "system_get_path did not return a usable temp path or unknown fallback".to_string(),
        );
    }

    let shell_target_checked = matches!(
        crate::commands::shell_open_target("  https://example.com  "),
        crate::commands::ShellOpenTarget::Url("https://example.com")
    ) && matches!(
        crate::commands::shell_open_target("  /tmp/atools-native-bridge-smoke  "),
        crate::commands::ShellOpenTarget::Path("/tmp/atools-native-bridge-smoke")
    ) && matches!(
        crate::commands::shell_open_target("mailto:hello@example.com"),
        crate::commands::ShellOpenTarget::Url("mailto:hello@example.com")
    );
    if !shell_target_checked {
        errors.push("shell_open target classification changed".to_string());
    }

    let browser_context_checked = native_context_result_checked(
        crate::commands::read_current_browser_url(),
        "readCurrentBrowserUrl",
    );
    if !browser_context_checked {
        errors.push("readCurrentBrowserUrl returned an ambiguous context result".to_string());
    }
    let finder_context_checked = native_context_result_checked(
        crate::commands::read_current_folder_path(),
        "readCurrentFolderPath",
    );
    if !finder_context_checked {
        errors.push("readCurrentFolderPath returned an ambiguous context result".to_string());
    }
    let context_bridge_checked = browser_context_checked && finder_context_checked;

    let missing_file_path = std::env::temp_dir()
        .join(format!(
            "atools-native-bridge-missing-{}",
            atools_core::utils::generate_rev()
        ))
        .to_string_lossy()
        .to_string();
    let copy_file_error_checked = native_missing_path_error(
        crate::commands::copy_file(missing_file_path.clone()),
        "copyFile",
    );
    if !copy_file_error_checked {
        errors.push("copyFile missing-path call did not return an explicit error".to_string());
    }
    let copy_image_error_checked = native_missing_path_error(
        crate::commands::copy_image(missing_file_path.clone()),
        "copyImage",
    );
    if !copy_image_error_checked {
        errors.push("copyImage missing-path call did not return an explicit error".to_string());
    }
    let shell_show_item_error_checked = native_missing_path_error(
        crate::commands::shell_show_item_in_folder(missing_file_path),
        "shellShowItemInFolder",
    );
    if !shell_show_item_error_checked {
        errors.push(
            "shellShowItemInFolder missing-path call did not return an explicit error".to_string(),
        );
    }
    let copied_files_read_checked =
        copied_files_result_checked(crate::commands::get_copyed_files());
    if !copied_files_read_checked {
        errors.push("getCopyedFiles returned an ambiguous clipboard file list result".to_string());
    }
    let screen_capture_guard_checked = if desktop_smoke_enabled() {
        screen_capture_result_checked(crate::commands::screen_capture())
    } else {
        screen_capture_result_checked(Err(crate::commands::screen_capture_smoke_guard_error()))
    };
    if !screen_capture_guard_checked {
        errors.push(
            "screenCapture did not return an explicit no-side-effect smoke result".to_string(),
        );
    }
    let native_error_checked =
        copy_file_error_checked && copy_image_error_checked && shell_show_item_error_checked;

    PluginNativeBridgeSmoke {
        native_bridge_checked: system_path_checked
            && dialog_guard_checked
            && shell_target_checked
            && context_bridge_checked
            && copied_files_read_checked
            && screen_capture_guard_checked
            && native_error_checked,
        system_path_checked,
        dialog_guard_checked,
        shell_target_checked,
        context_bridge_checked,
        browser_context_checked,
        finder_context_checked,
        shell_show_item_error_checked,
        copied_files_read_checked,
        screen_capture_guard_checked,
        native_error_checked,
        copy_file_error_checked,
        copy_image_error_checked,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

fn screen_capture_result_checked(result: Result<String, String>) -> bool {
    match result {
        Ok(path) => !path.trim().is_empty(),
        Err(error) => {
            let normalized = error.to_ascii_lowercase();
            normalized.contains("screencapture")
                || normalized.contains("screen capture")
                || normalized.contains("desktop smoke")
                || normalized.contains("unsupported")
                || normalized.contains("permission")
        }
    }
}

fn copied_files_result_checked(result: Result<Vec<String>, String>) -> bool {
    match result {
        Ok(paths) => paths.iter().all(|path| !path.trim().is_empty()),
        Err(error) => {
            let normalized = error.to_ascii_lowercase();
            normalized.contains("getcopyedfiles") || normalized.contains("unsupported")
        }
    }
}

fn native_context_result_checked(result: Result<Option<String>, String>, method: &str) -> bool {
    match result {
        Ok(Some(value)) => !value.trim().is_empty(),
        Ok(None) => true,
        Err(error) => {
            let normalized = error.to_ascii_lowercase();
            normalized.contains(&method.to_ascii_lowercase())
                || normalized.contains("osascript failed")
                || normalized.contains("unsupported")
        }
    }
}

fn native_missing_path_error(result: Result<(), String>, method: &str) -> bool {
    match result {
        Ok(()) => false,
        Err(error) => {
            let normalized = error.to_ascii_lowercase();
            normalized.contains(&method.to_ascii_lowercase())
                && (normalized.contains("does not exist") || normalized.contains("unsupported"))
        }
    }
}

pub async fn run_permission_smoke(app: &tauri::AppHandle, db: &Database) -> PermissionSmokeSummary {
    let client_id = format!(
        "atools-desktop-smoke-{}",
        atools_core::utils::generate_rev()
    );
    let previous_mode = match db.get_setting("agent.permission_mode") {
        Ok(value) => value,
        Err(error) => return PermissionSmokeSummary::skipped(error.to_string()),
    };
    let previous_scope_policy = match db.get_setting("agent.scope_policy") {
        Ok(value) => value,
        Err(error) => return PermissionSmokeSummary::skipped(error.to_string()),
    };
    let restore_setting =
        |db: &Database, key: &str, previous: &Option<String>| -> Result<(), String> {
            match previous {
                Some(value) => db
                    .set_setting(key, value)
                    .map_err(|error| error.to_string()),
                None => db
                    .delete_setting(key)
                    .map(|_| ())
                    .map_err(|error| error.to_string()),
            }
        };

    if let Err(error) = db.set_setting("agent.permission_mode", "conservative") {
        return PermissionSmokeSummary::skipped(error.to_string());
    }
    let _ = db.revoke_agent_tool(&client_id, PERMISSION_SMOKE_TOOL);

    let result = crate::agent_tools::call_tool_with_audit(
        app,
        db,
        &client_id,
        PERMISSION_SMOKE_TOOL,
        json!({
            "query": "atools-smoke-never-run",
            "roots": [],
            "limit": 1,
            "dry_run": true
        }),
        false,
    )
    .await;

    let state = app.state::<crate::state::AppState>();
    let pending_id = result
        .structured_content
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let permission_required = result.is_error
        && result
            .structured_content
            .get("permission_required")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
    let pending_request_created = pending_id
        .as_ref()
        .is_some_and(|id| state.pending_agent_requests.lock().contains_key(id));
    let pending_request_dismissed = pending_id
        .as_ref()
        .is_some_and(|id| state.pending_agent_requests.lock().remove(id).is_some());
    let audit_denied_recorded = db
        .list_audit_entries(1000)
        .map(|entries| {
            entries.iter().any(|entry| {
                entry.client_id == client_id
                    && entry.tool_name == PERMISSION_SMOKE_TOOL
                    && matches!(entry.status, AuditStatus::Denied)
            })
        })
        .unwrap_or(false);
    let mut errors = Vec::new();
    if let Err(error) = db.set_setting("agent.permission_mode", "developer") {
        errors.push(format!("developer mode setup failed: {error}"));
    }
    if let Err(error) = db.set_setting("agent.scope_policy", r#"{"shell":"deny"}"#) {
        errors.push(format!("scope policy setup failed: {error}"));
    }
    let scope_decision =
        crate::agent_tools::permission_decision_for_tool(db, &client_id, "open_or_reveal_path");
    let scope_result = if errors.is_empty() {
        Some(
            crate::agent_tools::call_tool_with_audit(
                app,
                db,
                &client_id,
                "open_or_reveal_path",
                json!({
                    "path": "/tmp/atools-scope-deny-smoke-never-open",
                    "reveal": true
                }),
                true,
            )
            .await,
        )
    } else {
        None
    };
    let scope_deny_overrides_developer = matches!(scope_decision, Ok(PermissionDecision::Deny))
        && scope_result.as_ref().is_some_and(|result| {
            result.is_error
                && result
                    .structured_content
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    == Some("Permission denied")
        });
    let scope_deny_audit_recorded = db
        .list_audit_entries(1000)
        .map(|entries| {
            entries.iter().any(|entry| {
                entry.client_id == client_id
                    && entry.tool_name == "open_or_reveal_path"
                    && matches!(entry.status, AuditStatus::Denied)
                    && entry.error.as_deref() == Some("Permission denied")
            })
        })
        .unwrap_or(false);
    let toggle_smoke = run_agent_tool_toggle_smoke(db);
    if let Some(error) = &toggle_smoke.error {
        errors.push(error.clone());
    }
    let cleanup_deleted_audits = db
        .delete_audit_entries_for_client(&client_id)
        .unwrap_or_default();
    if let Err(error) = restore_setting(db, "agent.permission_mode", &previous_mode) {
        errors.push(format!("permission mode restore failed: {error}"));
    }
    if let Err(error) = restore_setting(db, "agent.scope_policy", &previous_scope_policy) {
        errors.push(format!("scope policy restore failed: {error}"));
    }

    PermissionSmokeSummary {
        client_id,
        tool_name: PERMISSION_SMOKE_TOOL.to_string(),
        permission_required,
        pending_request_created,
        audit_denied_recorded,
        pending_request_dismissed,
        scope_deny_overrides_developer,
        scope_deny_audit_recorded,
        tool_toggle_persisted: toggle_smoke.persisted,
        tool_toggle_restored: toggle_smoke.restored,
        cleanup_deleted_audits,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

#[derive(Debug, Clone)]
struct AgentToolToggleSmoke {
    persisted: bool,
    restored: bool,
    error: Option<String>,
}

fn run_agent_tool_toggle_smoke(db: &Database) -> AgentToolToggleSmoke {
    const TOOL_NAME: &str = "search_clipboard";
    let previous = match db.get_agent_tool(TOOL_NAME) {
        Ok(Some(tool)) => tool.enabled,
        Ok(None) => {
            return AgentToolToggleSmoke {
                persisted: false,
                restored: false,
                error: Some(format!("agent tool {TOOL_NAME} is missing")),
            };
        }
        Err(error) => {
            return AgentToolToggleSmoke {
                persisted: false,
                restored: false,
                error: Some(format!("read agent tool toggle failed: {error}")),
            };
        }
    };
    let toggled = !previous;
    let mut errors = Vec::new();

    if let Err(error) = db.set_agent_tool_enabled(TOOL_NAME, toggled) {
        errors.push(format!("toggle agent tool failed: {error}"));
    }
    let persisted = db
        .get_agent_tool(TOOL_NAME)
        .map(|tool| tool.is_some_and(|tool| tool.enabled == toggled))
        .unwrap_or_else(|error| {
            errors.push(format!("read toggled agent tool failed: {error}"));
            false
        });

    if let Err(error) = db.set_agent_tool_enabled(TOOL_NAME, previous) {
        errors.push(format!("restore agent tool failed: {error}"));
    }
    let restored = db
        .get_agent_tool(TOOL_NAME)
        .map(|tool| tool.is_some_and(|tool| tool.enabled == previous))
        .unwrap_or_else(|error| {
            errors.push(format!("read restored agent tool failed: {error}"));
            false
        });

    AgentToolToggleSmoke {
        persisted,
        restored,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

pub fn run_data_debug_smoke(app: &tauri::AppHandle, db: &Database) -> DataDebugSmokeSummary {
    let state = app.state::<crate::state::AppState>();
    let mcp_status = state.mcp_status.lock().clone();
    let active_plugin = state.active_plugin.lock().clone();
    let runtime_events = state.runtime_events.lock().clone();

    let diagnostics = match crate::commands::runtime_diagnostics_snapshot(
        &state.config,
        db,
        mcp_status.clone(),
        active_plugin,
        &runtime_events,
    ) {
        Ok(value) => value,
        Err(error) => return DataDebugSmokeSummary::skipped(error),
    };

    let runtime_diagnostics_ready = diagnostics.runtime == "Tauri WebView"
        && !diagnostics.base_dir.is_empty()
        && !diagnostics.db_path.is_empty()
        && !diagnostics.plugins_dir.is_empty()
        && diagnostics.agent_tool_count >= 7;
    let clipboard_export_json_valid = db
        .export_clipboard_history_json(20)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|value| {
            value
                .get("entries")
                .is_some_and(serde_json::Value::is_array)
        });
    let audit_export_jsonl_valid = db
        .export_audit_entries_jsonl(20)
        .map(|text| {
            text.lines()
                .filter(|line| !line.trim().is_empty())
                .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok())
        })
        .unwrap_or(false);
    let audit_filtered_export = run_audit_filtered_export_smoke(db);
    let crash_log_readable = crate::crash::list_crash_logs(&state.config, 20).is_ok();
    let mcp_status_consistent = match mcp_status.as_ref() {
        Some(status) => {
            diagnostics.mcp_enabled && diagnostics.mcp_bind.as_deref() == Some(&status.bind)
        }
        None => !diagnostics.mcp_enabled && diagnostics.mcp_bind.is_none(),
    };
    let mcp_protocol_smoke = run_mcp_protocol_smoke(mcp_status.as_ref());

    DataDebugSmokeSummary {
        runtime_diagnostics_ready,
        clipboard_export_json_valid,
        audit_export_jsonl_valid,
        audit_filtered_export_checked: audit_filtered_export.filtered_export_checked,
        audit_filtered_export_count_checked: audit_filtered_export.filtered_export_count_checked,
        crash_log_readable,
        mcp_status_consistent,
        mcp_ping_ok: mcp_protocol_smoke.ping_ok,
        mcp_initialized_notification_ok: mcp_protocol_smoke.initialized_notification_ok,
        mcp_discovery_lists_ok: mcp_protocol_smoke.discovery_lists_ok,
        mcp_resources_ok: mcp_protocol_smoke.resources_ok,
        mcp_prompts_ok: mcp_protocol_smoke.prompts_ok,
        mcp_batch_ok: mcp_protocol_smoke.batch_ok,
        mcp_notification_ok: mcp_protocol_smoke.notification_ok,
        error: audit_filtered_export.error.or(mcp_protocol_smoke.error),
    }
}

#[derive(Debug, Clone)]
struct AuditFilteredExportSmoke {
    filtered_export_checked: bool,
    filtered_export_count_checked: bool,
    error: Option<String>,
}

fn run_audit_filtered_export_smoke(db: &Database) -> AuditFilteredExportSmoke {
    let marker = atools_core::utils::generate_rev();
    let client_id = format!("atools-data-debug-smoke-{marker}");
    let matching_tool = "search_clipboard";
    let other_tool = "find_local_files";
    let query_text = format!("filtered-export-{marker}");
    let mut errors = Vec::new();

    let matching = AuditLogEntry::new(
        &client_id,
        matching_tool,
        json!({ "query": query_text, "scope": "matching" }),
        AuditStatus::Allowed,
    )
    .with_output(json!({ "items": [{ "text": "filtered export match" }] }))
    .with_duration_ms(7);
    let other = AuditLogEntry::new(
        &client_id,
        other_tool,
        json!({ "query": format!("{query_text}-other"), "scope": "other" }),
        AuditStatus::Denied,
    )
    .with_error("Permission confirmation required")
    .with_duration_ms(3);

    if let Err(error) = db.insert_audit_entry(&matching) {
        errors.push(format!("insert matching audit failed: {error}"));
    }
    if let Err(error) = db.insert_audit_entry(&other) {
        errors.push(format!("insert other audit failed: {error}"));
    }

    let mut filtered_export_checked = false;
    let mut filtered_export_count_checked = false;
    if errors.is_empty() {
        match db.export_audit_entries_jsonl_filtered(&AuditLogQuery {
            limit: 20,
            offset: 0,
            query: Some(query_text.clone()),
            status: Some("success".to_string()),
            tool_name: Some(matching_tool.to_string()),
            client_id: Some(client_id.clone()),
        }) {
            Ok(jsonl) => {
                let rows = jsonl
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .map(serde_json::from_str::<serde_json::Value>)
                    .collect::<Result<Vec<_>, _>>();
                match rows {
                    Ok(rows) => {
                        filtered_export_count_checked = rows.len() == 1;
                        filtered_export_checked = rows.first().is_some_and(|row| {
                            row.get("client_id") == Some(&json!(client_id))
                                && row.get("tool_name") == Some(&json!(matching_tool))
                                && row.get("input").and_then(|input| input.get("query"))
                                    == Some(&json!(query_text))
                        });
                        if !filtered_export_count_checked {
                            errors.push(format!("filtered export returned {} rows", rows.len()));
                        }
                        if !filtered_export_checked {
                            errors.push(
                                "filtered export did not return the matching audit row".to_string(),
                            );
                        }
                    }
                    Err(error) => {
                        errors.push(format!("filtered export JSONL parse failed: {error}"))
                    }
                }
            }
            Err(error) => errors.push(format!("filtered export failed: {error}")),
        }
    }

    if let Err(error) = db.delete_audit_entries_for_client(&client_id) {
        errors.push(format!("filtered export cleanup failed: {error}"));
    }

    AuditFilteredExportSmoke {
        filtered_export_checked,
        filtered_export_count_checked,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

#[derive(Debug, Clone)]
struct McpProtocolSmokeSummary {
    ping_ok: bool,
    initialized_notification_ok: bool,
    discovery_lists_ok: bool,
    resources_ok: bool,
    prompts_ok: bool,
    batch_ok: bool,
    notification_ok: bool,
    error: Option<String>,
}

fn run_mcp_protocol_smoke(status: Option<&McpServerStatus>) -> McpProtocolSmokeSummary {
    let Some(status) = status else {
        return McpProtocolSmokeSummary {
            ping_ok: false,
            initialized_notification_ok: false,
            discovery_lists_ok: false,
            resources_ok: false,
            prompts_ok: false,
            batch_ok: false,
            notification_ok: false,
            error: Some("mcp server is not ready".to_string()),
        };
    };

    let ping_result = send_mcp_http_request(
        &status.bind,
        &status.token,
        json!({
            "jsonrpc": "2.0",
            "id": 7001,
            "method": "ping"
        }),
    )
    .and_then(|response| {
        let payload = serde_json::from_str::<serde_json::Value>(&response.body)
            .map_err(|error| error.to_string())?;
        let ok = response.status == 200
            && payload.get("id") == Some(&json!(7001))
            && payload
                .get("result")
                .is_some_and(|result| result == &json!({}));
        ok.then_some(())
            .ok_or_else(|| format!("unexpected MCP ping response: {}", response.status))
    });

    let initialized_result = send_mcp_http_request(
        &status.bind,
        &status.token,
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
    )
    .and_then(|response| {
        let ok = response.status == 204 && response.body.trim().is_empty();
        ok.then_some(()).ok_or_else(|| {
            format!(
                "unexpected MCP initialized notification response: {}",
                response.status
            )
        })
    });

    let discovery_results = [("resources/templates/list", 7003, "resourceTemplates")]
        .into_iter()
        .map(|(method, id, result_key)| {
            send_mcp_empty_list_request(&status.bind, &status.token, method, id, result_key)
        })
        .collect::<Vec<_>>();
    let discovery_lists_ok = discovery_results.iter().all(Result::is_ok);

    let resources_result = send_mcp_agent_tools_resource_request(&status.bind, &status.token);
    let prompts_result = send_mcp_prompt_catalog_request(&status.bind, &status.token);

    let batch_result = send_mcp_http_request(
        &status.bind,
        &status.token,
        json!([
            {
                "jsonrpc": "2.0",
                "id": 7005,
                "method": "ping"
            },
            {
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            },
            {
                "jsonrpc": "2.0",
                "id": 7006,
                "method": "prompts/list"
            }
        ]),
    )
    .and_then(|response| {
        let payload = serde_json::from_str::<serde_json::Value>(&response.body)
            .map_err(|error| error.to_string())?;
        let responses = payload
            .as_array()
            .ok_or_else(|| format!("unexpected MCP batch response body: {}", response.body))?;
        let ok = response.status == 200
            && responses.len() == 2
            && responses[0].get("id") == Some(&json!(7005))
            && responses[0].get("result") == Some(&json!({}))
            && responses[1].get("id") == Some(&json!(7006))
            && responses[1]
                .get("result")
                .and_then(|result| result.get("prompts"))
                .is_some_and(serde_json::Value::is_array);
        ok.then_some(())
            .ok_or_else(|| format!("unexpected MCP batch response: {}", response.status))
    });

    let notification_result = send_mcp_http_request(
        &status.bind,
        &status.token,
        json!({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "find_local_files",
                "arguments": {
                    "root": "/tmp",
                    "query": "atools-desktop-smoke-idless-notification",
                    "limit": 1
                }
            }
        }),
    )
    .and_then(|response| {
        let ok = response.status == 204 && response.body.trim().is_empty();
        ok.then_some(()).ok_or_else(|| {
            format!(
                "unexpected MCP id-less tools/call notification response: {} {}",
                response.status, response.body
            )
        })
    });

    let mut errors = Vec::new();
    if let Err(error) = &ping_result {
        errors.push(error.clone());
    }
    if let Err(error) = &initialized_result {
        errors.push(error.clone());
    }
    for result in &discovery_results {
        if let Err(error) = result {
            errors.push(error.clone());
        }
    }
    if let Err(error) = &resources_result {
        errors.push(error.clone());
    }
    if let Err(error) = &prompts_result {
        errors.push(error.clone());
    }
    if let Err(error) = &batch_result {
        errors.push(error.clone());
    }
    if let Err(error) = &notification_result {
        errors.push(error.clone());
    }

    McpProtocolSmokeSummary {
        ping_ok: ping_result.is_ok(),
        initialized_notification_ok: initialized_result.is_ok(),
        discovery_lists_ok,
        resources_ok: resources_result.is_ok(),
        prompts_ok: prompts_result.is_ok(),
        batch_ok: batch_result.is_ok(),
        notification_ok: notification_result.is_ok(),
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

fn send_mcp_agent_tools_resource_request(bind: &str, token: &str) -> Result<(), String> {
    let list_response = send_mcp_http_request(
        bind,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": 7002,
            "method": "resources/list"
        }),
    )?;
    let list_payload = serde_json::from_str::<serde_json::Value>(&list_response.body)
        .map_err(|error| error.to_string())?;
    let resource_list_ok = list_response.status == 200
        && list_payload.get("id") == Some(&json!(7002))
        && list_payload
            .get("result")
            .and_then(|result| result.get("resources"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|resources| {
                let has_agent_tools = resources.iter().any(|resource| {
                    resource.get("uri") == Some(&json!("atools://agent/tools"))
                        && resource.get("name") == Some(&json!("agent_tools"))
                        && resource.get("mimeType") == Some(&json!("application/json"))
                });
                let has_capabilities = resources.iter().any(|resource| {
                    resource.get("uri") == Some(&json!("atools://capabilities"))
                        && resource.get("name") == Some(&json!("capabilities"))
                        && resource.get("mimeType") == Some(&json!("application/json"))
                });
                has_agent_tools && has_capabilities
            });
    if !resource_list_ok {
        return Err(format!(
            "unexpected MCP resources/list response: {} {}",
            list_response.status, list_response.body
        ));
    }

    let read_response = send_mcp_http_request(
        bind,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": 7008,
            "method": "resources/read",
            "params": {
                "uri": "atools://agent/tools"
            }
        }),
    )?;
    let read_payload = serde_json::from_str::<serde_json::Value>(&read_response.body)
        .map_err(|error| error.to_string())?;
    let resource_text = read_payload
        .pointer("/result/contents/0/text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let resource_read_ok = read_response.status == 200
        && read_payload.get("id") == Some(&json!(7008))
        && read_payload.pointer("/result/contents/0/uri") == Some(&json!("atools://agent/tools"))
        && read_payload.pointer("/result/contents/0/mimeType") == Some(&json!("application/json"))
        && resource_text.contains("find_local_files")
        && resource_text.contains("search_clipboard")
        && resource_text.contains("inputSchema");
    if !resource_read_ok {
        return Err(format!(
            "unexpected MCP resources/read response: {} {}",
            read_response.status, read_response.body
        ));
    }

    let capability_response = send_mcp_http_request(
        bind,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": 7009,
            "method": "resources/read",
            "params": {
                "uri": "atools://capabilities"
            }
        }),
    )?;
    let capability_payload = serde_json::from_str::<serde_json::Value>(&capability_response.body)
        .map_err(|error| error.to_string())?;
    let capability_text = capability_payload
        .pointer("/result/contents/0/text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let capability_read_ok = capability_response.status == 200
        && capability_payload.get("id") == Some(&json!(7009))
        && capability_payload.pointer("/result/contents/0/uri")
            == Some(&json!("atools://capabilities"))
        && capability_payload.pointer("/result/contents/0/mimeType")
            == Some(&json!("application/json"))
        && capability_text.contains("atools_capabilities")
        && capability_text.contains("find_local_files")
        && capability_text.contains("permissionScopes")
        && capability_text.contains("agentInvocable");
    capability_read_ok.then_some(()).ok_or_else(|| {
        format!(
            "unexpected MCP capabilities resource response: {} {}",
            capability_response.status, capability_response.body
        )
    })
}

fn send_mcp_prompt_catalog_request(bind: &str, token: &str) -> Result<(), String> {
    let list_response = send_mcp_http_request(
        bind,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": 7004,
            "method": "prompts/list"
        }),
    )?;
    let list_payload = serde_json::from_str::<serde_json::Value>(&list_response.body)
        .map_err(|error| error.to_string())?;
    let prompt_list_ok = list_response.status == 200
        && list_payload.get("id") == Some(&json!(7004))
        && list_payload
            .get("result")
            .and_then(|result| result.get("prompts"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|prompts| {
                prompts.iter().any(|prompt| {
                    prompt.get("name") == Some(&json!("atools_agent_tool_guide"))
                        && prompt.get("description")
                            == Some(&json!("Guide for choosing ATools local Agent tools"))
                        && prompt
                            .get("arguments")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(|arguments| {
                                arguments.iter().any(|argument| {
                                    argument.get("name") == Some(&json!("task"))
                                        && argument.get("required") == Some(&json!(false))
                                })
                            })
                })
            });
    if !prompt_list_ok {
        return Err(format!(
            "unexpected MCP prompts/list response: {} {}",
            list_response.status, list_response.body
        ));
    }

    let get_response = send_mcp_http_request(
        bind,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": 7007,
            "method": "prompts/get",
            "params": {
                "name": "atools_agent_tool_guide",
                "arguments": {
                    "task": "desktop smoke prompt"
                }
            }
        }),
    )?;
    let get_payload = serde_json::from_str::<serde_json::Value>(&get_response.body)
        .map_err(|error| error.to_string())?;
    let prompt_text = get_payload
        .pointer("/result/messages/0/content/text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let prompt_get_ok = get_response.status == 200
        && get_payload.get("id") == Some(&json!(7007))
        && get_payload.pointer("/result/description")
            == Some(&json!("Guide for choosing ATools local Agent tools"))
        && get_payload.pointer("/result/messages/0/role") == Some(&json!("user"))
        && get_payload.pointer("/result/messages/0/content/type") == Some(&json!("text"))
        && prompt_text.contains("find_local_files")
        && prompt_text.contains("desktop smoke prompt");
    prompt_get_ok.then_some(()).ok_or_else(|| {
        format!(
            "unexpected MCP prompts/get response: {} {}",
            get_response.status, get_response.body
        )
    })
}

fn send_mcp_empty_list_request(
    bind: &str,
    token: &str,
    method: &str,
    id: i64,
    result_key: &str,
) -> Result<(), String> {
    send_mcp_http_request(
        bind,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method
        }),
    )
    .and_then(|response| {
        let payload = serde_json::from_str::<serde_json::Value>(&response.body)
            .map_err(|error| error.to_string())?;
        let ok = response.status == 200
            && payload.get("id") == Some(&json!(id))
            && payload
                .get("result")
                .and_then(|result| result.get(result_key))
                .is_some_and(|items| items == &json!([]))
            && payload
                .get("result")
                .is_some_and(|result| result.get("nextCursor").is_none());
        ok.then_some(()).ok_or_else(|| {
            format!(
                "unexpected MCP {method} response: {} {}",
                response.status, response.body
            )
        })
    })
}

#[derive(Debug, Clone)]
struct McpHttpSmokeResponse {
    status: u16,
    body: String,
}

fn send_mcp_http_request(
    bind: &str,
    token: &str,
    payload: serde_json::Value,
) -> Result<McpHttpSmokeResponse, String> {
    let body = payload.to_string();
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: {bind}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut stream = TcpStream::connect(bind).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;

    let raw = read_mcp_http_response(&mut stream)?;
    let (headers, body) = raw
        .split_once("\r\n\r\n")
        .ok_or_else(|| "invalid MCP HTTP response".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "missing MCP HTTP status".to_string())?;

    Ok(McpHttpSmokeResponse {
        status,
        body: body.to_string(),
    })
}

fn read_mcp_http_response(reader: &mut impl Read) -> Result<String, String> {
    read_mcp_http_response_with_would_block_retries(reader, 80)
}

fn read_mcp_http_response_with_would_block_retries(
    reader: &mut impl Read,
    max_would_block_retries: usize,
) -> Result<String, String> {
    let mut raw = Vec::new();
    let mut chunk = [0_u8; 4096];
    let mut would_block_retries = 0_usize;

    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(bytes_read) => {
                would_block_retries = 0;
                raw.extend_from_slice(&chunk[..bytes_read]);
                if mcp_http_response_complete(&raw)? {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if mcp_http_response_complete(&raw).unwrap_or(false) {
                    break;
                }
                if would_block_retries < max_would_block_retries {
                    would_block_retries += 1;
                    std::thread::sleep(Duration::from_millis(25));
                    continue;
                }
                return Err(error.to_string());
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    String::from_utf8(raw).map_err(|error| error.to_string())
}

fn mcp_http_response_complete(raw: &[u8]) -> Result<bool, String> {
    let text = std::str::from_utf8(raw).map_err(|error| error.to_string())?;
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return Ok(false);
    };
    let content_length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    });

    Ok(content_length.is_some_and(|content_length| body.len() >= content_length))
}

pub fn run_system_settings_smoke(
    app: &tauri::AppHandle,
    db: &Database,
) -> SystemSettingsSmokeSummary {
    let settings_before = match db.get_setting("settings-general") {
        Ok(value) => value,
        Err(error) => return SystemSettingsSmokeSummary::skipped(error.to_string()),
    };
    let shortcut =
        smoke_normalize_shortcut(&smoke_hotkey_from_settings(settings_before.as_deref()));
    let alternate_shortcut = smoke_alternate_shortcut(&shortcut);
    let tray_visible = smoke_tray_visible_from_settings(settings_before.as_deref());
    let mut errors = Vec::new();

    let mut hotkey_reregistered = match crate::hotkey::update_hotkey(app, &shortcut) {
        Ok(()) => true,
        Err(error) => {
            errors.push(format!("hotkey: {error}"));
            false
        }
    };
    let mut hotkey_old_unregistered = false;
    let mut hotkey_probe_attempted = false;
    let mut hotkey_probe_success = false;
    if hotkey_reregistered {
        if alternate_shortcut != shortcut {
            hotkey_probe_attempted = true;
            match crate::hotkey::update_hotkey_from(app, &shortcut, &alternate_shortcut) {
                Ok(()) => {
                    hotkey_probe_success = true;
                    if crate::hotkey::is_shortcut_registered(app, &alternate_shortcut) {
                        hotkey_old_unregistered =
                            !crate::hotkey::is_shortcut_registered(app, &shortcut);
                    } else {
                        errors.push("hotkey-probe: alternate shortcut not registered".to_string());
                    }
                }
                Err(error) => {
                    errors.push(format!("hotkey-probe: {error}"));
                }
            }
        } else {
            errors.push("hotkey-probe: no alternate shortcut available".to_string());
        }
        let active_shortcut =
            smoke_hotkey_restore_previous(hotkey_probe_success, &shortcut, &alternate_shortcut);
        if let Err(error) = crate::hotkey::update_hotkey_from(app, active_shortcut, &shortcut) {
            errors.push(format!("hotkey-restore: {error}"));
            hotkey_reregistered = false;
        } else {
            let initial_registered = crate::hotkey::is_shortcut_registered(app, &shortcut);
            let alternate_registered = alternate_shortcut != shortcut
                && crate::hotkey::is_shortcut_registered(app, &alternate_shortcut);
            if let Some(error) =
                smoke_hotkey_restore_error(initial_registered, alternate_registered)
            {
                errors.push(error.to_string());
                hotkey_reregistered = false;
            }
        }
    }
    let tray_visibility_applied =
        match crate::commands::set_tray_icon_visible(app.clone(), tray_visible) {
            Ok(()) => true,
            Err(error) => {
                errors.push(format!("tray: {error}"));
                false
            }
        };
    let tray_visibility_toggled = if tray_visibility_applied {
        smoke_toggle_tray_visibility_smoke(app, tray_visible)
    } else {
        false
    };
    let executable_path = match std::env::current_exe() {
        Ok(path) => Some(path.to_string_lossy().to_string()),
        Err(error) => {
            errors.push(format!("launch-agent: {error}"));
            None
        }
    };
    let launch_agent_plist_valid = executable_path.as_deref().is_some_and(|executable| {
        let plist = crate::commands::launch_agent_plist(executable);
        plist.contains("<string>com.atools.desktop</string>")
            && plist.contains("<key>RunAtLoad</key>")
            && plist.contains(&smoke_xml_escape(executable))
    });
    if !launch_agent_plist_valid {
        errors.push("launch-agent: generated plist is invalid".to_string());
    }
    let (launch_agent_write_checked, launch_agent_cleanup_checked) =
        match executable_path.as_deref() {
            Some(executable) => match run_launch_agent_file_smoke(executable) {
                Ok(result) => result,
                Err(error) => {
                    errors.push(format!("launch-agent-file: {error}"));
                    (false, false)
                }
            },
            None => (false, false),
        };
    if hotkey_reregistered && alternate_shortcut != shortcut && !hotkey_probe_attempted {
        errors.push("hotkey-probe: no alternate shortcut attempt was made".to_string());
    }
    if hotkey_reregistered && alternate_shortcut != shortcut {
        if !hotkey_probe_success {
            errors.push("hotkey-probe: failed to register alternate shortcut".to_string());
        } else if !hotkey_old_unregistered {
            errors.push("hotkey: old shortcut still registered after probing".to_string());
        }
    }
    if !launch_agent_write_checked {
        errors.push("launch-agent-file: temp plist write check failed".to_string());
    }
    if !launch_agent_cleanup_checked {
        errors.push("launch-agent-file: temp plist cleanup check failed".to_string());
    }
    if !tray_visibility_toggled {
        errors.push("tray: visibility toggle smoke check failed".to_string());
    }
    let main_window_centered = match app.get_webview_window("main") {
        Some(window) => is_main_window_centered(&window).unwrap_or(false),
        None => {
            errors.push("main-window: missing main window".to_string());
            false
        }
    };
    if !main_window_centered {
        errors.push("main-window: center check failed".to_string());
    }
    let floating_ball_window = match crate::commands::set_floating_ball_visible(app.clone(), true) {
        Ok(()) => {
            let created = app
                .get_webview_window(crate::window::FLOATING_BALL_LABEL)
                .is_some();
            if let Err(error) = crate::commands::set_floating_ball_visible(app.clone(), false) {
                errors.push(format!("floating-ball-hide: {error}"));
            }
            created
        }
        Err(error) => {
            errors.push(format!("floating-ball: {error}"));
            false
        }
    };
    if !floating_ball_window {
        errors.push("floating-ball: window was not created".to_string());
    }
    let super_panel_window = match crate::commands::set_super_panel_visible(app.clone(), true) {
        Ok(()) => {
            let created = app
                .get_webview_window(crate::window::SUPER_PANEL_LABEL)
                .is_some();
            if let Err(error) = crate::commands::set_super_panel_visible(app.clone(), false) {
                errors.push(format!("super-panel-hide: {error}"));
            }
            created
        }
        Err(error) => {
            errors.push(format!("super-panel: {error}"));
            false
        }
    };
    if !super_panel_window {
        errors.push("super-panel: window was not created".to_string());
    }

    let settings_after = match db.get_setting("settings-general") {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("settings: {error}"));
            None
        }
    };
    let settings_preserved = settings_before == settings_after;
    if !settings_preserved {
        errors.push("settings: settings-general changed during smoke".to_string());
    }

    SystemSettingsSmokeSummary {
        main_window_centered,
        hotkey_old_unregistered,
        hotkey_reregistered,
        tray_visibility_applied,
        tray_visibility_toggled,
        launch_agent_plist_valid,
        launch_agent_write_checked,
        launch_agent_cleanup_checked,
        floating_ball_window,
        super_panel_window,
        settings_preserved,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

fn run_launch_agent_file_smoke(executable: &str) -> Result<(bool, bool), String> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let smoke_dir = std::env::temp_dir().join(format!(
        "atools-launch-agent-smoke-{}-{}",
        std::process::id(),
        unique
    ));
    let smoke_path = smoke_dir.join("com.atools.desktop.plist");
    fs::create_dir(&smoke_dir).map_err(|error| error.to_string())?;
    fs::write(&smoke_path, crate::commands::launch_agent_plist(executable))
        .map_err(|error| error.to_string())?;
    let written = fs::read_to_string(&smoke_path).map_err(|error| error.to_string())?;
    let write_checked = smoke_path.is_file()
        && written.contains("<string>com.atools.desktop</string>")
        && written.contains("<key>RunAtLoad</key>")
        && written.contains(&smoke_xml_escape(executable));
    fs::remove_file(&smoke_path).map_err(|error| error.to_string())?;
    let cleanup_checked = !smoke_path.exists();
    let _ = fs::remove_dir_all(&smoke_dir);
    Ok((write_checked, cleanup_checked))
}

fn smoke_hotkey_from_settings(settings_json: Option<&str>) -> String {
    settings_json
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|json| {
            json.get("hotkey")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "Option+Z".to_string()
            } else {
                "Alt+Z".to_string()
            }
        })
}

fn smoke_hotkey_restore_previous<'a>(
    probe_success: bool,
    initial: &'a str,
    alternate: &'a str,
) -> &'a str {
    if probe_success {
        alternate
    } else {
        initial
    }
}

fn smoke_hotkey_restore_error(
    initial_registered: bool,
    alternate_registered: bool,
) -> Option<&'static str> {
    if !initial_registered {
        Some("hotkey: initial shortcut not restored")
    } else if alternate_registered {
        Some("hotkey: alternate shortcut still registered after restore")
    } else {
        None
    }
}

fn smoke_tray_visible_from_settings(settings_json: Option<&str>) -> bool {
    settings_json
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|json| {
            json.get("showTrayIcon")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

fn smoke_xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn smoke_normalize_shortcut(value: &str) -> String {
    let normalized = value
        .trim()
        .replace("Option+", "Alt+")
        .replace("option+", "Alt+")
        .replace("Command+", "Cmd+")
        .replace("command+", "Cmd+")
        .trim()
        .to_string();
    if normalized.is_empty() {
        "Alt+Z".to_string()
    } else {
        normalized
    }
}

fn smoke_alternate_shortcut(shortcut: &str) -> String {
    let normalized = smoke_normalize_shortcut(shortcut);
    if normalized.is_empty() {
        return if cfg!(target_os = "macos") {
            "Cmd+X".to_string()
        } else {
            "Alt+X".to_string()
        };
    }

    let mut segments = normalized.split('+').collect::<Vec<_>>();
    if segments.is_empty() {
        return if cfg!(target_os = "macos") {
            "Cmd+X".to_string()
        } else {
            "Alt+X".to_string()
        };
    }

    let key = segments.pop().unwrap_or_default().trim();
    let modifiers = segments.join("+");
    let alternate_key = if key.eq_ignore_ascii_case("Z") {
        "X"
    } else {
        "Z"
    };
    if modifiers.is_empty() {
        if cfg!(target_os = "macos") {
            format!("Cmd+{}", alternate_key)
        } else {
            format!("Alt+{}", alternate_key)
        }
    } else {
        format!("{}+{}", modifiers, alternate_key)
    }
}

fn smoke_toggle_tray_visibility_smoke(app: &tauri::AppHandle, tray_visible: bool) -> bool {
    let opposite = !tray_visible;
    if crate::commands::set_tray_icon_visible(app.clone(), opposite).is_err() {
        return false;
    }
    if crate::commands::set_tray_icon_visible(app.clone(), tray_visible).is_err() {
        return false;
    }
    true
}

fn is_main_window_centered(window: &tauri::WebviewWindow) -> Result<bool, String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Main window monitor unavailable".to_string())?;
    let monitor_size = monitor.size();
    let monitor_position = monitor.position();
    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    let window_position = window.outer_position().map_err(|error| error.to_string())?;

    let expected_x =
        monitor_position.x + ((monitor_size.width as i32 - window_size.width as i32) / 2);
    let expected_y =
        monitor_position.y + ((monitor_size.height as i32 - window_size.height as i32) / 2);

    let tolerance = 64;
    let dx = (window_position.x - expected_x).abs();
    let dy = (window_position.y - expected_y).abs();
    Ok(dx <= tolerance && dy <= tolerance)
}

pub fn build_local_app_smoke_summary(
    query: impl Into<String>,
    results: &[SearchResult],
) -> LocalAppSmokeSummary {
    let sample = results.first();
    LocalAppSmokeSummary {
        query: query.into(),
        result_count: results.len(),
        icon_count: results
            .iter()
            .filter(|result| result.icon.is_some())
            .count(),
        sample_label: sample.map(|result| result.label.clone()),
        sample_has_icon: sample.is_some_and(|result| result.icon.is_some()),
    }
}

pub fn desktop_smoke_output_line(snapshot: &DesktopSmokeSnapshot) -> Result<String, String> {
    Ok(format!(
        "{}{}",
        SMOKE_PREFIX,
        serde_json::to_string(snapshot).map_err(|e| e.to_string())?
    ))
}

pub fn spawn_desktop_smoke_reporter(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<crate::state::AppState>();
        for _ in 0..40 {
            if state.mcp_status.lock().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let permission_smoke = run_permission_smoke(&app, &state.db).await;
        let data_debug_smoke = run_data_debug_smoke(&app, &state.db);
        let system_settings_smoke = run_system_settings_smoke(&app, &state.db);
        let plugin_panel_wait_attempts = plugin_panel_render_smoke_wait_attempts(
            ztools_activation_plan_path_from_env().as_deref(),
        );
        for _ in 0..plugin_panel_wait_attempts {
            if state
                .plugin_panel_render_smoke
                .lock()
                .as_ref()
                .is_some_and(PluginPanelRenderSmokeSummary::complete)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(PLUGIN_PANEL_RENDER_SMOKE_POLL_MS)).await;
        }
        let plugin_panel_render_smoke = state
            .plugin_panel_render_smoke
            .lock()
            .clone()
            .map(PluginPanelRenderSmokeSummary::finalized)
            .unwrap_or_else(|| {
                PluginPanelRenderSmokeSummary::skipped("PluginPanel render smoke did not report")
            });

        let snapshot = build_desktop_smoke_snapshot(
            &state.db,
            app.get_webview_window("main").is_some(),
            app.get_webview_window("settings").is_some(),
            state.mcp_status.lock().clone(),
            state.runtime_events.lock().len(),
            permission_smoke,
            data_debug_smoke,
            system_settings_smoke,
            plugin_panel_render_smoke,
            build_local_app_smoke_summary(
                LOCAL_APP_SMOKE_QUERY,
                &crate::commands::search_local_apps_for_smoke(LOCAL_APP_SMOKE_QUERY, 10),
            ),
        );

        let exit_code = match snapshot.and_then(|snapshot| {
            let exit_code = if snapshot.status == "ok" { 0 } else { 2 };
            desktop_smoke_output_line(&snapshot).map(|line| (line, exit_code))
        }) {
            Ok((line, exit_code)) => {
                println!("{}", line);
                let _ = std::io::Write::flush(&mut std::io::stdout());
                exit_code
            }
            Err(error) => {
                eprintln!(
                    "{}{}",
                    SMOKE_PREFIX,
                    serde_json::json!({
                        "status": "error",
                        "error": error,
                        "timestamp": atools_core::utils::now_iso(),
                    })
                );
                3
            }
        };

        std::process::exit(exit_code);
    });
}

#[cfg(test)]
mod tests {
    use atools_core::agent::{AuditLogEntry, AuditStatus};
    use atools_core::db::Database;
    use atools_core::models::{Cmd, Feature, Plugin, PluginManifest, PluginSetting};
    use serde_json::json;
    use std::collections::HashMap;
    use std::io::{self, Read};
    use std::path::PathBuf;

    use crate::agent_tools;
    use crate::mcp_server::McpServerStatus;

    use super::{
        build_desktop_smoke_snapshot, build_plugin_runtime_smoke_summary,
        desktop_smoke_output_line, plugin_panel_render_smoke_wait_attempts,
        smoke_hotkey_restore_error, smoke_hotkey_restore_previous, DataDebugSmokeSummary,
        LocalAppSmokeSummary, PermissionSmokeSummary, PluginPanelRenderSmokeReport,
        PluginPanelRenderSmokeSummary, SystemSettingsSmokeSummary, LOCAL_APP_SMOKE_QUERY,
    };

    fn valid_browser_window_probe_report() -> PluginPanelRenderSmokeReport {
        PluginPanelRenderSmokeReport {
            plugin_id: "timestamp".to_string(),
            feature_code: "timestamp".to_string(),
            main_url: "index.html".to_string(),
            plugin_path: std::env::temp_dir().to_string_lossy().to_string(),
            fs_load: true,
            iframe_srcdoc_loaded: true,
            iframe_src_empty: true,
            load_error: None,
            iframe_srcdoc_bytes: 128,
            expected_samples: 1,
            sample_index: 0,
            external_plan_sample: false,
            bridge_probe_reported: true,
            bridge_probe_passed: true,
            bridge_probe_checks: 5,
            bridge_probe_passed_checks: 5,
            bridge_probe_failed_ids: Vec::new(),
            native_method_probe_reported: true,
            native_method_probe_passed: true,
            native_method_probe_checks: 4,
            native_method_probe_passed_checks: 4,
            native_method_probe_failed_ids: Vec::new(),
            browser_window_probe_expected: true,
            browser_window_probe_reported: true,
            browser_window_probe_passed: true,
            browser_window_probe_checks: 9,
            browser_window_probe_passed_checks: 9,
            browser_window_probe_failed_ids: Vec::new(),
            browser_window_created: true,
            browser_window_child_origin_opaque: true,
            browser_window_self_tauri_unavailable: true,
            browser_window_parent_tauri_unavailable: true,
            browser_window_parent_document_blocked: true,
            browser_window_send_to_parent_checked: true,
            browser_window_execute_javascript_checked: true,
            browser_window_ipc_roundtrip_checked: true,
            browser_window_cleanup_checked: true,
            subinput_visible: true,
            subinput_placeholder: "输入时间戳 (秒/毫秒) 或日期时间".to_string(),
        }
    }

    #[test]
    fn hotkey_smoke_restore_uses_the_actual_active_shortcut() {
        assert_eq!(
            smoke_hotkey_restore_previous(true, "Alt+Z", "Alt+X"),
            "Alt+X"
        );
        assert_eq!(
            smoke_hotkey_restore_previous(false, "Alt+Z", "Alt+X"),
            "Alt+Z"
        );
    }

    #[test]
    fn hotkey_smoke_restore_requires_original_only_to_be_registered() {
        assert_eq!(smoke_hotkey_restore_error(true, false), None);
        assert_eq!(
            smoke_hotkey_restore_error(false, false),
            Some("hotkey: initial shortcut not restored")
        );
        assert_eq!(
            smoke_hotkey_restore_error(true, true),
            Some("hotkey: alternate shortcut still registered after restore")
        );
    }

    #[test]
    fn desktop_smoke_local_app_query_exercises_bundle_identifier_alias() {
        assert_eq!(LOCAL_APP_SMOKE_QUERY, "com apple terminal");
    }

    #[test]
    fn desktop_smoke_waits_longer_for_external_plan_render_queue() {
        assert_eq!(plugin_panel_render_smoke_wait_attempts(None), 300);
        assert!(
            plugin_panel_render_smoke_wait_attempts(Some(
                PathBuf::from("output/ztools-plugin-activation-plan.json").as_path()
            )) >= 1200
        );
    }

    #[test]
    fn desktop_smoke_snapshot_reports_core_runtime_state() {
        let db = Database::in_memory().expect("in-memory db");
        agent_tools::sync_builtin_tools(&db).expect("sync tools");
        db.set_setting("agent.permission_mode", "developer")
            .expect("permission setting");
        db.insert_audit_entry(
            &AuditLogEntry::new(
                "codex",
                "open_or_reveal_path",
                json!({ "path": "/tmp/a.txt" }),
                AuditStatus::Allowed,
            )
            .with_output(json!({ "ok": true }))
            .with_duration_ms(9),
        )
        .expect("audit");
        let _calculator_dir = install_test_plugin_with_cmds(
            &db,
            "plugin_calculator_hash",
            "calculator",
            "calc",
            400,
            true,
            &["calculator", "计算", "计算器", "calc"],
        );
        let _timestamp_dir = install_test_plugin_with_cmds(
            &db,
            "plugin_timestamp_hash",
            "timestamp",
            "timestamp",
            500,
            true,
            &["时间戳", "timestamp", "ts"],
        );

        let snapshot = build_desktop_smoke_snapshot(
            &db,
            true,
            true,
            Some(McpServerStatus {
                enabled: true,
                bind: "127.0.0.1:17321".to_string(),
                token: "token".to_string(),
            }),
            2,
            PermissionSmokeSummary {
                client_id: "atools-desktop-smoke-test".to_string(),
                tool_name: "find_local_files".to_string(),
                permission_required: true,
                pending_request_created: true,
                audit_denied_recorded: true,
                pending_request_dismissed: true,
                scope_deny_overrides_developer: true,
                scope_deny_audit_recorded: true,
                tool_toggle_persisted: true,
                tool_toggle_restored: true,
                cleanup_deleted_audits: 2,
                error: None,
            },
            DataDebugSmokeSummary {
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
                error: None,
            },
            SystemSettingsSmokeSummary {
                main_window_centered: true,
                hotkey_reregistered: true,
                hotkey_old_unregistered: true,
                tray_visibility_applied: true,
                tray_visibility_toggled: true,
                launch_agent_plist_valid: true,
                launch_agent_write_checked: true,
                launch_agent_cleanup_checked: true,
                floating_ball_window: true,
                super_panel_window: true,
                settings_preserved: true,
                error: None,
            },
            PluginPanelRenderSmokeSummary {
                reported: true,
                sample_plugin_id: "timestamp".to_string(),
                sample_feature_code: "timestamp".to_string(),
                main_url: "index.html".to_string(),
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
                sample_plugin_ids: vec!["timestamp".to_string()],
                bridge_probe_expected_samples: 1,
                bridge_probe_reported_samples: 1,
                bridge_probe_passed_samples: 1,
                bridge_probe_checks: 5,
                bridge_probe_passed_checks: 5,
                bridge_probe_failed_ids: Vec::new(),
                native_method_probe_expected_samples: 1,
                native_method_probe_reported_samples: 1,
                native_method_probe_passed_samples: 1,
                native_method_probe_checks: 4,
                native_method_probe_passed_checks: 4,
                native_method_probe_failed_ids: Vec::new(),
                browser_window_probe_expected_samples: 1,
                browser_window_probe_reported_samples: 1,
                browser_window_probe_passed_samples: 1,
                browser_window_probe_checks: 9,
                browser_window_probe_passed_checks: 9,
                browser_window_probe_failed_ids: Vec::new(),
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
                error: None,
            },
            LocalAppSmokeSummary {
                query: "terminal".to_string(),
                result_count: 2,
                icon_count: 1,
                sample_label: Some("打开 Terminal".to_string()),
                sample_has_icon: true,
            },
        )
        .expect("snapshot");

        assert_eq!(snapshot.status, "ok");
        assert!(snapshot.main_window);
        assert!(snapshot.settings_window);
        assert!(snapshot.mcp_ready);
        assert_eq!(snapshot.mcp_bind.as_deref(), Some("127.0.0.1:17321"));
        assert_eq!(snapshot.permission_mode, "developer");
        assert_eq!(snapshot.audit_entries_count, 1);
        assert_eq!(snapshot.runtime_events_count, 2);
        assert!(snapshot.permission_smoke.permission_required);
        assert!(snapshot.permission_smoke.pending_request_created);
        assert!(snapshot.permission_smoke.audit_denied_recorded);
        assert!(snapshot.permission_smoke.pending_request_dismissed);
        assert!(snapshot.permission_smoke.scope_deny_overrides_developer);
        assert!(snapshot.permission_smoke.scope_deny_audit_recorded);
        assert!(snapshot.permission_smoke.tool_toggle_persisted);
        assert!(snapshot.permission_smoke.tool_toggle_restored);
        assert_eq!(snapshot.permission_smoke.cleanup_deleted_audits, 2);
        assert!(snapshot.data_debug_smoke.runtime_diagnostics_ready);
        assert!(snapshot.data_debug_smoke.clipboard_export_json_valid);
        assert!(snapshot.data_debug_smoke.audit_export_jsonl_valid);
        assert!(snapshot.data_debug_smoke.crash_log_readable);
        assert!(snapshot.data_debug_smoke.mcp_status_consistent);
        assert!(snapshot.data_debug_smoke.mcp_ping_ok);
        assert!(snapshot.data_debug_smoke.mcp_initialized_notification_ok);
        assert!(snapshot.data_debug_smoke.mcp_discovery_lists_ok);
        assert!(snapshot.data_debug_smoke.mcp_resources_ok);
        assert!(snapshot.data_debug_smoke.mcp_prompts_ok);
        assert!(snapshot.data_debug_smoke.mcp_batch_ok);
        assert!(snapshot.data_debug_smoke.mcp_notification_ok);
        assert!(snapshot.system_settings_smoke.main_window_centered);
        assert!(snapshot.system_settings_smoke.hotkey_old_unregistered);
        assert!(snapshot.system_settings_smoke.hotkey_reregistered);
        assert!(snapshot.system_settings_smoke.tray_visibility_applied);
        assert!(snapshot.system_settings_smoke.tray_visibility_toggled);
        assert!(snapshot.system_settings_smoke.launch_agent_plist_valid);
        assert!(snapshot.system_settings_smoke.launch_agent_write_checked);
        assert!(snapshot.system_settings_smoke.launch_agent_cleanup_checked);
        assert!(snapshot.system_settings_smoke.floating_ball_window);
        assert!(snapshot.system_settings_smoke.super_panel_window);
        assert!(snapshot.system_settings_smoke.settings_preserved);
        assert!(snapshot.plugin_runtime_smoke.feature_activated);
        assert_eq!(
            snapshot.plugin_runtime_smoke.sample_plugin_id,
            "plugin_timestamp_hash"
        );
        assert_eq!(
            snapshot.plugin_runtime_smoke.sample_plugin_name,
            "timestamp"
        );
        assert_eq!(
            snapshot.plugin_runtime_smoke.sample_feature_code,
            "timestamp"
        );
        assert_eq!(snapshot.plugin_runtime_smoke.main_url, "index.html");
        assert!(snapshot.plugin_runtime_smoke.main_exists);
        assert!(snapshot.plugin_runtime_smoke.plugin_path_exists);
        assert!(snapshot.plugin_runtime_smoke.expand_height_valid);
        assert!(snapshot.plugin_runtime_smoke.preload_checked);
        assert!(snapshot.plugin_runtime_smoke.data_bridge_checked);
        assert!(snapshot.plugin_runtime_smoke.data_roundtrip_checked);
        assert!(snapshot.plugin_runtime_smoke.bulk_docs_checked);
        assert!(snapshot.plugin_runtime_smoke.attachment_checked);
        assert!(snapshot.plugin_runtime_smoke.data_cleanup_checked);
        assert!(snapshot.plugin_runtime_smoke.native_bridge_checked);
        assert!(snapshot.plugin_runtime_smoke.dialog_guard_checked);
        assert!(snapshot.plugin_runtime_smoke.system_path_checked);
        assert!(snapshot.plugin_runtime_smoke.shell_target_checked);
        assert!(snapshot.plugin_runtime_smoke.context_bridge_checked);
        assert!(snapshot.plugin_runtime_smoke.browser_context_checked);
        assert!(snapshot.plugin_runtime_smoke.finder_context_checked);
        assert!(snapshot.plugin_runtime_smoke.shell_show_item_error_checked);
        assert!(snapshot.plugin_runtime_smoke.copied_files_read_checked);
        assert!(snapshot.plugin_runtime_smoke.screen_capture_guard_checked);
        assert!(snapshot.plugin_runtime_smoke.native_error_checked);
        assert!(snapshot.plugin_runtime_smoke.copy_file_error_checked);
        assert!(snapshot.plugin_runtime_smoke.copy_image_error_checked);
        assert!(
            snapshot
                .plugin_runtime_smoke
                .calculator_search_enter_checked
        );
        assert!(snapshot.plugin_runtime_smoke.timestamp_search_enter_checked);
        assert!(snapshot.plugin_panel_render_smoke.reported);
        assert_eq!(
            snapshot.plugin_panel_render_smoke.sample_plugin_id,
            "timestamp"
        );
        assert_eq!(
            snapshot.plugin_panel_render_smoke.sample_feature_code,
            "timestamp"
        );
        assert_eq!(snapshot.plugin_panel_render_smoke.main_url, "index.html");
        assert!(snapshot.plugin_panel_render_smoke.plugin_path_exists);
        assert!(snapshot.plugin_panel_render_smoke.fs_load);
        assert!(snapshot.plugin_panel_render_smoke.iframe_srcdoc_loaded);
        assert!(snapshot.plugin_panel_render_smoke.iframe_src_empty);
        assert!(snapshot.plugin_panel_render_smoke.load_error_empty);
        assert!(snapshot.plugin_panel_render_smoke.iframe_srcdoc_bytes > 0);
        assert_eq!(snapshot.plugin_panel_render_smoke.expected_samples, 1);
        assert_eq!(snapshot.plugin_panel_render_smoke.reported_samples, 1);
        assert_eq!(snapshot.plugin_panel_render_smoke.rendered_samples, 1);
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .external_plan_expected_samples,
            0
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .external_plan_rendered_samples,
            0
        );
        assert_eq!(
            snapshot.plugin_panel_render_smoke.sample_plugin_ids,
            vec!["timestamp".to_string()]
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .bridge_probe_expected_samples,
            1
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .bridge_probe_reported_samples,
            1
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .bridge_probe_passed_samples,
            1
        );
        assert_eq!(snapshot.plugin_panel_render_smoke.bridge_probe_checks, 5);
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .bridge_probe_passed_checks,
            5
        );
        assert!(snapshot
            .plugin_panel_render_smoke
            .bridge_probe_failed_ids
            .is_empty());
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .native_method_probe_expected_samples,
            1
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .native_method_probe_reported_samples,
            1
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .native_method_probe_passed_samples,
            1
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .native_method_probe_checks,
            4
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .native_method_probe_passed_checks,
            4
        );
        assert!(snapshot
            .plugin_panel_render_smoke
            .native_method_probe_failed_ids
            .is_empty());
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_probe_expected_samples,
            1
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_probe_reported_samples,
            1
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_probe_passed_samples,
            1
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_probe_checks,
            9
        );
        assert_eq!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_probe_passed_checks,
            9
        );
        assert!(snapshot
            .plugin_panel_render_smoke
            .browser_window_probe_failed_ids
            .is_empty());
        assert!(snapshot.plugin_panel_render_smoke.browser_window_created);
        assert!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_child_origin_opaque
        );
        assert!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_self_tauri_unavailable
        );
        assert!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_parent_tauri_unavailable
        );
        assert!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_parent_document_blocked
        );
        assert!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_send_to_parent_checked
        );
        assert!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_execute_javascript_checked
        );
        assert!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_ipc_roundtrip_checked
        );
        assert!(
            snapshot
                .plugin_panel_render_smoke
                .browser_window_cleanup_checked
        );
        assert!(
            snapshot
                .plugin_panel_render_smoke
                .timestamp_subinput_checked
        );
        assert_eq!(snapshot.local_app_search.query, "terminal");
        assert_eq!(snapshot.local_app_search.result_count, 2);
        assert_eq!(snapshot.local_app_search.icon_count, 1);
        assert_eq!(
            snapshot.local_app_search.sample_label.as_deref(),
            Some("打开 Terminal")
        );
        assert!(snapshot.agent_tools_count >= 8);
        assert!(snapshot
            .enabled_agent_tools
            .contains(&"ask_ai_model".to_string()));
        assert!(snapshot
            .enabled_agent_tools
            .contains(&"open_or_reveal_path".to_string()));
    }

    #[test]
    fn plugin_runtime_smoke_summary_activates_indexed_plugin_entry() {
        let db = Database::in_memory().expect("in-memory db");
        let _calculator_dir = install_test_plugin_with_cmds(
            &db,
            "plugin_calculator_hash",
            "calculator",
            "calc",
            400,
            true,
            &["calculator", "计算", "计算器", "calc"],
        );
        let _timestamp_dir = install_test_plugin_with_cmds(
            &db,
            "plugin_timestamp_hash",
            "timestamp",
            "timestamp",
            500,
            true,
            &["时间戳", "timestamp", "ts"],
        );

        let summary = build_plugin_runtime_smoke_summary(&db);

        assert!(summary.ok());
        assert!(summary.feature_activated);
        assert_eq!(summary.sample_plugin_id, "plugin_timestamp_hash");
        assert_eq!(summary.sample_plugin_name, "timestamp");
        assert_eq!(summary.sample_feature_code, "timestamp");
        assert_eq!(summary.main_url, "index.html");
        assert!(summary.main_exists);
        assert!(summary.plugin_path_exists);
        assert!(summary.expand_height_valid);
        assert!(summary.preload_checked);
        assert!(summary.data_bridge_checked);
        assert!(summary.data_roundtrip_checked);
        assert!(summary.bulk_docs_checked);
        assert!(summary.attachment_checked);
        assert!(summary.data_cleanup_checked);
        assert!(summary.native_bridge_checked);
        assert!(summary.dialog_guard_checked);
        assert!(summary.system_path_checked);
        assert!(summary.shell_target_checked);
        assert!(summary.context_bridge_checked);
        assert!(summary.browser_context_checked);
        assert!(summary.finder_context_checked);
        assert!(summary.shell_show_item_error_checked);
        assert!(summary.copied_files_read_checked);
        assert!(summary.screen_capture_guard_checked);
        assert!(summary.native_error_checked);
        assert!(summary.copy_file_error_checked);
        assert!(summary.copy_image_error_checked);
        assert!(summary.calculator_search_enter_checked);
        assert!(summary.timestamp_search_enter_checked);
        assert_eq!(summary.error, None);
    }

    #[test]
    fn plugin_runtime_search_checks_later_timestamp_candidate_when_first_path_invalid() {
        let db = Database::in_memory().expect("in-memory db");
        let bad_timestamp_dir = install_test_plugin_with_cmds(
            &db,
            "plugin_timestamp_hash",
            "timestamp",
            "timestamp",
            500,
            true,
            &["时间戳", "timestamp", "ts"],
        );
        let mut bad_timestamp_plugin = db
            .get_plugin("plugin_timestamp_hash")
            .expect("bad timestamp plugin");
        bad_timestamp_plugin.path = bad_timestamp_dir
            .path()
            .join("missing")
            .to_string_lossy()
            .to_string();
        db.save_plugin(&bad_timestamp_plugin)
            .expect("save bad timestamp plugin");
        let _legacy_timestamp_dir = install_test_plugin_with_cmds(
            &db,
            "plugin_legacy_timestamp_hash",
            "时间戳",
            "时间戳",
            500,
            true,
            &["时间戳", "timestamp", "ts"],
        );
        let features = db.all_features().expect("features");

        assert!(super::plugin_search_enter_checked(
            &db,
            &features,
            "时间戳",
            &["timestamp", "时间戳"],
            &["timestamp", "时间戳"],
        ));
    }

    #[test]
    fn preferred_plugin_panel_render_action_continues_after_invalid_primary_timestamp_path() {
        let db = Database::in_memory().expect("in-memory db");
        let bad_timestamp_dir = install_test_plugin_with_cmds(
            &db,
            "plugin_timestamp_hash",
            "timestamp",
            "timestamp",
            500,
            true,
            &["时间戳", "timestamp", "ts"],
        );
        let mut bad_timestamp_plugin = db
            .get_plugin("plugin_timestamp_hash")
            .expect("bad timestamp plugin");
        bad_timestamp_plugin.path = bad_timestamp_dir
            .path()
            .join("missing")
            .to_string_lossy()
            .to_string();
        db.save_plugin(&bad_timestamp_plugin)
            .expect("save bad timestamp plugin");
        let _legacy_timestamp_dir = install_test_plugin_with_cmds(
            &db,
            "plugin_legacy_timestamp_hash",
            "时间戳",
            "时间戳",
            500,
            true,
            &["时间戳", "timestamp", "ts"],
        );

        let action = super::preferred_plugin_panel_render_action(&db, &["timestamp", "时间戳"])
            .expect("legacy timestamp action");

        assert_eq!(action.plugin_id, "plugin_legacy_timestamp_hash");
        assert_eq!(action.feature_code, "时间戳");
    }

    #[test]
    fn plugin_panel_render_smoke_summary_accumulates_external_plan_reports() {
        let first = PluginPanelRenderSmokeSummary::from_report(PluginPanelRenderSmokeReport {
            plugin_id: "timestamp".to_string(),
            feature_code: "timestamp".to_string(),
            main_url: "index.html".to_string(),
            plugin_path: std::env::temp_dir().to_string_lossy().to_string(),
            fs_load: true,
            iframe_srcdoc_loaded: true,
            iframe_src_empty: true,
            load_error: None,
            iframe_srcdoc_bytes: 128,
            expected_samples: 2,
            sample_index: 0,
            external_plan_sample: false,
            bridge_probe_reported: true,
            bridge_probe_passed: true,
            bridge_probe_checks: 5,
            bridge_probe_passed_checks: 5,
            bridge_probe_failed_ids: Vec::new(),
            native_method_probe_reported: true,
            native_method_probe_passed: true,
            native_method_probe_checks: 4,
            native_method_probe_passed_checks: 4,
            native_method_probe_failed_ids: Vec::new(),
            browser_window_probe_expected: true,
            browser_window_probe_reported: true,
            browser_window_probe_passed: true,
            browser_window_probe_checks: 9,
            browser_window_probe_passed_checks: 9,
            browser_window_probe_failed_ids: Vec::new(),
            browser_window_created: true,
            browser_window_child_origin_opaque: true,
            browser_window_self_tauri_unavailable: true,
            browser_window_parent_tauri_unavailable: true,
            browser_window_parent_document_blocked: true,
            browser_window_send_to_parent_checked: true,
            browser_window_execute_javascript_checked: true,
            browser_window_ipc_roundtrip_checked: true,
            browser_window_cleanup_checked: true,
            subinput_visible: true,
            subinput_placeholder: "输入时间戳 (秒/毫秒) 或日期时间".to_string(),
        });
        assert!(!first.ok());

        let second = first.merge_report(PluginPanelRenderSmokeReport {
            plugin_id: "alpha-ready".to_string(),
            feature_code: "alpha-open".to_string(),
            main_url: "index.html".to_string(),
            plugin_path: std::env::temp_dir().to_string_lossy().to_string(),
            fs_load: true,
            iframe_srcdoc_loaded: true,
            iframe_src_empty: true,
            load_error: None,
            iframe_srcdoc_bytes: 256,
            expected_samples: 2,
            sample_index: 1,
            external_plan_sample: true,
            bridge_probe_reported: true,
            bridge_probe_passed: true,
            bridge_probe_checks: 5,
            bridge_probe_passed_checks: 5,
            bridge_probe_failed_ids: Vec::new(),
            native_method_probe_reported: true,
            native_method_probe_passed: true,
            native_method_probe_checks: 4,
            native_method_probe_passed_checks: 4,
            native_method_probe_failed_ids: Vec::new(),
            browser_window_probe_expected: false,
            browser_window_probe_reported: false,
            browser_window_probe_passed: false,
            browser_window_probe_checks: 0,
            browser_window_probe_passed_checks: 0,
            browser_window_probe_failed_ids: vec!["ignored-later-sample".to_string()],
            browser_window_created: false,
            browser_window_child_origin_opaque: false,
            browser_window_self_tauri_unavailable: false,
            browser_window_parent_tauri_unavailable: false,
            browser_window_parent_document_blocked: false,
            browser_window_send_to_parent_checked: false,
            browser_window_execute_javascript_checked: false,
            browser_window_ipc_roundtrip_checked: false,
            browser_window_cleanup_checked: false,
            subinput_visible: false,
            subinput_placeholder: String::new(),
        });

        assert!(second.ok());
        assert_eq!(second.expected_samples, 2);
        assert_eq!(second.reported_samples, 2);
        assert_eq!(second.rendered_samples, 2);
        assert_eq!(second.external_plan_expected_samples, 1);
        assert_eq!(second.external_plan_rendered_samples, 1);
        assert_eq!(second.bridge_probe_expected_samples, 2);
        assert_eq!(second.bridge_probe_reported_samples, 2);
        assert_eq!(second.bridge_probe_passed_samples, 2);
        assert_eq!(second.bridge_probe_checks, 10);
        assert_eq!(second.bridge_probe_passed_checks, 10);
        assert!(second.bridge_probe_failed_ids.is_empty());
        assert_eq!(second.native_method_probe_expected_samples, 2);
        assert_eq!(second.native_method_probe_reported_samples, 2);
        assert_eq!(second.native_method_probe_passed_samples, 2);
        assert_eq!(second.native_method_probe_checks, 8);
        assert_eq!(second.native_method_probe_passed_checks, 8);
        assert!(second.native_method_probe_failed_ids.is_empty());
        assert_eq!(second.browser_window_probe_expected_samples, 1);
        assert_eq!(second.browser_window_probe_reported_samples, 1);
        assert_eq!(second.browser_window_probe_passed_samples, 1);
        assert_eq!(second.browser_window_probe_checks, 9);
        assert_eq!(second.browser_window_probe_passed_checks, 9);
        assert!(second.browser_window_probe_failed_ids.is_empty());
        assert!(second.browser_window_created);
        assert!(second.browser_window_child_origin_opaque);
        assert!(second.browser_window_self_tauri_unavailable);
        assert!(second.browser_window_parent_tauri_unavailable);
        assert!(second.browser_window_parent_document_blocked);
        assert!(second.browser_window_send_to_parent_checked);
        assert!(second.browser_window_execute_javascript_checked);
        assert!(second.browser_window_ipc_roundtrip_checked);
        assert!(second.browser_window_cleanup_checked);
        assert_eq!(
            second.sample_plugin_ids,
            vec!["timestamp".to_string(), "alpha-ready".to_string()]
        );
        assert_eq!(second.iframe_srcdoc_bytes, 384);
        assert!(second.timestamp_subinput_checked);
    }

    #[test]
    fn plugin_panel_render_smoke_summary_requires_complete_browser_window_probe_contract() {
        let valid = PluginPanelRenderSmokeSummary::from_report(valid_browser_window_probe_report());
        assert!(valid.ok());
        assert_eq!(valid.browser_window_probe_expected_samples, 1);
        assert_eq!(valid.browser_window_probe_reported_samples, 1);
        assert_eq!(valid.browser_window_probe_passed_samples, 1);
        assert_eq!(valid.browser_window_probe_checks, 9);
        assert_eq!(valid.browser_window_probe_passed_checks, 9);
        assert!(valid.browser_window_probe_failed_ids.is_empty());

        macro_rules! assert_required_browser_window_flag {
            ($field:ident) => {{
                let mut invalid = valid.clone();
                invalid.$field = false;
                assert!(
                    !invalid.ok(),
                    concat!(stringify!($field), " must be required")
                );
            }};
        }

        assert_required_browser_window_flag!(browser_window_created);
        assert_required_browser_window_flag!(browser_window_child_origin_opaque);
        assert_required_browser_window_flag!(browser_window_self_tauri_unavailable);
        assert_required_browser_window_flag!(browser_window_parent_tauri_unavailable);
        assert_required_browser_window_flag!(browser_window_parent_document_blocked);
        assert_required_browser_window_flag!(browser_window_send_to_parent_checked);
        assert_required_browser_window_flag!(browser_window_execute_javascript_checked);
        assert_required_browser_window_flag!(browser_window_ipc_roundtrip_checked);
        assert_required_browser_window_flag!(browser_window_cleanup_checked);

        let mut invalid_counts = valid.clone();
        invalid_counts.browser_window_probe_checks = 8;
        assert!(!invalid_counts.ok());

        let mut invalid_expected = valid.clone();
        invalid_expected.browser_window_probe_expected_samples = 2;
        assert!(!invalid_expected.ok());

        let mut invalid_reported = valid.clone();
        invalid_reported.browser_window_probe_reported_samples = 0;
        assert!(!invalid_reported.ok());

        let mut invalid_passed = valid.clone();
        invalid_passed.browser_window_probe_passed_samples = 0;
        assert!(!invalid_passed.ok());

        let mut invalid_passed_checks = valid.clone();
        invalid_passed_checks.browser_window_probe_passed_checks = 8;
        assert!(!invalid_passed_checks.ok());

        let mut invalid_failure = valid;
        invalid_failure
            .browser_window_probe_failed_ids
            .push("desktop-browser-window-child-origin-opaque".to_string());
        assert!(!invalid_failure.ok());
    }

    #[test]
    fn plugin_panel_render_smoke_summary_rejects_browser_window_expected_flag_mismatch() {
        let mut report = valid_browser_window_probe_report();
        report.browser_window_probe_expected = false;

        let summary = PluginPanelRenderSmokeSummary::from_report(report);

        assert!(!summary.ok());
        assert_eq!(summary.browser_window_probe_expected_samples, 1);
        assert_eq!(summary.browser_window_probe_reported_samples, 1);
        assert_eq!(summary.browser_window_probe_passed_samples, 1);
        assert!(summary.error.as_deref().is_some_and(|error| error
            .contains("PluginPanel BrowserWindow probe expected flag was false for sample 0")));
    }

    #[test]
    fn plugin_panel_render_smoke_summary_accepts_sample_zero_after_sample_one() {
        let mut later_report = valid_browser_window_probe_report();
        later_report.plugin_id = "alpha-ready".to_string();
        later_report.feature_code = "alpha-open".to_string();
        later_report.expected_samples = 2;
        later_report.sample_index = 1;
        later_report.external_plan_sample = true;
        later_report.browser_window_probe_expected = false;
        later_report.browser_window_probe_reported = false;
        later_report.browser_window_probe_passed = false;
        later_report.browser_window_probe_checks = 0;
        later_report.browser_window_probe_passed_checks = 0;
        later_report.browser_window_probe_failed_ids = vec!["ignored-later-sample".to_string()];
        later_report.browser_window_created = false;
        later_report.browser_window_child_origin_opaque = false;
        later_report.browser_window_self_tauri_unavailable = false;
        later_report.browser_window_parent_tauri_unavailable = false;
        later_report.browser_window_parent_document_blocked = false;
        later_report.browser_window_send_to_parent_checked = false;
        later_report.browser_window_execute_javascript_checked = false;
        later_report.browser_window_ipc_roundtrip_checked = false;
        later_report.browser_window_cleanup_checked = false;
        later_report.subinput_visible = false;
        later_report.subinput_placeholder = String::new();

        let later_summary = PluginPanelRenderSmokeSummary::from_report(later_report);
        assert!(!later_summary.complete());
        assert_eq!(later_summary.error, None);
        assert_eq!(later_summary.browser_window_probe_expected_samples, 0);

        let mut first_report = valid_browser_window_probe_report();
        first_report.expected_samples = 2;
        let summary = later_summary.merge_report(first_report);

        assert!(summary.ok());
        assert_eq!(summary.reported_samples, 2);
        assert_eq!(summary.rendered_samples, 2);
        assert_eq!(
            summary.sample_plugin_ids,
            vec!["alpha-ready".to_string(), "timestamp".to_string()]
        );
        assert_eq!(summary.browser_window_probe_expected_samples, 1);
        assert_eq!(summary.browser_window_probe_reported_samples, 1);
        assert_eq!(summary.browser_window_probe_passed_samples, 1);
        assert_eq!(summary.browser_window_probe_checks, 9);
        assert_eq!(summary.browser_window_probe_passed_checks, 9);
        assert!(summary.browser_window_probe_failed_ids.is_empty());
        assert!(summary.browser_window_created);
        assert!(summary.browser_window_child_origin_opaque);
        assert!(summary.browser_window_self_tauri_unavailable);
        assert!(summary.browser_window_parent_tauri_unavailable);
        assert!(summary.browser_window_parent_document_blocked);
        assert!(summary.browser_window_send_to_parent_checked);
        assert!(summary.browser_window_execute_javascript_checked);
        assert!(summary.browser_window_ipc_roundtrip_checked);
        assert!(summary.browser_window_cleanup_checked);
    }

    #[test]
    fn plugin_panel_render_smoke_summary_finalized_rejects_missing_browser_window_report() {
        let mut summary =
            PluginPanelRenderSmokeSummary::from_report(valid_browser_window_probe_report());
        summary.browser_window_probe_reported_samples = 0;
        summary.browser_window_probe_passed_samples = 0;
        summary.error = None;

        let finalized = summary.finalized();

        assert!(!finalized.ok());
        assert_eq!(finalized.browser_window_probe_expected_samples, 1);
        assert_eq!(finalized.browser_window_probe_reported_samples, 0);
        assert_eq!(
            finalized.error.as_deref(),
            Some("PluginPanel BrowserWindow probe reported 0/1 samples")
        );
    }

    #[test]
    fn plugin_panel_render_smoke_summary_deduplicates_retransmission_but_rejects_two_sample_zero_reports(
    ) {
        let report = valid_browser_window_probe_report();
        let retransmitted =
            PluginPanelRenderSmokeSummary::from_report(report.clone()).merge_report(report.clone());

        assert!(retransmitted.ok());
        assert_eq!(retransmitted.reported_samples, 1);
        assert_eq!(
            retransmitted.sample_plugin_ids,
            vec!["timestamp".to_string()]
        );
        assert_eq!(retransmitted.browser_window_probe_expected_samples, 1);
        assert_eq!(retransmitted.browser_window_probe_reported_samples, 1);
        assert_eq!(retransmitted.browser_window_probe_passed_samples, 1);
        assert_eq!(retransmitted.browser_window_probe_checks, 9);
        assert_eq!(retransmitted.browser_window_probe_passed_checks, 9);

        let mut first_report = report;
        first_report.expected_samples = 2;
        let first = PluginPanelRenderSmokeSummary::from_report(first_report);

        let mut duplicate_probe_report = valid_browser_window_probe_report();
        duplicate_probe_report.plugin_id = "alpha-ready".to_string();
        duplicate_probe_report.feature_code = "alpha-open".to_string();
        duplicate_probe_report.expected_samples = 2;
        duplicate_probe_report.external_plan_sample = true;
        duplicate_probe_report.subinput_visible = false;
        duplicate_probe_report.subinput_placeholder = String::new();

        let duplicated = first.merge_report(duplicate_probe_report);

        assert!(duplicated.complete());
        assert_eq!(duplicated.error, None);
        assert_eq!(duplicated.reported_samples, 2);
        assert_eq!(duplicated.rendered_samples, 2);
        assert_eq!(duplicated.browser_window_probe_expected_samples, 1);
        assert_eq!(duplicated.browser_window_probe_reported_samples, 2);
        assert_eq!(duplicated.browser_window_probe_passed_samples, 2);
        assert_eq!(duplicated.browser_window_probe_checks, 18);
        assert_eq!(duplicated.browser_window_probe_passed_checks, 18);
        assert!(!duplicated.ok());
        assert!(!duplicated.finalized().ok());
    }

    #[test]
    fn plugin_panel_render_smoke_summary_keeps_partial_bridge_probe_progress_error_free() {
        let report = |plugin_id: &str, sample_index: usize| PluginPanelRenderSmokeReport {
            plugin_id: plugin_id.to_string(),
            feature_code: if plugin_id == "timestamp" {
                "timestamp".to_string()
            } else {
                format!("{plugin_id}-open")
            },
            main_url: "index.html".to_string(),
            plugin_path: std::env::temp_dir().to_string_lossy().to_string(),
            fs_load: true,
            iframe_srcdoc_loaded: true,
            iframe_src_empty: true,
            load_error: None,
            iframe_srcdoc_bytes: 128,
            expected_samples: 3,
            sample_index,
            external_plan_sample: true,
            bridge_probe_reported: true,
            bridge_probe_passed: true,
            bridge_probe_checks: 5,
            bridge_probe_passed_checks: 5,
            bridge_probe_failed_ids: Vec::new(),
            native_method_probe_reported: true,
            native_method_probe_passed: true,
            native_method_probe_checks: 4,
            native_method_probe_passed_checks: 4,
            native_method_probe_failed_ids: Vec::new(),
            browser_window_probe_expected: sample_index == 0,
            browser_window_probe_reported: sample_index == 0,
            browser_window_probe_passed: sample_index == 0,
            browser_window_probe_checks: if sample_index == 0 { 9 } else { 0 },
            browser_window_probe_passed_checks: if sample_index == 0 { 9 } else { 0 },
            browser_window_probe_failed_ids: Vec::new(),
            browser_window_created: sample_index == 0,
            browser_window_child_origin_opaque: sample_index == 0,
            browser_window_self_tauri_unavailable: sample_index == 0,
            browser_window_parent_tauri_unavailable: sample_index == 0,
            browser_window_parent_document_blocked: sample_index == 0,
            browser_window_send_to_parent_checked: sample_index == 0,
            browser_window_execute_javascript_checked: sample_index == 0,
            browser_window_ipc_roundtrip_checked: sample_index == 0,
            browser_window_cleanup_checked: sample_index == 0,
            subinput_visible: plugin_id == "timestamp",
            subinput_placeholder: if plugin_id == "timestamp" {
                "输入时间戳 (秒/毫秒) 或日期时间".to_string()
            } else {
                String::new()
            },
        };

        let first = PluginPanelRenderSmokeSummary::from_report(report("timestamp", 0));
        let second = first.merge_report(report("beta-ready", 1));

        assert!(!second.complete());
        assert_eq!(second.bridge_probe_reported_samples, 2);
        assert_eq!(second.error, None);

        let third = second.merge_report(report("gamma-ready", 2));

        assert!(third.ok());
        assert_eq!(third.bridge_probe_reported_samples, 3);
        assert_eq!(third.bridge_probe_passed_samples, 3);
        assert_eq!(third.bridge_probe_checks, 15);
        assert_eq!(third.bridge_probe_passed_checks, 15);
        assert_eq!(third.native_method_probe_reported_samples, 3);
        assert_eq!(third.native_method_probe_passed_samples, 3);
        assert_eq!(third.native_method_probe_checks, 12);
        assert_eq!(third.native_method_probe_passed_checks, 12);
        assert_eq!(third.browser_window_probe_expected_samples, 1);
        assert_eq!(third.browser_window_probe_reported_samples, 1);
        assert_eq!(third.browser_window_probe_passed_samples, 1);
        assert_eq!(third.browser_window_probe_checks, 9);
        assert_eq!(third.browser_window_probe_passed_checks, 9);
        assert!(third.browser_window_probe_failed_ids.is_empty());
        assert!(third.browser_window_created);
        assert!(third.browser_window_child_origin_opaque);
        assert!(third.browser_window_self_tauri_unavailable);
        assert!(third.browser_window_parent_tauri_unavailable);
        assert!(third.browser_window_parent_document_blocked);
        assert!(third.browser_window_send_to_parent_checked);
        assert!(third.browser_window_execute_javascript_checked);
        assert!(third.browser_window_ipc_roundtrip_checked);
        assert!(third.browser_window_cleanup_checked);
        assert_eq!(third.error, None);
    }

    #[test]
    fn ztools_external_activation_smoke_consumes_plan_imports_and_cleans_up_sample() {
        let db = Database::in_memory().expect("in-memory db");
        let root = tempfile::TempDir::new().expect("activation smoke root");
        let source = root.path().join("alpha-ready");
        std::fs::create_dir_all(&source).expect("plugin source dir");
        std::fs::write(source.join("index.html"), "<main>alpha</main>").expect("main html");
        std::fs::write(
            source.join("plugin.json"),
            r#"{
              "name": "alpha ready!",
              "title": "Alpha Ready",
              "version": "1.0.0",
              "main": "index.html",
              "platform": ["darwin"],
              "features": [{
                "code": "alpha-open",
                "explain": "Alpha Open",
                "cmds": ["alpha"]
              }]
            }"#,
        )
        .expect("plugin manifest");
        let install_root = root.path().join("install");
        let plan_path = root.path().join("activation-plan.json");
        std::fs::write(
            &plan_path,
            serde_json::json!({
                "activation_plans": [{
                    "name": "alpha ready!",
                    "source_path": source,
                    "expected_install_id": "alpha-ready",
                    "install": {
                        "install_root": install_root,
                        "expected_plugin_id": "alpha-ready",
                        "overwrite": true
                    },
                    "activation": {
                        "feature_code": "alpha-open",
                        "trigger_type": "text",
                        "query": "alpha"
                    },
                    "assertions": {
                        "main_exists": true,
                        "preload_checked": true
                    },
                    "cleanup": {
                        "uninstall_plugin_id": "alpha-ready",
                        "remove_installed_files": true,
                        "remove_plugin_data": true
                    }
                }]
            })
            .to_string(),
        )
        .expect("activation plan");

        let summary =
            super::build_ztools_external_activation_smoke_summary(&db, Some(plan_path.as_path()));

        assert!(summary.ok());
        assert_eq!(summary.planned_samples, 1);
        assert_eq!(summary.imported_samples, 1);
        assert_eq!(summary.activated_samples, 1);
        assert_eq!(summary.ui_actions_checked, 1);
        assert_eq!(summary.plugin_panel_fs_load_checked, 1);
        assert_eq!(summary.assertions_checked, 1);
        assert_eq!(summary.cleanup_verified, 1);
        assert_eq!(summary.sample_plugin_ids, vec!["alpha-ready".to_string()]);
        assert!(db.get_plugin("alpha-ready").is_err());
        assert!(!install_root.join("alpha-ready").exists());
    }

    #[test]
    fn ztools_render_actions_skip_plan_samples_marked_unsafe_for_render_smoke() {
        let db = Database::in_memory().expect("in-memory db");
        let root = tempfile::TempDir::new().expect("activation render root");
        let install_root = root.path().join("install");
        let blocked_source = root.path().join("ztools-developer-plugin");
        let alpha_source = root.path().join("alpha-ready");
        std::fs::create_dir_all(&blocked_source).expect("blocked source dir");
        std::fs::create_dir_all(&alpha_source).expect("alpha source dir");
        std::fs::write(blocked_source.join("index.html"), "<main>developer</main>")
            .expect("blocked html");
        std::fs::write(alpha_source.join("index.html"), "<main>alpha</main>").expect("alpha html");
        std::fs::write(
            blocked_source.join("plugin.json"),
            r#"{
              "name": "ztools-developer-plugin",
              "title": "ZTools Developer",
              "version": "1.0.0",
              "main": "index.html",
              "platform": ["darwin"],
              "features": [{
                "code": "ui.router",
                "explain": "Developer",
                "cmds": ["developer"]
              }]
            }"#,
        )
        .expect("blocked manifest");
        std::fs::write(
            alpha_source.join("plugin.json"),
            r#"{
              "name": "alpha ready!",
              "title": "Alpha Ready",
              "version": "1.0.0",
              "main": "index.html",
              "platform": ["darwin"],
              "features": [{
                "code": "alpha-open",
                "explain": "Alpha Open",
                "cmds": ["alpha"]
              }]
            }"#,
        )
        .expect("alpha manifest");
        let plan_path = root.path().join("activation-plan.json");
        std::fs::write(
            &plan_path,
            serde_json::json!({
                "activation_plans": [
                  {
                    "name": "ztools-developer-plugin",
                    "source_path": blocked_source,
                    "expected_install_id": "ztools-developer-plugin",
                    "install": {
                      "install_root": install_root,
                      "expected_plugin_id": "ztools-developer-plugin",
                      "overwrite": true
                    },
                    "activation": {
                      "feature_code": "ui.router",
                      "trigger_type": "text",
                      "query": "developer"
                    },
                    "render_smoke": {
                      "safe": false,
                      "reason": "blocks iframe smoke probe"
                    },
                    "assertions": {
                      "main_exists": true,
                      "preload_checked": true
                    },
                    "cleanup": {
                      "uninstall_plugin_id": "ztools-developer-plugin",
                      "remove_installed_files": true,
                      "remove_plugin_data": true
                    }
                  },
                  {
                    "name": "alpha ready!",
                    "source_path": alpha_source,
                    "expected_install_id": "alpha-ready",
                    "install": {
                      "install_root": install_root,
                      "expected_plugin_id": "alpha-ready",
                      "overwrite": true
                    },
                    "activation": {
                      "feature_code": "alpha-open",
                      "trigger_type": "text",
                      "query": "alpha"
                    },
                    "assertions": {
                      "main_exists": true,
                      "preload_checked": true
                    },
                    "cleanup": {
                      "uninstall_plugin_id": "alpha-ready",
                      "remove_installed_files": true,
                      "remove_plugin_data": true
                    }
                  }
                ]
            })
            .to_string(),
        )
        .expect("activation plan");

        let actions = super::build_ztools_activation_plan_render_actions(&db, plan_path.as_path())
            .expect("render actions");

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].plugin_id, "alpha-ready");
        assert_eq!(actions[0].feature_code, "alpha-open");
    }

    #[test]
    fn ztools_activation_plan_path_resolves_repo_relative_output_from_tauri_cwd() {
        let root = tempfile::TempDir::new().expect("repo root");
        let cwd = root.path().join("src-tauri");
        let output = root.path().join("output");
        std::fs::create_dir_all(&cwd).expect("cwd");
        std::fs::create_dir_all(&output).expect("output");
        let plan_path = output.join("ztools-plugin-activation-plan.json");
        std::fs::write(&plan_path, "{}").expect("plan");

        let resolved = super::resolve_ztools_activation_plan_path(
            PathBuf::from("output/ztools-plugin-activation-plan.json"),
            &cwd,
            root.path(),
        );

        assert_eq!(resolved, plan_path);
    }

    #[test]
    fn local_app_smoke_summary_counts_results_icons_and_sample() {
        let results = vec![
            crate::commands::SearchResult {
                code: "local-app:/Applications/Terminal.app".to_string(),
                plugin_id: "local-apps".to_string(),
                plugin_name: "本地应用".to_string(),
                label: "打开 Terminal".to_string(),
                icon: Some("/Applications/Terminal.app/Contents/Resources/icon.icns".to_string()),
                explain: "/Applications/Terminal.app".to_string(),
                score: 112,
                match_type: "exact",
            },
            crate::commands::SearchResult {
                code: "local-app:/Applications/Terminal Helper.app".to_string(),
                plugin_id: "local-apps".to_string(),
                plugin_name: "本地应用".to_string(),
                label: "打开 Terminal Helper".to_string(),
                icon: None,
                explain: "/Applications/Terminal Helper.app".to_string(),
                score: 96,
                match_type: "prefix",
            },
        ];

        let summary = super::build_local_app_smoke_summary("terminal", &results);

        assert_eq!(summary.query, "terminal");
        assert_eq!(summary.result_count, 2);
        assert_eq!(summary.icon_count, 1);
        assert_eq!(summary.sample_label.as_deref(), Some("打开 Terminal"));
        assert!(summary.sample_has_icon);
    }

    #[test]
    fn desktop_smoke_output_line_is_machine_parseable() {
        let db = Database::in_memory().expect("in-memory db");
        agent_tools::sync_builtin_tools(&db).expect("sync tools");
        let snapshot = build_desktop_smoke_snapshot(
            &db,
            true,
            false,
            None,
            0,
            PermissionSmokeSummary::skipped("missing permission smoke"),
            DataDebugSmokeSummary::skipped("missing data/debug smoke"),
            SystemSettingsSmokeSummary::skipped("missing system settings smoke"),
            PluginPanelRenderSmokeSummary::skipped("missing PluginPanel render smoke"),
            LocalAppSmokeSummary {
                query: "terminal".to_string(),
                result_count: 0,
                icon_count: 0,
                sample_label: None,
                sample_has_icon: false,
            },
        )
        .expect("snapshot");

        let line = desktop_smoke_output_line(&snapshot).expect("output line");

        assert!(line.starts_with("ATOOLS_DESKTOP_SMOKE "));
        let payload = line.trim_start_matches("ATOOLS_DESKTOP_SMOKE ");
        let parsed: serde_json::Value = serde_json::from_str(payload).expect("json payload");
        assert_eq!(parsed["status"], "degraded");
        assert_eq!(parsed["main_window"], true);
        assert_eq!(parsed["settings_window"], false);
        assert_eq!(parsed["mcp_ready"], false);
        assert_eq!(parsed["plugin_runtime_smoke"]["feature_activated"], false);
        assert_eq!(parsed["plugin_panel_render_smoke"]["reported"], false);
    }

    #[test]
    fn mcp_http_smoke_reader_stops_after_complete_content_length_without_eof() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let mut reader = WouldBlockAfterPayload::new(raw.as_bytes());

        let response = super::read_mcp_http_response(&mut reader).expect("HTTP response");

        assert_eq!(response, raw);
    }

    #[test]
    fn mcp_http_smoke_reader_tolerates_transient_would_block_before_payload() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let mut reader = WouldBlockBeforePayload::new(raw.as_bytes());

        let response = super::read_mcp_http_response_with_would_block_retries(&mut reader, 1)
            .expect("HTTP response");

        assert_eq!(response, raw);
    }

    #[test]
    fn mcp_http_smoke_reader_reports_timeout_before_complete_body() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{}";
        let mut reader = WouldBlockAfterPayload::new(raw.as_bytes());

        let error = super::read_mcp_http_response_with_would_block_retries(&mut reader, 0)
            .expect_err("incomplete response");

        assert!(error.contains("would block"));
    }

    struct WouldBlockAfterPayload {
        payload: Vec<u8>,
        consumed: bool,
    }

    impl WouldBlockAfterPayload {
        fn new(payload: &[u8]) -> Self {
            Self {
                payload: payload.to_vec(),
                consumed: false,
            }
        }
    }

    impl Read for WouldBlockAfterPayload {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.consumed {
                return Err(io::Error::new(io::ErrorKind::WouldBlock, "would block"));
            }
            self.consumed = true;
            let len = self.payload.len().min(buf.len());
            buf[..len].copy_from_slice(&self.payload[..len]);
            Ok(len)
        }
    }

    struct WouldBlockBeforePayload {
        payload: Vec<u8>,
        blocked: bool,
        consumed: bool,
    }

    impl WouldBlockBeforePayload {
        fn new(payload: &[u8]) -> Self {
            Self {
                payload: payload.to_vec(),
                blocked: false,
                consumed: false,
            }
        }
    }

    impl Read for WouldBlockBeforePayload {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if !self.blocked {
                self.blocked = true;
                return Err(io::Error::new(io::ErrorKind::WouldBlock, "would block"));
            }
            if self.consumed {
                return Ok(0);
            }
            self.consumed = true;
            let len = self.payload.len().min(buf.len());
            buf[..len].copy_from_slice(&self.payload[..len]);
            Ok(len)
        }
    }

    fn install_test_plugin_with_cmds(
        db: &Database,
        id: &str,
        name: &str,
        feature_code: &str,
        height: u32,
        with_preload: bool,
        cmds: &[&str],
    ) -> tempfile::TempDir {
        let temp_dir = tempfile::TempDir::new().expect("plugin temp dir");
        std::fs::write(temp_dir.path().join("index.html"), "<main>plugin</main>")
            .expect("main html");
        if with_preload {
            std::fs::write(temp_dir.path().join("preload.js"), "window.ready = true;")
                .expect("preload js");
        }
        let feature = Feature {
            code: feature_code.to_string(),
            label: Some(feature_code.to_string()),
            explain: format!("{feature_code} feature"),
            icon: None,
            main_push: true,
            main_hide: false,
            cmds: cmds
                .iter()
                .map(|cmd| Cmd::Text((*cmd).to_string()))
                .collect(),
        };
        let manifest = PluginManifest {
            name: name.to_string(),
            version: "1.0.0".to_string(),
            main: Some("index.html".to_string()),
            logo: None,
            preload: with_preload.then(|| "preload.js".to_string()),
            description: Some("Test plugin".to_string()),
            author: Some("ATools".to_string()),
            homepage: None,
            plugin_setting: Some(PluginSetting {
                single: true,
                height,
            }),
            features: vec![feature.clone()],
            development: None,
            tools: HashMap::new(),
            permissions: vec![
                "data".to_string(),
                "clipboard".to_string(),
                "shell".to_string(),
                "screen".to_string(),
                "dialog".to_string(),
                "context".to_string(),
            ],
        };
        let plugin = Plugin {
            id: id.to_string(),
            name: name.to_string(),
            version: "1.0.0".to_string(),
            path: temp_dir.path().to_string_lossy().to_string(),
            enabled: true,
            manifest,
            created_at: atools_core::utils::now_iso(),
            updated_at: atools_core::utils::now_iso(),
        };

        db.save_plugin(&plugin).expect("save plugin");
        db.index_features(id, &[feature]).expect("index feature");

        temp_dir
    }
}
