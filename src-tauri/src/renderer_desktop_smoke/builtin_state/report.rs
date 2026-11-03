use super::storage::DatabaseIdentity;
use crate::renderer_desktop_smoke::profile::Profile;
use serde::Serialize;

pub(super) const SEED_REPORT_NAME: &str = "native-builtin-state-seed-report.json";
pub(super) const MAIN_REPORT_NAME: &str = "native-builtin-state-report.json";
const REPORT_LIMIT_BYTES: usize = 32 * 1024;
const ERRORS: &[&str] = &[
    "builtin-state-seed-package-invalid",
    "builtin-state-seed-metadata-register-failed",
    "builtin-state-seed-disabled-write-failed",
    "builtin-state-seed-state-invalid",
    "builtin-state-seed-document-write-failed",
    "builtin-state-seed-attachment-write-failed",
    "builtin-state-seed-database-identity-invalid",
    "builtin-state-seed-report-write-failed",
    "builtin-state-resume-owner-invalid",
    "builtin-state-pending-timeout",
    "builtin-state-pending-state-invalid",
    "builtin-state-metadata-register-failed",
    "builtin-state-disabled-state-not-preserved",
    "builtin-state-document-not-preserved",
    "builtin-state-attachment-not-preserved",
    "builtin-state-startup-refresh-invalid",
    "builtin-state-restore-mutation-failed",
    "builtin-state-restore-refresh-invalid",
    "builtin-state-runtime-started",
    "builtin-state-database-identity-invalid",
    "builtin-state-report-write-failed",
];

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SeedObservations {
    pub(super) staged_package_valid: Option<bool>,
    pub(super) metadata_registered: Option<bool>,
    pub(super) plugin_id_resolved: Option<bool>,
    pub(super) disable_committed: Option<bool>,
    pub(super) enabled_after_disable: Option<bool>,
    pub(super) document_written: Option<bool>,
    pub(super) attachment_written: Option<bool>,
    pub(super) database_device: Option<String>,
    pub(super) database_inode: Option<String>,
    pub(super) created_at_fingerprint: Option<String>,
    pub(super) tray_setting_stored: Option<bool>,
    pub(super) tray_configured_visible: Option<bool>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MainObservations {
    pub(super) resume_claimed: Option<bool>,
    pub(super) pending_waiter_observed: Option<bool>,
    pub(super) pending_list_read_count: Option<u64>,
    pub(super) pending_native_calls: Option<u64>,
    pub(super) store_ready_before_release: Option<bool>,
    pub(super) metadata_registered: Option<bool>,
    pub(super) enabled_after_metadata_refresh: Option<bool>,
    pub(super) document_preserved: Option<bool>,
    pub(super) attachment_preserved: Option<bool>,
    pub(super) startup_store_ready: Option<bool>,
    pub(super) startup_timestamp_match_count: Option<u64>,
    pub(super) startup_target_app_count: Option<u64>,
    pub(super) startup_event_delivered_before: Option<u64>,
    pub(super) startup_event_delivered_after: Option<u64>,
    pub(super) startup_list_read_before: Option<u64>,
    pub(super) startup_list_read_after: Option<u64>,
    pub(super) restore_committed: Option<bool>,
    pub(super) enabled_after_restore: Option<bool>,
    pub(super) final_timestamp_match_count: Option<u64>,
    pub(super) final_target_app_count: Option<u64>,
    pub(super) restore_event_delivered_before: Option<u64>,
    pub(super) restore_event_delivered_after: Option<u64>,
    pub(super) restore_list_read_before: Option<u64>,
    pub(super) restore_list_read_after: Option<u64>,
    pub(super) plugin_ui_opened: Option<bool>,
    pub(super) preload_started: Option<bool>,
    pub(super) database_device: Option<String>,
    pub(super) database_inode: Option<String>,
    pub(super) created_at_fingerprint: Option<String>,
    pub(super) tray_configured_visible: Option<bool>,
    pub(super) tray_native_visible: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SeedReport {
    schema_version: u8,
    journey: &'static str,
    scope: &'static str,
    identifier: String,
    root: String,
    pid: u32,
    run_id: String,
    pub(super) observations: SeedObservations,
    pub(super) errors: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MainReport {
    schema_version: u8,
    journey: &'static str,
    scope: &'static str,
    identifier: String,
    root: String,
    pid: u32,
    run_id: String,
    seed_pid: u32,
    pub(super) observations: MainObservations,
    pub(super) errors: Vec<&'static str>,
}

impl SeedReport {
    pub(super) fn new(profile: &Profile) -> Self {
        Self {
            schema_version: 2,
            journey: "builtin-state-seed",
            scope: "settings-input-timestamp-disabled-seed",
            identifier: profile.identifier.clone(),
            root: profile.root.to_string_lossy().into_owned(),
            pid: std::process::id(),
            run_id: profile.run_id.clone(),
            observations: SeedObservations::default(),
            errors: Vec::new(),
        }
    }
}

impl MainReport {
    pub(super) fn new(profile: &Profile) -> Self {
        Self {
            schema_version: 2,
            journey: "builtin-state",
            scope: "settings-input-original-vue-cold-start",
            identifier: profile.identifier.clone(),
            root: profile.root.to_string_lossy().into_owned(),
            pid: std::process::id(),
            run_id: profile.run_id.clone(),
            seed_pid: profile.resume_seed_pid.unwrap_or_default(),
            observations: MainObservations::default(),
            errors: Vec::new(),
        }
    }
}

pub(super) fn add_error(errors: &mut Vec<&'static str>, code: &'static str) {
    if ERRORS.contains(&code) && !errors.contains(&code) && errors.len() < ERRORS.len() {
        errors.push(code);
    }
}

pub(super) fn write_seed(profile: &Profile, report: &SeedReport) -> Result<(), &'static str> {
    write(profile, SEED_REPORT_NAME, report)
}

pub(super) fn write_main(profile: &Profile, report: &MainReport) -> Result<(), &'static str> {
    write(profile, MAIN_REPORT_NAME, report)
}

pub(super) fn write_resume_rejection(profile: &Profile) -> Result<(), &'static str> {
    let mut report = MainReport::new(profile);
    report.observations.resume_claimed = Some(false);
    add_error(&mut report.errors, "builtin-state-resume-owner-invalid");
    write_main(profile, &report)
}

fn write<T: Serialize>(
    profile: &Profile,
    expected_name: &str,
    report: &T,
) -> Result<(), &'static str> {
    if profile.output.file_name().and_then(|name| name.to_str()) != Some(expected_name) {
        return Err("builtin-state-report-write-failed");
    }
    let value = serde_json::to_value(report).map_err(|_| "builtin-state-report-write-failed")?;
    let bytes = serde_json::to_vec(&value).map_err(|_| "builtin-state-report-write-failed")?;
    if bytes.len() > REPORT_LIMIT_BYTES {
        return Err("builtin-state-report-write-failed");
    }
    profile
        .write_report(&value)
        .map_err(|_| "builtin-state-report-write-failed")
}

pub(super) fn apply_database_identity(
    device: &mut Option<String>,
    inode: &mut Option<String>,
    identity: Option<DatabaseIdentity>,
) {
    if let Some(identity) = identity {
        *device = Some(identity.device);
        *inode = Some(identity.inode);
    }
}
