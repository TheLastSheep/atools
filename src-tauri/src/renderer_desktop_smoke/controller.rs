use super::observations::{Stage, FOCUS_TARGET_LABEL};
#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
use std::time::Instant;
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[path = "protocol.rs"]
mod protocol;
pub(in crate::renderer_desktop_smoke) use protocol::{
    handler, handles, is_local_root_url, on_page_load, record_window_event, Harness,
};

const SETTINGS_JOURNEY_TIMEOUT: Duration = Duration::from_secs(120);
const LAUNCHER_JOURNEY_TIMEOUT: Duration = Duration::from_secs(120);
const MULTIWEBVIEW_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(29);
const READINESS_TIMEOUT: Duration = Duration::from_secs(12);
const EVENT_TIMEOUT: Duration = Duration::from_secs(2);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(35);
const MACOS_ACTIVATION_UNCONFIRMED_PREFIX: &str =
    "macOS activation did not result in the main window being foregrounded";

pub(super) fn start(app: AppHandle) {
    let harness = app.state::<Harness>().inner().clone();
    if crate::window::main_window(&app).is_err() {
        harness.note_error("main-window-missing-at-controller-start");
    }

    tauri::async_runtime::spawn(async move {
        let timeout = if harness.profile().settings_journey {
            SETTINGS_JOURNEY_TIMEOUT
        } else if harness.profile().launcher_journey {
            LAUNCHER_JOURNEY_TIMEOUT
        } else if cfg!(feature = "ztools-multiwebview") {
            MULTIWEBVIEW_TIMEOUT
        } else {
            DEFAULT_TIMEOUT
        };
        match tokio::time::timeout(timeout, drive(&app, &harness)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => harness.note_error(error),
            Err(_) => harness.note_error("renderer-controller-watchdog-timeout"),
        }
        #[cfg(feature = "ztools-multiwebview")]
        if !harness.profile().settings_journey && !harness.profile().launcher_journey {
            if let Err(error) = super::multiwebview::cleanup(&app).await {
                harness.note_error(error);
            }
        }
        finish(&app, &harness);
    });
}

async fn drive(app: &AppHandle, harness: &Harness) -> Result<(), &'static str> {
    harness.wait_ready(READINESS_TIMEOUT).await?;
    if let Err(error) = crate::window::show_main_window(app) {
        let classification = if error
            .to_string()
            .contains(MACOS_ACTIVATION_UNCONFIRMED_PREFIX)
        {
            "macos-activation-unconfirmed"
        } else {
            "foreground-request-rejected"
        };
        eprintln!("renderer-smoke initial-show-failure classification={classification}");
        #[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
        {
            let focus_gained_before = harness.event_count("main", "focus-gained");
            let started = Instant::now();
            let settled = wait_main_state(app, true, true, EVENT_TIMEOUT).await;
            let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            let focus_gained_after = harness.event_count("main", "focus-gained");
            let (visible, focused) = match crate::window::main_window(app) {
                Ok(window) => (window.is_visible().ok(), window.is_focused().ok()),
                Err(_) => (None, None),
            };
            eprintln!(
                "renderer-smoke activation-settling {}",
                serde_json::json!({
                    "schemaVersion": 1,
                    "kind": "activation-settling",
                    "pid": std::process::id(),
                    "deadlineMs": 2000,
                    "elapsedMs": elapsed_ms,
                    "settled": settled,
                    "visible": visible,
                    "focused": focused,
                    "focusGainedBefore": focus_gained_before,
                    "focusGainedAfter": focus_gained_after,
                })
            );
        }
        return Err("ready-main-window-foreground-show-failed");
    }
    if harness.wait_incognito(EVENT_TIMEOUT).await != Some(false) {
        harness.note_error("incognito-webview-data-store-not-proven-nonpersistent");
    }

    if !wait_main_state(app, true, true, EVENT_TIMEOUT).await {
        harness.note_error("initial-main-window-not-natively-visible-and-focused");
    }
    #[cfg(feature = "ztools-multiwebview")]
    if harness.profile().settings_journey {
        super::settings_journey::run(app).await;
    } else if !harness.profile().launcher_journey {
        super::multiwebview::prepare_and_verify(app).await?;
    }
    capture_stage(app, harness, Stage::Shown).await?;

    set_fixture_query(app)?;
    capture_stage(app, harness, Stage::Prepared).await?;

    let focus_lost_before_hide = harness.event_count("main", "focus-lost");
    if crate::window::hide_main_window(app).is_err() {
        harness.note_error("production-main-window-hide-failed");
    }
    if !wait_for_event_and_state(
        app,
        harness,
        "main",
        "focus-lost",
        focus_lost_before_hide,
        false,
    )
    .await
    {
        harness.note_error("main-window-hide-did-not-produce-native-hidden-focus-loss");
    }
    capture_stage(app, harness, Stage::Hidden).await?;

    let focus_gained_before_show = harness.event_count("main", "focus-gained");
    if crate::window::show_main_window(app).is_err() {
        harness.note_error("production-main-window-reshow-failed");
    }
    if !wait_for_event_and_state(
        app,
        harness,
        "main",
        "focus-gained",
        focus_gained_before_show,
        true,
    )
    .await
    {
        harness.note_error("main-window-reshow-did-not-produce-native-focus-gain");
    }
    capture_stage(app, harness, Stage::Reshown).await?;

    set_fixture_query(app)?;
    capture_stage(app, harness, Stage::PreparedBlur).await?;

    let focus_lost_before_target = harness.event_count("main", "focus-lost");
    let target_focus_before = harness.event_count(FOCUS_TARGET_LABEL, "focus-gained");
    let target = create_focus_target(app)?;
    target
        .show()
        .map_err(|_| "auxiliary-focus-window-show-failed")?;
    target
        .set_focus()
        .map_err(|_| "auxiliary-focus-window-focus-failed")?;
    let target_blur_observed = wait_for_auxiliary_blur(
        app,
        harness,
        &target,
        focus_lost_before_target,
        target_focus_before,
    )
    .await;
    if !target_blur_observed {
        harness.note_error("auxiliary-window-did-not-cause-production-main-blur-hide");
    }
    capture_stage(app, harness, Stage::BlurHidden).await?;

    close_focus_target(harness, &target).await;
    let focus_gained_before_return = harness.event_count("main", "focus-gained");
    if crate::window::show_main_window(app).is_err() {
        harness.note_error("production-main-window-blur-return-show-failed");
    }
    if !wait_for_event_and_state(
        app,
        harness,
        "main",
        "focus-gained",
        focus_gained_before_return,
        true,
    )
    .await
    {
        harness.note_error("blur-return-did-not-produce-native-focus-gain");
    }
    capture_stage(app, harness, Stage::BlurReturn).await?;

    #[cfg(feature = "legacy-node-smoke")]
    if harness.profile().launcher_journey {
        super::launcher_journey::run(app).await;
        if !wait_main_state(app, true, true, EVENT_TIMEOUT).await {
            let _ = crate::window::show_main_window(app);
            if let Ok(window) = crate::window::main_window(app) {
                let _ = window.set_focus();
            }
            wait_main_state(app, true, true, EVENT_TIMEOUT).await;
        }
    }

    capture_stage(app, harness, Stage::Disposed).await?;

    let focus_lost_after_dispose = harness.event_count("main", "focus-lost");
    let target_focus_after_dispose = harness.event_count(FOCUS_TARGET_LABEL, "focus-gained");
    let target = create_focus_target(app)?;
    if target.show().is_err() || target.set_focus().is_err() {
        harness.note_error("post-dispose-auxiliary-window-focus-failed");
    }
    if !wait_for_auxiliary_blur(
        app,
        harness,
        &target,
        focus_lost_after_dispose,
        target_focus_after_dispose,
    )
    .await
    {
        harness.note_error("post-dispose-focus-loss-cycle-not-observed");
    }
    close_focus_target(harness, &target).await;
    let focus_gained_after_dispose = harness.event_count("main", "focus-gained");
    if crate::window::show_main_window(app).is_err() {
        harness.note_error("post-dispose-main-window-show-failed");
    }
    if !wait_for_event_and_state(
        app,
        harness,
        "main",
        "focus-gained",
        focus_gained_after_dispose,
        true,
    )
    .await
    {
        harness.note_error("post-dispose-main-window-focus-return-not-observed");
    }
    capture_stage(app, harness, Stage::DisposedReturn).await?;
    Ok(())
}

fn set_fixture_query(app: &AppHandle) -> Result<(), &'static str> {
    let webview =
        crate::window::main_webview(app).map_err(|_| "main-webview-unavailable-for-query-input")?;
    webview
        .eval("window.__ATOOLS_RENDERER_DESKTOP_SMOKE__?.setFixtureQuery()")
        .map_err(|_| "programmatic-search-input-eval-failed")
}

async fn capture_stage(
    app: &AppHandle,
    harness: &Harness,
    stage: Stage,
) -> Result<(), &'static str> {
    let webview = crate::window::main_webview(app)
        .map_err(|_| "main-webview-unavailable-for-stage-capture")?;
    let receiver = harness.begin_capture(stage)?;
    let stage_argument = serde_json::to_string(stage.as_str())
        .map_err(|_| "renderer-stage-argument-serialization-failed")?;
    let script = format!("window.__ATOOLS_RENDERER_DESKTOP_SMOKE__?.capture({stage_argument})");
    if webview.eval(script).is_err() {
        harness.cancel_capture(stage);
        return Err("renderer-stage-capture-eval-failed");
    }
    match tokio::time::timeout(CAPTURE_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("renderer-stage-observation-channel-interrupted"),
        Err(_) => {
            harness.cancel_capture(stage);
            Err("renderer-stage-capture-timeout")
        }
    }
}

fn create_focus_target(app: &AppHandle) -> Result<WebviewWindow, &'static str> {
    if app.get_webview_window(FOCUS_TARGET_LABEL).is_some() {
        return Err("auxiliary-focus-window-label-already-in-use");
    }
    let blank_url = tauri::Url::parse("about:blank").map_err(|_| "about-blank-url-invalid")?;
    WebviewWindowBuilder::new(app, FOCUS_TARGET_LABEL, WebviewUrl::External(blank_url))
        .title("ATools focus acceptance target")
        .inner_size(2.0, 2.0)
        .position(0.0, 0.0)
        .resizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .on_navigation(|url| url.as_str() == "about:blank")
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .disable_javascript()
        .incognito(true)
        .build()
        .map_err(|_| "auxiliary-focus-window-create-failed")
}

async fn close_focus_target(harness: &Harness, target: &WebviewWindow) {
    let destroyed_before = harness.event_count(FOCUS_TARGET_LABEL, "destroyed");
    if target.close().is_err() {
        harness.note_error("auxiliary-focus-window-close-failed");
        return;
    }
    if !wait_until(EVENT_TIMEOUT, || {
        harness.event_count(FOCUS_TARGET_LABEL, "destroyed") > destroyed_before
    })
    .await
    {
        harness.note_error("auxiliary-focus-window-destroy-event-timeout");
    }
}

async fn wait_for_auxiliary_blur(
    app: &AppHandle,
    harness: &Harness,
    target: &WebviewWindow,
    main_focus_lost_before: u32,
    target_focus_gained_before: u32,
) -> bool {
    wait_until(EVENT_TIMEOUT, || {
        let main_hidden = crate::window::main_window(app)
            .ok()
            .and_then(|window| window.is_visible().ok())
            == Some(false);
        let main_focus_lost = harness.event_count("main", "focus-lost") > main_focus_lost_before;
        let target_focus_gained =
            harness.event_count(FOCUS_TARGET_LABEL, "focus-gained") > target_focus_gained_before;
        let target_focused = target.is_focused().ok() == Some(true);
        main_hidden && main_focus_lost && target_focus_gained && target_focused
    })
    .await
}

async fn wait_for_event_and_state(
    app: &AppHandle,
    harness: &Harness,
    label: &'static str,
    event: &'static str,
    event_count_before: u32,
    visible: bool,
) -> bool {
    wait_until(EVENT_TIMEOUT, || {
        let event_received = harness.event_count(label, event) > event_count_before;
        let target_state = crate::window::main_window(app)
            .ok()
            .and_then(|window| Some((window.is_visible().ok()?, window.is_focused().ok()?)));
        let window_state_matches = match (visible, target_state) {
            (true, Some((is_visible, focused))) => is_visible && focused,
            (false, Some((is_visible, focused))) => !is_visible && !focused,
            (_, None) => false,
        };
        event_received && window_state_matches
    })
    .await
}

async fn wait_main_state(app: &AppHandle, visible: bool, focused: bool, timeout: Duration) -> bool {
    wait_until(timeout, || {
        crate::window::main_window(app)
            .ok()
            .and_then(|window| Some((window.is_visible().ok()?, window.is_focused().ok()?)))
            == Some((visible, focused))
    })
    .await
}

async fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn finish(app: &AppHandle, harness: &Harness) {
    if !harness.begin_finish() {
        return;
    }
    let report = harness.report(app);
    let passed = report.get("passed").and_then(serde_json::Value::as_bool) == Some(true);
    let write_succeeded = harness.profile().write_report(&report).is_ok();
    if !write_succeeded {
        eprintln!("renderer desktop smoke report write failed");
    }
    let code = if passed && write_succeeded { 0 } else { 1 };
    app.state::<std::sync::Arc<super::FixtureExitStatus>>()
        .code
        .store(code, Ordering::Release);
    app.exit(code);
}
