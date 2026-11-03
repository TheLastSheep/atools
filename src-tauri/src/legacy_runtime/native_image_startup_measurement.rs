//! Fixture-only, bounded live checkpoint for one authorized Node startup.
use atools_plugin::sidecar::{StartupDiagnosticSnapshot, StartupPhase, StartupResolutionSource};
use serde::Serialize;
#[cfg(test)]
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const CHECKPOINT_NAME: &str = "native-node-startup-checkpoint.json";
const MAX_CHECKPOINT_BYTES: usize = 2048;
const MAX_EVENTS: usize = 12;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint<'a> {
    schema_version: u8,
    case_id: &'a str,
    plugin_id: &'a str,
    runtime: &'static str,
    owned_pid: u32,
    selected_executable_path_sha256: &'a str,
    events: Vec<CheckpointEvent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointEvent {
    phase: String,
    elapsed_ms: u64,
}

pub(crate) struct StartupCheckpointSink {
    final_path: PathBuf,
    case_id: String,
    plugin_id: String,
}

impl StartupCheckpointSink {
    pub(crate) fn new(
        output_path: &Path,
        fixture_root: &Path,
        case_id: &str,
        plugin_id: &str,
    ) -> Result<Self, String> {
        if output_path.file_name().and_then(|name| name.to_str()) == Some(CHECKPOINT_NAME) {
            return Err("Native startup report cannot share the checkpoint filename".into());
        }
        let output_parent = output_path
            .parent()
            .ok_or("Native startup output has no parent")?
            .canonicalize()
            .map_err(|_| "Native startup output parent is unavailable")?;
        let fixture_root = fixture_root
            .canonicalize()
            .map_err(|_| "Native startup fixture root is unavailable")?;
        if case_id != "pasteboard-pro-native-image"
            || plugin_id != "batch59-pasteboard-pro-native-image"
        {
            return Err("Native startup checkpoint fixture identity is not registered".into());
        }
        if output_parent.starts_with(&fixture_root) {
            return Err("Native startup checkpoint must be outside fixture data".into());
        }
        let final_path = output_parent.join(CHECKPOINT_NAME);
        match fs::symlink_metadata(&final_path) {
            Ok(_) => return Err("Native startup checkpoint path must be fresh".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Native startup checkpoint path could not be inspected".into()),
        }
        Ok(Self {
            final_path,
            case_id: case_id.to_owned(),
            plugin_id: plugin_id.to_owned(),
        })
    }

    pub(crate) fn publish(&self, snapshot: &StartupDiagnosticSnapshot) -> Result<(), String> {
        let checkpoint = project_snapshot(snapshot, &self.case_id, &self.plugin_id)?;
        let bytes = serde_json::to_vec(&checkpoint)
            .map_err(|_| "Native startup checkpoint could not be encoded")?;
        if bytes.len() > MAX_CHECKPOINT_BYTES {
            return Err("Native startup checkpoint exceeds its size limit".into());
        }
        let parent = self
            .final_path
            .parent()
            .ok_or("Native startup checkpoint has no parent")?;
        let temporary = parent.join(format!(".native-startup-{}.tmp", uuid::Uuid::new_v4()));
        let mut temporary_created = false;
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| "Native startup temporary checkpoint could not be created")?;
            temporary_created = true;
            file.write_all(&bytes)
                .map_err(|_| "Native startup checkpoint write failed")?;
            file.sync_all()
                .map_err(|_| "Native startup checkpoint sync failed")?;
            fs::hard_link(&temporary, &self.final_path)
                .map_err(|_| "Native startup checkpoint was not published")?;
            Ok(())
        })();
        if temporary_created {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn project_snapshot<'a>(
    snapshot: &'a StartupDiagnosticSnapshot,
    case_id: &'a str,
    plugin_id: &'a str,
) -> Result<Checkpoint<'a>, String> {
    let pid = snapshot
        .owned_pid
        .filter(|pid| *pid != 0)
        .ok_or("Native startup checkpoint has no owned process")?;
    if snapshot.resolution_source != Some(StartupResolutionSource::SharedProductionResolver) {
        return Err("Native startup checkpoint did not use the shared Node resolver".into());
    }
    let path_hash = snapshot
        .selected_executable_path_sha256
        .as_deref()
        .filter(|value| is_lower_hex_digest(value))
        .ok_or("Native startup checkpoint has no verified Node path digest")?;
    if snapshot.events.is_empty() || snapshot.events.len() > MAX_EVENTS {
        return Err("Native startup checkpoint event count is invalid".into());
    }
    let mut previous = 0;
    let mut events = Vec::with_capacity(snapshot.events.len());
    let required = [
        StartupPhase::NodeResolved,
        StartupPhase::SidecarSpawned,
        StartupPhase::SidecarRunning,
        StartupPhase::InitializeRequestWritten,
        StartupPhase::FirstStdoutParsed,
        StartupPhase::InitializeResponseMatched,
        StartupPhase::InitializeCompleted,
    ];
    let mut required_index = 0;
    for event in &snapshot.events {
        if event.elapsed_ms < previous {
            return Err("Native startup checkpoint event order is invalid".into());
        }
        previous = event.elapsed_ms;
        let phase = serde_json::to_value(event.phase)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or("Native startup checkpoint phase is invalid")?;
        if required.get(required_index) == Some(&event.phase) {
            required_index += 1;
        }
        events.push(CheckpointEvent {
            phase,
            elapsed_ms: event.elapsed_ms,
        });
    }
    if required_index != required.len() {
        return Err("Native startup checkpoint startup phases are incomplete".into());
    }
    Ok(Checkpoint {
        schema_version: 1,
        case_id,
        plugin_id,
        runtime: "node",
        owned_pid: pid,
        selected_executable_path_sha256: path_hash,
        events,
    })
}

fn is_lower_hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use atools_plugin::sidecar::{
        StartupDiagnosticSnapshot, StartupProcessStatus, StartupTryWait, StartupVersionSource,
    };

    fn snapshot() -> StartupDiagnosticSnapshot {
        StartupDiagnosticSnapshot {
            schema_version: 1,
            elapsed_ms: 9,
            events: [
                StartupPhase::NodeResolved,
                StartupPhase::SidecarSpawned,
                StartupPhase::SidecarRunning,
                StartupPhase::InitializeRequestWritten,
                StartupPhase::FirstStdoutParsed,
                StartupPhase::InitializeResponseMatched,
                StartupPhase::InitializeCompleted,
            ]
            .into_iter()
            .enumerate()
            .map(|(index, phase)| atools_plugin::sidecar::StartupEvent {
                phase,
                elapsed_ms: index as u64 + 3,
                request_id: Some(7),
                bytes_written: Some(11),
                parse_outcome: None,
                response_outcome: None,
            })
            .collect(),
            resolution_source: Some(StartupResolutionSource::SharedProductionResolver),
            selected_executable_path_sha256: Some("a".repeat(64)),
            node_version: Some("22.23.3".into()),
            node_version_source: StartupVersionSource::InitializeResponse,
            owned_pid: Some(42),
            stdout_read: Default::default(),
            sidecar_status: StartupProcessStatus::Running,
            last_try_wait: StartupTryWait::Running,
            last_try_wait_elapsed_ms: Some(9),
            stderr_bytes: 25,
            stderr_hashed_bytes: 25,
            stderr_sha256: Some("b".repeat(64)),
            stderr_truncated: false,
            cleanup_required: false,
            cleanup_completed: None,
        }
    }

    fn private_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("atools-startup-measure-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn projection_keeps_only_allowlisted_identity_and_phase_timing() {
        let snapshot = snapshot();
        let projected = project_snapshot(
            &snapshot,
            "pasteboard-pro-native-image",
            "batch59-pasteboard-pro-native-image",
        )
        .unwrap();
        let value = serde_json::to_value(projected).unwrap();
        assert_eq!(value["ownedPid"], 42);
        assert_eq!(value["selectedExecutablePathSha256"], "a".repeat(64));
        assert_eq!(value["events"][0]["phase"], "node_resolved");
        assert_eq!(value["events"][6]["phase"], "initialize_completed");
        let encoded = serde_json::to_string(&value).unwrap();
        assert!(!encoded.contains("22.23.3"));
        assert!(!encoded.contains(&"b".repeat(64)));
        assert!(!encoded.contains("requestId"));
    }

    #[test]
    fn invalid_or_incomplete_snapshot_is_rejected() {
        let mut value = snapshot();
        value.owned_pid = Some(0);
        assert!(project_snapshot(&value, "case", "plugin").is_err());
        let mut value = snapshot();
        value.selected_executable_path_sha256 = Some("../path".into());
        assert!(project_snapshot(&value, "case", "plugin").is_err());
        let mut value = snapshot();
        value.events[0].phase = StartupPhase::SidecarRunning;
        assert!(project_snapshot(&value, "case", "plugin").is_err());
        let mut value = snapshot();
        let first = value.events[0].phase;
        value.events[0].phase = value.events[1].phase;
        value.events[1].phase = first;
        assert!(project_snapshot(&value, "case", "plugin").is_err());
        let mut value = snapshot();
        value.events[0].elapsed_ms = 1;
        value.events.push(atools_plugin::sidecar::StartupEvent {
            phase: StartupPhase::NodeResolved,
            elapsed_ms: 0,
            request_id: None,
            bytes_written: None,
            parse_outcome: None,
            response_outcome: None,
        });
        assert!(project_snapshot(&value, "case", "plugin").is_err());
    }

    #[test]
    fn checkpoint_is_fresh_atomic_and_never_overwrites_existing_file() {
        let parent = private_dir();
        let fixture_root = parent.join("fixture");
        fs::create_dir(&fixture_root).unwrap();
        let output = parent.join("report.json");
        let sink = StartupCheckpointSink::new(
            &output,
            &fixture_root,
            "pasteboard-pro-native-image",
            "batch59-pasteboard-pro-native-image",
        )
        .unwrap();
        assert!(StartupCheckpointSink::new(
            &parent.join(CHECKPOINT_NAME),
            &fixture_root,
            "pasteboard-pro-native-image",
            "batch59-pasteboard-pro-native-image",
        )
        .is_err());
        sink.publish(&snapshot()).unwrap();
        let value: Value =
            serde_json::from_slice(&fs::read(parent.join(CHECKPOINT_NAME)).unwrap()).unwrap();
        assert_eq!(value["ownedPid"], 42);
        assert!(sink.publish(&snapshot()).is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn pasteboard_permit_requires_its_own_explicit_fixture_flag_and_identity() {
        use crate::legacy_runtime::native_node_startup_fixture::NativeNodeStartupFixture;
        use serde_json::json;
        use std::sync::Arc;

        let root = private_dir();
        let missing_output = root.join("missing-parent/report.json");
        let missing_fixture = root.join("missing-fixture");
        let app_run_id = uuid::Uuid::new_v4().to_string();
        let owner = format!("window:main:{}", uuid::Uuid::new_v4());
        let profile = json!({
            "caseId":"pasteboard-pro-native-image",
            "id":"batch59-pasteboard-pro-native-image",
            "runtime":"node"
        });
        let disabled = NativeNodeStartupFixture::new_pasteboard_native_image(
            &profile,
            &app_run_id,
            false,
            &missing_output,
            &missing_fixture,
        )
        .unwrap();
        assert!(Arc::new(disabled)
            .permit("batch59-pasteboard-pro-native-image", &owner)
            .is_none());

        let output_dir = root.join("output");
        fs::create_dir(&output_dir).unwrap();
        let fixture_root = root.join("fixture");
        fs::create_dir(&fixture_root).unwrap();
        let output = output_dir.join("report.json");
        let authorized = NativeNodeStartupFixture::new_pasteboard_native_image(
            &profile,
            &app_run_id,
            true,
            &output,
            &fixture_root,
        )
        .unwrap();
        let authorized = Arc::new(authorized);
        assert!(authorized
            .permit("batch59-pasteboard-pro-native-image", &owner)
            .is_some());
        assert!(authorized.permit("plain-text", &owner).is_none());

        let mismatch = json!({
            "caseId":"pasteboard-pro-native-image",
            "id":"plain-text",
            "runtime":"node"
        });
        let disabled = NativeNodeStartupFixture::new_pasteboard_native_image(
            &mismatch,
            &app_run_id,
            true,
            &missing_output,
            &missing_fixture,
        )
        .unwrap();
        assert!(Arc::new(disabled).permit("plain-text", &owner).is_none());
        let non_node = json!({
            "caseId":"pasteboard-pro-native-image",
            "id":"batch59-pasteboard-pro-native-image",
            "runtime":"quickjs"
        });
        let disabled = NativeNodeStartupFixture::new_pasteboard_native_image(
            &non_node,
            &app_run_id,
            true,
            &missing_output,
            &missing_fixture,
        )
        .unwrap();
        assert!(Arc::new(disabled)
            .permit("batch59-pasteboard-pro-native-image", &owner)
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checkpoint_refuses_a_parent_inside_fixture_root() {
        let parent = private_dir();
        let fixture_root = parent.join("fixture");
        fs::create_dir_all(fixture_root.join("reports")).unwrap();
        assert!(StartupCheckpointSink::new(
            &fixture_root.join("reports/out.json"),
            &fixture_root,
            "pasteboard-pro-native-image",
            "batch59-pasteboard-pro-native-image"
        )
        .is_err());
        fs::remove_dir_all(parent).unwrap();
    }
}
