use super::{
    report::{NativeObservation, Stage},
    Harness,
};
use crate::{launcher_app_catalog_source::LauncherAppCatalogSource, state::AppState};
use std::{
    fs,
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::{AppHandle, Manager, Window, Wry};
use tokio::sync::oneshot;

const WATCHDOG: Duration = Duration::from_secs(120);
const READY_TIMEOUT: Duration = Duration::from_secs(40);
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(12);
const FILE_EVENT_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(40);
const STALE_LAUNCH_NAME: &str = "ATools Catalog Added";

pub(super) fn start(app: AppHandle<Wry>) {
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    tauri::async_runtime::spawn(async move {
        match tokio::time::timeout(WATCHDOG, run(&app, &harness)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => harness.record_error(error),
            Err(_) => harness.record_error("catalog-journey-watchdog-timeout"),
        }
        finish(&app, &harness);
    });
}

fn finish(app: &AppHandle<Wry>, harness: &Harness) {
    let clipboard_counts =
        app.try_state::<Arc<super::super::DisabledClipboard>>()
            .map(|clipboard| {
                (
                    clipboard.reads.load(Ordering::Relaxed) as u64,
                    clipboard.writes.load(Ordering::Relaxed) as u64,
                    clipboard.pastes.load(Ordering::Relaxed) as u64,
                )
            });
    harness.set_clipboard_counts(clipboard_counts);

    let exit_status = app.try_state::<Arc<super::super::FixtureExitStatus>>();
    if exit_status.is_none() {
        harness.record_error("catalog-fixture-exit-status-unavailable");
    }
    if let Err(error) = super::super::main_drop_probe::finish(&app, harness.profile()) {
        harness.record_error(error);
    }
    let report = harness.snapshot();
    let passed = report.get("passed").and_then(serde_json::Value::as_bool) == Some(true);
    let write_succeeded = harness.profile().write_report(&report).is_ok();
    if !write_succeeded {
        tracing::error!(
            diagnostic = "catalog-report-write-failed",
            "Renderer catalog report could not be written"
        );
    }
    let code = if passed && write_succeeded { 0 } else { 1 };
    if let Some(status) = exit_status {
        status.code.store(code, Ordering::Release);
    }
    app.exit(code);
}

async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    harness.wait_ready(READY_TIMEOUT).await?;
    super::super::main_drop_probe::run(&app, harness.profile()).await?;

    create_fixture_app(harness.added_path(), harness.profile())?;
    capture_stage(app, harness, Stage::Added).await?;

    remove_fixture_app(harness.added_path(), harness.profile())?;
    capture_stage(app, harness, Stage::Removed).await?;

    stale_launch(app, harness).await?;
    capture_stage(app, harness, Stage::Disposed).await?;

    create_fixture_app(harness.after_dispose_path(), harness.profile())?;
    wait_for_catalog_count(app, 2, FILE_EVENT_TIMEOUT).await?;
    capture_stage(app, harness, Stage::PostDispose).await?;
    Ok(())
}

async fn capture_stage(
    app: &AppHandle<Wry>,
    harness: &Harness,
    stage: Stage,
) -> Result<(), &'static str> {
    let receiver = harness.begin_stage(stage)?;
    let webview = match crate::window::main_webview(app) {
        Ok(webview) if webview.label() == "main" && webview.window().label() == "main" => webview,
        _ => {
            harness.cancel_stage(stage, "catalog-main-webview-unavailable");
            return Err("catalog-main-webview-unavailable");
        }
    };
    let stage_json = match serde_json::to_string(stage.as_str()) {
        Ok(value) => value,
        Err(_) => {
            harness.cancel_stage(stage, "catalog-probe-protocol-rejected");
            return Err("catalog-probe-protocol-rejected");
        }
    };
    if webview
        .eval(format!(
            "window.__ATOOLS_RENDERER_CATALOG_PROBE__?.observe({stage_json})"
        ))
        .is_err()
    {
        harness.cancel_stage(stage, "catalog-probe-eval-failed");
        return Err("catalog-probe-eval-failed");
    }
    wait_receipt(harness, stage, receiver).await
}

async fn wait_receipt(
    harness: &Harness,
    stage: Stage,
    receiver: oneshot::Receiver<Result<(), &'static str>>,
) -> Result<(), &'static str> {
    match tokio::time::timeout(RECEIPT_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("catalog-probe-protocol-rejected"),
        Err(_) => {
            harness.cancel_stage(stage, "catalog-stage-observation-timeout");
            Err("catalog-stage-observation-timeout")
        }
    }
}

async fn stale_launch(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let receiver = harness.begin_stale_launch()?;
    let target = serde_json::json!({
        "path": harness.added_path().to_string_lossy(),
        "name": STALE_LAUNCH_NAME,
    });
    let target_json = match serde_json::to_string(&target) {
        Ok(value) => value,
        Err(_) => {
            harness.fail_stale_launch("catalog-stale-launch-protocol-rejected");
            return Err("catalog-stale-launch-protocol-rejected");
        }
    };
    let webview = match crate::window::main_webview(app) {
        Ok(webview) => webview,
        Err(_) => {
            harness.fail_stale_launch("catalog-main-webview-unavailable");
            return Err("catalog-main-webview-unavailable");
        }
    };
    if webview
        .eval(format!(
            "window.__ATOOLS_RENDERER_CATALOG_PROBE__?.staleLaunch({target_json})"
        ))
        .is_err()
    {
        harness.fail_stale_launch("catalog-stale-launch-probe-failed");
        return Err("catalog-stale-launch-probe-failed");
    }
    match tokio::time::timeout(RECEIPT_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("catalog-stale-launch-protocol-rejected"),
        Err(_) => {
            harness.fail_stale_launch("catalog-stale-launch-timeout");
            Err("catalog-stale-launch-timeout")
        }
    }
}

async fn wait_for_catalog_count(
    app: &AppHandle<Wry>,
    expected: u64,
    timeout: Duration,
) -> Result<(), &'static str> {
    let source = app
        .try_state::<AppState>()
        .map(|state| Arc::clone(&state.launcher_app_catalog))
        .ok_or("catalog-app-state-unavailable")?;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if native_catalog_count(Arc::clone(&source)).await == Some(expected) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("catalog-post-dispose-native-refresh-timeout");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn native_catalog_count(source: Arc<LauncherAppCatalogSource>) -> Option<u64> {
    tauri::async_runtime::spawn_blocking(move || {
        source.snapshot().ok().map(|apps| apps.len() as u64)
    })
    .await
    .ok()
    .flatten()
}

pub(super) async fn capture_native(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<NativeObservation, &'static str> {
    let source = app
        .try_state::<AppState>()
        .map(|state| Arc::clone(&state.launcher_app_catalog))
        .ok_or("catalog-app-state-unavailable")?;
    let catalog_items = native_catalog_count(source).await;
    let (sender, receiver) = oneshot::channel();
    let observed_app = app.clone();
    let focus_gained_events = harness.focus_gained_events();
    app.run_on_main_thread(move || {
        let observation = crate::window::main_window(&observed_app)
            .map_err(|_| "catalog-main-window-native-snapshot-unavailable")
            .map(|window| {
                let child_webviews = child_webview_count(&window);
                let active_child_layouts = active_child_layout_count(&observed_app);
                let data_store_persistent = observed_app
                    .try_state::<super::super::controller::Harness>()
                    .and_then(|common| common.incognito_persistent());
                NativeObservation {
                    visible: window.is_visible().ok(),
                    focused: window.is_focused().ok(),
                    focus_gained_events,
                    active_child_layouts,
                    child_webviews,
                    data_store_persistent,
                    catalog_items,
                }
            });
        let _ = sender.send(observation);
    })
    .map_err(|_| "catalog-main-thread-snapshot-dispatch-failed")?;
    tokio::time::timeout(Duration::from_secs(2), receiver)
        .await
        .map_err(|_| "catalog-main-thread-snapshot-timeout")?
        .map_err(|_| "catalog-main-thread-snapshot-interrupted")?
}

fn create_fixture_app(
    path: &Path,
    profile: &super::super::profile::Profile,
) -> Result<(), &'static str> {
    validate_fixture_path(path, profile)?;
    fs::create_dir(path).map_err(|_| "catalog-fixture-directory-create-failed")?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "catalog-fixture-directory-create-failed")?;
    if !metadata.file_type().is_dir() {
        return Err("catalog-fixture-directory-create-failed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "catalog-fixture-directory-create-failed")?;
    }
    Ok(())
}

fn remove_fixture_app(
    path: &Path,
    profile: &super::super::profile::Profile,
) -> Result<(), &'static str> {
    validate_fixture_path(path, profile)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "catalog-fixture-directory-remove-failed")?;
    if !metadata.file_type().is_dir() {
        return Err("catalog-fixture-directory-remove-failed");
    }
    fs::remove_dir(path).map_err(|_| "catalog-fixture-directory-remove-failed")
}

fn validate_fixture_path(
    path: &Path,
    profile: &super::super::profile::Profile,
) -> Result<(), &'static str> {
    let parent = path
        .parent()
        .ok_or("catalog-fixture-directory-path-rejected")?;
    let canonical_profile_root =
        fs::canonicalize(&profile.root).map_err(|_| "catalog-fixture-directory-path-rejected")?;
    let expected_parent = canonical_profile_root.join("launcher-apps");
    if !path.is_absolute()
        || parent != expected_parent
        || parent.file_name().and_then(|name| name.to_str()) != Some("launcher-apps")
        || !matches!(
            path.file_name().and_then(|name| name.to_str()),
            Some("ATools Catalog Added.app" | "ATools Catalog AfterDispose.app")
        )
    {
        return Err("catalog-fixture-directory-path-rejected");
    }
    let metadata =
        fs::symlink_metadata(parent).map_err(|_| "catalog-fixture-directory-path-rejected")?;
    if !metadata.file_type().is_dir() {
        return Err("catalog-fixture-directory-path-rejected");
    }
    Ok(())
}

#[cfg(feature = "ztools-multiwebview")]
fn child_webview_count(window: &Window<Wry>) -> Option<u64> {
    Some(
        window
            .webviews()
            .into_iter()
            .filter(|view| view.label() != "main")
            .count() as u64,
    )
}

#[cfg(not(feature = "ztools-multiwebview"))]
fn child_webview_count(_window: &Window<Wry>) -> Option<u64> {
    None
}

#[cfg(feature = "ztools-multiwebview")]
fn active_child_layout_count(app: &AppHandle<Wry>) -> Option<u64> {
    crate::window::main_child_layout_active_count(app)
        .ok()
        .map(|count| count as u64)
}

#[cfg(not(feature = "ztools-multiwebview"))]
fn active_child_layout_count(_app: &AppHandle<Wry>) -> Option<u64> {
    None
}
