//! Feature-only finite Native updater witness. No ordinary startup enables it.
#[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
mod about;
mod assets;
mod commands;
mod control;
mod driver;
mod probe;
mod state;

pub(super) use commands::{handler, handles, on_page_load, on_window_event};
pub(crate) use control::Control;
pub(super) fn start(app: tauri::AppHandle) {
    #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
    if about_authorized(&app) {
        about::start(app);
        return;
    }
    driver::start(app)
}
pub(super) use state::Harness;
pub(crate) use state::{authorized, capability};

pub(super) struct MainRole(String);
pub(super) fn bind_main(
    profile: &super::profile::Profile,
    assets: &super::assets::RendererAssets,
) -> Result<Option<MainRole>, String> {
    if !profile.updater_journey {
        return Ok(None);
    }
    assets::verify(assets)?;
    Ok(Some(MainRole(profile.run_id.clone())))
}
pub(super) fn prepare(
    profile: std::sync::Arc<super::profile::Profile>,
    db: std::sync::Arc<atools_core::Database>,
    role: Option<MainRole>,
) -> Result<Option<Harness>, String> {
    if !profile.updater_journey {
        return Ok(None);
    }
    if role.is_none_or(|r| r.0 != profile.run_id) {
        return Err("updater-main-role-not-bound".into());
    }
    Harness::new(profile, db).map(Some)
}

pub(crate) fn about_authorized(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    authorized(app)
        && app
            .try_state::<Harness>()
            .is_some_and(|h| h.profile.updater_about)
}
pub(super) fn seed_about(
    db: &atools_core::Database,
    profile: &super::profile::Profile,
) -> Result<(), String> {
    if !profile.updater_about {
        return Ok(());
    }
    db.set_setting("settings-general",&serde_json::json!({"autoCheckUpdate":false,"autoClear":"never","autoPaste":"off","autoBackToSearch":"never","theme":"dark","opacity":1.0,"showTrayIcon":false,"r79Unknown":{"runId":profile.run_id,"keep":["owned",7]}}).to_string()).map_err(|e|e.to_string())
}
pub(super) fn setup_about(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
    if about_authorized(app) {
        return about::setup(app);
    }
    Ok(())
}
