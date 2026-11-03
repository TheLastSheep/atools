//! Native App-shortcut recording orchestration; existing App worker owns timing/delivery.
use super::recording_gate::{self, Ack, Gate};
use crate::{general_settings_runtime::GeneralSettingsCoordinator, hotkey::recording::Target};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
pub(crate) fn gate(app: &AppHandle) -> Result<Arc<Gate>, String> {
    app.try_state::<GeneralSettingsCoordinator>()
        .map(|c| c.app_recording.clone())
        .ok_or(recording_gate::UNAVAILABLE.into())
}
pub(crate) fn start(app: &AppHandle, target: Target, generation: u64) -> Result<Ack, String> {
    let c = app.state::<GeneralSettingsCoordinator>();
    let _lease = c
        .hotkey_operation_lease()
        .map_err(|_| recording_gate::BUSY)?;
    #[cfg(feature = "ztools-multiwebview")]
    if !crate::renderer_settings_view::app_recording_target_live(app, &target) {
        return Err(recording_gate::STALE.into());
    }
    if crate::hotkey::recording_runtime::scope_busy(app) {
        return Err(recording_gate::BUSY.into());
    }
    let rt = super::runtime(app)?;
    {
        let registry = rt.registry.lock();
        let published = rt.published.lock();
        if registry.entries.len() != published.len()
            || registry
                .entries
                .values()
                .any(|owned| published.get(&owned.target_code.row_id) != Some(&owned.target_code))
        {
            return Err(recording_gate::UNAVAILABLE.into());
        }
    }
    super::feature_dispatch::cancel_offers(app);
    let ack = c.app_recording.start(target.clone(), generation)?;
    #[cfg(feature = "ztools-multiwebview")]
    if !crate::renderer_settings_view::app_recording_target_live(app, &target) {
        c.app_recording
            .cancel(Some(&target.session_id), "cancelled");
        return Err(recording_gate::STALE.into());
    }
    let mut q = rt.queue.lock();
    q.events.clear();
    q.pending.clear();
    q.epochs.clear();
    Ok(ack)
}
pub(crate) fn stop(app: &AppHandle, session: &str, generation: u64) -> Result<Ack, String> {
    let c = app.state::<GeneralSettingsCoordinator>();
    let _lease = c
        .hotkey_operation_lease()
        .map_err(|_| recording_gate::BUSY)?;
    c.app_recording.stop(session, generation)
}
pub(crate) fn cancel(app: &AppHandle, session: Option<&str>) {
    if let Ok(gate) = gate(app) {
        gate.cancel(session, "cancelled");
    }
}
pub(super) fn work(app: &AppHandle, gate: &Gate) -> Option<tokio::time::Instant> {
    let (deadline, notices) = gate.tick();
    for notice in notices {
        deliver(app, notice);
    }
    deadline
}
pub(super) fn deliver(app: &AppHandle, notice: super::recording_gate::Notice) {
    #[cfg(feature = "ztools-multiwebview")]
    crate::renderer_settings_view::deliver_app_recording(app, notice);
    #[cfg(not(feature = "ztools-multiwebview"))]
    let _ = (app, notice);
}
