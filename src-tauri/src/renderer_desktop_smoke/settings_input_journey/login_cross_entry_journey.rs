use super::{
    login_cross_entry_flow, login_cross_entry_schema as schema, login_cross_entry_storage,
};
use crate::renderer_desktop_smoke::profile::Profile;
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tauri::{ipc::Invoke, AppHandle, Manager, Webview, WebviewWindow, Wry};

#[derive(Clone)]
pub(super) struct Progress(Arc<Inner>);

struct Inner {
    active: AtomicBool,
    reads: AtomicU64,
    changes: AtomicU64,
    saves: AtomicU64,
    data: Mutex<Data>,
}

struct Data {
    report: Value,
    errors: Vec<&'static str>,
    original: Option<login_cross_entry_storage::OriginalSettings>,
    fallback: Option<(WebviewWindow<Wry>, Webview<Wry>)>,
}

impl Progress {
    fn new(profile: &Profile) -> Self {
        Self(Arc::new(Inner {
            active: AtomicBool::new(false),
            reads: AtomicU64::new(0),
            changes: AtomicU64::new(0),
            saves: AtomicU64::new(0),
            data: Mutex::new(Data {
                report: schema::empty_report(profile),
                errors: Vec::new(),
                original: None,
                fallback: None,
            }),
        }))
    }

    pub(super) fn set_active(&self, active: bool) {
        self.0.active.store(active, Ordering::Release);
    }

    pub(super) fn active(&self) -> bool {
        self.0.active.load(Ordering::Acquire)
    }

    pub(super) fn set_original(&self, original: login_cross_entry_storage::OriginalSettings) {
        let database = login_cross_entry_storage::database_report(Some(&original), None);
        let mut data = self.0.data.lock();
        data.report["database"] = database;
        data.original = Some(original);
    }

    pub(super) fn original(&self) -> Option<login_cross_entry_storage::OriginalSettings> {
        self.0.data.lock().original.clone()
    }

    pub(super) fn set_stage(&self, stage: &str, value: Value) {
        self.0.data.lock().report["stages"][stage] = value;
    }

    fn set_final_database_enabled(&self, enabled: Option<bool>) {
        self.0.data.lock().report["stages"]["final"]["databaseEnabled"] =
            enabled.map(Value::Bool).unwrap_or(Value::Null);
    }

    pub(super) fn error(&self, code: &'static str) {
        let mut data = self.0.data.lock();
        if !data.errors.contains(&code) {
            data.errors.push(code);
        }
    }

    pub(super) fn set_fallback(&self, window: WebviewWindow<Wry>, webview: Webview<Wry>) {
        self.0.data.lock().fallback = Some((window, webview));
    }

    pub(super) fn fallback_view(&self) -> Option<Webview<Wry>> {
        self.0
            .data
            .lock()
            .fallback
            .as_ref()
            .map(|(_, webview)| webview.clone())
    }

    pub(super) fn take_fallback(&self) -> Option<(WebviewWindow<Wry>, Webview<Wry>)> {
        self.0.data.lock().fallback.take()
    }

    pub(super) fn put_fallback(&self, pair: (WebviewWindow<Wry>, Webview<Wry>)) {
        let mut data = self.0.data.lock();
        if data.fallback.is_none() {
            data.fallback = Some(pair);
        }
    }

    fn counters(&self) -> Value {
        serde_json::json!({
            "readLaunchAtLogin": self.0.reads.load(Ordering::Acquire),
            "changeLaunchAtLogin": self.0.changes.load(Ordering::Acquire),
            "saveGeneralSettings": self.0.saves.load(Ordering::Acquire),
        })
    }

    fn report_parts(&self) -> (Value, Vec<&'static str>) {
        let data = self.0.data.lock();
        (data.report["stages"].clone(), data.errors.clone())
    }
}

pub(super) fn profile_enabled(profile: &Profile) -> bool {
    profile.settings_input_journey
        && !profile.builtin_state_journey
        && !profile.main_hotkey_recovery_first
        && !profile.main_hotkey_recovery_second
}

pub(super) fn initialize(app: &AppHandle<Wry>) {
    if app.try_state::<Progress>().is_none() {
        let profile = app.state::<super::state::Harness>().profile_arc();
        app.manage(Progress::new(&profile));
    }
}

pub(super) fn is_active(app: &AppHandle<Wry>) -> bool {
    app.try_state::<Progress>()
        .is_some_and(|progress| progress.active())
}

pub(super) fn observe_command(invoke: &Invoke<Wry>) {
    let command = invoke.message.command();
    let counter = match command {
        "read_launch_at_login" => 0,
        "change_launch_at_login" => 1,
        "save_general_settings" => 2,
        _ => return,
    };
    let webview = invoke.message.webview_ref();
    if webview.label() != "settings" || webview.window().label() != "settings" {
        return;
    }
    let app = webview.app_handle();
    let Some(progress) = app.try_state::<Progress>() else {
        return;
    };
    if !progress.active() || !profile_enabled(app.state::<super::state::Harness>().profile()) {
        return;
    }
    let counter = match counter {
        0 => &progress.0.reads,
        1 => &progress.0.changes,
        _ => &progress.0.saves,
    };
    let _ = counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
        Some(value.saturating_add(1).min(4096))
    });
}

pub(super) async fn run(
    app: &AppHandle<Wry>,
    harness: &super::state::Harness,
    child: &mut Webview<Wry>,
    session: &mut String,
) -> Result<(), &'static str> {
    let progress = app
        .try_state::<Progress>()
        .map(|state| state.inner().clone())
        .ok_or(schema::BASELINE_INVALID)?;
    progress.set_active(true);
    if let Err(error) = login_cross_entry_flow::run(app, harness, &progress, child, session).await {
        progress.error(error);
        return Err(error);
    }
    progress.set_active(false);
    Ok(())
}

pub(super) async fn finalize(app: &AppHandle<Wry>, harness: &super::state::Harness) -> bool {
    let Some(state) = app.try_state::<Progress>() else {
        return false;
    };
    let progress = state.inner().clone();
    progress.set_active(false);
    let mut fallback_closed = close_fallback(app, &progress).await;
    if !fallback_closed {
        progress.error(schema::CLEANUP_FAILED);
        fallback_closed = close_fallback(app, &progress).await;
    }

    let terminal = login_cross_entry_storage::coordinator_barrier(app).await;
    if !terminal {
        progress.error(schema::COORDINATOR_TIMEOUT);
    }
    let mut original = progress.original();
    if terminal && original.is_none() {
        if let Ok(snapshot) =
            login_cross_entry_storage::snapshot_original(app, harness.database()).await
        {
            progress.set_original(snapshot.clone());
            original = Some(snapshot);
        }
    }

    let mut restored = false;
    let mut after_hash = None;
    if terminal {
        if let Some(original_settings) = original.as_ref() {
            match login_cross_entry_storage::restore(app, harness.database(), original_settings)
                .await
            {
                Ok((hash, exact)) => {
                    let matches_original = exact && hash == original_settings.before_sha256;
                    after_hash = Some(hash);
                    restored = matches_original;
                    if matches_original {
                        // This is a DB readback fact after exact raw restoration, not a UI pass.
                        progress
                            .set_final_database_enabled(original_settings.original_launch_at_login);
                    }
                }
                Err(_) => progress.error(schema::RESTORE_FAILED),
            }
        }
    }
    if !restored {
        progress.error(schema::CLEANUP_FAILED);
    }
    let fallback_count = if app.get_webview_window("settings").is_some() {
        1
    } else {
        0
    };
    let pending = harness.pending_probe_count();
    let cleanup = serde_json::json!({
        "fallbackWindowCount": fallback_count,
        "coordinatorTerminal": terminal,
        "databaseRestored": restored,
        "pendingProbes": pending,
    });
    let database =
        login_cross_entry_storage::database_report_from_hash(original.as_ref(), after_hash);
    let (stages, errors) = progress.report_parts();
    let report = schema::build(
        harness.profile(),
        &database,
        &stages,
        &progress.counters(),
        &cleanup,
        &errors,
    );
    if !schema::valid_report(harness.profile(), &report)
        || super::local_app_search_report::write_owned_artifact(
            harness.profile(),
            schema::REPORT_NAME,
            &report,
        )
        .is_err()
    {
        progress.error(schema::REPORT_WRITE_FAILED);
        harness.add_error(schema::REPORT_WRITE_FAILED);
    }
    terminal && fallback_closed && fallback_count == 0 && restored && pending == 0
}

async fn close_fallback(app: &AppHandle<Wry>, progress: &Progress) -> bool {
    let Some(pair) = progress.take_fallback() else {
        return app.get_webview_window("settings").is_none();
    };
    let close_result = super::login_cross_entry_window::close(app, &pair.0).await;
    if let Err(error) = close_result {
        if let Some(code) = schema::fallback_close_error(error) {
            progress.error(code);
        }
    }
    if close_result.is_ok() {
        if app.get_webview_window("settings").is_none() {
            return true;
        }
    }
    progress.put_fallback(pair);
    false
}
