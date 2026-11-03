//! Compile-time opt-in backend; selecting it requires the owned native journey capability.
use super::{archive::VerifiedArchive, model::*};
use std::sync::{atomic::Ordering, Arc};

pub(super) struct Backend(Arc<crate::renderer_desktop_smoke::updater_journey::Control>);
pub(super) fn select(app: &tauri::AppHandle) -> Result<Option<Backend>, UpdateCommandError> {
    crate::renderer_desktop_smoke::updater_journey::capability(app)
        .map(|c| c.map(Backend))
        .map_err(|_| UpdateCommandError::new("provider_disabled", "隔离更新能力无效"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn fixed_fixture_download_can_only_end_as_explicit_error() {
        let control = Arc::new(crate::renderer_desktop_smoke::updater_journey::Control::default());
        let backend = Backend(control.clone());
        let candidate = backend.check().await.unwrap().unwrap();
        assert_eq!(candidate.version, "99.78.0");
        assert!(candidate.prepared.is_none());
        control.release_for_test();
        let result = backend
            .download_archive(
                &candidate,
                Box::new(|p| {
                    assert_eq!(p.downloaded, 50);
                    assert_eq!(p.total, Some(100));
                }),
            )
            .await;
        assert!(matches!(result,Err(error) if error.code=="download_failed"));
        assert_eq!(control.downloads.load(Ordering::Acquire), 1);
        assert_eq!(control.installs.load(Ordering::Acquire), 0);
        assert_eq!(control.applies.load(Ordering::Acquire), 0);
        assert_eq!(control.restarts.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn actual_coordinator_holds_busy_until_fixture_fails_and_keeps_no_archive() {
        let control = Arc::new(crate::renderer_desktop_smoke::updater_journey::Control::default());
        let backend = Backend(control.clone());
        let coordinator = super::super::UpdateCoordinator::default();
        let candidate = coordinator.check(&backend).await.unwrap().unwrap();
        let worker_state = coordinator.clone();
        let id = candidate.candidate_id.clone();
        let version = candidate.version.clone();
        let worker = tokio::spawn(async move {
            worker_state
                .confirm(&backend, &version, &id, false, || true, |_| {})
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while control.downloads.load(Ordering::Acquire) != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            coordinator.reserve_window_close().err().unwrap().code,
            "busy"
        );
        assert_eq!(
            coordinator.view().unwrap().phase,
            super::super::snapshot::Phase::Downloading
        );
        control.release_for_test();
        assert_eq!(worker.await.unwrap().unwrap_err().code, "download_failed");
        assert!(!coordinator.operation_busy());
        assert!(coordinator.reserve_window_close().is_ok());
        let backend = Backend(control.clone());
        let result = coordinator
            .confirm(
                &backend,
                &candidate.version,
                &candidate.candidate_id,
                true,
                || true,
                |_| {},
            )
            .await;
        assert_eq!(result.unwrap_err().code, "not_downloaded");
        assert_eq!(control.downloads.load(Ordering::Acquire), 1);
        assert_eq!(control.applies.load(Ordering::Acquire), 0);
        assert_eq!(control.restarts.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn actual_fixed_backend_terminal_error_retires_operation_ownership() {
        let control = Arc::new(crate::renderer_desktop_smoke::updater_journey::Control::default());
        let backend = Backend(control.clone());
        let coordinator = super::super::UpdateCoordinator::default();
        let candidate = coordinator.check(&backend).await.unwrap().unwrap();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = events.clone();
        coordinator.bind_notifier(Arc::new(move |snapshot, _| {
            observed.lock().unwrap().push(snapshot)
        }));
        let worker_state = coordinator.clone();
        let worker = tokio::spawn(async move {
            worker_state
                .confirm(
                    &backend,
                    &candidate.version,
                    &candidate.candidate_id,
                    false,
                    || true,
                    |_| {},
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while control.downloads.load(Ordering::Acquire) != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let busy = coordinator.view().unwrap();
        assert!(busy.operation_id.is_some());
        assert!(coordinator.operation_busy());
        control.release_for_test();
        assert_eq!(worker.await.unwrap().unwrap_err().code, "download_failed");
        let terminal = coordinator.view().unwrap();
        let can_close = coordinator.reserve_window_close().is_ok();
        assert!(can_close);
        assert!(!coordinator.operation_busy());
        assert_eq!(terminal.phase, super::super::snapshot::Phase::Error);
        println!(
            "OPERATION_OWNERSHIP_OBSERVATION {}",
            serde_json::json!({"during":busy,"terminal":terminal,"realGateCanClose":can_close,"events":*events.lock().unwrap()})
        );
        assert!(terminal.operation_id.is_none(),"actual worker finished and the real gate is free; authoritative operationId must retire");
        let events = events.lock().unwrap();
        let settled = events.last().unwrap();
        assert!(settled.operation_id.is_none());
        assert!(settled.sequence > busy.sequence);
    }
}
fn denied() -> UpdateCommandError {
    UpdateCommandError::new("provider_disabled", "隔离实例禁止安装与重启")
}
#[async_trait::async_trait]
impl UpdateBackend for Backend {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        self.0.checks.fetch_add(1, Ordering::AcqRel);
        Ok(Some(UpdateMetadata {
            candidate_id: String::new(),
            prepared: None,
            current_version: "0.0.0".into(),
            version: "99.78.0".into(),
            date: None,
            body: Some(
                "# Native popup fixture\n\nOffline candidate; no SDK download or installation."
                    .into(),
            ),
        }))
    }
    async fn download_archive(
        &self,
        _metadata: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<VerifiedArchive, UpdateCommandError> {
        let _active = self.0.begin();
        progress(UpdateProgress {
            event: "downloading".into(),
            downloaded: 50,
            total: Some(100),
        });
        self.0.wait_release().await;
        Err(UpdateCommandError::new(
            "download_failed",
            "隔离夹具按计划终止下载",
        ))
    }
    async fn install(
        &self,
        _metadata: &UpdateMetadata,
        _progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        self.0.installs.fetch_add(1, Ordering::AcqRel);
        Err(denied())
    }
    async fn apply_archive(
        &self,
        _archive: Arc<VerifiedArchive>,
    ) -> Result<(), UpdateCommandError> {
        self.0.applies.fetch_add(1, Ordering::AcqRel);
        Err(denied())
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        self.0.restarts.fetch_add(1, Ordering::AcqRel);
        Err(denied())
    }
}
