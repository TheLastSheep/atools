use super::{probe, Harness};
use crate::renderer_updater::fixture_observation;
use serde_json::{json, Value};
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Manager};

const POLL: Duration = Duration::from_millis(40);
const RECEIPT: Duration = Duration::from_secs(20);

pub(in crate::renderer_desktop_smoke) fn start(app: AppHandle) {
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let h = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut errors = Vec::new();
        match tokio::time::timeout(Duration::from_secs(120), run(&app, &h)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => errors.push(error),
            Err(_) => errors.push("updater-journey-watchdog-timeout".into()),
        }
        h.control.release();
        if cleanup(&app, &h).await.is_err() {
            errors.push("updater-owned-cleanup-incomplete".into());
        }
        let native = fixture_observation::snapshot(&app).unwrap_or(Value::Null);
        let fixture = h.control.snapshot();
        if fixture["checkCalls"] != 1
            || fixture["downloadCalls"] != 1
            || fixture["activeWork"] != 0
            || fixture["forbiddenEffectCalls"] != 0
        {
            errors.push("updater-fixture-call-count-mismatch".into());
        }
        if h.destroyed.load(Ordering::Acquire) != 1 || h.rejected.load(Ordering::Acquire) != 2 {
            errors.push("updater-destroy-or-rejection-count-mismatch".into());
        }
        let report = json!({"schemaVersion":1,"journey":"updater","runId":h.profile.run_id,"pid":std::process::id(),
            "passed":errors.is_empty(),"errors":errors,"inputSource":"rust-injected-javascript","physicalOsInput":false,"realSdk":false,
            "stages":h.stages(),"fixture":fixture,"rejectedProbeCalls":h.rejected.load(Ordering::Acquire),
            "cleanup":{"native":native,"destroyedEvents":h.destroyed.load(Ordering::Acquire),"activeWork":h.control.active(),
                "listenerCount":Value::Null,"listenersDirectlyObserved":false}});
        let passed = report["passed"] == true;
        let written = h.profile.write_report(&report).is_ok();
        let code = if passed && written { 0 } else { 1 };
        if let Some(status) = app.try_state::<std::sync::Arc<super::super::FixtureExitStatus>>() {
            status.code.store(code, Ordering::Release);
        }
        app.exit(code);
    });
}
async fn run(app: &AppHandle, h: &Harness) -> Result<(), String> {
    let ready = wait_stage(h, "main-ready").await?;
    validate("main-ready", &ready)?;
    eval_main(app, "main-check")?;
    let checked = wait_stage(h, "main-check").await?;
    validate("main-check", &checked)?;
    let popup = wait_stage(h, "popup-ready").await?;
    validate("popup-ready", &popup)?;
    let candidate = popup["native"]["candidateId"]
        .as_str()
        .ok_or("updater-candidate-not-observed")?
        .to_owned();
    eval_popup(app, h, "popup-busy")?;
    let busy = wait_stage(h, "popup-busy").await?;
    validate("popup-busy", &busy)?;
    if busy["native"]["candidateId"] != candidate || h.control.active() != 1 {
        return Err("updater-busy-candidate-or-work-changed".into());
    }
    h.control.release();
    eval_popup(app, h, "popup-error")?;
    let error = wait_stage(h, "popup-error").await?;
    validate("popup-error", &error)?;
    if error["native"]["candidateId"] != candidate || h.control.active() != 0 {
        return Err("updater-error-candidate-or-work-changed".into());
    }
    eval_popup(app, h, "popup-disposed")?;
    let disposed = wait_stage(h, "popup-disposed").await?;
    validate("popup-disposed", &disposed)?;
    wait_closed(app, h).await?;
    eval_main(app, "main-disposed")?;
    validate("main-disposed", &wait_stage(h, "main-disposed").await?)?;
    Ok(())
}
async fn wait_stage(h: &Harness, stage: &str) -> Result<Value, String> {
    let deadline = if stage == "main-ready" {
        Duration::from_secs(40)
    } else {
        RECEIPT
    };
    tokio::time::timeout(deadline, async {
        loop {
            let changed = h.changed.notified();
            if let Some(value) = h.get(stage) {
                return value;
            }
            changed.await;
        }
    })
    .await
    .map_err(|_| format!("updater-{stage}-receipt-timeout"))
}
fn eval_main(app: &AppHandle, stage: &str) -> Result<(), String> {
    crate::window::main_webview(app)
        .map_err(|_| "updater-main-missing")?
        .eval(probe::run(stage))
        .map_err(|_| "updater-main-eval-failed".into())
}
fn eval_popup(app: &AppHandle, h: &Harness, stage: &str) -> Result<(), String> {
    let label = h.label().ok_or("updater-popup-not-observed")?;
    app.get_webview_window(&label)
        .ok_or("updater-popup-missing")?
        .eval(probe::run(stage))
        .map_err(|_| "updater-popup-eval-failed".into())
}
async fn wait_closed(app: &AppHandle, h: &Harness) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let native = fixture_observation::snapshot(app)?;
            if native["session"].is_null()
                && native["windowCount"] == 0
                && native["opening"] == false
                && native["busy"] == false
                && h.control.active() == 0
                && h.destroyed.load(Ordering::Acquire) == 1
            {
                return Ok(());
            }
            tokio::time::sleep(POLL).await;
        }
    })
    .await
    .map_err(|_| "updater-native-destroy-timeout".to_string())?
}
async fn cleanup(app: &AppHandle, h: &Harness) -> Result<(), String> {
    // The release is retained even if a detached confirmation reaches the fixture late.
    h.control.release();
    let native = fixture_observation::snapshot(app)?;
    if let Some(label) = native["session"]["label"].as_str() {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
    wait_closed(app, h).await
}
fn validate(stage: &str, row: &Value) -> Result<(), String> {
    let dom = &row["dom"];
    let native = &row["native"];
    if dom["ready"] != true {
        return Err(format!("updater-{stage}-dom-not-ready"));
    }
    let valid = match stage {
        "main-ready" => {
            dom["bridgePresent"] == true && dom["rejected"] == true && native["windowCount"] == 0
        }
        "main-check" => {
            dom["bridgePresent"] == true
                && dom["rejected"] == true
                && dom["text"] == "99.78.0"
                && native["windowCount"] == 1
        }
        "popup-ready" => {
            popup_valid(native)
                && native["phase"] == "available"
                && native["busy"] == false
                && dom["bridgePresent"] == true
                && dom["title"].as_str().is_some_and(|s| s.contains("99.78.0"))
                && dom["confirmDisabled"] == false
                && dom["cancelDisabled"] == false
        }
        "popup-busy" => {
            popup_valid(native)
                && native["phase"] == "downloading"
                && native["busy"] == true
                && !native["operationId"].is_null()
                && dom["confirmDisabled"] == true
                && dom["cancelDisabled"] == true
                && dom["rejected"] == true
                && dom["text"].as_str().is_some_and(|s| s.contains("50%"))
        }
        "popup-error" => {
            popup_valid(native)
                && native["phase"] == "error"
                && native["busy"] == false
                && native["errorCode"] == "download_failed"
                && dom["cancelDisabled"] == false
                && dom["text"].as_str().is_some_and(|s| s.contains("下载失败"))
        }
        "popup-disposed" => {
            popup_valid(native) && dom["bridgePresent"] == false && native["busy"] == false
        }
        "main-disposed" => {
            dom["bridgePresent"] == false
                && dom["text"] == "disposed"
                && native["session"].is_null()
                && native["windowCount"] == 0
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("updater-{stage}-facts-rejected"))
    }
}
fn popup_valid(n: &Value) -> bool {
    n["windowCount"] == 1
        && n["session"]["ready"] == true
        && n["session"]["alive"] == true
        && n["session"]["closing"] == false
        && n["session"]["candidateId"] == n["candidateId"]
        && !n["candidateId"].is_null()
        && n["window"]["exists"] == true
        && n["window"]["visible"] == false
        && n["window"]["focused"] == false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_stage_gate_rejects_busy_close_admission_or_missing_dom() {
        let native = json!({"windowCount":1,"session":{"ready":true,"alive":true,"closing":false,"candidateId":"a"},"candidateId":"a",
            "window":{"exists":true,"visible":false,"focused":false},"phase":"downloading","busy":true,"operationId":"b"});
        let mut row = json!({"dom":{"ready":true,"confirmDisabled":true,"cancelDisabled":true,"rejected":true,"text":"50%"},"native":native});
        validate("popup-busy", &row).unwrap();
        row["dom"]["rejected"] = json!(false);
        assert!(validate("popup-busy", &row).is_err());
        row["dom"]["rejected"] = json!(true);
        row["native"]["busy"] = json!(false);
        assert!(validate("popup-busy", &row).is_err());
        assert!(validate("popup-ready", &json!({})).is_err());
    }
}
