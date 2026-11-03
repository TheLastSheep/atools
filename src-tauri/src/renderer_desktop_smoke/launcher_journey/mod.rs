mod commands;
pub(in crate::renderer_desktop_smoke) mod evidence;
mod factory;
mod journey;
pub(in crate::renderer_desktop_smoke) mod process;
mod report;
mod schema;
mod state;

use atools_core::Database;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Webview, Wry};

pub(in crate::renderer_desktop_smoke) use commands::{handler, handles};
pub(in crate::renderer_desktop_smoke) use state::Harness;

pub(in crate::renderer_desktop_smoke) struct Prepared {
    pub(in crate::renderer_desktop_smoke) source:
        crate::launcher_app_catalog_source::LauncherAppCatalogSource,
    pub(in crate::renderer_desktop_smoke) harness: Harness,
}

pub(in crate::renderer_desktop_smoke) struct HiddenPrepared {
    pub(in crate::renderer_desktop_smoke) source:
        crate::launcher_app_catalog_source::LauncherAppCatalogSource,
    pub(in crate::renderer_desktop_smoke) first_path: String,
    pub(in crate::renderer_desktop_smoke) second_path: String,
    pub(in crate::renderer_desktop_smoke) fixture_valid: bool,
}

pub(in crate::renderer_desktop_smoke) fn prepare(
    profile: &super::profile::Profile,
    db: Arc<Database>,
) -> Result<Prepared, String> {
    let factory::Prepared {
        source,
        first_path,
        second_path,
        fixture_valid,
        errors,
        catalog,
    } = factory::prepare(profile, &db, false).map_err(str::to_owned)?;
    let harness = Harness::new(
        profile,
        db,
        first_path,
        second_path,
        fixture_valid,
        errors,
        catalog,
    );
    Ok(Prepared { source, harness })
}

pub(in crate::renderer_desktop_smoke) fn prepare_hidden(
    profile: &super::profile::Profile,
    db: &Database,
) -> Result<HiddenPrepared, String> {
    let factory::Prepared {
        source,
        first_path,
        second_path,
        fixture_valid,
        errors,
        catalog,
    } = factory::prepare(profile, db, true).map_err(str::to_owned)?;
    if !fixture_valid || !errors.is_empty() || catalog.item_count != 2 || !catalog.confined {
        return Err("launch-return-owned-fixture-not-verified".to_owned());
    }
    Ok(HiddenPrepared {
        source,
        first_path,
        second_path,
        fixture_valid,
    })
}

pub(in crate::renderer_desktop_smoke) fn inject(
    webview: &Webview<Wry>,
    harness: &Harness,
) -> Result<(), &'static str> {
    let token =
        serde_json::to_string(harness.token()).map_err(|_| "launcher-renderer-probe-not-ready")?;
    let script = include_str!("probe.js").replace("\"__ATOOLS_RENDERER_LAUNCHER_TOKEN__\"", &token);
    webview
        .eval(script)
        .map_err(|_| "launcher-renderer-probe-not-ready")
}

pub(in crate::renderer_desktop_smoke) async fn run(app: &AppHandle<Wry>) {
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    journey::run(app, &harness).await;
}

pub(in crate::renderer_desktop_smoke) fn snapshot(app: &AppHandle<Wry>) -> serde_json::Value {
    app.try_state::<Harness>()
        .map(|state| (*state).snapshot())
        .unwrap_or_else(|| serde_json::Value::Null)
}
