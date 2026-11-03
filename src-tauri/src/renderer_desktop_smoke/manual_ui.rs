//! Bounded, human-operated native acceptance. No renderer driver or GUI assertions.
use super::{fixture_owner, profile::Profile, DisabledClipboard};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{
    ipc::{Invoke, InvokeBody},
    AppHandle, Builder, Manager, Wry,
};

#[path = "manual_hotkey_witness.rs"]
pub(crate) mod hotkey_witness;

pub(super) const LIMIT: Duration = Duration::from_secs(600);

pub(super) struct Session {
    profile: Arc<Profile>,
    started: Instant,
    timed_out: AtomicBool,
    reopen_failed: AtomicBool,
    exit_report: ExitReportWriter,
    witness: hotkey_witness::Witness,
}

pub(super) fn validate_paths(root: &Path, output: &Path, run_id: &str) -> Result<(), String> {
    let expected = Path::new("/private/tmp").join(format!("atools-renderer-manual-{run_id}"));
    if root != expected || output != root.join("report.json") {
        return Err("manual-ui requires its fixed private root and root/report.json output".into());
    }
    Ok(())
}

fn validate_owner(profile: &Profile) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    validate_paths(&profile.root, &profile.output, &profile.run_id)?;
    if !profile.manual_ui
        || profile.identifier != format!("dev.atools.renderer-manual.{}", profile.run_id)
    {
        return Err("manual-ui profile identity rejected".into());
    }
    fixture_owner::verify(profile).map_err(str::to_owned)?;
    for (path, mode) in [
        (profile.root.clone(), 0o700),
        (
            profile.root.join(".atools-renderer-smoke-owner.json"),
            0o600,
        ),
    ] {
        let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o777 != mode {
            return Err("manual-ui private ownership rejected".into());
        }
    }
    Ok(())
}

pub(super) fn prepare_state(
    state: crate::state::AppState,
    profile: &Profile,
) -> Result<crate::state::AppState, String> {
    if !profile.manual_ui {
        return Ok(state);
    }
    validate_owner(profile)?;
    let root = profile.root.join("launcher-apps");
    std::fs::create_dir(&root).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    Ok(state.with_launcher_app_catalog(
        crate::launcher_app_catalog_source::LauncherAppCatalogSource::from_owned_fixture_directory(
            &root,
        )?,
    ))
}

pub(super) fn manage(builder: Builder<Wry>, profile: Arc<Profile>) -> Builder<Wry> {
    if !profile.manual_ui {
        return builder;
    }
    builder.manage(Session {
        profile,
        started: Instant::now(),
        timed_out: AtomicBool::new(false),
        reopen_failed: AtomicBool::new(false),
        exit_report: ExitReportWriter::default(),
        witness: hotkey_witness::Witness::default(),
    })
}

pub(super) fn active(app: &AppHandle) -> bool {
    app.try_state::<Session>().is_some()
}

pub(crate) fn authorizes_material(app: &AppHandle) -> bool {
    app.try_state::<Session>().is_some_and(|session| {
        app.config().identifier == session.profile.identifier
            && validate_owner(&session.profile).is_ok()
    })
}

pub(super) fn setup(app: &AppHandle) -> Result<(), String> {
    if !active(app) {
        return Ok(());
    }
    if !authorizes_material(app) {
        return Err("manual-ui owner invalid at setup".into());
    }
    // Standard native app Quit keeps the ordinary exit/teardown path available.
    if crate::renderer_close_shortcut::is_original(app) {return crate::renderer_close_shortcut::setup(app);}
    let menu = tauri::menu::Menu::default(app).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn start(app: &AppHandle) -> bool {
    if !active(app) {
        return false;
    }
    if let Err(error) = crate::window::show_main_window(app) {
        eprintln!("manual-ui initial show: {error}");
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LIMIT).await;
        if let Some(session) = app.try_state::<Session>() {
            session.timed_out.store(true, Ordering::Release);
            app.exit(0);
        }
    });
    true
}

pub(super) fn reopen(app: &AppHandle) {
    if !active(app) {
        return;
    }
    let result = if authorizes_material(app) {
        crate::window::show_main_window(app).map_err(|e| e.to_string())
    } else {
        Err("manual-ui reopen owner rejected".into())
    };
    if let Err(error) = result {
        app.state::<Session>()
            .reopen_failed
            .store(true, Ordering::Release);
        eprintln!("manual-ui reopen: {error}");
    }
}

// Deliberately narrow test-only seam: production validation still owns every admitted call.
pub(super) fn command_allowed(command: &str, body: &Value) -> bool {
    match command {
        "list_launcher_apps"
        | "list_plugins"
        | "get_ztools_renderer_settings"
        | "get_app_update_status"
        | "expand_window"
        | "reset_window"
        | "hide_main_window"
        | "open_renderer_settings"
        | "close_renderer_settings"
        | "notify_renderer_settings_input" => true,
        "call_renderer_settings" => match body["operation"].as_str() {
            Some(
                "ready"
                | "readGeneral"
                | "readCommands"
                | "readCommandSettings"
                | "readAliases"
                | "readCommandDataPage"
                | "readLocalShortcuts"
                | "updateSubInput"
                | "outAcknowledged"
                | "close"
                | "setTheme"
                | "setWindowOpacity"
                | "startHotkeyRecording"
                | "stopHotkeyRecording",
            ) => true,
            Some("patchGeneral") => safe_patch(&body["payload"]["changes"]),
            _ => false,
        },
        _ => false,
    }
}

fn safe_patch(changes: &Value) -> bool {
    changes.as_object().is_some_and(|object| {
        !object.is_empty()
            && object.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "theme"
                        | "hotkey"
                        | "opacity"
                        | "searchMode"
                        | "autoClear"
                        | "autoBackToSearch"
                        | "showMatchRecommendation"
                        | "builtinAppShortcutsEnabled"
                )
            })
            && atools_core::db::validate_renderer_general_settings_patch(
                &object
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            )
            .is_ok()
    })
}

pub(super) fn reject_if_blocked(invoke: Invoke<Wry>) -> Result<Invoke<Wry>, ()> {
    if !active(&invoke.message.webview().app_handle()) {
        return Ok(invoke);
    }
    let allowed = match invoke.message.payload() {
        InvokeBody::Json(body) => command_allowed(invoke.message.command(), body),
        _ => false,
    };
    if allowed {
        Ok(invoke)
    } else {
        invoke
            .resolver
            .reject("This operation is disabled in manual native acceptance");
        Err(())
    }
}

/// AppKit's standard Quit can terminate without returning from `run_return`.
/// Record only facts observed in Exit, before the ordinary host teardown starts.
pub(super) fn record_exit(app: &AppHandle) -> Result<(), String> {
    let Some(session) = app.try_state::<Session>() else {
        return Ok(());
    };
    validate_owner(&session.profile)?;
    // Fixture-only explicit ownership release; ordinary host Exit still runs afterward.
    crate::hotkey::recording_runtime::shutdown(app);
    let main_release = crate::hotkey::release_owned_main_hotkey(app);
    let clipboard = app.state::<Arc<DisabledClipboard>>();
    #[cfg(feature = "ztools-multiwebview")]
    let settings_at_exit = crate::renderer_settings_view::snapshot(app);
    #[cfg(not(feature = "ztools-multiwebview"))]
    let settings_at_exit = Value::Null;
    let resources = json!({
        "nativeHotkeyWitness": session.witness.snapshot(),
        "recordingShutdown": "invoked-result-not-exposed",
        "ownedMainRelease": match main_release { Ok(()) => json!({"status":"confirmed"}), Err(error) => json!({"status":"unconfirmed","error":error}) },
        "clipboardReads": clipboard.reads.load(Ordering::Relaxed),
        "clipboardWrites": clipboard.writes.load(Ordering::Relaxed),
        "clipboardPastes": clipboard.pastes.load(Ordering::Relaxed),
        "settingsAtExit": settings_at_exit,
        "windowLabelsAtExit": app.webview_windows().keys().cloned().collect::<Vec<_>>(),
        "materialCleanup": "unverified", "sqliteDurability": "requires-independent-read"
    });
    let report = exit_report_payload(
        &session.profile,
        session.started.elapsed().as_millis() as u64,
        session.timed_out.load(Ordering::Acquire),
        session.reopen_failed.load(Ordering::Acquire),
        resources,
    );
    session.exit_report.write_once(&session.profile, &report)
}

#[derive(Default)]
struct ExitReportWriter {
    written: AtomicBool,
}

impl ExitReportWriter {
    // Exit observations are delivered serially on the native main thread.
    // Failed writes remain retryable and never suppress ordinary host teardown.
    fn write_once(&self, profile: &Profile, report: &Value) -> Result<(), String> {
        if self.written.load(Ordering::Acquire) {
            return Ok(());
        }
        profile.write_report(report)?;
        self.written.store(true, Ordering::Release);
        Ok(())
    }
}

fn exit_report_payload(
    profile: &Profile,
    elapsed_ms: u64,
    deadline_requested: bool,
    reopen_failed: bool,
    resources: Value,
) -> Value {
    json!({
        "schemaVersion": 1, "journey": "manual-ui", "runId": profile.run_id,
        "pid": std::process::id(), "identifier": profile.identifier,
        "root": profile.root, "durationLimitMs": LIMIT.as_millis() as u64,
        "elapsedMs": elapsed_ms, "lifecyclePhase": "exit-observed-before-host-teardown",
        "exitObservation": "runtime-exit", "deadlineRequested": deadline_requested,
        "runReturnCode": null, "processTerminalStatus": "external-runner",
        "guiAcceptance": "unverified", "reopenRequestFailed": reopen_failed,
        "resources": resources
    })
}

// This path is available for app.exit()/event-loop stops, but not guaranteed for
// AppKit terminate:. Never rewrite the Exit report or infer terminal facts here.
pub(super) fn finish(app: &AppHandle, run_return_code: i32) -> Result<bool, String> {
    if !active(app) {
        return Ok(false);
    }
    if run_return_code != 0 {
        return Err(format!("manual-ui native exit code: {run_return_code}"));
    }
    Ok(true)
}

#[cfg(test)]
#[path = "manual_ui_tests.rs"]
mod tests;
