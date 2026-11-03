use super::{
    probe_caller::{caller_context, valid_token, validate_caller},
    probe_protocol::{self, PendingProbes, ProbeReply},
    report, schema,
};
use crate::renderer_desktop_smoke::profile::Profile;
use atools_core::Database;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::{ipc::Invoke, AppHandle, Manager, State, Webview, Window, Wry};
use tokio::sync::{oneshot, Notify};

const COMMAND: &str = "settings_input_probe";
const MAX_EVIDENCE_BYTES: usize = 16 * 1024;

struct Inner {
    report: Value,
    probes: PendingProbes<oneshot::Sender<Result<Value, &'static str>>>,
    main_ready: Option<Value>,
    target_name: Option<String>,
    target_path: Option<String>,
    initial_history_raw: Option<Option<String>>,
    first_session_id: Option<String>,
    timed_out: bool,
    finished: bool,
}

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness {
    profile: Arc<Profile>,
    db: Arc<Database>,
    token: String,
    inner: Arc<Mutex<Inner>>,
    changed: Arc<Notify>,
    focus_gained_events: Arc<AtomicU64>,
}

impl Harness {
    fn new(profile: Arc<Profile>, db: Arc<Database>) -> Self {
        Self {
            profile: Arc::clone(&profile),
            db,
            token: uuid::Uuid::new_v4().simple().to_string(),
            inner: Arc::new(Mutex::new(Inner {
                report: report::empty_report(&profile),
                probes: PendingProbes::default(),
                main_ready: None,
                target_name: None,
                target_path: None,
                initial_history_raw: None,
                first_session_id: None,
                timed_out: false,
                finished: false,
            })),
            changed: Arc::new(Notify::new()),
            focus_gained_events: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(super) fn profile(&self) -> &Profile {
        &self.profile
    }

    pub(in crate::renderer_desktop_smoke) fn profile_arc(&self) -> Arc<Profile> {
        Arc::clone(&self.profile)
    }

    pub(super) fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub(super) fn token(&self) -> &str {
        &self.token
    }

    pub(super) fn target(&self) -> Option<(String, String)> {
        let inner = self.inner.lock();
        Some((inner.target_name.clone()?, inner.target_path.clone()?))
    }

    pub(super) fn set_target(&self, name: String, path: String) {
        let mut inner = self.inner.lock();
        inner.target_name = Some(name);
        inner.target_path = Some(path);
        inner.report["catalogSelection"] = json!({
            "available": true,
            "canonicalNonEmpty": true,
        });
    }

    pub(super) fn search_pins(&self) -> Value {
        self.inner.lock().report["searchPins"].clone()
    }

    pub(super) fn set_search_pins(&self, value: Value) {
        self.inner.lock().report["searchPins"] = value;
    }

    pub(super) fn set_initial_history_raw(&self, value: Option<String>) {
        self.inner.lock().initial_history_raw = Some(value);
    }

    pub(super) fn initial_history_raw(&self) -> Option<Option<String>> {
        self.inner.lock().initial_history_raw.clone()
    }

    pub(super) fn first_session_id(&self) -> Option<String> {
        self.inner.lock().first_session_id.clone()
    }

    pub(super) fn set_first_session_id(&self, id: String) {
        let mut inner = self.inner.lock();
        if inner.first_session_id.is_none() {
            inner.first_session_id = Some(id);
        }
    }

    pub(super) fn focus_gained_events(&self) -> u64 {
        self.focus_gained_events.load(Ordering::Acquire)
    }

    pub(super) fn begin(
        &self,
        operation: &str,
        caller: &str,
    ) -> Result<(u64, oneshot::Receiver<Result<Value, &'static str>>), &'static str> {
        if !schema::valid_operation(operation, caller)
            || !super::main_hotkey_startup_schema::allowed_for_profile(
                &self.profile,
                operation,
                caller,
            )
        {
            return Err("settings-input-probe-operation-invalid");
        }
        let mut inner = self.inner.lock();
        if inner.finished {
            return Err("settings-input-probe-protocol-rejected");
        }
        let (sender, receiver) = oneshot::channel();
        let probe_id = inner
            .probes
            .begin(&self.token, operation, caller, sender)
            .map_err(|_| "settings-input-probe-protocol-rejected")?;
        Ok((probe_id, receiver))
    }

    pub(super) fn cancel(&self, probe_id: u64) {
        let _ = self.inner.lock().probes.cancel(probe_id);
    }

    pub(super) fn pending_probe_count(&self) -> u64 {
        if self.inner.lock().probes.is_pending() {
            1
        } else {
            0
        }
    }

    pub(super) async fn wait_main_ready(&self) -> Result<Value, &'static str> {
        let deadline = tokio::time::Instant::now() + schema::MAIN_READY_TIMEOUT;
        loop {
            if let Some(evidence) = self.inner.lock().main_ready.clone() {
                return Ok(evidence);
            }
            let notified = self.changed.notified();
            if let Some(evidence) = self.inner.lock().main_ready.clone() {
                return Ok(evidence);
            }
            tokio::time::timeout_at(deadline, notified)
                .await
                .map_err(|_| "settings-input-main-ready-timeout")?;
        }
    }

    pub(super) fn set_updater_status(&self, value: Value) {
        self.inner.lock().report["updaterStatus"] = value;
    }

    pub(super) fn push_stage(&self, value: Value) {
        report::push_stage(&mut self.inner.lock().report, value);
    }

    pub(super) fn add_error(&self, code: &'static str) {
        report::add_error(&mut self.inner.lock().report, code);
    }

    pub(super) fn mark_timed_out(&self) {
        let mut inner = self.inner.lock();
        inner.timed_out = true;
        inner.report["timedOut"] = Value::Bool(true);
        report::add_error(&mut inner.report, "settings-input-watchdog-timeout");
    }

    pub(super) fn set_cleanup(&self, value: Value) {
        self.inner.lock().report["cleanup"] = value;
    }

    pub(super) fn record_focus_gained(&self) {
        self.focus_gained_events.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn snapshot(&self, elapsed_ms: u64) -> Value {
        let mut inner = self.inner.lock();
        report::ensure_all_stages(&mut inner.report);
        inner.report["elapsedMs"] = Value::from(elapsed_ms);
        inner.report["timedOut"] = Value::Bool(inner.timed_out);
        inner.report["passed"] = Value::Bool(report::compute_passed(&inner.report));
        inner.report.clone()
    }

    pub(super) fn finish(&self) {
        let pending = {
            let mut inner = self.inner.lock();
            inner.finished = true;
            inner.probes.finish()
        };
        if let Some(pending) = pending {
            let _ = pending.send(Err("settings-input-probe-protocol-rejected"));
        }
    }

    fn accept(
        &self,
        app: &AppHandle<Wry>,
        webview: &Webview<Wry>,
        window: &Window<Wry>,
        token: &str,
        probe_id: u64,
        operation: &str,
        evidence: Value,
    ) -> Result<(), &'static str> {
        if !valid_token(token) || token != self.token {
            return Err("settings-input-probe-protocol-rejected");
        }
        if !probe_protocol::valid_probe_id(operation, probe_id) {
            return Err("settings-input-probe-protocol-rejected");
        }
        if serde_json::to_vec(&evidence).map_or(true, |bytes| bytes.len() > MAX_EVIDENCE_BYTES) {
            return Err("settings-input-probe-protocol-rejected");
        }
        schema::validate_evidence(operation, &evidence)?;
        let (caller, caller_is_current) =
            match validate_caller(app, webview, window, operation, &self.profile) {
                Ok(caller) => (caller, true),
                // A removed WebView can still deliver a queued invoke. The identity-only path below
                // is allowed to discard a tombstoned reply, never to satisfy a live probe.
                Err(_) => (caller_context(window, webview, operation)?, false),
            };

        if operation == "mainReady" {
            let mut inner = self.inner.lock();
            if !caller_is_current
                || inner.finished
                || inner.probes.is_pending()
                || inner.main_ready.is_some()
            {
                return Err("settings-input-probe-protocol-rejected");
            }
            inner.main_ready = Some(evidence);
            drop(inner);
            self.changed.notify_waiters();
            return Ok(());
        }

        let reply = {
            let mut inner = self.inner.lock();
            if inner.finished {
                return Err("settings-input-probe-protocol-rejected");
            }
            if !caller_is_current {
                if inner
                    .probes
                    .discard_cancelled(token, probe_id, operation, &caller)
                {
                    return Ok(());
                }
                return Err("settings-input-probe-protocol-rejected");
            }
            inner.probes.take_reply(token, probe_id, operation, &caller)
        };
        match reply {
            ProbeReply::Matched(sender) => {
                let _ = sender.send(Ok(evidence));
                Ok(())
            }
            ProbeReply::Cancelled => Ok(()),
            ProbeReply::Rejected => Err("settings-input-probe-protocol-rejected"),
        }
    }
}

pub(super) fn prepare(profile: Arc<Profile>, db: Arc<Database>) -> Result<Harness, String> {
    if !profile.settings_input_journey
        || profile.auto_clear != "never"
        || profile.identifier != format!("dev.atools.renderer-settings-input.{}", profile.run_id)
        || !valid_token(&profile.run_id)
    {
        return Err("settings-input-profile-invalid".to_owned());
    }
    super::super::fixture_owner::verify(&profile)
        .map_err(|_| "settings-input-fixture-owner-invalid".to_owned())?;
    let recovery_profile =
        profile.main_hotkey_recovery_first || profile.main_hotkey_recovery_second;
    let raw_settings = if recovery_profile {
        super::main_hotkey_startup_storage::prepare_general(&profile, &db)?
    } else if profile.builtin_state_journey {
        db.get_setting("settings-general")
            .map_err(|_| "settings-input-fixture-seed-failed".to_owned())?
            .ok_or_else(|| "settings-input-fixture-seed-failed".to_owned())?
    } else {
        let mut settings = settings_input_seed();
        settings["hotkey"] = Value::String(super::main_hotkey_schema::HOTKEY_A.to_owned());
        settings.to_string()
    };
    let projected =
        crate::renderer_settings_view::project_general_settings(Some(&raw_settings), "Option+Z")
            .map_err(|_| "settings-input-fixture-seed-invalid".to_owned())?;
    if profile.builtin_state_journey && projected["showTrayIcon"].as_bool() != Some(false) {
        return Err("settings-input-fixture-seed-invalid".to_owned());
    }
    if !profile.builtin_state_journey && !recovery_profile {
        db.set_setting("settings-general", &raw_settings)
            .map_err(|_| "settings-input-fixture-seed-failed".to_owned())?;
    }
    Ok(Harness::new(profile, db))
}

fn settings_input_seed() -> Value {
    json!({
        "theme": "dark",
        "autoPaste": "off",
        "autoClear": "never",
        "opacity": 1.0,
    })
}

pub(super) fn builtin_state_general_seed() -> Value {
    let mut settings = settings_input_seed();
    settings["showTrayIcon"] = Value::Bool(false);
    settings
}

pub(super) fn handles(command: &str) -> bool {
    command == COMMAND
}

pub(super) fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![settings_input_probe]
}

#[tauri::command]
fn settings_input_probe(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    window: Window<Wry>,
    harness: State<'_, Harness>,
    token: String,
    operation: String,
    probe_id: u64,
    evidence: Value,
) -> Result<(), String> {
    (*harness)
        .accept(
            &app, &webview, &window, &token, probe_id, &operation, evidence,
        )
        .map_err(str::to_owned)
}

#[cfg(test)]
mod settings_seed_tests {
    use super::settings_input_seed;
    use serde_json::json;

    #[test]
    fn isolated_settings_seed_is_accepted_by_the_shared_production_projection() {
        let seed = settings_input_seed();
        let raw = seed.to_string();
        let projected =
            crate::renderer_settings_view::project_general_settings(Some(&raw), "Option+Z").expect(
                "the complete isolated seed must satisfy the production General projection",
            );
        assert_eq!(projected["theme"], "dark");
        assert_eq!(projected["autoPaste"], "off");
        assert_eq!(projected["autoClear"], "never");
        assert_eq!(projected["opacity"], 1.0);
        assert_eq!(projected["showTrayIcon"], true);
        assert!(seed.get("showTrayIcon").is_none());

        let mut former_seed = seed;
        former_seed["autoPaste"] = json!("never");
        assert!(crate::renderer_settings_view::project_general_settings(
            Some(&former_seed.to_string()),
            "Option+Z",
        )
        .is_err());
    }

    #[test]
    fn builtin_cold_seed_explicitly_disables_tray_and_preserves_general_defaults() {
        let seed = super::builtin_state_general_seed();
        assert_eq!(seed["showTrayIcon"], false);
        assert_eq!(seed["theme"], "dark");
        assert_eq!(seed["autoPaste"], "off");
        assert_eq!(seed["autoClear"], "never");
        assert_eq!(seed["opacity"], 1.0);
    }
}

pub(super) fn record_window_event(window: &Window<Wry>, event: &tauri::WindowEvent) {
    if window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(true)) {
        if let Some(harness) = window.app_handle().try_state::<Harness>() {
            harness.record_focus_gained();
        }
    }
}
