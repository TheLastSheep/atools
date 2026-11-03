use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use super::readiness::BootstrapCompletionGuard;

/// Load builtin metadata before exposing the initial plugin inventory.
/// Agent/background registry synchronization remains an independent startup task.
pub(crate) async fn load(
    app: AppHandle,
    builtin_plugins_dir: Option<PathBuf>,
    completion: BootstrapCompletionGuard,
) {
    let db = app.state::<crate::state::AppState>().inner().db.clone();
    if let Err(error) =
        crate::builtin_plugins::load_builtin_plugins(db.clone(), builtin_plugins_dir).await
    {
        tracing::error!("Failed to load builtin plugins: {error}");
        app.state::<crate::state::AppState>()
            .inner()
            .record_runtime_event("error", format!("Failed to load builtin plugins: {error}"));
        completion.complete(Err(error.to_string()));
        return;
    }

    complete_metadata_registration(&app, completion);

    if let Err(error) = crate::agent_tools::sync_plugin_tools(&db) {
        tracing::error!("Failed to sync plugin Agent tools: {error}");
        app.state::<crate::state::AppState>()
            .inner()
            .record_runtime_event(
                "error",
                format!("Failed to sync plugin Agent tools: {error}"),
            );
    } else {
        app.state::<crate::state::AppState>()
            .inner()
            .record_runtime_event("info", "Plugin Agent tools synced");
    }

    if let Err(error) = crate::plugin_background_runtime::registry::sync(&db) {
        tracing::error!("Failed to sync plugin background tools: {error}");
        app.state::<crate::state::AppState>()
            .inner()
            .record_runtime_event(
                "error",
                format!("Failed to sync plugin background tools: {error}"),
            );
    }

    let _ = app.emit("builtin-plugins-loaded", ());
}

/// Publish successfully registered metadata before independent startup syncs.
pub(crate) fn complete_metadata_registration(
    app: &AppHandle,
    completion: BootstrapCompletionGuard,
) {
    app.state::<crate::state::AppState>()
        .inner()
        .record_runtime_event("info", "Builtin plugins loaded");
    completion.complete(Ok(()));
    super::events::notify(app);
}
