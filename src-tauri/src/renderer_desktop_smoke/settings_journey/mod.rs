mod journey;
mod native;
mod preference_schema;
mod preferences;
mod probe;
mod report;
mod schema;
mod state;

use atools_core::Database;
use serde_json::json;
use tauri::{AppHandle, Manager, Wry};

pub(super) use state::{handler, handles, Harness};

pub(super) fn seed_fixture(db: &Database, auto_clear: &str) -> Result<(), String> {
    let fake_terminal = format!(
        "ATools-Fake-Terminal-Command-Do-Not-Expose{}",
        "x".repeat(5 * 1024)
    );
    let value = json!({
        "theme": "dark",
        "primaryColor": "blue",
        "customColor": "#db2777",
        "autoClear": auto_clear,
        "autoPaste": "3s",
        "placeholder": "atools-native-settings-initial",
        "showRecentInSearch": false,
        "recentRows": 2,
        "pinnedRows": 2,
        "searchMode": "list",
        "showMatchRecommendation": true,
        "tabKeyFunction": "navigate",
        "spaceOpenCommand": false,
        "opacity": 1.0,
        "windowDefaultHeight": 2001,
        "tabTargetCommand": "x".repeat(2049),
        "terminalCustomCommand": fake_terminal,
        "proxyUrl": "ATools-Fake-Proxy-URL-Do-Not-Expose",
        "aiApiKey": "ATools-Fake-AI-Secret-Do-Not-Expose",
        "webdavPassword": "ATools-Fake-WebDAV-Password-Do-Not-Expose",
        "unknownNested": {
            "marker": "ATools-Fake-Unknown-Nested-Secret-Do-Not-Expose",
            "metadata": {"source": "native-settings-fixture", "version": 1}
        }
    });
    db.set_setting("settings-general", &value.to_string())
        .map_err(|error| format!("seed private General settings fixture: {error}"))
}

pub(super) async fn run(app: &AppHandle<Wry>) {
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    if !harness.enabled() {
        return;
    }
    if let Err(error) = journey::run(app, &harness).await {
        harness.record_error(error);
        crate::renderer_settings_view::stop(app);
        let _ = native::wait_for_closed_session(app).await;
    }
    harness.set_cleanup(app);
}

pub(super) fn snapshot(app: &AppHandle<Wry>) -> serde_json::Value {
    app.try_state::<Harness>()
        .map(|state| (*state).snapshot())
        .unwrap_or_else(Harness::unavailable_report)
}
