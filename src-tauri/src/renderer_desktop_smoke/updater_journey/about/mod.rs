//! Single owned updater Harness, explicit About submode, no second profile/capability.
mod auth;
mod driver;
mod facts;
mod observe;
mod probe;
mod protocol;
mod state;
mod validate;
use super::Harness;
pub(super) use observe::{dispatch, handles, on_page_load, on_window_event};
pub(super) use state::State;
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Manager};
pub(super) fn state(h: &Harness) -> Result<&State, String> {
    h.about
        .as_deref()
        .ok_or_else(|| "about-mode-required".into())
}
pub(super) fn setup(app: &AppHandle) -> Result<(), String> {
    if !super::about_authorized(app) {
        return Err("about-capability-rejected".into());
    }
    let h = app.state::<Harness>();
    h.verify(app)?;
    let raw =
        h.db.get_setting("settings-general")
            .map_err(|_| "about-general-unavailable")?;
    crate::renderer_window_material::install_original_fixture(app, raw.as_deref())?;
    crate::renderer_settings_view::presentation::install_owned_about_hidden(app)
}
pub(super) fn start(app: AppHandle) {
    driver::start(app)
}

#[cfg(test)]
mod compatibility_tests {
    #[test]
    fn original_popup_stages_are_not_about_success_proof() {
        assert_eq!(
            super::super::state::STAGES,
            &[
                "main-ready",
                "main-check",
                "popup-ready",
                "popup-busy",
                "popup-error",
                "popup-disposed",
                "main-disposed"
            ]
        );
        assert_eq!(super::state::STAGES.len(), 11);
        assert!(super::auth::role("settings-closed").is_none());
        assert!(super::auth::role("settings-final-closed").is_none());
    }
}
