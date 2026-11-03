use super::{expectations, native, protocol::Harness, report};
use crate::renderer_desktop_smoke::launcher_journey::evidence::DatabaseEvidence;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, Wry};

const RECEIPT_TIMEOUT: Duration = Duration::from_secs(18);

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    if !harness.fixture_valid() {
        return Err("launch-return-owned-fixture-not-verified");
    }
    #[cfg(feature = "ztools-multiwebview")]
    if harness.profile().registration_source
        == super::super::profile::RegistrationSource::SettingsChild
    {
        return tokio::select! {
            _ = harness.witness.wait_for_focus() => {
                crate::renderer_settings_view::stop(app);
                Err("settings-registration-foreground-observed")
            }
            result = run_settings_child(app, harness) => result,
        };
    }
    run_stages(app, harness).await
}

#[cfg(feature = "ztools-multiwebview")]
async fn run_settings_child(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    match tokio::time::timeout(
        Duration::from_secs(60),
        super::settings_registration_flow::run(app, harness),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            crate::renderer_settings_view::stop(app);
            return Err("settings-registration-watchdog-timeout");
        }
    }
    tokio::time::timeout(Duration::from_secs(120), run_stages(app, harness))
        .await
        .map_err(|_| "launch-return-stages-watchdog-timeout")?
}

async fn run_stages(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    harness.wait_probe_ready(Duration::from_secs(20)).await?;
    let baseline = DatabaseEvidence::read(&harness.database())
        .map_err(|_| "launch-return-database-observation-failed")?;
    if !baseline.empty()
        || baseline.task_run_count() != 0
        || !super::super::launcher_journey::process::markers_absent(
            harness.profile().root.as_path(),
        )
    {
        return Err("launch-return-baseline-not-empty");
    }
    capture_stage(app, harness, 0, "baseline").await?;
    capture_stage(app, harness, 1, "pasted").await?;

    if set_shell_deny(&harness.database()).is_err() {
        expectations::mark_stage_unobserved(harness, 2, "launch-return-deny-policy-not-applied");
        return Err("launch-return-deny-policy-not-applied");
    }
    capture_stage(app, harness, 2, "denied").await?;

    if clear_shell_deny(&harness.database()).is_err() {
        expectations::mark_stage_unobserved(harness, 3, "launch-return-deny-policy-not-cleared");
        return Err("launch-return-deny-policy-not-cleared");
    }
    capture_stage(app, harness, 3, "direct-return").await?;
    capture_stage(app, harness, 4, "typed").await?;
    capture_stage(app, harness, 5, "keyboard-return").await?;
    capture_stage(app, harness, 6, "disposed").await?;

    let keyboard_events =
        expectations::stage_native_count(harness, 5, &["appLaunchedWitness", "deliveredEvents"]);
    let disposed_events =
        expectations::stage_native_count(harness, 6, &["appLaunchedWitness", "deliveredEvents"]);
    let unchanged = keyboard_events.is_some() && keyboard_events == disposed_events;
    if !unchanged {
        harness.record_error("launch-return-native-event-after-dispose");
        return Err("launch-return-native-event-after-dispose");
    }
    native::stop_witness(app, harness);
    tokio::time::sleep(Duration::from_millis(50)).await;
    Ok(())
}

pub(super) async fn finish(app: &AppHandle<Wry>, harness: &Harness) {
    native::stop_witness(app, harness);
    let clipboard = app.try_state::<std::sync::Arc<super::super::DisabledClipboard>>();
    let clipboard_counts = clipboard
        .map(|state| {
            (
                state.reads.load(std::sync::atomic::Ordering::Acquire),
                state.writes.load(std::sync::atomic::Ordering::Acquire),
                state.pastes.load(std::sync::atomic::Ordering::Acquire),
            )
        })
        .unwrap_or((usize::MAX, usize::MAX, usize::MAX));
    if clipboard_counts != (0, 0, 0) {
        harness.record_error("launch-return-clipboard-access-observed");
    }
    let report = harness.finalize(clipboard_counts);
    let passed = report.get("passed").and_then(Value::as_bool) == Some(true);
    let write_succeeded = harness.profile().write_report(&report).is_ok();
    let code = if passed && write_succeeded { 0 } else { 1 };
    if let Some(status) = app.try_state::<std::sync::Arc<super::super::FixtureExitStatus>>() {
        status
            .code
            .store(code, std::sync::atomic::Ordering::Release);
    }
    app.exit(code);
}

async fn capture_stage(
    app: &AppHandle<Wry>,
    harness: &Harness,
    index: usize,
    stage: &'static str,
) -> Result<(), &'static str> {
    let dom = match call_probe(app, harness, stage).await {
        Ok(dom) => dom,
        Err(error) => {
            match crate::window::main_webview(app) {
                Ok(webview) => match super::failure_snapshot::read(webview).await {
                    Some(dom) => {
                        if !super::snapshot::valid_dom(&dom) {
                            harness.record_error("launch-return-failure-snapshot-shape-rejected");
                        }
                        let native = native::capture(app, harness, &dom, stage).await;
                        harness.set_probes(native.first_probe.clone(), native.second_probe.clone());
                        harness.set_stage(index, dom, native.value, false, Some(error));
                    }
                    None => {
                        harness.record_error("launch-return-failure-snapshot-unavailable");
                        harness.set_stage(
                            index,
                            report::unknown_dom(),
                            report::empty_native(),
                            false,
                            Some(error),
                        );
                    }
                },
                Err(_) => {
                    harness.record_error("launch-return-failure-snapshot-unavailable");
                    harness.set_stage(
                        index,
                        report::unknown_dom(),
                        report::empty_native(),
                        false,
                        Some(error),
                    );
                }
            }
            return Err(error);
        }
    };
    let native = native::capture(app, harness, &dom, stage).await;
    harness.set_probes(native.first_probe.clone(), native.second_probe.clone());
    #[cfg(feature = "ztools-multiwebview")]
    if harness.profile().registration_source
        == super::super::profile::RegistrationSource::SettingsChild
    {
        let observed =
            super::settings_registration_focus::observe(app, harness, &format!("launch-{stage}"))
                .await?;
        let hidden = super::settings_registration_focus::hidden(&observed);
        harness.append_registration_focus(observed);
        if !hidden {
            harness.set_stage(
                index,
                dom,
                native.value,
                false,
                Some("settings-registration-foreground-observed"),
            );
            return Err("settings-registration-foreground-observed");
        }
    }
    let error = expectations::phase_error(
        stage,
        &dom,
        &native,
        &native.first_probe,
        &native.second_probe,
        harness.profile().launch_target_kind,
        harness.profile().registration_source,
    );
    harness.set_stage(index, dom, native.value, error.is_none(), error);
    if let Some(error) = error {
        return Err(error);
    }
    Ok(())
}

async fn call_probe(
    app: &AppHandle<Wry>,
    harness: &Harness,
    stage: &'static str,
) -> Result<Value, &'static str> {
    let (nonce, receiver) = harness.begin_stage(stage)?;
    let webview = match crate::window::main_webview(app) {
        Ok(webview) => webview,
        Err(_) => {
            harness.cancel_stage(stage, &nonce);
            return Err("launch-return-main-webview-unavailable");
        }
    };
    let stage_json =
        serde_json::to_string(stage).map_err(|_| "launch-return-stage-argument-invalid")?;
    let nonce_json =
        serde_json::to_string(&nonce).map_err(|_| "launch-return-stage-argument-invalid")?;
    let script = format!(
        "if(!window.__ATOOLS_RENDERER_LAUNCH_RETURN__||typeof window.__ATOOLS_RENDERER_LAUNCH_RETURN__.run!==\"function\")throw new Error(\"launch-return-probe-not-ready\");window.__ATOOLS_RENDERER_LAUNCH_RETURN__.run({stage_json},{nonce_json});"
    );
    if webview.eval(script).is_err() {
        harness.cancel_stage(stage, &nonce);
        return Err("launch-return-renderer-probe-not-ready");
    }
    match tokio::time::timeout(RECEIPT_TIMEOUT, receiver).await {
        Ok(Ok(Ok(dom))) => Ok(dom),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err("launch-return-receipt-channel-interrupted"),
        Err(_) => {
            harness.cancel_stage(stage, &nonce);
            Err("launch-return-renderer-probe-timeout")
        }
    }
}

fn set_shell_deny(db: &atools_core::Database) -> Result<(), ()> {
    let policies =
        crate::agent_tools::set_agent_scope_policy(db, "shell", "deny").map_err(|_| ())?;
    let denied = policies
        .iter()
        .any(|policy| policy.scope == "shell" && policy.decision == "deny");
    if denied {
        Ok(())
    } else {
        Err(())
    }
}

fn clear_shell_deny(db: &atools_core::Database) -> Result<(), ()> {
    let policies =
        crate::agent_tools::set_agent_scope_policy(db, "shell", "confirm").map_err(|_| ())?;
    let cleared = policies
        .iter()
        .any(|policy| policy.scope == "shell" && policy.decision == "confirm");
    if cleared {
        Ok(())
    } else {
        Err(())
    }
}
