#[path = "session_runtime_phases.rs"]
mod phases;
#[path = "session_runtime_updater.rs"]
mod updater;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
pub(crate) use updater::UpdaterGrant;

use serde_json::Value;
use tokio::sync::{watch, Mutex as AsyncMutex, Semaphore};

use super::super::{
    accounting::RuntimeAccounting,
    bundle::SettingsBundle,
    phase::{SessionPhase, SessionSignal},
    preferences::SettingsPreferences,
};
use super::{ActiveSession, SessionView};

#[path = "session_runtime_intent.rs"]
mod intent;

#[path = "session_runtime_open.rs"]
mod open;

#[path = "session_runtime_material.rs"]
mod material;

#[path = "session_diagnostics.rs"]
mod diagnostics;

#[path = "session_runtime_height.rs"]
mod height;

struct RuntimeInner {
    main_binding: Option<super::super::main_authority::MainBinding>,
    pending_intent: Option<super::super::intent_protocol::PendingIntent>,
    open_claims: super::super::open_claims::OpenClaims,
    open_flight: Option<super::super::open_service::OpenFlight>,
    cached_bundle: Option<Arc<SettingsBundle>>,
    heights: super::super::height::HeightCache,
    session: Option<ActiveSession>,
}

pub(crate) struct SettingsViewRuntime {
    inner: Mutex<RuntimeInner>,
    bundle_load_active: AtomicBool,
    accounting: Arc<RuntimeAccounting>,
}

impl Default for SettingsViewRuntime {
    fn default() -> Self {
        Self {
            inner: Mutex::new(RuntimeInner {
                main_binding: None,
                cached_bundle: None,
                open_claims: Default::default(),
                open_flight: None,
                pending_intent: None,
                heights: Default::default(),
                session: None,
            }),
            bundle_load_active: AtomicBool::new(false),
            accounting: RuntimeAccounting::shared(),
        }
    }
}

impl SettingsViewRuntime {
    pub(crate) fn accounting(&self) -> Arc<RuntimeAccounting> {
        Arc::clone(&self.accounting)
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub(crate) fn cache_bundle(&self, bundle: Arc<SettingsBundle>) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        if inner.session.is_some() {
            return Err("Settings bundle cannot change while the settings view is active".into());
        }
        if let Some(current) = inner.cached_bundle.as_ref() {
            if current.revision() != bundle.revision() {
                return Err("A different settings bundle is already cached".into());
            }
            return Ok(());
        }
        inner.cached_bundle = Some(bundle);
        Ok(())
    }

    pub(crate) fn cache_loaded_bundle(
        &self,
        bundle: Arc<SettingsBundle>,
    ) -> Result<Arc<SettingsBundle>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        if let Some(current) = inner.cached_bundle.as_ref() {
            return Ok(Arc::clone(current));
        }
        if inner.session.is_some() {
            return Err(
                "Settings bundle cannot be installed while the settings view is active".into(),
            );
        }
        inner.cached_bundle = Some(Arc::clone(&bundle));
        Ok(bundle)
    }

    #[cfg(test)]
    pub(crate) fn begin_session(
        &self,
        id: String,
        bundle: Arc<SettingsBundle>,
        preferences: Arc<SettingsPreferences>,
        native_runtime: Value,
        platform: Value,
    ) -> Result<SessionView, String> {
        self.begin_session_reserved(
            id,
            bundle,
            preferences,
            native_runtime,
            platform,
            Arc::new(AtomicBool::new(false)),
            None,
        )
    }

    pub(crate) fn begin_session_reserved(
        &self,
        id: String,
        bundle: Arc<SettingsBundle>,
        preferences: Arc<SettingsPreferences>,
        native_runtime: Value,
        platform: Value,
        revoked: Arc<AtomicBool>,
        reservation: Option<(
            super::super::open_claims::MainKey,
            super::super::open_claims::SessionKey,
        )>,
    ) -> Result<SessionView, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        if let Some((main, key)) = reservation.as_ref() {
            if key.id != id || key.revoked_identity != Arc::as_ptr(&revoked) as usize {
                return Err("Settings session reservation identity changed".into());
            }
            inner.open_claims.admit_stage(*main, key)?;
        }
        if inner.session.is_some() {
            return Err("A settings view session is already active".into());
        }
        if bundle.revision().is_empty()
            || inner
                .cached_bundle
                .as_ref()
                .is_some_and(|cached| cached.revision() != bundle.revision())
        {
            return Err("Settings bundle changed while opening the settings view".into());
        }
        let label = format!("ztools-settings-{id}");
        let origin = format!("atools-settings://{id}.localhost");
        let bundle_revision = bundle.revision().to_owned();
        let command_data = Arc::new(super::CommandDataBuffers::new(
            id.clone(),
            bundle_revision.clone(),
        ));
        let sub_input = Arc::new(super::SubInputBuffer::new());
        let (signals, _) = watch::channel(SessionSignal {
            phase: SessionPhase::Opening,
            opened: false,
            ready: false,
            out_acknowledged: false,
        });
        let session = ActiveSession {
            id,
            label,
            origin,
            bundle_revision,
            bundle,
            preferences,
            command_data,
            sub_input,
            native_runtime,
            platform,
            revoked,
            operations: Arc::new(Semaphore::new(32)),
            write_gate: Arc::new(AsyncMutex::new(())),
            close_gate: Arc::new(AsyncMutex::new(())),
            signals,
            closing_reason: None,
            index_consumed: false,
            started_count: 0,
            closed_phase_emitted: false,
            back_phase_emitted: false,
            layout_lease: None,
            material_lease: None,
            material_release_retry: None,
        };
        let view = view_of(&session);
        inner.session = Some(session);
        Ok(view)
    }

    pub(crate) fn current(&self) -> Result<Option<SessionView>, String> {
        self.inner
            .lock()
            .map(|inner| inner.session.as_ref().map(view_of))
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())
    }

    pub(crate) fn current_for_id(&self, id: &str) -> Result<SessionView, String> {
        self.current()?
            .filter(|session| session.id == id)
            .ok_or_else(|| "Settings view session is no longer active".into())
    }

    pub(crate) fn current_for_label(&self, label: &str) -> Result<SessionView, String> {
        self.current()?
            .filter(|session| session.label == label)
            .ok_or_else(|| "Settings view document is no longer active".into())
    }

    pub(crate) fn install_layout_lease(
        &self,
        id: &str,
        lease: crate::window::MainChildLayoutLease,
    ) -> Result<(), crate::window::MainChildLayoutLease> {
        let Ok(mut inner) = self.inner.lock() else {
            return Err(lease);
        };
        let Some(session) = inner.session.as_mut().filter(|session| session.id == id) else {
            return Err(lease);
        };
        if session.layout_lease.is_some() {
            return Err(lease);
        }
        session.layout_lease = Some(lease);
        Ok(())
    }

    pub(crate) fn mark_closing(&self, id: &str, reason: &str) -> Result<SessionView, String> {
        let current = self.current_for_id(id)?;
        let (view, pending) = current.command_data.close_after_mark(|| {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
            let session = inner
                .session
                .as_mut()
                .filter(|session| session.id == id)
                .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
            let mut signal = session.signals.borrow().clone();
            if signal.phase == SessionPhase::Closing {
                if session.closing_reason.as_deref() != Some(reason) {
                    return Err("Settings view close reason changed during cleanup".into());
                }
            } else {
                signal.phase = SessionPhase::Closing;
                session.closing_reason = Some(reason.to_owned());
                session.signals.send_replace(signal);
            }
            session.revoked.store(true, Ordering::Release);
            session.sub_input.close();
            let view = view_of(session);
            let key = super::super::open_claims::SessionKey {
                id: view.id.clone(),
                revoked_identity: Arc::as_ptr(&view.revoked) as usize,
            };
            inner.open_claims.invalidate_session(&key);
            let pending = intent::cancel_invalid_intent(&mut inner);
            Ok((view, pending))
        })?;
        drop(pending);
        Ok(view)
    }

    pub(crate) fn acknowledge_out(&self, id: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        let session = inner
            .session
            .as_mut()
            .filter(|session| session.id == id)
            .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
        let mut signal = session.signals.borrow().clone();
        if signal.phase != SessionPhase::Closing {
            return Err("Settings view is not waiting for its out acknowledgement".into());
        }
        signal.out_acknowledged = true;
        session.signals.send_replace(signal);
        Ok(())
    }

    pub(crate) fn note_index_request(&self, label: &str, origin: &str) -> Option<Arc<[u8]>> {
        let mut inner = self.inner.lock().ok()?;
        let session = inner.session.as_mut()?;
        if session.label != label
            || session.origin != origin
            || session.revoked.load(Ordering::Acquire)
            || session.signals.borrow().phase == SessionPhase::Closing
            || session.index_consumed
        {
            return None;
        }
        let bytes = Arc::clone(&session.bundle.asset("index.html")?.bytes);
        session.index_consumed = true;
        Some(bytes)
    }

    pub(crate) fn asset_for_document(
        &self,
        label: &str,
        origin: &str,
        path: &str,
    ) -> Option<(Arc<[u8]>, &'static str)> {
        let inner = self.inner.lock().ok()?;
        let session = inner.session.as_ref()?;
        if session.label != label
            || session.origin != origin
            || session.revoked.load(Ordering::Acquire)
            || session.signals.borrow().phase == SessionPhase::Closing
            || !session.index_consumed
        {
            return None;
        }
        let asset = session.bundle.asset(path)?;
        Some((Arc::clone(&asset.bytes), asset.mime))
    }

    pub(crate) fn record_page_started(&self, id: &str) -> Result<bool, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        let session = inner
            .session
            .as_mut()
            .filter(|session| session.id == id)
            .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
        if session.revoked.load(Ordering::Acquire) {
            return Err("Settings view document has been revoked".into());
        }
        session.started_count = session.started_count.saturating_add(1);
        if session.started_count > 1 {
            session.revoked.store(true, Ordering::Release);
            let key = super::super::open_claims::SessionKey {
                id: session.id.clone(),
                revoked_identity: Arc::as_ptr(&session.revoked) as usize,
            };
            inner.open_claims.invalidate_session(&key);
            let pending = intent::cancel_invalid_intent(&mut inner);
            drop(inner);
            drop(pending);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(crate) fn record_ready(&self, id: &str, revision: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        let session = inner
            .session
            .as_mut()
            .filter(|session| session.id == id)
            .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
        let signal = session.signals.borrow().clone();
        if session.revoked.load(Ordering::Acquire)
            || signal.phase != SessionPhase::Opening
            || !signal.opened
            || !session.index_consumed
            || session.started_count != 1
            || session.bundle_revision != revision
            || session.bundle.revision() != session.bundle_revision
        {
            return Err("Settings view readiness handshake was rejected".into());
        }
        let mut signal = signal;
        signal.ready = true;
        session.signals.send_replace(signal);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn take_if(&self, id: &str) -> Option<SessionView> {
        self.take_if_with(id, |_| {})
    }

    /// The retirement callback runs only for this current generation, before it is removed.
    /// It must not call session APIs or native dispatch while the session mutex is held.
    pub(crate) fn take_if_with(
        &self,
        id: &str,
        before_remove: impl FnOnce(&str),
    ) -> Option<SessionView> {
        let current = self.current_for_id(id).ok()?;
        current.command_data.close();
        current.sub_input.close();
        let mut inner = self.inner.lock().ok()?;
        let session = inner.session.as_ref()?;
        if session.id != id
            || !material::may_take_for_close(
                session.material_lease.is_some(),
                session.material_release_retry.is_some(),
            )
        {
            return None;
        }
        before_remove(&session.id);
        let mut session = inner.session.take()?;
        session.revoked.store(true, Ordering::Release);
        let view = view_of(&session);
        let key = super::super::open_claims::SessionKey {
            id: view.id.clone(),
            revoked_identity: Arc::as_ptr(&view.revoked) as usize,
        };
        inner.open_claims.invalidate_session(&key);
        let pending = intent::cancel_invalid_intent(&mut inner);
        let layout = session.layout_lease.take();
        drop(inner);
        drop(pending);
        drop(layout);
        session.command_data.close();
        Some(view)
    }

    pub(crate) fn diagnostics(&self, child_present: bool, layout_count: Option<usize>) -> Value {
        diagnostics::snapshot(self, child_present, layout_count)
    }
}

fn view_of(session: &ActiveSession) -> SessionView {
    SessionView {
        id: session.id.clone(),
        label: session.label.clone(),
        origin: session.origin.clone(),
        bundle_revision: session.bundle_revision.clone(),
        bundle: Arc::clone(&session.bundle),
        preferences: Arc::clone(&session.preferences),
        command_data: Arc::clone(&session.command_data),
        sub_input: Arc::clone(&session.sub_input),
        native_runtime: session.native_runtime.clone(),
        platform: session.platform.clone(),
        revoked: Arc::clone(&session.revoked),
        operations: Arc::clone(&session.operations),
        write_gate: Arc::clone(&session.write_gate),
        close_gate: Arc::clone(&session.close_gate),
        signals: session.signals.clone(),
        closing_reason: session.closing_reason.clone(),
    }
}
