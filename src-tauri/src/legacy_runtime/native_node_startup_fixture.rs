//! Fixture-only authorization and report storage for bounded Node startup snapshots.
use super::native_image_startup_measurement::StartupCheckpointSink;
use atools_core::Database;
use atools_plugin::sidecar::StartupDiagnosticSnapshot;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

const MAX_SUCCESS_SNAPSHOTS: usize = 2;
const MAX_FAILURE_SNAPSHOTS: usize = 2;
const MAX_SNAPSHOT_BYTES: usize = 2048;
const MAX_FAILURE_RECORD_BYTES: usize = 8192;
const DEEPREAD_CASE: &str = "converted-deepread-source";

pub(crate) fn is_task_run_id(value: &str) -> bool {
    let Some(uuid_value) = value.strip_prefix("run-") else {
        return false;
    };
    uuid::Uuid::parse_str(uuid_value).is_ok_and(|uuid| uuid.hyphenated().to_string() == uuid_value)
}

pub(crate) struct NativeNodeStartupFixture {
    app_run_id: String,
    case_id: String,
    plugin_id: String,
    enabled: bool,
    success_snapshots: Mutex<Vec<Value>>,
    failure_snapshots: Mutex<Vec<Value>>,
    capture_complete: Mutex<bool>,
    checkpoint: Option<Arc<StartupCheckpointSink>>,
}

/// Path-free identity copied only from a verified converted handoff.
pub(crate) struct StartupDiagnosticHandoffIdentity {
    pub case_id: String,
    pub source_case_id: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub artifact_kind: String,
    pub handoff_status: String,
    pub native_ui_consumer_supported: bool,
    pub manifest_sha256: String,
    pub installed_package_tree_sha256: String,
}

#[derive(Clone)]
pub(crate) struct StartupDiagnosticPermit {
    fixture: Arc<NativeNodeStartupFixture>,
    plugin_id: String,
    owner: String,
}

/// Owns one authorized Node startup attempt. Any path that does not deliver a
/// verified success or typed failure marks the fixture evidence incomplete.
pub(crate) struct StartupAttemptGuard {
    permit: StartupDiagnosticPermit,
    completed: AtomicBool,
}

impl NativeNodeStartupFixture {
    pub(crate) fn new(
        profile: &Value,
        app_run_id: &str,
        native_ui_input: bool,
        worker_contract_only: bool,
    ) -> Self {
        let case_id = profile["caseId"].as_str().unwrap_or_default().to_owned();
        let plugin_id = profile["id"].as_str().unwrap_or_default().to_owned();
        let registered_editor = matches!(
            (case_id.as_str(), plugin_id.as_str()),
            ("local-json-editor", "json-editor") | ("local-plain-text", "plain-text")
        );
        let enabled = native_ui_input
            && !worker_contract_only
            && registered_editor
            && profile["runtime"] == "node"
            && uuid::Uuid::parse_str(app_run_id).is_ok();
        Self::build(app_run_id, case_id, plugin_id, enabled, None)
    }

    pub(crate) fn new_converted_deepread(
        profile: &Value,
        app_run_id: &str,
        handoff: Option<&StartupDiagnosticHandoffIdentity>,
    ) -> Self {
        let case_id = profile["caseId"].as_str().unwrap_or_default().to_owned();
        let plugin_id = profile["id"].as_str().unwrap_or_default().to_owned();
        let registered_profile =
            crate::plugin_source_build::converted_source_registry::profile(DEEPREAD_CASE).ok();
        let registered_handoff =
            crate::plugin_source_build::converted_source_registry::handoff(DEEPREAD_CASE).ok();
        let identity_matches = handoff.is_some_and(|value| {
            value.case_id == DEEPREAD_CASE
                && value.source_case_id == "fixed-head-deepread-public"
                && value.plugin_id == "deepread"
                && value.plugin_version == "1.1.2"
                && value.artifact_kind == "converted_source_evidence"
                && value.handoff_status == "conversion_evidence_only"
                && !value.native_ui_consumer_supported
                && registered_handoff.as_ref().is_some_and(|pins| {
                    pins["sourceCaseId"] == value.source_case_id
                        && pins["manifestSha256"] == value.manifest_sha256
                        && pins["installedPackageTreeSha256"] == value.installed_package_tree_sha256
                        && pins["artifactKind"] == value.artifact_kind
                        && pins["handoffStatus"] == value.handoff_status
                        && pins["nativeUiConsumerSupported"] == value.native_ui_consumer_supported
                })
        });
        let profile_is_registered = registered_profile
            .as_ref()
            .is_some_and(|registered| profile == registered);
        let run_id_is_canonical = uuid::Uuid::parse_str(app_run_id)
            .is_ok_and(|value| value.hyphenated().to_string() == app_run_id);
        let enabled = profile_is_registered
            && identity_matches
            && profile["runtime"] == "web"
            && run_id_is_canonical;
        Self::build(app_run_id, case_id, plugin_id, enabled, None)
    }

    pub(crate) fn new_pasteboard_native_image(
        profile: &Value,
        app_run_id: &str,
        pasteboard_native_image_ui: bool,
        output_path: &Path,
        fixture_root: &Path,
    ) -> Result<Self, String> {
        let case_id = profile["caseId"].as_str().unwrap_or_default().to_owned();
        let plugin_id = profile["id"].as_str().unwrap_or_default().to_owned();
        let authorized = pasteboard_native_image_ui
            && case_id == "pasteboard-pro-native-image"
            && plugin_id == "batch59-pasteboard-pro-native-image"
            && profile["runtime"] == "node"
            && uuid::Uuid::parse_str(app_run_id).is_ok();
        let checkpoint = if authorized {
            Some(Arc::new(StartupCheckpointSink::new(
                output_path,
                fixture_root,
                &case_id,
                &plugin_id,
            )?))
        } else {
            None
        };
        Ok(Self::build(
            app_run_id, case_id, plugin_id, authorized, checkpoint,
        ))
    }

    fn build(
        app_run_id: &str,
        case_id: String,
        plugin_id: String,
        enabled: bool,
        checkpoint: Option<Arc<StartupCheckpointSink>>,
    ) -> Self {
        Self {
            app_run_id: app_run_id.to_owned(),
            case_id,
            plugin_id,
            enabled,
            success_snapshots: Mutex::new(Vec::new()),
            failure_snapshots: Mutex::new(Vec::new()),
            capture_complete: Mutex::new(true),
            checkpoint,
        }
    }

    pub(crate) fn permit(
        self: &Arc<Self>,
        plugin_id: &str,
        owner: &str,
    ) -> Option<StartupDiagnosticPermit> {
        if !self.enabled || plugin_id != self.plugin_id || !is_fixture_owner(owner) {
            return None;
        }
        Some(StartupDiagnosticPermit {
            fixture: self.clone(),
            plugin_id: plugin_id.to_owned(),
            owner: owner.to_owned(),
        })
    }

    pub(crate) fn report(&self, db: &Database) -> Option<Value> {
        if !self.enabled {
            return None;
        }
        let success_snapshots = self.success_snapshots.lock().clone();
        let failure_snapshots = self.failure_snapshots.lock().clone();
        let successes_verified = success_snapshots.iter().all(|record| {
            let Some(run_id) = record["taskRunId"].as_str() else {
                return false;
            };
            let Ok(Some(run)) = db.get_task_run(run_id) else {
                return false;
            };
            is_task_run_id(run_id)
                && run.id == run_id
                && run.status.as_str() == "succeeded"
                && record["owner"].as_str().is_some_and(is_fixture_owner)
                && record["pluginId"] == self.plugin_id
                && record["snapshot"].is_object()
        });
        let failures_verified = failure_snapshots.iter().all(|record| {
            let Some(run_id) = record["taskRunId"].as_str() else {
                return false;
            };
            let Ok(Some(run)) = db.get_task_run(run_id) else {
                return false;
            };
            let details = &record["taskIssue"]["details"];
            let issue = run.errors.iter().find(|issue| {
                issue.code == record["taskIssue"]["code"].as_str().unwrap_or_default()
            });
            is_task_run_id(run_id)
                && run.id == run_id
                && run.status.as_str() == "failed"
                && issue.is_some_and(|issue| {
                    issue.details == *details
                        && issue.retryable == (record["taskIssue"]["retryable"] == true)
                })
                && record["errorObservation"]["runId"] == run_id
                && record["errorObservation"]["errorObservation"]["diagnostics"] == *details
                && details["runId"] == run_id
                && details["runId"] == run_id
                && details["owner"] == record["owner"]
                && details["pluginId"] == self.plugin_id
        });
        let capture_complete = *self.capture_complete.lock();
        let exercised = !success_snapshots.is_empty() || !failure_snapshots.is_empty();
        Some(json!({
            "enabled": true,
            "appRunId": self.app_run_id,
            "caseId": self.case_id,
            "pluginId": self.plugin_id,
            "successSnapshots": success_snapshots,
            "failureSnapshots": failure_snapshots,
            "captureComplete": capture_complete,
            "captureStatus": if !capture_complete { "incomplete" } else if !exercised { "not_exercised" } else if successes_verified && failures_verified { "verified" } else { "incomplete" },
            "associationVerified": exercised && capture_complete && successes_verified && failures_verified,
        }))
    }

    fn record_failure(
        &self,
        task_run_id: &str,
        plugin_id: &str,
        owner: &str,
        issue: &atools_core::task_run::TaskIssue,
        error_observation: &Value,
    ) -> bool {
        let valid = is_task_run_id(task_run_id)
            && self.plugin_id == plugin_id
            && issue.code.starts_with("node_sidecar_startup_")
            && issue.details["runId"] == task_run_id
            && issue.details["pluginId"] == plugin_id
            && issue.details["owner"] == owner
            && is_fixture_owner(owner)
            && error_observation["runId"] == task_run_id
            && error_observation["errorObservation"]["diagnostics"] == issue.details;
        let record = json!({
            "taskRunId": task_run_id,
            "owner": owner,
            "taskIssue": {
                "code": issue.code,
                "details": issue.details,
                "retryable": issue.retryable,
            },
            "errorObservation": error_observation,
        });
        let size_ok = serde_json::to_vec(&record)
            .map(|encoded| encoded.len() <= MAX_FAILURE_RECORD_BYTES)
            .unwrap_or(false);
        let mut records = self.failure_snapshots.lock();
        if !valid || !size_ok || records.len() >= MAX_FAILURE_SNAPSHOTS {
            *self.capture_complete.lock() = false;
            return false;
        }
        records.push(record);
        true
    }
}

impl StartupDiagnosticPermit {
    pub(crate) fn begin_attempt(&self) -> StartupAttemptGuard {
        StartupAttemptGuard {
            permit: self.clone(),
            completed: AtomicBool::new(false),
        }
    }

    pub(crate) fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    pub(crate) fn owner(&self) -> &str {
        &self.owner
    }

    pub(crate) fn mark_incomplete(&self) {
        *self.fixture.capture_complete.lock() = false;
    }

    pub(crate) fn record_success(
        &self,
        task_run_id: &str,
        snapshot: &StartupDiagnosticSnapshot,
    ) -> bool {
        if !is_task_run_id(task_run_id) {
            *self.fixture.capture_complete.lock() = false;
            return false;
        }
        let Ok(snapshot_value) = serde_json::to_value(snapshot) else {
            *self.fixture.capture_complete.lock() = false;
            return false;
        };
        let Ok(encoded) = serde_json::to_vec(&snapshot_value) else {
            *self.fixture.capture_complete.lock() = false;
            return false;
        };
        if encoded.len() > MAX_SNAPSHOT_BYTES {
            *self.fixture.capture_complete.lock() = false;
            return false;
        }
        if let Some(checkpoint) = &self.fixture.checkpoint {
            if checkpoint.publish(snapshot).is_err() {
                *self.fixture.capture_complete.lock() = false;
                return false;
            }
        }
        let mut records = self.fixture.success_snapshots.lock();
        if records.len() >= MAX_SUCCESS_SNAPSHOTS {
            *self.fixture.capture_complete.lock() = false;
            return false;
        }
        records.push(json!({
            "taskRunId": task_run_id,
            "owner": self.owner,
            "pluginId": self.plugin_id,
            "snapshot": snapshot_value,
        }));
        true
    }

    pub(crate) fn record_failure(
        &self,
        task_run_id: &str,
        issue: &atools_core::task_run::TaskIssue,
        error_observation: &Value,
    ) -> bool {
        self.fixture.record_failure(
            task_run_id,
            &self.plugin_id,
            &self.owner,
            issue,
            error_observation,
        )
    }
}

impl StartupAttemptGuard {
    pub(crate) fn plugin_id(&self) -> &str {
        self.permit.plugin_id()
    }

    pub(crate) fn owner(&self) -> &str {
        self.permit.owner()
    }

    pub(crate) fn record_success(
        &self,
        task_run_id: &str,
        snapshot: &StartupDiagnosticSnapshot,
    ) -> bool {
        if self.completed.load(Ordering::Acquire) {
            self.mark_incomplete();
            return false;
        }
        let captured = self.permit.record_success(task_run_id, snapshot);
        if captured {
            self.completed.store(true, Ordering::Release);
        } else {
            self.mark_incomplete();
        }
        captured
    }

    pub(crate) fn record_failure(
        &self,
        task_run_id: &str,
        issue: &atools_core::task_run::TaskIssue,
        error_observation: &Value,
    ) -> bool {
        if self.completed.swap(true, Ordering::AcqRel) {
            self.permit.mark_incomplete();
            return false;
        }
        let captured = self
            .permit
            .record_failure(task_run_id, issue, error_observation);
        if !captured {
            self.permit.mark_incomplete();
        }
        captured
    }

    pub(crate) fn mark_incomplete(&self) {
        self.permit.mark_incomplete();
        self.completed.store(true, Ordering::Release);
    }
}

impl Drop for StartupAttemptGuard {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::Acquire) {
            self.permit.mark_incomplete();
            self.completed.store(true, Ordering::Release);
        }
    }
}

fn is_fixture_owner(owner: &str) -> bool {
    let mut parts = owner.split(':');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some("window"), Some("main"), Some(instance), None)
            if uuid::Uuid::parse_str(instance).is_ok()
    )
}

#[cfg(test)]
#[path = "native_node_startup_fixture_tests.rs"]
mod tests;
