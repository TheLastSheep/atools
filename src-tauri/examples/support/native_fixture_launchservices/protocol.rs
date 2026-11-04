use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchConfig {
    pub run_id: String,
    pub case_id: String,
    pub bundle_path: PathBuf,
    pub bundle_id: String,
    pub executable_path: PathBuf,
    pub target_args: Vec<String>,
    pub target_env: std::collections::BTreeMap<String, String>,
    pub control_dir: PathBuf,
    pub observer_report_path: PathBuf,
    pub native_report_path: PathBuf,
    pub process_tag: String,
    pub launch_timeout_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ProcessIdentity {
    pub pid: i32,
    pub start_token: String,
    pub command_sha256: String,
    pub executable_path: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ObserverReport {
    pub schema_version: u8,
    pub mode: &'static str,
    pub run_id: String,
    pub case_id: String,
    pub observer_pid: u32,
    pub target_pid: Option<i32>,
    pub target_bundle_url: Option<String>,
    pub target_bundle_id: Option<String>,
    pub target_executable_url: Option<String>,
    pub target_process_identity: Option<ProcessIdentity>,
    pub launch_date_present: bool,
    pub launch_date_in_window: bool,
    pub launch_callback_received: bool,
    pub target_terminated: bool,
    pub target_os_exit_code: Option<i32>,
    pub target_os_exit_code_source: &'static str,
    pub termination_identity_rechecked: bool,
    pub log_bytes: u64,
    pub log_encoded_bytes: u64,
    pub log_frame_count: u64,
    pub log_overflow: bool,
    pub log_route_complete: bool,
    pub error: Option<String>,
}

impl ObserverReport {
    pub fn failed(config: &LaunchConfig, error: String) -> Self {
        Self {
            schema_version: 1,
            mode: "launchservices-private-fixture",
            run_id: config.run_id.clone(),
            case_id: config.case_id.clone(),
            observer_pid: std::process::id(),
            target_pid: None,
            target_bundle_url: None,
            target_bundle_id: None,
            target_executable_url: None,
            target_process_identity: None,
            launch_date_present: false,
            launch_date_in_window: false,
            launch_callback_received: false,
            target_terminated: false,
            target_os_exit_code: None,
            target_os_exit_code_source: "NSRunningApplication does not expose process exit status",
            termination_identity_rechecked: false,
            log_bytes: 0,
            log_encoded_bytes: 0,
            log_frame_count: 0,
            log_overflow: false,
            log_route_complete: false,
            error: Some(error),
        }
    }
}

pub fn write_report(path: &Path, report: &ObserverReport) -> Result<(), String> {
    let parent = path.parent().ok_or("observer report has no parent")?;
    validate_private_directory(parent)?;
    if path.exists() {
        return Err("observer report path already exists".into());
    }
    let bytes = serde_json::to_vec_pretty(report).map_err(|error| error.to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("observer report exceeds fixed size budget".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("create observer report: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("write observer report: {error}"))?;
    file.write_all(b"\n")
        .map_err(|error| format!("finish observer report: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync observer report: {error}"))?;
    Ok(())
}

pub fn validate_private_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect private directory: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err("control directory must be an owned, non-symlink mode-0700 directory".into());
    }
    Ok(())
}
