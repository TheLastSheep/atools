//! Shared production provider entry, used by original popup and legacy commands.
use super::*;
pub(crate) async fn check(
    app: &tauri::AppHandle,
    state: &UpdateCoordinator,
) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
    #[cfg(feature = "legacy-node-smoke")]
    if let Some(backend) = fixture::select(app)? {
        return state.check(&backend).await;
    }
    state
        .check(&backend::TauriUpdateBackend { app: app.clone() })
        .await
}
pub(crate) fn startup(app: &tauri::AppHandle, state: &UpdateCoordinator) {
    startup::register(app, state)
}
pub(crate) async fn confirm<F, G>(
    app: &tauri::AppHandle,
    state: &UpdateCoordinator,
    version: &str,
    id: &str,
    cache_only: bool,
    authorize: G,
    progress: F,
) -> Result<(), UpdateCommandError>
where
    F: Fn(UpdateProgress) + Send + Sync + 'static,
    G: FnOnce() -> bool,
{
    #[cfg(feature = "legacy-node-smoke")]
    if let Some(backend) = fixture::select(app)? {
        return state
            .confirm(&backend, version, id, cache_only, authorize, progress)
            .await;
    }
    state
        .confirm(
            &backend::TauriUpdateBackend { app: app.clone() },
            version,
            id,
            cache_only,
            authorize,
            progress,
        )
        .await
}

pub(crate) fn valid_id(id: &str) -> bool {
    super::coordinator::valid_id(id)
}

/// Pure provider admission: never constructs an SDK provider or performs network I/O.
pub(super) fn provider_available(app: &tauri::AppHandle) -> Result<(), UpdateCommandError> {
    #[cfg(feature = "legacy-node-smoke")]
    if fixture::select(app)?.is_some() {
        return Ok(());
    }
    backend::ensure_network_allowed(app)
}
pub(super) async fn check_silent(
    app: &tauri::AppHandle,
    state: &UpdateCoordinator,
    generation: u64,
) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
    let authorize = || state.scheduler.current(generation);
    #[cfg(feature = "legacy-node-smoke")]
    if let Some(backend) = fixture::select(app)? {
        return state.check_silent(&backend, generation, authorize).await;
    }
    state
        .check_silent(
            &backend::TauriUpdateBackend { app: app.clone() },
            generation,
            authorize,
        )
        .await
}

/// About-specific fail-fast admission; existing legacy check semantics stay unchanged.
pub(crate) async fn check_about(
    app: &tauri::AppHandle,
    state: &UpdateCoordinator,
    authorize: impl FnOnce() -> bool,
) -> Result<snapshot::Snapshot, UpdateCommandError> {
    #[cfg(feature = "legacy-node-smoke")]
    if let Some(backend) = fixture::select(app)? {
        return state.check_about(&backend, authorize).await;
    }
    state
        .check_about(&backend::TauriUpdateBackend { app: app.clone() }, authorize)
        .await
}
