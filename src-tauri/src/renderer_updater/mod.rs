//! Original updater's source-bound popup. Domain state remains in the shared coordinator.
mod appearance;
mod assets;
mod bundle;
mod candidate;
pub(crate) use candidate::expected_candidate;
pub(crate) mod commands;
mod display;
#[cfg(feature = "legacy-node-smoke")]
pub(crate) mod fixture_observation;
mod identity;
mod links;
mod manager;
mod native_appearance;
mod opening;
mod protocol;
mod publisher;
mod runtime;
mod selection;
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Manager};
type Error = crate::updater::UpdateCommandError;
fn error(code: &str) -> Error {
    Error::new(
        code,
        match code {
            "invalid_request" => "更新请求无效",
            "appearance_unavailable" => "更新窗口外观状态暂不可用",
            "no_update" => "当前没有可用更新",
            "busy" => "更新操作正在进行",
            "stale_candidate" => "更新候选已失效",
            "provider_disabled" => "隔离实例未启用更新提供方",
            "forbidden_window" => "当前窗口无权管理应用更新",
            _ => "更新操作暂不可用",
        },
    )
}
fn runtime(app: &AppHandle) -> Result<Arc<runtime::Runtime>, Error> {
    app.try_state::<Arc<runtime::Runtime>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| error("state_unavailable"))
}
fn coordinator(app: &AppHandle) -> Result<crate::updater::UpdateCoordinator, Error> {
    app.try_state::<crate::updater::UpdateCoordinator>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| error("state_unavailable"))
}
pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    assets::register(builder)
}
pub(crate) fn initialize(app: &AppHandle) -> Result<(), Error> {
    let runtime = runtime(app)?;
    let _delivery = runtime.delivery.lock();
    if runtime.stopped.load(Ordering::Acquire) {
        return Err(error("operation_interrupted"));
    }
    if !runtime.publisher_bound.swap(true, Ordering::AcqRel) {
        if let Err(error) = publisher::bind(app) {
            runtime.publisher_bound.store(false, Ordering::Release);
            return Err(error);
        }
    }
    Ok(())
}
pub(crate) fn general_committed(app: &AppHandle, raw: &str) {
    native_appearance::committed(app, raw)
}
pub(crate) fn stop(app: &AppHandle) {
    if let Ok(runtime) = runtime(app) {
        let _delivery = runtime.delivery.lock();
        runtime.stopped.store(true, Ordering::Release);
        if let Some(session) = runtime.session.lock().as_ref() {
            session.alive.store(false, Ordering::Release);
            session.closing.store(true, Ordering::Release);
            session.appearance_changed.notify_waiters();
        }
    }
    if let Ok(state) = coordinator(app) {
        state.shutdown()
    }
}
#[cfg(test)]
mod resource_binding_tests;

#[cfg(feature = "ztools-multiwebview")]
pub(crate) async fn reuse_from_settings(
    app: &AppHandle,
    grant: crate::renderer_settings_view::UpdaterGrant,
) -> Result<Option<crate::updater::snapshot::Snapshot>, Error> {
    display::reuse(app, display::Principal::settings(grant)).await
}
#[cfg(feature = "ztools-multiwebview")]
pub(crate) async fn show_from_settings(
    app: &AppHandle,
    grant: crate::renderer_settings_view::UpdaterGrant,
    expected: String,
) -> Result<String, Error> {
    manager::show_about(app, display::Principal::settings(grant), expected).await
}
