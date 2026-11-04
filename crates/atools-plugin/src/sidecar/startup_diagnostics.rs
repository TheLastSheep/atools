use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::stdout_observation::{StartupStdoutReadObserver, StartupStdoutReadSnapshot};
use super::SidecarError;

const MAX_EVENTS: usize = 12;
const MAX_SNAPSHOT_BYTES: usize = 2048;
const MAX_HASHED_STDERR_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupPhase {
    NodeResolveStarted,
    NodeResolved,
    NodeResolveFailed,
    SidecarSpawned,
    SidecarRunning,
    InitializeRequestWritten,
    FirstStdoutParsed,
    InitializeResponseMatched,
    InitializeCompleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupParseOutcome {
    Parsed,
    InvalidJson,
    Oversized,
    ReadError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupResponseOutcome {
    Result,
    RemoteError,
    Malformed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupFailureKind {
    NodeResolve,
    NodeSpawn,
    WaitUntilRunning,
    InitializeWrite,
    InitializeResponse,
    StartupProtocol,
    StartupCrashed,
}

pub(crate) fn classify_initialize_startup_failure(
    error: &SidecarError,
    trace: &StartupTrace,
    process_status: StartupProcessStatus,
) -> StartupFailureKind {
    if trace.initialize_write_failed() {
        return StartupFailureKind::InitializeWrite;
    }
    match error {
        SidecarError::Timeout(_) => StartupFailureKind::InitializeResponse,
        SidecarError::Crashed(_) => StartupFailureKind::StartupCrashed,
        SidecarError::NotRunning
            if process_status == StartupProcessStatus::Crashed
                || trace.child_termination_observed() =>
        {
            StartupFailureKind::StartupCrashed
        }
        _ => StartupFailureKind::StartupProtocol,
    }
}

pub(crate) fn classify_wait_until_running_failure(
    error: &SidecarError,
    process_status: StartupProcessStatus,
    child_termination_observed: bool,
) -> StartupFailureKind {
    match error {
        SidecarError::Timeout(_) => StartupFailureKind::WaitUntilRunning,
        SidecarError::Crashed(_) => StartupFailureKind::StartupCrashed,
        SidecarError::NotRunning
            if process_status == StartupProcessStatus::Crashed || child_termination_observed =>
        {
            StartupFailureKind::StartupCrashed
        }
        _ => StartupFailureKind::StartupProtocol,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupResolutionSource {
    SharedProductionResolver,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupVersionSource {
    InitializeResponse,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupProcessStatus {
    Starting,
    Running,
    Stopped,
    Crashed,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "exit_code")]
pub enum StartupTryWait {
    Unobserved,
    Running,
    Exited(Option<i32>),
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StartupEvent {
    pub phase: StartupPhase,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_written: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_outcome: Option<StartupParseOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_outcome: Option<StartupResponseOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StartupDiagnosticSnapshot {
    pub schema_version: u8,
    pub elapsed_ms: u64,
    pub events: Vec<StartupEvent>,
    pub resolution_source: Option<StartupResolutionSource>,
    pub selected_executable_path_sha256: Option<String>,
    pub node_version: Option<String>,
    pub node_version_source: StartupVersionSource,
    pub owned_pid: Option<u32>,
    pub sidecar_status: StartupProcessStatus,
    pub last_try_wait: StartupTryWait,
    pub last_try_wait_elapsed_ms: Option<u64>,
    pub stderr_bytes: u64,
    pub stderr_hashed_bytes: u64,
    pub stderr_sha256: Option<String>,
    pub stderr_truncated: bool,
    pub stdout_read: StartupStdoutReadSnapshot,
    pub cleanup_required: bool,
    pub cleanup_completed: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StartupFailureDiagnostic {
    pub schema_version: u8,
    pub failure: StartupFailureKind,
    pub snapshot: StartupDiagnosticSnapshot,
}

struct TraceState {
    events: Vec<StartupEvent>,
    last_try_wait: StartupTryWait,
    last_try_wait_elapsed_ms: Option<u64>,
    stderr_bytes: u64,
    stderr_hashed_bytes: u64,
    stderr_hasher: Sha256,
    sealed_elapsed_ms: Option<u64>,
    cleanup_observed: Option<bool>,
    resolution_source: Option<StartupResolutionSource>,
    selected_executable_path_sha256: Option<String>,
    node_version: Option<String>,
    node_version_source: StartupVersionSource,
    sealed: bool,
}

pub(crate) struct StartupTrace {
    started: Instant,
    sealed_fast: AtomicBool,
    initialize_write_failed: AtomicBool,
    stdout_read_observer: Arc<StartupStdoutReadObserver>,
    state: Mutex<TraceState>,
}

impl StartupTrace {
    #[cfg(feature = "native-smoke")]
    pub(crate) fn new() -> Self {
        Self {
            started: Instant::now(),
            sealed_fast: AtomicBool::new(false),
            initialize_write_failed: AtomicBool::new(false),
            stdout_read_observer: Arc::new(StartupStdoutReadObserver::new()),
            state: Mutex::new(TraceState {
                events: Vec::with_capacity(MAX_EVENTS),
                last_try_wait: StartupTryWait::Unobserved,
                last_try_wait_elapsed_ms: None,
                stderr_bytes: 0,
                stderr_hashed_bytes: 0,
                stderr_hasher: Sha256::new(),
                sealed_elapsed_ms: None,
                cleanup_observed: None,
                resolution_source: None,
                selected_executable_path_sha256: None,
                node_version: None,
                node_version_source: StartupVersionSource::Unavailable,
                sealed: false,
            }),
        }
    }

    pub(crate) fn record(
        &self,
        phase: StartupPhase,
        request_id: Option<u64>,
        bytes_written: Option<u64>,
    ) {
        self.record_event(StartupEvent {
            phase,
            elapsed_ms: 0,
            request_id,
            bytes_written,
            parse_outcome: None,
            response_outcome: None,
        });
    }

    pub(crate) fn record_first_stdout(&self, outcome: StartupParseOutcome) {
        self.record_event(StartupEvent {
            phase: StartupPhase::FirstStdoutParsed,
            elapsed_ms: 0,
            request_id: None,
            bytes_written: None,
            parse_outcome: Some(outcome),
            response_outcome: None,
        });
    }

    pub(crate) fn record_selected_executable_path(&self, path: &Path) {
        if self.sealed_fast.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if !state.sealed {
                state.resolution_source = Some(StartupResolutionSource::SharedProductionResolver);
                state.selected_executable_path_sha256 = Some(format!(
                    "{:x}",
                    Sha256::digest(path_fingerprint_bytes(path))
                ));
            }
        }
    }

    pub(crate) fn record_node_version(&self, candidate: Option<&str>) {
        if self.sealed_fast.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if state.sealed {
                return;
            }
            state.node_version = candidate
                .filter(|version| is_strict_node_version(version))
                .map(str::to_owned);
            state.node_version_source = if state.node_version.is_some() {
                StartupVersionSource::InitializeResponse
            } else {
                StartupVersionSource::Unavailable
            };
        }
    }

    pub(crate) fn record_initialize_response(
        &self,
        request_id: u64,
        outcome: StartupResponseOutcome,
    ) {
        self.record_event(StartupEvent {
            phase: StartupPhase::InitializeResponseMatched,
            elapsed_ms: 0,
            request_id: Some(request_id),
            bytes_written: None,
            parse_outcome: None,
            response_outcome: Some(outcome),
        });
    }

    pub(crate) fn record_initialize_write_failure(&self) {
        self.initialize_write_failed.store(true, Ordering::Release);
    }

    pub(crate) fn initialize_write_failed(&self) -> bool {
        self.initialize_write_failed.load(Ordering::Acquire)
    }

    pub(crate) fn stdout_read_observer(&self) -> Arc<StartupStdoutReadObserver> {
        self.stdout_read_observer.clone()
    }

    pub(crate) fn child_termination_observed(&self) -> bool {
        self.state
            .lock()
            .map(|state| {
                matches!(
                    state.last_try_wait,
                    StartupTryWait::Exited(_) | StartupTryWait::Failed
                )
            })
            .unwrap_or(false)
    }

    fn record_event(&self, mut event: StartupEvent) {
        if self.sealed_fast.load(Ordering::Acquire) {
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.sealed || state.events.len() >= MAX_EVENTS {
            return;
        }
        if state.events.iter().any(|item| item.phase == event.phase) {
            return;
        }
        // Sample under the insertion lock so concurrent callbacks cannot
        // append timestamps out of order.
        event.elapsed_ms = self.elapsed_ms();
        state.events.push(event);
    }

    pub(crate) fn record_stderr(&self, bytes: &[u8]) {
        if self.sealed_fast.load(Ordering::Acquire) {
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.sealed {
            return;
        }
        state.stderr_bytes = state.stderr_bytes.saturating_add(bytes.len() as u64);
        let remaining = MAX_HASHED_STDERR_BYTES.saturating_sub(state.stderr_hashed_bytes);
        let take = remaining.min(bytes.len() as u64) as usize;
        if take > 0 {
            state.stderr_hasher.update(&bytes[..take]);
            state.stderr_hashed_bytes += take as u64;
        }
    }

    pub(crate) fn record_try_wait(&self, observation: StartupTryWait) {
        if self.sealed_fast.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if !state.sealed {
                state.last_try_wait = observation;
                state.last_try_wait_elapsed_ms = Some(self.elapsed_ms());
            }
        }
    }

    pub(crate) fn seal(&self) {
        if let Ok(mut state) = self.state.lock() {
            if !state.sealed {
                state.sealed_elapsed_ms = Some(self.elapsed_ms());
                state.sealed = true;
                self.sealed_fast.store(true, Ordering::Release);
                self.stdout_read_observer.seal();
            }
        }
    }

    pub(crate) fn record_cleanup_completed(&self, completed: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.cleanup_observed = Some(completed);
        }
    }

    #[cfg(all(test, feature = "native-smoke"))]
    pub(crate) fn has_phase(&self, phase: StartupPhase) -> bool {
        self.state
            .lock()
            .map(|state| state.events.iter().any(|event| event.phase == phase))
            .unwrap_or(false)
    }

    pub(crate) fn snapshot(
        &self,
        owned_pid: Option<u32>,
        sidecar_status: StartupProcessStatus,
        cleanup_required: bool,
    ) -> StartupDiagnosticSnapshot {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let digest = if state.stderr_hashed_bytes == 0 {
            None
        } else {
            Some(format!("{:x}", state.stderr_hasher.clone().finalize()))
        };
        let snapshot = StartupDiagnosticSnapshot {
            schema_version: 1,
            elapsed_ms: state.sealed_elapsed_ms.unwrap_or_else(|| self.elapsed_ms()),
            events: state.events.clone(),
            resolution_source: state.resolution_source,
            selected_executable_path_sha256: state.selected_executable_path_sha256.clone(),
            node_version: state.node_version.clone(),
            node_version_source: state.node_version_source,
            owned_pid,
            sidecar_status,
            last_try_wait: state.last_try_wait,
            last_try_wait_elapsed_ms: state.last_try_wait_elapsed_ms,
            stderr_bytes: state.stderr_bytes,
            stderr_hashed_bytes: state.stderr_hashed_bytes,
            stderr_sha256: digest,
            stderr_truncated: state.stderr_bytes > state.stderr_hashed_bytes,
            stdout_read: self.stdout_read_observer.snapshot(),
            cleanup_required,
            cleanup_completed: cleanup_required.then_some(state.cleanup_observed).flatten(),
        };
        assert!(serde_json::to_vec(&snapshot)
            .map(|bytes| bytes.len() <= MAX_SNAPSHOT_BYTES)
            .unwrap_or(false));
        snapshot
    }

    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
}

fn is_strict_node_version(version: &str) -> bool {
    version.len() <= 24
        && version.split('.').count() == 3
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(unix)]
fn path_fingerprint_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn path_fingerprint_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn path_fingerprint_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().as_bytes().to_vec()
}
