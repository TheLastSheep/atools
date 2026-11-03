use super::{
    launch_at_login_operations::NativeOperations, launch_at_login_probe as probe,
    launch_at_login_schema as schema, native, state::Harness,
};
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Webview, Wry};

const NATIVE_OPERATION_DRAIN: Duration = Duration::from_secs(15);

#[derive(Clone)]
struct Progress(Arc<Mutex<ProgressData>>);

struct ProgressData {
    observations: Value,
    errors: Vec<&'static str>,
    activity_before: (Option<bool>, Option<bool>),
    native_operations: NativeOperations,
}

impl Progress {
    fn new(activity_before: (Option<bool>, Option<bool>)) -> Self {
        Self(Arc::new(Mutex::new(ProgressData {
            observations: schema::empty_observations(),
            errors: Vec::new(),
            activity_before,
            native_operations: NativeOperations::default(),
        })))
    }

    fn set_bool(&self, group: &str, field: &str, value: Option<bool>) {
        self.0.lock().observations[group][field] = value.map(Value::Bool).unwrap_or(Value::Null);
    }

    fn set_code(&self, group: &str, value: Option<&str>) {
        self.0.lock().observations[group]["errorCode"] = value
            .map(|code| Value::String(code.to_owned()))
            .unwrap_or(Value::Null);
    }

    fn set_direct_bool(&self, field: &str, value: Option<bool>) {
        self.0.lock().observations[field] = value.map(Value::Bool).unwrap_or(Value::Null);
    }

    fn error(&self, code: &'static str) {
        let mut data = self.0.lock();
        if !data.errors.contains(&code) {
            data.errors.push(code);
        }
    }

    fn activity_before(&self) -> (Option<bool>, Option<bool>) {
        self.0.lock().activity_before
    }

    fn native_operations(&self) -> NativeOperations {
        self.0.lock().native_operations.clone()
    }

    fn report_data(&self) -> (Value, Vec<&'static str>) {
        let data = self.0.lock();
        (data.observations.clone(), data.errors.clone())
    }
}

pub(super) fn initialize(app: &AppHandle<Wry>) {
    if app.try_state::<Progress>().is_none() {
        app.manage(Progress::new(runtime_activity(app)));
    }
    if super::login_cross_entry_journey::profile_enabled(app.state::<Harness>().profile()) {
        super::login_cross_entry_journey::initialize(app);
    }
}

pub(super) fn install_isolated(app: &AppHandle<Wry>, harness: &Harness) {
    let Some(progress) = progress(app) else {
        return;
    };
    let profile = harness.profile();
    let owner_verified = super::super::fixture_owner::verify(profile).is_ok();
    progress.set_bool("install", "ownerVerified", Some(owner_verified));
    if !owner_verified {
        progress.error(schema::OWNER_INVALID);
        return;
    }

    progress.set_bool("install", "attempted", Some(true));
    let installed = std::env::current_exe().ok().is_some_and(|executable| {
        crate::general_settings_runtime::login_items::install_isolated(
            app,
            &profile.root,
            &profile.run_id,
            &executable,
        )
        .is_ok()
    });
    progress.set_bool("install", "proofInstalled", Some(installed));
    if !installed {
        progress.error(schema::INSTALL_FAILED);
    }
}

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) {
    let Some(progress) = progress(app) else {
        return;
    };
    if progress.0.lock().observations["install"]["proofInstalled"].as_bool() != Some(true) {
        return;
    }
    if let Err(error) = run_flow(app, harness, &progress).await {
        if error.starts_with("settings-login-cross-entry-") {
            progress.error(schema::READBACK_INVALID);
            harness.add_error("settings-input-native-state-invalid");
        } else {
            progress.error(error);
        }
    }
}

async fn run_flow(
    app: &AppHandle<Wry>,
    harness: &Harness,
    progress: &Progress,
) -> Result<(), &'static str> {
    let (mut child, mut session) = current_or_open_child(app, harness)
        .await
        .map_err(|_| schema::REOPEN_FAILED)?;
    let baseline = probe::inspect(app, harness, &child)
        .await
        .map_err(|_| schema::BASELINE_INVALID)?;
    let baseline_native = native_read(app, progress).await;
    record_probe(progress, "baseline", &baseline);
    progress.set_bool("baseline", "nativeEnabled", baseline_native);
    if baseline["routeGeneral"].as_bool() != Some(true)
        || baseline["controlUnique"].as_bool() != Some(true)
        || baseline["uiEnabled"].as_bool() != Some(false)
        || baseline["getterEnabled"].as_bool() != Some(false)
        || baseline_native != Some(false)
    {
        return Err(schema::BASELINE_INVALID);
    }

    let enabled = probe::click(app, harness, &child, "enable")
        .await
        .map_err(|_| schema::ENABLE_FAILED)?;
    let enabled_native = native_read(app, progress).await;
    record_click(progress, "enable", &enabled);
    progress.set_bool("enable", "nativeEnabled", enabled_native);
    if enabled["routeGeneral"].as_bool() != Some(true)
        || enabled["controlUnique"].as_bool() != Some(true)
        || enabled["clickDispatched"].as_bool() != Some(true)
        || enabled["uiEnabled"].as_bool() != Some(true)
        || enabled["getterEnabled"].as_bool() != Some(true)
        || !enabled["errorCode"].is_null()
        || enabled_native != Some(true)
    {
        return Err(schema::ENABLE_FAILED);
    }

    close_child(app, harness, &child).await?;
    let (fresh_enabled, fresh_enabled_session) = open_child(app, harness).await?;
    let reopened_enabled = probe::inspect(app, harness, &fresh_enabled)
        .await
        .map_err(|_| schema::REOPEN_FAILED)?;
    let reopened_native = native_read(app, progress).await;
    record_reopen(
        progress,
        "freshEnabled",
        &reopened_enabled,
        fresh_enabled_session != session,
        reopened_native,
    );
    if !reopen_matches(&reopened_enabled, true)
        || reopened_native != Some(true)
        || fresh_enabled_session == session
    {
        return Err(schema::REOPEN_FAILED);
    }
    child = fresh_enabled;
    session = fresh_enabled_session;

    if super::login_cross_entry_journey::profile_enabled(harness.profile()) {
        super::login_cross_entry_journey::run(app, harness, &mut child, &mut session).await?;
    }

    progress.set_bool("externalDisable", "attempted", Some(true));
    let external_app = app.clone();
    let external_result = progress
        .native_operations()
        .run(move || {
            let changed = crate::general_settings_runtime::login_items::read_apply(
                &external_app,
                Some(true),
                Some(false),
            );
            let readback = crate::general_settings_runtime::login_items::read(&external_app).ok();
            (changed, readback)
        })
        .await;
    let (external_changed, external_native) = match external_result {
        Ok((changed, readback)) => (changed, readback),
        Err(()) => (
            Err(crate::general_settings_runtime::login_items::UNAVAILABLE.to_owned()),
            None,
        ),
    };
    let external_confirmed =
        matches!(external_changed, Ok(false)) && external_native == Some(false);
    progress.set_bool("externalDisable", "confirmed", Some(external_confirmed));
    progress.set_bool("externalDisable", "nativeEnabled", external_native);
    if !external_confirmed {
        return Err(schema::EXTERNAL_DISABLE_FAILED);
    }

    let conflict = probe::click(app, harness, &child, "conflict")
        .await
        .map_err(|_| schema::CONFLICT_INVALID)?;
    let conflict_native = native_read(app, progress).await;
    record_click(progress, "conflict", &conflict);
    progress.set_bool(
        "conflict",
        "rollbackObserved",
        Some(
            conflict["clickDispatched"].as_bool() == Some(true)
                && conflict["uiEnabled"].as_bool() == Some(true)
                && conflict["errorCode"].as_str() == Some("conflict"),
        ),
    );
    progress.set_bool("conflict", "nativeEnabled", conflict_native);
    if conflict["routeGeneral"].as_bool() != Some(true)
        || conflict["controlUnique"].as_bool() != Some(true)
        || conflict["clickDispatched"].as_bool() != Some(true)
        || conflict["uiEnabled"].as_bool() != Some(true)
        || conflict["errorCode"].as_str() != Some("conflict")
        || conflict_native != Some(false)
    {
        return Err(schema::CONFLICT_INVALID);
    }

    close_child(app, harness, &child).await?;
    let (fresh_disabled, fresh_disabled_session) = open_child(app, harness).await?;
    let reopened_disabled = probe::inspect(app, harness, &fresh_disabled)
        .await
        .map_err(|_| schema::READBACK_INVALID)?;
    let disabled_native = native_read(app, progress).await;
    record_reopen(
        progress,
        "freshDisabled",
        &reopened_disabled,
        fresh_disabled_session != session,
        disabled_native,
    );
    if !reopen_matches(&reopened_disabled, false)
        || disabled_native != Some(false)
        || fresh_disabled_session == session
    {
        return Err(schema::READBACK_INVALID);
    }
    // Leave this fresh, disabled Child to the common timeout-aware finalizer.
    Ok(())
}

pub(super) async fn finalize(app: &AppHandle<Wry>, harness: &Harness, started: Instant) {
    let Some(progress) = progress(app) else {
        return;
    };
    let child_closed = close_active_child(app, harness).await;
    progress.set_direct_bool("childClosed", Some(child_closed));
    if !child_closed {
        progress.error(schema::CLOSE_FAILED);
    }

    let cross_entry_terminal =
        if super::login_cross_entry_journey::profile_enabled(harness.profile()) {
            super::login_cross_entry_journey::finalize(app, harness).await
        } else {
            true
        };

    let operations = progress.native_operations();
    if !cross_entry_terminal || !operations.wait_until_idle(NATIVE_OPERATION_DRAIN).await {
        progress.set_bool("cleanup", "attempted", Some(false));
        progress.set_bool("cleanup", "unregistered", None);
        progress.set_bool("cleanup", "osEnabled", None);
        progress.set_bool("cleanup", "nativeCallsTerminal", Some(false));
        progress.error(schema::CLEANUP_FAILED);
    } else {
        progress.set_bool("cleanup", "attempted", Some(true));
        let cleanup_app = app.clone();
        let unregister_result = operations.run(move || cleanup_isolated(&cleanup_app)).await;
        let unregister_result = match unregister_result {
            Ok(result) => result,
            Err(()) => Err(crate::general_settings_runtime::login_items::UNAVAILABLE.to_owned()),
        };
        let os_enabled = native_read(app, &progress).await;
        let native_calls_terminal = operations.wait_until_idle(NATIVE_OPERATION_DRAIN).await;
        progress.set_bool("cleanup", "unregistered", Some(unregister_result.is_ok()));
        progress.set_bool("cleanup", "osEnabled", os_enabled);
        progress.set_bool(
            "cleanup",
            "nativeCallsTerminal",
            Some(native_calls_terminal),
        );
        if unregister_result.is_err() || os_enabled != Some(false) || !native_calls_terminal {
            progress.error(schema::CLEANUP_FAILED);
        }
    }

    let (plugin_after, preload_after) = runtime_activity(app);
    let (plugin_before, preload_before) = progress.activity_before();
    let plugin_opened = observed_any(plugin_before, plugin_after);
    let preload_started = observed_any(preload_before, preload_after);
    progress.set_direct_bool("pluginUiOpened", plugin_opened);
    progress.set_direct_bool("preloadStarted", preload_started);
    if plugin_opened != Some(false) || preload_started != Some(false) {
        progress.error(schema::SAFETY_INVALID);
    }

    let (observations, errors) = progress.report_data();
    let attempted = observations["install"]["attempted"].as_bool() == Some(true);
    let report = schema::build(
        harness.profile(),
        elapsed_ms(started),
        attempted,
        &observations,
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
        harness.add_error("settings-input-report-write-failed");
    }
}

fn progress(app: &AppHandle<Wry>) -> Option<Progress> {
    app.try_state::<Progress>()
        .map(|state| state.inner().clone())
}

async fn current_or_open_child(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(Webview<Wry>, String), &'static str> {
    let state = crate::renderer_settings_view::snapshot(app);
    if state["sessionCount"].as_u64() == Some(1) && state["childPresent"].as_bool() == Some(true) {
        return native::active_child(app, Duration::from_secs(2)).await;
    }
    open_child(app, harness).await
}

pub(super) async fn open_child(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(Webview<Wry>, String), &'static str> {
    let before = super::probe::main_open_state(app, harness).await.ok();
    let opened = super::probe::main_open_settings(app, harness)
        .await
        .map_err(|_| schema::REOPEN_FAILED)?;
    if opened["openCallAvailable"].as_bool() != Some(true)
        || opened["openCallDispatched"].as_bool() != Some(true)
    {
        return Err(schema::REOPEN_FAILED);
    }
    super::diagnostics::active_child_after_open(app, harness, before)
        .await
        .map_err(|_| schema::REOPEN_FAILED)
}

pub(super) async fn close_child(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<(), &'static str> {
    super::cleanup::close_child_via_plugin(app, harness, child)
        .await
        .map_err(|_| schema::CLOSE_FAILED)
}

async fn close_active_child(app: &AppHandle<Wry>, harness: &Harness) -> bool {
    match native::active_child(app, Duration::from_secs(2)).await {
        Ok((child, _)) => close_child(app, harness, &child).await.is_ok(),
        Err(_) => {
            native::wait_for_closed(app).await.is_ok()
                && crate::renderer_settings_view::snapshot(app)["sessionCount"].as_u64() == Some(0)
        }
    }
}

fn cleanup_isolated(app: &AppHandle<Wry>) -> Result<(), String> {
    #[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
    {
        crate::general_settings_runtime::login_items::cleanup_isolated(app)
    }
    #[cfg(not(all(feature = "legacy-node-smoke", target_os = "macos")))]
    {
        let _ = app;
        Err("SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED".to_owned())
    }
}

async fn native_read(app: &AppHandle<Wry>, progress: &Progress) -> Option<bool> {
    let app = app.clone();
    progress
        .native_operations()
        .run(move || crate::general_settings_runtime::login_items::read(&app))
        .await
        .ok()
        .and_then(Result::ok)
}

fn record_probe(progress: &Progress, group: &str, value: &Value) {
    for field in [
        "routeGeneral",
        "controlUnique",
        "uiEnabled",
        "getterEnabled",
    ] {
        progress.set_bool(group, field, value[field].as_bool());
    }
}

fn record_click(progress: &Progress, group: &str, value: &Value) {
    for field in [
        "routeGeneral",
        "controlUnique",
        "clickDispatched",
        "uiEnabled",
        "getterEnabled",
    ] {
        progress.set_bool(group, field, value[field].as_bool());
    }
    progress.set_code(group, value["errorCode"].as_str());
}

fn record_reopen(
    progress: &Progress,
    group: &str,
    value: &Value,
    new_session: bool,
    native: Option<bool>,
) {
    progress.set_bool(group, "newSession", Some(new_session));
    record_probe(progress, group, value);
    progress.set_bool(group, "nativeEnabled", native);
}

fn reopen_matches(value: &Value, enabled: bool) -> bool {
    value["routeGeneral"].as_bool() == Some(true)
        && value["controlUnique"].as_bool() == Some(true)
        && value["uiEnabled"].as_bool() == Some(enabled)
        && value["getterEnabled"].as_bool() == Some(enabled)
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn runtime_activity(app: &AppHandle<Wry>) -> (Option<bool>, Option<bool>) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return (None, None);
    };
    let plugin_ui = Some(state.active_plugin.lock().is_some());
    let preload = crate::legacy_runtime::inventory_snapshot(app)
        .ok()
        .filter(|(_, truncated)| !truncated)
        .map(|(sessions, _)| !sessions.is_empty());
    (plugin_ui, preload)
}

fn observed_any(before: Option<bool>, after: Option<bool>) -> Option<bool> {
    if before == Some(true) || after == Some(true) {
        Some(true)
    } else if before == Some(false) && after == Some(false) {
        Some(false)
    } else {
        None
    }
}
