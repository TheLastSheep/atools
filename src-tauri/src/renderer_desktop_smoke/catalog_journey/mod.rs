mod commands;
mod driver;
mod factory;
mod protocol;
mod report;
mod schema;

use atools_core::Database;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Wry};

pub(in crate::renderer_desktop_smoke) use commands::{
    handler, handles, on_page_load, record_window_event,
};
pub(in crate::renderer_desktop_smoke) use protocol::Harness;

pub(in crate::renderer_desktop_smoke) struct Prepared {
    pub(in crate::renderer_desktop_smoke) source:
        crate::launcher_app_catalog_source::LauncherAppCatalogSource,
    pub(in crate::renderer_desktop_smoke) harness: Harness,
}

pub(in crate::renderer_desktop_smoke) fn prepare(
    profile: Arc<super::profile::Profile>,
    db: Arc<Database>,
) -> Result<Prepared, String> {
    let factory::Prepared {
        source,
        added_path,
        after_dispose_path,
        task_runs_before,
        history_before,
    } = factory::prepare(Arc::clone(&profile), Arc::clone(&db))?;
    let harness = Harness::new(
        profile,
        db,
        added_path,
        after_dispose_path,
        task_runs_before,
        history_before,
    );
    Ok(Prepared { source, harness })
}

pub(in crate::renderer_desktop_smoke) fn start(app: AppHandle<Wry>) {
    driver::start(app);
}

pub(in crate::renderer_desktop_smoke) fn snapshot(app: &AppHandle<Wry>) -> serde_json::Value {
    app.try_state::<Harness>()
        .map(|harness| harness.snapshot())
        .unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
