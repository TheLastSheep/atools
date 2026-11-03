//! Passive current-owned About snapshot, never a page-callable coordinator API.
use super::*;
use tauri::Manager;
impl UpdateCoordinator {
    pub(crate) fn about_fixture_snapshot(
        app: &tauri::AppHandle,
    ) -> Result<serde_json::Value, String> {
        if !crate::renderer_desktop_smoke::updater_journey::about_authorized(app) {
            return Err("about-runtime-capability-rejected".into());
        }
        let state = app
            .try_state::<Self>()
            .ok_or("about-runtime-state-missing")?;
        let scheduler = state.scheduler.about_fixture_snapshot(app)?;
        Ok(
            serde_json::json!({"scheduler":scheduler,"manualSlotCount":u8::from(state.manual_request.load(std::sync::atomic::Ordering::Acquire)),"schedulerDirectlyObserved":true,"manualSlotDirectlyObserved":true}),
        )
    }
}
