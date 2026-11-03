//! Shared-gate check admission preserves displayed and recovery candidates.
use super::*;
impl UpdateCoordinator {
    pub async fn check<B: UpdateBackend + ?Sized>(
        &self,
        backend: &B,
    ) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        let permit = self.operation_gate.lock().await;
        self.check_admitted(backend, &permit, None).await
    }
    pub(crate) async fn check_silent<B: UpdateBackend + ?Sized>(
        &self,
        backend: &B,
        generation: u64,
        authorize: impl FnOnce() -> bool,
    ) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        let permit = self
            .operation_gate
            .try_lock()
            .map_err(|_| failure("busy"))?;
        if !authorize() {
            return Err(failure("operation_interrupted"));
        }
        self.check_admitted(backend, &permit, Some(generation))
            .await
    }
    pub(crate) async fn check_about<B: UpdateBackend + ?Sized>(
        &self,
        backend: &B,
        authorize: impl FnOnce() -> bool,
    ) -> Result<Snapshot, UpdateCommandError> {
        let permit = self
            .operation_gate
            .try_lock()
            .map_err(|_| failure("busy"))?;
        self.ensure_running()?;
        if !authorize() {
            return Err(failure("forbidden_window"));
        }
        let candidate = self.check_admitted(backend, &permit, None).await?;
        let snapshot = self.view()?;
        if snapshot.candidate.as_ref().map(|m| &m.candidate_id)
            != candidate.as_ref().map(|m| &m.candidate_id)
        {
            return Err(failure("stale_candidate"));
        }
        Ok(snapshot)
    }
    async fn check_admitted<B: UpdateBackend + ?Sized>(
        &self,
        backend: &B,
        _permit: &tokio::sync::MutexGuard<'_, ()>,
        auto_generation: Option<u64>,
    ) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        self.ensure_running()?;
        self.lock_snapshot()?.auto_generation = auto_generation;
        {
            let s = self.lock_snapshot()?;
            if s.archive.is_some()
                || s.presentation.is_some()
                || matches!(
                    s.phase,
                    Phase::Downloaded
                        | Phase::InstallUnknown
                        | Phase::RestartPending
                        | Phase::Restarting
                )
            {
                return Ok(s
                    .cached
                    .as_ref()
                    .and_then(|v| v.as_ref())
                    .map(|v| v.as_ref().clone()));
            }
            if s.checked_at.is_some_and(|t| t.elapsed() < self.cache_ttl) {
                return Ok(s
                    .cached
                    .as_ref()
                    .and_then(|v| v.as_ref())
                    .map(|v| v.as_ref().clone()));
            }
        }
        {
            let mut s = self.lock_snapshot()?;
            s.operation = UpdateOperation::Checking;
            s.operation_id = None;
            s.last_error = None;
        }
        self.phase(Phase::Checking)?;
        let mut cleanup = OperationCleanup::new(&self.snapshot);
        let result = backend.check().await.and_then(normalize_update);
        self.ensure_running()?;
        match result {
            Ok(update) => {
                let mut update = update;
                if let Some(value) = &mut update {
                    value.candidate_id = uuid::Uuid::new_v4().simple().to_string();
                    value.validate_status_fields()?;
                    let bound = UpdateStatus {
                        operation: UpdateOperation::Idle,
                        update: Some(value.clone()),
                        checked: true,
                        last_error: None,
                    };
                    if let Err(e) = bound
                        .validate_serialized_size()
                        .and_then(|_| crate::updater::snapshot::validate_candidate(value))
                    {
                        let e = self.error(e, Phase::Error);
                        cleanup.complete();
                        return Err(e);
                    }
                }
                let available = update.is_some();
                {
                    let mut s = self.lock_snapshot()?;
                    s.cached = Some(update.clone().map(Arc::new));
                    s.archive = None;
                    s.operation = UpdateOperation::Idle;
                    s.checked_at = Some(Instant::now());
                    s.last_error = None;
                    s.operation_id = None;
                    s.progress = Progress::default();
                }
                self.phase(if available {
                    Phase::Available
                } else {
                    Phase::NotAvailable
                })?;
                cleanup.complete();
                Ok(update)
            }
            Err(e) => {
                let e = self.error(e, Phase::Error);
                cleanup.complete();
                Err(e)
            }
        }
    }
}
