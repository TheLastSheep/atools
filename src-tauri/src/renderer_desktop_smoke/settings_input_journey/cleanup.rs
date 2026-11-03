use super::{native, probe, report, stage, state::Harness};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Wry};

pub(super) async fn close_child_via_plugin(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &tauri::Webview<Wry>,
) -> Result<(), &'static str> {
    let available = probe::child_out_available(app, harness, child).await?;
    if available["available"].as_bool() != Some(true) {
        return Err("settings-input-out-plugin-unavailable");
    }
    probe::trigger_out(child)?;
    native::wait_for_closed(app).await
}

pub(super) async fn finalize(app: &AppHandle<Wry>, harness: &Harness, started: Instant) {
    super::plugin_inventory_journey::finalize(app, harness).await;
    if let Ok((child, _)) = native::active_child(app, Duration::from_secs(2)).await {
        if let Err(error) = close_child_via_plugin(app, harness, &child).await {
            harness.add_error(error);
            // Teardown only after the required original Child close path failed; this run stays red.
            crate::renderer_settings_view::stop(app);
            let _ = native::wait_for_closed(app).await;
        }
    }
    let _ = native::wait_for_closed(app).await;
    let main = probe::main_inspect(app, harness).await.ok();
    if main
        .as_ref()
        .and_then(|value| value["inputEmpty"].as_bool())
        != Some(true)
    {
        harness.add_error("settings-input-cleanup-failed");
    }

    let uninstall = super::super::settings_input_activation::uninstall(app).await;
    if uninstall.is_err() {
        harness.add_error("settings-input-observer-uninstall-failed");
    }
    let capture = match native::capture(app, harness, None, None).await {
        Ok(capture) => capture,
        Err(error) => {
            harness.add_error(error);
            stage::failed_capture()
        }
    };
    let final_dom = main
        .as_ref()
        .map(|evidence| stage::build_dom(evidence, None))
        .unwrap_or_else(report::empty_dom);
    let final_clean = stage::capture_is_hidden(&capture, "finalCleanup", false)
        && final_dom["inputEmpty"].as_bool() == Some(true)
        && uninstall.is_ok();
    if !final_clean {
        harness.add_error("settings-input-cleanup-failed");
    }
    let cleanup = stage::cleanup_snapshot(&capture);
    stage::push(
        harness,
        "finalCleanup",
        stage::elapsed_ms(started),
        final_dom,
        capture,
        None,
        None,
        final_clean,
        (!final_clean).then_some("settings-input-cleanup-failed"),
    );
    harness.set_cleanup(cleanup);

    super::material::finalize(app, harness, started).await;

    harness.finish();
    let mut value = harness.snapshot(stage::elapsed_ms(started));
    value["passed"] = Value::Bool(report::compute_passed(&value));
    let write_result = harness.profile().write_report(&value);
    if write_result.is_err() {
        harness.add_error("settings-input-report-write-failed");
        value = harness.snapshot(stage::elapsed_ms(started));
        value["passed"] = Value::Bool(false);
        let _ = harness.profile().write_report(&value);
    }
    let exit_code = if write_result.is_ok() && value["passed"].as_bool() == Some(true) {
        0
    } else {
        1
    };
    if let Some(status) = app.try_state::<std::sync::Arc<super::super::FixtureExitStatus>>() {
        status
            .code
            .store(exit_code, std::sync::atomic::Ordering::Release);
    }
    app.exit(exit_code);
}
