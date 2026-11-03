//! Real opening/install/reuse/Destroyed helpers with a controlled creator barrier, without an OS App.
use super::*;
use crate::updater::{
    archive::VerifiedArchive, UpdateBackend, UpdateCommandError, UpdateMetadata, UpdateProgress,
};
struct Port;
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
        panic!("check only")
    }
    async fn apply_archive(&self, _: Arc<VerifiedArchive>) -> Result<(), UpdateCommandError> {
        panic!("check only")
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        panic!("check only")
    }
}
fn session(candidate: &str) -> runtime::Session {
    runtime::Session::new(
        "a".repeat(32),
        Arc::new(bundle::Bundle {
            assets: Default::default(),
        }),
        true,
        candidate.into(),
    )
}
#[tokio::test]
async fn r79_review_created_before_final_display_cannot_be_promoted_by_b_and_pin_waits_destroyed() {
    let state = crate::updater::UpdateCoordinator::default();
    let candidate = state.check(&Port).await.unwrap().unwrap();
    let rt = Arc::new(runtime::Runtime::default());
    let mut s = session(&candidate.candidate_id);
    s.presentation = Some(
        state
            .reserve_presentation(&s.id, &candidate.candidate_id)
            .await
            .unwrap(),
    );
    let created = Arc::new(std::sync::Barrier::new(2));
    let resume = Arc::new(std::sync::Barrier::new(2));
    let creator = {
        let rt = rt.clone();
        let s = s.clone();
        let created = created.clone();
        let resume = resume.clone();
        std::thread::spawn(move || {
            let opening = rt.reserve_opening().unwrap();
            opening.install(s.clone()).unwrap();
            created.wait();
            resume.wait();
            // A's final grant is denied: the existing production failure path revokes before Native destroy.
            rt.invalidate(&s.id);
            drop(opening);
        })
    };
    created.wait();
    assert!(rt.reusable_session().is_err());
    assert!(!s.presented.load(Ordering::Acquire));
    assert!(state
        .reserve_presentation("b", &candidate.candidate_id)
        .await
        .is_err());
    resume.wait();
    creator.join().unwrap();
    assert!(rt.reusable_session().is_err());
    assert!(rt.session.lock().is_some());
    assert!(state
        .reserve_presentation("b", &candidate.candidate_id)
        .await
        .is_err());
    rt.destroyed(&s.id);
    assert!(rt.session.lock().is_none());
    assert!(s.destroyed.load(Ordering::Acquire));
    let next = state
        .reserve_presentation("b", &candidate.candidate_id)
        .await
        .unwrap();
    rt.destroyed(&s.id);
    drop(next);
}
#[tokio::test]
async fn r79_review_committed_global_window_reuses_while_core_gate_is_held() {
    let state = crate::updater::UpdateCoordinator::default();
    let candidate = state.check(&Port).await.unwrap().unwrap();
    let rt = Arc::new(runtime::Runtime::default());
    let s = session(&candidate.candidate_id);
    let opening = rt.reserve_opening().unwrap();
    opening.install(s.clone()).unwrap();
    // Same flag set only after successful main-thread display/focus by production display.rs.
    s.presented.store(true, Ordering::Release);
    assert!(rt.reusable_session().is_err());
    drop(opening);
    let permit = state.reserve_window_close().unwrap();
    assert_eq!(rt.reusable_session().unwrap().unwrap().id, s.id);
    drop(permit);
    rt.destroyed(&s.id);
}
