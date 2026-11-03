//! Actual manager selection/display helper path, with a controlled lookup barrier and no OS App.
use super::*;
use crate::updater::{
    archive::VerifiedArchive, UpdateBackend, UpdateCommandError, UpdateMetadata, UpdateProgress,
};
use std::sync::atomic::AtomicUsize;
#[derive(Default)]
struct Port {
    started: Option<Arc<tokio::sync::Notify>>,
    release: Option<Arc<tokio::sync::Notify>>,
}
#[async_trait::async_trait]
impl UpdateBackend for Port {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        Ok(Some(UpdateMetadata::test_candidate()))
    }
    async fn install(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        panic!("check only")
    }
    async fn download_archive(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<VerifiedArchive, UpdateCommandError> {
        let Some(started) = &self.started else {
            panic!("check only")
        };
        started.notify_one();
        self.release.as_ref().unwrap().notified().await;
        Err(error("download_failed"))
    }
    async fn apply_archive(&self, _: Arc<VerifiedArchive>) -> Result<(), UpdateCommandError> {
        panic!("check only")
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        panic!("check only")
    }
}
#[tokio::test]
async fn r79_tail_red_a_entry_passes_then_b_existing_window_cannot_be_focused() {
    let state = crate::updater::UpdateCoordinator::uncached_for_presentation_test();
    let a = state
        .check_about(&Port::default(), || true)
        .await
        .unwrap()
        .candidate
        .unwrap();
    let runtime = Arc::new(runtime::Runtime::default());
    let initial = Arc::new(std::sync::Barrier::new(2));
    let lookup = Arc::new(std::sync::Barrier::new(2));
    let calls = Arc::new(AtomicUsize::new(0));
    let worker = {
        let state = state.clone();
        let runtime = runtime.clone();
        let initial = initial.clone();
        let lookup = lookup.clone();
        let calls = calls.clone();
        let id = a.candidate_id.clone();
        std::thread::spawn(move || {
            // Same actual initial selector and existing branch used by manager::show_owned.
            let captured =
                super::super::expected_candidate(&state.view().unwrap(), Some(&id)).unwrap();
            initial.wait();
            lookup.wait();
            let result = existing(&runtime, &state, &captured.candidate_id);
            if result.as_ref().ok().and_then(|s| s.as_ref()).is_some() {
                calls.fetch_add(1, Ordering::SeqCst);
            }
            result.err().map(|e| e.code)
        })
    };
    initial.wait();
    let b = state.check(&Port::default()).await.unwrap().unwrap();
    assert_ne!(a.candidate_id, b.candidate_id);
    let mut session = runtime::Session::new(
        "b".repeat(32),
        Arc::new(bundle::Bundle {
            assets: Default::default(),
        }),
        true,
        b.candidate_id.clone(),
    );
    session.presentation = Some(
        state
            .reserve_presentation(&session.id, &b.candidate_id)
            .await
            .unwrap(),
    );
    let opening = runtime.reserve_opening().unwrap();
    opening.install(session.clone()).unwrap();
    session.presented.store(true, Ordering::Release);
    drop(opening);
    lookup.wait();
    assert_eq!(worker.join().unwrap().as_deref(), Some("stale_candidate"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(admit(&runtime, &state, &session, &a.candidate_id).is_err());
    runtime.destroyed(&session.id);
}

#[tokio::test]
async fn r79_tail_valid_committed_busy_window_reuses_without_waiting_on_install_gate() {
    let state = crate::updater::UpdateCoordinator::uncached_for_presentation_test();
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let port = Port {
        started: Some(started.clone()),
        release: Some(release.clone()),
    };
    let candidate = state
        .check_about(&port, || true)
        .await
        .unwrap()
        .candidate
        .unwrap();
    let runtime = Arc::new(runtime::Runtime::default());
    let mut session = runtime::Session::new(
        "c".repeat(32),
        Arc::new(bundle::Bundle {
            assets: Default::default(),
        }),
        true,
        candidate.candidate_id.clone(),
    );
    session.presentation = Some(
        state
            .reserve_presentation(&session.id, &candidate.candidate_id)
            .await
            .unwrap(),
    );
    let opening = runtime.reserve_opening().unwrap();
    opening.install(session.clone()).unwrap();
    session.presented.store(true, Ordering::Release);
    drop(opening);
    let worker = {
        let state = state.clone();
        let candidate = candidate.clone();
        tokio::spawn(async move {
            state
                .confirm(
                    &port,
                    &candidate.version,
                    &candidate.candidate_id,
                    false,
                    || true,
                    |_| {},
                )
                .await
        })
    };
    started.notified().await;
    assert!(state.operation_busy());
    let existing = existing(&runtime, &state, &candidate.candidate_id)
        .unwrap()
        .unwrap();
    admit(&runtime, &state, &existing, &candidate.candidate_id).unwrap();
    release.notify_one();
    assert_eq!(worker.await.unwrap().err().unwrap().code, "download_failed");
    runtime.destroyed(&session.id);
}
