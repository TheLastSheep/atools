//! One candidate, one permit and one retained verified archive, shared by every entry.
use super::{
    archive::VerifiedArchive,
    model::*,
    snapshot::{Notify, Phase, Progress, Snapshot},
};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
#[path = "check.rs"]
mod check;
#[path = "confirmation_lifecycle.rs"]
mod confirmation_lifecycle;
#[path = "manual_request.rs"]
mod manual_request;
#[path = "presentation.rs"]
mod presentation;
pub(crate) use presentation::PresentationLease;
struct CoordinatorSnapshot {
    operation: UpdateOperation,
    checked_at: Option<Instant>,
    cached: Option<Option<Arc<UpdateMetadata>>>,
    last_error: Option<Arc<UpdateCommandError>>,
    phase: Phase,
    archive: Option<Arc<VerifiedArchive>>,
    presentation: Option<(String, String)>,
    auto_generation: Option<u64>,
    progress: Progress,
    sequence: u64,
    operation_id: Option<String>,
}
#[derive(Clone)]
pub struct UpdateCoordinator {
    operation_gate: Arc<tokio::sync::Mutex<()>>,
    manual_request: Arc<std::sync::atomic::AtomicBool>,
    pub(super) scheduler: Arc<super::auto_check::Scheduler>,
    snapshot: Arc<Mutex<CoordinatorSnapshot>>,
    cache_ttl: Duration,
    notifier: Arc<Mutex<Option<Notify>>>,
    pub(crate) startup_registered: Arc<std::sync::atomic::AtomicBool>,
    stopped: Arc<std::sync::atomic::AtomicBool>,
}
impl Default for UpdateCoordinator {
    fn default() -> Self {
        Self {
            operation_gate: Arc::new(tokio::sync::Mutex::new(())),
            manual_request: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            scheduler: Arc::new(super::auto_check::Scheduler::default()),
            snapshot: Arc::new(Mutex::new(CoordinatorSnapshot {
                operation: UpdateOperation::Idle,
                checked_at: None,
                cached: None,
                last_error: None,
                phase: Phase::Idle,
                archive: None,
                presentation: None,
                auto_generation: None,
                progress: Progress::default(),
                sequence: 0,
                operation_id: None,
            })),
            cache_ttl: Duration::from_secs(10),
            notifier: Arc::new(Mutex::new(None)),
            startup_registered: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            stopped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}
impl UpdateCoordinator {
    fn lock_snapshot(&self) -> Result<MutexGuard<'_, CoordinatorSnapshot>, UpdateCommandError> {
        self.snapshot
            .lock()
            .map_err(|_| UpdateCommandError::new("state_unavailable", "更新状态当前不可读取"))
    }
    pub(crate) fn bind_notifier(&self, notify: Notify) {
        if let Ok(mut n) = self.notifier.lock() {
            *n = Some(notify)
        }
    }
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn operation_busy(&self) -> bool {
        self.operation_gate.try_lock().is_err()
            || self
                .lock_snapshot()
                .map_or(true, |s| s.phase == Phase::Restarting)
    }
    pub(crate) fn reserve_window_close(
        &self,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, UpdateCommandError> {
        let permit = self
            .operation_gate
            .clone()
            .try_lock_owned()
            .map_err(|_| failure("busy"))?;
        self.ensure_running()?;
        if self.lock_snapshot()?.phase == Phase::Restarting {
            return Err(failure("busy"));
        }
        Ok(permit)
    }
    pub(crate) fn shutdown(&self) {
        self.scheduler.stop();
        self.stopped
            .store(true, std::sync::atomic::Ordering::Release);
        if let Ok(mut n) = self.notifier.lock() {
            *n = None;
        }
        if let Ok(mut s) = self.snapshot.lock() {
            s.cached = None;
            s.archive = None;
        }
    }
    fn ensure_running(&self) -> Result<(), UpdateCommandError> {
        if self.stopped.load(std::sync::atomic::Ordering::Acquire) {
            Err(failure("operation_interrupted"))
        } else {
            Ok(())
        }
    }
    fn notify(&self, progress_only: bool) {
        if self.ensure_running().is_err() {
            return;
        }
        let notify = self.notifier.lock().ok().and_then(|n| n.clone());
        if let (Some(notify), Ok(snapshot)) = (notify, self.view()) {
            notify(snapshot, progress_only)
        }
    }
    /// Only obsolete automatic discovery hints are suppressed; popup and confirmation facts remain live.
    pub(crate) fn main_discovery_current(&self) -> bool {
        self.lock_snapshot().map_or(false, |s| {
            s.auto_generation.is_none_or(|g| self.scheduler.current(g))
        })
    }
    pub fn view(&self) -> Result<Snapshot, UpdateCommandError> {
        let s = self.lock_snapshot()?;
        let out = Snapshot {
            version: 1,
            sequence: s.sequence,
            phase: s.phase,
            candidate: s
                .cached
                .as_ref()
                .and_then(|v| v.as_ref())
                .map(|v| v.as_ref().clone()),
            checked: s.checked_at.is_some(),
            operation_id: s.operation_id.clone(),
            progress: s.progress.clone(),
            error: s.last_error.as_ref().map(|e| e.as_ref().clone()),
        };
        drop(s);
        if serde_json::to_vec(&out)
            .map_err(|_| failure("internal"))?
            .len()
            > 64 * 1024
        {
            return Err(failure("invalid_manifest"));
        }
        Ok(out)
    }
    fn phase(&self, phase: Phase) -> Result<(), UpdateCommandError> {
        let mut s = self.lock_snapshot()?;
        let sequence = confirmation_lifecycle::next_sequence(&s)?;
        s.phase = phase;
        s.sequence = sequence;
        drop(s);
        self.notify(false);
        Ok(())
    }
    fn error(&self, error: UpdateCommandError, phase: Phase) -> UpdateCommandError {
        let error = super::errors::normalize(error);
        if let Ok(mut s) = self.lock_snapshot() {
            s.operation = UpdateOperation::Idle;
            s.last_error = Some(Arc::new(error.clone()));
        }
        let _ = self.phase(phase);
        error
    }
    pub async fn install<B, F>(
        &self,
        backend: &B,
        expected_version: &str,
        expected_candidate_id: &str,
        progress: F,
    ) -> Result<(), UpdateCommandError>
    where
        B: UpdateBackend + Clone + Send + Sync + 'static,
        F: Fn(UpdateProgress) + Send + Sync + 'static,
    {
        let this = self.clone();
        let backend = backend.clone();
        let version = expected_version.to_owned();
        let id = expected_candidate_id.to_owned();
        tauri::async_runtime::spawn(async move {
            this.confirm(&backend, &version, &id, false, || true, progress)
                .await
        })
        .await
        .map_err(|_| failure("internal"))?
    }
    pub(crate) async fn confirm<B, F, G>(
        &self,
        backend: &B,
        expected_version: &str,
        id: &str,
        cache_only: bool,
        authorize: G,
        progress: F,
    ) -> Result<(), UpdateCommandError>
    where
        B: UpdateBackend + ?Sized,
        F: Fn(UpdateProgress) + Send + Sync + 'static,
        G: FnOnce() -> bool,
    {
        let permit = self
            .operation_gate
            .try_lock()
            .map_err(|_| failure("busy"))?;
        self.ensure_running()?;
        if !authorize() {
            return Err(failure("forbidden_window"));
        }
        let (candidate, archive, restart_only) = {
            let s = self.lock_snapshot()?;
            let candidate = s
                .cached
                .as_ref()
                .and_then(|v| v.clone())
                .ok_or_else(|| failure("no_update"))?;
            if candidate.version != expected_version {
                return Err(failure("version_mismatch"));
            }
            if candidate.candidate_id != id || !valid_id(id) {
                return Err(failure("stale_candidate"));
            }
            (
                candidate,
                s.archive.clone(),
                s.phase == Phase::RestartPending,
            )
        };
        if cache_only && archive.is_none() && !restart_only {
            return Err(failure("not_downloaded"));
        }
        self.lock_snapshot()?.auto_generation = None;
        let operation = confirmation_lifecycle::Confirmation::begin(self, permit, restart_only)?;
        let result = async {
            if restart_only {
                self.phase(Phase::Restarting)?;
                return self.restart(backend).await;
            }
            let archive = if let Some(archive) = archive {
                archive
            } else {
                if cache_only {
                    return Err(failure("not_downloaded"));
                }
                self.lock_snapshot()?.operation = UpdateOperation::Installing;
                self.phase(Phase::Downloading)?;
                let (invalid_progress, handler) = confirmation_lifecycle::progress(
                    self.clone(),
                    operation.id().to_owned(),
                    progress,
                );
                let download = backend.download_archive(&candidate, handler).await;
                if invalid_progress.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(self.error(failure("download_failed"), Phase::Error));
                }
                let archive = match download {
                    Ok(a) => Arc::new(a),
                    Err(e) => return Err(self.error(e, Phase::Error)),
                };
                if archive.candidate_id != id {
                    return Err(self.error(failure("stale_candidate"), Phase::Error));
                }
                {
                    self.lock_snapshot()?.archive = Some(archive.clone());
                }
                self.phase(Phase::Downloaded)?;
                archive
            };
            self.ensure_running()?;
            self.lock_snapshot()?.operation = UpdateOperation::Installing;
            self.phase(Phase::Installing)?;
            if let Err(error) = backend.apply_archive(archive).await {
                // These codes originate before Update.install. Never report an installation
                // attempt or retain the failed cache when byte/identity admission failed.
                if matches!(
                    error.code.as_str(),
                    "archive_integrity"
                        | "archive_too_large"
                        | "stale_candidate"
                        | "not_downloaded"
                ) {
                    self.lock_snapshot()?.archive = None;
                    return Err(self.error(error, Phase::Error));
                }
                return Err(self.error(failure("install_unknown"), Phase::InstallUnknown));
            }
            {
                let mut s = self.lock_snapshot()?;
                s.archive = None;
                s.operation = UpdateOperation::Restarting;
            }
            self.ensure_running()?;
            self.phase(Phase::Restarting)?;
            self.restart(backend).await
        }
        .await;
        operation.finish();
        result
    }
    async fn restart<B: UpdateBackend + ?Sized>(
        &self,
        backend: &B,
    ) -> Result<(), UpdateCommandError> {
        if backend.before_restart().await.is_err() {
            return Err(self.error(failure("restart_pending"), Phase::RestartPending));
        }
        match backend.restart() {
            Ok(()) => Ok(()),
            Err(_) => Err(self.error(failure("restart_pending"), Phase::RestartPending)),
        }
    }
    pub async fn status(&self) -> Result<UpdateStatus, UpdateCommandError> {
        let s = self.lock_snapshot()?;
        if let Some(m) = s.cached.as_ref().and_then(|v| v.as_ref()) {
            m.validate_status_fields()?;
        }
        if let Some(e) = s.last_error.as_ref() {
            e.validate_status_fields()?;
        }
        let out = UpdateStatus {
            operation: s.operation,
            update: s
                .cached
                .as_ref()
                .and_then(|v| v.as_ref())
                .map(|v| v.as_ref().clone()),
            checked: s.checked_at.is_some(),
            last_error: s.last_error.as_ref().map(|v| v.as_ref().clone()),
        };
        drop(s);
        out.validate_serialized_size()?;
        Ok(out)
    }
}
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn failure(code: &str) -> UpdateCommandError {
    super::errors::fixed(code)
}

struct OperationCleanup<'a> {
    snapshot: &'a Mutex<CoordinatorSnapshot>,
    active: bool,
}
impl<'a> OperationCleanup<'a> {
    fn new(snapshot: &'a Mutex<CoordinatorSnapshot>) -> Self {
        Self {
            snapshot,
            active: true,
        }
    }
    fn complete(&mut self) {
        self.active = false
    }
}
impl Drop for OperationCleanup<'_> {
    fn drop(&mut self) {
        if self.active {
            if let Ok(mut s) = self.snapshot.lock() {
                s.operation = UpdateOperation::Idle;
                s.phase = Phase::Error;
                s.checked_at = None;
                s.cached = None;
                s.last_error = Some(Arc::new(failure("operation_interrupted")));
            }
        }
    }
}
fn normalize_update(
    update: Option<UpdateMetadata>,
) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
    let Some(update) = update else {
        return Ok(None);
    };
    update.validate_status_fields()?;
    let current =
        semver::Version::parse(&update.current_version).map_err(|_| failure("invalid_manifest"))?;
    let available =
        semver::Version::parse(&update.version).map_err(|_| failure("invalid_manifest"))?;
    Ok((available > current).then_some(update))
}

#[cfg(test)]
#[path = "admission_tests.rs"]
mod admission_tests;

#[cfg(test)]
#[path = "check_protection_tests.rs"]
mod check_protection_tests;

#[cfg(test)]
#[path = "manual_request_tests.rs"]
mod manual_request_tests;

#[cfg(feature = "legacy-node-smoke")]
#[path = "about_fixture.rs"]
mod about_fixture;
