use super::*;

pub(in crate::hotkey) fn shutdown_locked(app: &AppHandle, registry: &mut Registry, main_withdrawn: bool) -> Result<(), String> {
    let c = coordinator(app)?;
    shutdown_recording(registry, &c.recording_signals, &mut NativePort(app), main_withdrawn).map(|_| ())
}

pub(super) fn shutdown_recording(registry: &mut Registry, signals: &Signals, port: &mut impl Port, main_withdrawn: bool) -> Result<Option<Notice>, String> {
    signals.disarm();
    if registry.pending_target().is_some() && !registry.owns_temporary() && !main_withdrawn {
        registry.defer_cancel("cancelled");
        return Err(BUSY.into());
    }
    let outcome = registry.cancel(port, "cancelled");
    if outcome.is_ok() { signals.clear_if_idle(true); }
    update_signals(signals, registry);
    outcome
}
