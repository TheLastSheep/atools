//! Fixed-key runtime. Plugin callbacks hold the plugin map lock: only atomic
//! claims and deferred work are permitted on that stack.
#[path = "recording_shutdown.rs"]
mod shutdown;
use shutdown::shutdown_recording;
pub(super) use shutdown::shutdown_locked;
use super::recording::{self, Ack, Notice, Outcome, Port, Registry, Target};
use crate::general_settings_runtime::GeneralSettingsCoordinator;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutState};
pub(crate) const KEY: &str = "Alt+Space";
const DEADLINE: Duration = Duration::from_secs(30);
const BUSY: &str = "SETTINGS_HOTKEY_RECORDING_BUSY";
#[path = "recording_dispatch.rs"]
mod dispatch;
use dispatch::ReleaseClaim;
pub(crate) use dispatch::Signals;
pub(crate) struct NativePort<'a>(pub &'a AppHandle);
impl Port for NativePort<'_> {
    fn is_registered(&self) -> Result<bool, String> {
        Ok(manager(self.0)?.is_registered(key()?))
    }
    fn register(&mut self) -> Result<(), String> {
        let app = self.0.clone();
        manager(self.0)?
            .on_shortcut(key()?, move |_, key, event| {
                let _ = route_event(&app, key, event.state);
            })
            .map_err(|_| recording::UNAVAILABLE.into())
    }
    fn unregister(&mut self) -> Result<(), String> {
        manager(self.0)?
            .unregister(key()?)
            .map_err(|_| recording::UNAVAILABLE.into())
    }
}
fn key() -> Result<Shortcut, String> {
    KEY.parse().map_err(|_| recording::UNAVAILABLE.into())
}
fn manager(app: &AppHandle) -> Result<tauri::State<'_, GlobalShortcut<tauri::Wry>>, String> {
    app.try_state().ok_or_else(|| recording::UNAVAILABLE.into())
}
fn coordinator(app: &AppHandle) -> Result<tauri::State<'_, GeneralSettingsCoordinator>, String> {
    app.try_state().ok_or_else(|| recording::UNAVAILABLE.into())
}
pub(crate) fn visibility_allows(recorded_epoch: u64, current_epoch: u64, visible: bool) -> bool {
    visible && recorded_epoch == current_epoch
}
pub(crate) fn visibility_epoch(app: &AppHandle) -> u64 {
    coordinator(app)
        .map(|state| {
            state
                .recording_signals
                .visibility_epoch
                .load(Ordering::Acquire)
        })
        .unwrap_or(0)
}
pub(crate) fn note_main_hidden(app: &AppHandle) {
    crate::app_global_shortcuts::recording::cancel(app, None);
    if let Ok(state) = coordinator(app) {
        state
            .recording_signals
            .visibility_epoch
            .fetch_add(1, Ordering::AcqRel);
    }
}
pub(crate) fn scope_busy(app: &AppHandle) -> bool {
    coordinator(app).map_or(true, |c| {
        c.recording_signals.lease_present.load(Ordering::Acquire) || c.recording_signals.held()
    })
}
pub(crate) fn start(app: &AppHandle, target: Target, generation: u64) -> Result<Ack, String> {
    let c = coordinator(app)?;
    c.with_recording_registries(|primary, registry| {
        let signals = &c.recording_signals;
        if c.app_recording.busy() {
            return Err(BUSY.into());
        }
        if !target_live(app, &target) || signals.shutting_down.load(Ordering::Acquire) {
            return Err(recording::STALE.into());
        }
        if signals.held() {
            return Err(BUSY.into());
        }
        let fresh = registry.preflight(&target, generation)?;
        let borrowed = super::owned_main::owned_registry_uses_shortcut(primary, app, KEY)?;
        if !fresh {
            return registry
                .start(target, generation, borrowed, &mut NativePort(app))
                .map(|result| result.0);
        }
        finish_cancel(app, registry, signals, "cancelled", false)?;
        let token = signals.arm(target.clone(), generation)?; // before native register can deliver
        let started = registry.start(target.clone(), generation, borrowed, &mut NativePort(app));
        if started.is_err() {
            update_signals(signals, registry);
        }
        let (ack, _, _) = started?;
        if !target_live(app, &target) {
            finish_cancel(app, registry, signals, "cancelled", false)?;
            return Err(recording::STALE.into());
        }
        let handle = app.clone();
        *signals.deadline.lock() = Some(tauri::async_runtime::spawn(async move {
            tokio::time::sleep(DEADLINE).await;
            work(&handle, token, Work::Timeout, None).await;
        }));
        Ok(ack)
    })?
}
pub(crate) fn stop(app: &AppHandle, session: &str, generation: u64) -> Result<Ack, String> {
    let c = coordinator(app)?;
    let result = c.with_recording_registries(|_, registry| {
        let result = stop_recording(
            registry,
            &c.recording_signals,
            &mut NativePort(app),
            session,
            generation,
        );
        update_signals(&c.recording_signals, registry);
        if result.is_err() {
            report_failure(app, &c.recording_signals);
        }
        let (ack, notice) = result?;
        if let Some(notice) = notice {
            deliver(app, notice);
        }
        Ok(ack)
    });
    if result.is_err() {
        report_scoped_failure(app, &c.recording_signals, Some(session), generation);
    }
    result?
}
fn stop_recording(
    registry: &mut Registry,
    signals: &Signals,
    port: &mut impl Port,
    session: &str,
    generation: u64,
) -> Result<(Ack, Option<Notice>), String> {
    registry.remember_stop(session, generation)?;
    if registry
        .pending_target()
        .is_some_and(|(target, current)| target.session_id == session && current <= generation)
    {
        let notice = end_recording(registry, signals, port, "cancelled", false)?;
        return registry
            .stop(session, generation, port)
            .map(|(ack, _)| (ack, notice));
    }
    registry.stop(session, generation, port)
}
/// Also called before every Main mutation. Held fixed handlers must survive to
/// deliver Released; a busy result must not remove/replace the Main registration.
pub(crate) fn cancel_locked(app: &AppHandle, registry: &mut Registry) -> Result<(), String> {
    let c = coordinator(app)?;
    finish_cancel(app, registry, &c.recording_signals, "cancelled", false)
}
fn end_recording(
    registry: &mut Registry,
    signals: &Signals,
    port: &mut impl Port,
    reason: &'static str,
    force: bool,
) -> Result<Option<Notice>, String> {
    if force { return shutdown_recording(registry, signals, port, false); }
    signals.disarm();
    if !signals.clear_if_idle(false) {
        registry.defer_cancel(reason);
        return Err(BUSY.into());
    }
    let outcome = registry.cancel(port, reason);
    update_signals(signals, registry);
    outcome
}
fn finish_cancel(
    app: &AppHandle,
    registry: &mut Registry,
    signals: &Signals,
    reason: &'static str,
    force: bool,
) -> Result<(), String> {
    let outcome = end_recording(registry, signals, &mut NativePort(app), reason, force);
    if outcome.is_err() {
        report_failure(app, signals);
    }
    if let Some(notice) = outcome? {
        deliver(app, notice);
    }
    Ok(())
}
fn release_recording(
    registry: &mut Registry,
    signals: &Signals,
    port: &mut impl Port,
    live: bool,
) -> Result<Option<Notice>, String> {
    if let Some((target, generation)) = registry.pending_target() {
        if live && registry.matches_active(&target.session_id, generation) {
            let result = match signals.claim_release() {
                ReleaseClaim::Held => return Ok(None),
                ReleaseClaim::Cancelled => registry.cancel(port, "cancelled"),
                ReleaseClaim::Recorded => registry.capture(&target.session_id, generation, port),
            };
            update_signals(signals, registry);
            return result;
        }
    }
    let reason = registry.stop_reason();
    end_recording(registry, signals, port, reason, false)
}
fn update_signals(signals: &Signals, registry: &Registry) {
    let pending = registry.pending_target();
    signals
        .lease_present
        .store(pending.is_some(), Ordering::Release);
    if pending.is_none() {
        signals.clear();
        signals.abort_deadline();
    } else if pending.as_ref().is_some_and(|(target, generation)| {
        !registry.matches_active(&target.session_id, *generation)
    }) {
        signals.retain_failed_cleanup();
    }
}
/// No plugin APIs or blocking locks on the per-key callback stack.
pub(crate) fn route_event(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) -> bool {
    let Ok(c) = coordinator(app) else {
        return false;
    };
    if c.recording_signals.shutting_down.load(Ordering::Acquire) {
        return true;
    }
    if key().map_or(true, |key| key.id() != shortcut.id()) {
        return false;
    }
    let (consumed, released) = c.recording_signals.observe(state);
    if let Some(token) = released {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            work(&handle, token, Work::Released, None).await;
        });
    }
    consumed
}
/// Main and Pasteboard window actions may hide Main and release keys. Enqueue
/// them from the plugin callback, then run them after that synchronous stack.
#[cfg(test)]
pub(super) fn enqueue_pressed(state: ShortcutState, consumed: bool, enqueue: impl FnOnce()) {
    if state == ShortcutState::Pressed && !consumed {
        enqueue();
    }
}

#[derive(Clone, Copy)]
enum Work {
    Released,
    Timeout,
    Cancel,
}
async fn work(app: &AppHandle, token: u64, work: Work, expected_session: Option<String>) {
    let Ok(c) = coordinator(app) else {
        return;
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        let notified = c.hotkey_operation_available.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let result = c.with_recording_registries(|_, registry| {
            if token != c.recording_signals.token() {
                return Ok(());
            }
            let current = registry.pending_target();
            if expected_session.as_ref().is_some_and(|id| {
                current
                    .as_ref()
                    .is_none_or(|(target, _)| target.session_id != *id)
            }) {
                return Ok(());
            }
            let outcome = match (work, current.as_ref()) {
                (Work::Released, Some((target, _))) => release_recording(
                    registry,
                    &c.recording_signals,
                    &mut NativePort(app),
                    target_live(app, target),
                ),
                (Work::Timeout, _) => end_recording(
                    registry,
                    &c.recording_signals,
                    &mut NativePort(app),
                    "timeout",
                    false,
                ),
                _ => {
                    let reason = registry.stop_reason();
                    end_recording(
                        registry,
                        &c.recording_signals,
                        &mut NativePort(app),
                        reason,
                        false,
                    )
                }
            };
            match outcome {
                Ok(Some(notice)) => deliver(app, notice),
                Err(error) => {
                    report_failure(app, &c.recording_signals);
                    return Err(error);
                }
                _ => {}
            }
            Ok(())
        });
        match result {
            Ok(Ok(())) => return,
            Ok(Err(error)) => {
                tracing::warn!(%error, "Hotkey recording retains its handler until release/retry");
                return;
            }
            Err(_) => {
                if tokio::time::timeout_at(deadline, &mut notified)
                    .await
                    .is_err()
                {
                    if let Some(notice) = c.recording_signals.failure_notice(token) {
                        deliver(app, notice);
                    }
                    return;
                }
            }
        }
    }
}

pub(crate) fn cancel_session(app: &AppHandle, session: Option<&str>) -> Result<(), String> {
    crate::app_global_shortcuts::recording::cancel(app, session);
    let c = coordinator(app)?;
    if !c.recording_signals.lease_present.load(Ordering::Acquire) {
        return Ok(());
    }
    let attempt = c.with_recording_registries(|_, registry| {
        if session.is_some_and(|id| {
            registry
                .pending_target()
                .is_none_or(|(target, _)| target.session_id != id)
        }) {
            return Ok(());
        }
        cancel_locked(app, registry)
    });
    match attempt {
        Ok(Ok(())) => Ok(()),
        Err(error) | Ok(Err(error)) => {
            report_scoped_failure(
                app,
                &c.recording_signals,
                session,
                recording::MAX_GENERATION,
            );
            queue_cancellation(
                app,
                &c.recording_signals,
                c.recording_signals.token(),
                session.map(str::to_owned),
            );
            Err(error)
        }
    }
}
pub(crate) fn shutdown(app: &AppHandle) {
    let Ok(c) = coordinator(app) else {
        return;
    };
    c.recording_signals
        .shutting_down
        .store(true, Ordering::Release);
    let result = c.with_recording_registries(|_, registry| {
        finish_cancel(app, registry, &c.recording_signals, "cancelled", true)
    });
    if let Err(error) = result.and_then(|result| result) {
        tracing::error!(%error, "Exit could not confirm recording unregister; no rearm allowed");
    }
}
fn queue_cancellation(app: &AppHandle, signals: &Signals, token: u64, session: Option<String>) {
    {
        let mut request = signals.cancel_request.lock();
        if !request
            .as_ref()
            .is_some_and(|(current, scope)| *current == token && scope.is_none())
        {
            *request = Some((token, session));
        }
    }
    if signals.cleanup_worker.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(c) = coordinator(&handle) else {
            return;
        };
        loop {
            let request = c.recording_signals.cancel_request.lock().take();
            if let Some((token, session)) = request {
                work(&handle, token, Work::Cancel, session).await;
            } else {
                let request = c.recording_signals.cancel_request.lock();
                if request.is_some() {
                    continue;
                }
                c.recording_signals
                    .cleanup_worker
                    .store(false, Ordering::Release);
                break;
            }
        }
    });
}
fn report_scoped_failure(
    app: &AppHandle,
    signals: &Signals,
    session: Option<&str>,
    generation: u64,
) {
    let token = {
        let pending = signals.pending_notice.lock();
        pending
            .as_ref()
            .filter(|(target, current)| {
                session.is_none_or(|session| target.session_id == session) && *current <= generation
            })
            .map(|_| signals.token())
    };
    if let Some(notice) = token.and_then(|token| signals.failure_notice(token)) {
        deliver(app, notice);
    }
}
fn report_failure(app: &AppHandle, signals: &Signals) {
    if let Some(notice) = signals.failure_notice(signals.token()) {
        deliver(app, notice);
    }
}

/// Wait for a successful gate round-trip before scheduling the Child hook. This
/// guarantees the operation that produced the notice released its own gate.
fn deliver(app: &AppHandle, notice: Notice) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(c) = coordinator(&handle) else {
            return;
        };
        if wait_for_gate(&c).await && c.recording_signals.notice_current(&notice) {
            #[cfg(feature = "ztools-multiwebview")]
            crate::renderer_settings_view::deliver_hotkey_recording(&handle, notice);
            #[cfg(not(feature = "ztools-multiwebview"))]
            let _ = notice;
        }
    });
}
async fn wait_for_gate(c: &GeneralSettingsCoordinator) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        let notified = c.hotkey_operation_available.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if c.with_hotkey_operation(|| Ok(())).is_ok() {
            return true;
        }
        if tokio::time::timeout_at(deadline, &mut notified)
            .await
            .is_err()
        {
            tracing::warn!("Recording notice could not cross the operation barrier");
            return false;
        }
    }
}

fn target_live(app: &AppHandle, target: &Target) -> bool {
    #[cfg(feature = "ztools-multiwebview")]
    {
        crate::renderer_settings_view::hotkey_recording_target_live(app, target)
    }
    #[cfg(not(feature = "ztools-multiwebview"))]
    {
        let _ = (app, target);
        false
    }
}
#[cfg(test)]
#[path = "recording_runtime_tests.rs"]
mod tests;
