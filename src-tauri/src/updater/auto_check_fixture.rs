//! Passive owned-About-only data. No renderer invoke command or timer/permission control.
use super::*;
impl Scheduler {
    pub(crate) fn about_fixture_snapshot(
        &self,
        app: &AppHandle,
    ) -> Result<serde_json::Value, String> {
        if !crate::renderer_desktop_smoke::updater_journey::about_authorized(app) {
            return Err("about-runtime-capability-rejected".into());
        }
        let state = app
            .try_state::<UpdateCoordinator>()
            .ok_or("about-runtime-state-missing")?;
        if !std::ptr::eq(self, state.scheduler.as_ref()) {
            return Err("about-runtime-instance-rejected".into());
        }
        let p = self
            .policy
            .lock()
            .map_err(|_| "about-runtime-unavailable")?;
        Ok(
            serde_json::json!({"generation":p.generation,"initialized":p.initialized,"enabled":p.enabled,"stopped":p.stopped,"controllerStarted":self.started.load(Ordering::Acquire),"workerActive":self.active.load(Ordering::Acquire),"timerCount":null,"timerDirectlyObserved":false}),
        )
    }
}
