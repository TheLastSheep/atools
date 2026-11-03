pub(crate) mod archive;
pub(crate) mod auto_check;
mod auto_check_policy;
mod backend;
mod coordinator;
pub(crate) mod entry;
mod errors;
#[cfg(feature = "legacy-node-smoke")]
mod fixture;
mod model;
mod package_smoke;
mod provider_guard;
mod retained_candidate;
pub(crate) mod snapshot;
mod source;
pub(crate) use provider_guard::sdk_host_marker;
mod startup;

#[cfg(test)]
mod tests;

pub(crate) use coordinator::PresentationLease;
pub use coordinator::UpdateCoordinator;
pub use model::{
    UpdateBackend, UpdateCommandError, UpdateMetadata, UpdateOperation, UpdateProgress,
    UpdateStatus,
};
pub use package_smoke::start_package_smoke_if_requested;

use backend::TauriUpdateBackend;
use tauri::Manager;

// Label admission is only the first check; source::authorize also verifies the document.
fn ensure_updater_window(label: &str) -> Result<(), UpdateCommandError> {
    if matches!(label, "main" | "settings") {
        Ok(())
    } else {
        Err(coordinator::failure("forbidden_window"))
    }
}

#[tauri::command]
pub async fn check_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
    source::authorize(&window)?;
    crate::renderer_updater::initialize(window.app_handle())?;
    source::body(&request, &[])?;
    let backend = TauriUpdateBackend {
        app: window.app_handle().clone(),
    };
    state.check(&backend).await
}

#[tauri::command]
pub async fn install_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
    request: tauri::ipc::Request<'_>,
    expected_version: String,
    expected_candidate_id: String,
) -> Result<(), UpdateCommandError> {
    use tauri::Emitter;

    source::authorize(&window)?;
    crate::renderer_updater::initialize(window.app_handle())?;
    source::body(&request, &["expectedVersion", "expectedCandidateId"])?;
    let app = window.app_handle().clone();
    let coordinator = state.inner().clone();
    let principal = window.clone();
    // Detached owned operation survives a dropped IPC awaiter and retains its permit.
    tauri::async_runtime::spawn(async move {
        entry::confirm(
            &app.clone(),
            &coordinator,
            &expected_version,
            &expected_candidate_id,
            false,
            move || source::authorize(&principal).is_ok(),
            move |progress| {
                for label in ["main", "settings"] {
                    let _ = app.emit_to(
                        tauri::EventTarget::webview(label),
                        "app-update-progress",
                        &progress,
                    );
                }
            },
        )
        .await
    })
    .await
    .map_err(|_| UpdateCommandError::new("internal", "更新任务未完成"))?
}

#[tauri::command]
pub async fn get_app_update_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
    request: tauri::ipc::Request<'_>,
) -> Result<UpdateStatus, UpdateCommandError> {
    source::authorize(&window)?;
    crate::renderer_updater::initialize(window.app_handle())?;
    source::body(&request, &[])?;
    state.status().await
}

#[tauri::command]
pub async fn startup_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
    request: tauri::ipc::Request<'_>,
) -> Result<UpdateStatus, UpdateCommandError> {
    source::authorize(&window)?;
    crate::renderer_updater::initialize(window.app_handle())?;
    source::body(&request, &[])?;
    startup::register(window.app_handle(), state.inner());
    state.status().await
}
