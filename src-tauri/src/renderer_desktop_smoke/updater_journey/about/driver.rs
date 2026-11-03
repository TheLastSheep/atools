use super::*;
use serde_json::{json, Value};
use std::time::Duration;
const POLL: Duration = Duration::from_millis(40);
pub(super) fn start(app: AppHandle) {
    let Some(h) = app.try_state::<Harness>().map(|h| h.inner().clone()) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let mut errors = Vec::new();
        match tokio::time::timeout(Duration::from_secs(120), run(&app, &h)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => errors.push(e),
            Err(_) => errors.push("about-watchdog-timeout".into()),
        }
        if cleanup(&app, &h).await.is_err() {
            errors.push("about-owned-cleanup-incomplete".into());
        }
        let n = facts::snapshots(&app, &h, "cleanup").unwrap_or(Value::Null);
        let fixture = h.control.snapshot();
        let s = state(&h).expect("prepared About state");
        if fixture["checkCalls"] != 1
            || fixture["downloadCalls"] != 0
            || fixture["activeWork"] != 0
            || fixture["forbiddenEffectCalls"] != 0
            || h.destroyed.load(Ordering::Acquire) != 1
            || s.closed.load(Ordering::Acquire) != 2
            || !s.stale_rejected.load(Ordering::Acquire)
            || h.rejected.load(Ordering::Acquire) != 2
            || s.rows().len() != state::STAGES.len()
        {
            errors.push("about-final-counts-rejected".into());
        }
        let report = json!({"schemaVersion":1,"journey":"updater","mode":"about","runId":h.profile.run_id,"pid":std::process::id(),"passed":errors.is_empty(),"errors":errors,"inputSource":"rust-injected-javascript","physicalOsInput":false,"realSdk":false,"realNetwork":false,"fakeClock":false,"appVersion":app.package_info().version.to_string(),"stages":s.rows(),"fixture":fixture,"rejectedProbeCalls":h.rejected.load(Ordering::Acquire),"cleanup":{"settings":n["settings"],"updater":n["updater"],"runtime":n["runtime"],"destroyedEvents":h.destroyed.load(Ordering::Acquire),"closedChildGenerations":s.closed.load(Ordering::Acquire),"staleChildRejected":s.stale_rejected.load(Ordering::Acquire),"activeWork":h.control.active(),"listenerCount":null,"listenersDirectlyObserved":false}});
        let written = h.profile.write_report(&report).is_ok();
        let code = if report["passed"] == true && written {
            0
        } else {
            1
        };
        if let Some(status) =
            app.try_state::<Arc<crate::renderer_desktop_smoke::FixtureExitStatus>>()
        {
            status.code.store(code, Ordering::Release);
        }
        app.exit(code);
    });
}
async fn run(app: &AppHandle, h: &Harness) -> Result<(), String> {
    check(app, h, "main-ready").await?;
    eval_main(app, &probe::action("openSettings")?)?;
    wait_child(app, h, 1).await?;
    eval_child(h, &probe::run("about-ready"))?;
    check(app, h, "about-ready").await?;
    eval_child(h, &probe::run("about-manual"))?;
    check(app, h, "about-manual").await?;
    wait_popup(app, h).await?;
    eval_popup(app, h, &probe::run("popup-ready"))?;
    check(app, h, "popup-ready").await?;
    for stage in ["auto-on", "auto-off"] {
        eval_child(h, &probe::run(stage))?;
        check(app, h, stage).await?;
    }
    let first = state(h)?.child()?;
    eval_child(h, &probe::action("closeSettings")?)?;
    wait_settings_empty(app, h).await?;
    let parent = crate::window::main_window(app).map_err(|_| "about-main-missing")?;
    let rejected = crate::renderer_settings_view::fixture_call_renderer_settings(
        app.clone(),
        first.view,
        parent,
        first.id,
        "getAppVersion".into(),
        json!({}),
    )
    .await
    .is_err();
    state(h)?.stale_rejected.store(rejected, Ordering::Release);
    if !rejected {
        return Err("about-stale-child-accepted".into());
    }
    native_closed(app, h, "settings-closed")?;
    eval_main(app, &probe::action("openSettings")?)?;
    wait_child(app, h, 2).await?;
    eval_child(h, &probe::run("about-reopened"))?;
    check(app, h, "about-reopened").await?;
    eval_child(h, &probe::action("closeSettings")?)?;
    wait_settings_empty(app, h).await?;
    native_closed(app, h, "settings-final-closed")?;
    eval_popup(app, h, &probe::run("popup-disposed"))?;
    check(app, h, "popup-disposed").await?;
    wait_empty(app, h).await?;
    crate::renderer_updater::stop(app);
    eval_main(app, &probe::run("main-disposed"))?;
    check(app, h, "main-disposed").await?;
    Ok(())
}
fn native_closed(app: &AppHandle, h: &Harness, stage: &str) -> Result<(), String> {
    let row = facts::row(
        app,
        h,
        stage,
        "native",
        None,
        None,
        Value::Null,
        Value::Null,
    )?;
    super::validate::row(h, stage, &row, &app.package_info().version.to_string())?;
    state(h)?.closed.fetch_add(1, Ordering::AcqRel);
    state(h)?.accept(row, h)
}
async fn check(app: &AppHandle, h: &Harness, stage: &str) -> Result<(), String> {
    let row = tokio::time::timeout(
        Duration::from_secs(if stage == "main-ready" { 40 } else { 20 }),
        async {
            loop {
                let changed = h.changed.notified();
                if let Some(row) = state(h)?.get(stage) {
                    return Ok::<_, String>(row);
                }
                changed.await;
            }
        },
    )
    .await
    .map_err(|_| format!("about-{stage}-receipt-timeout"))??;
    super::validate::row(h, stage, &row, &app.package_info().version.to_string())
}
fn eval_main(app: &AppHandle, script: &str) -> Result<(), String> {
    crate::window::main_webview(app)
        .map_err(|_| "about-main-missing")?
        .eval(script)
        .map_err(|_| "about-main-eval-failed".into())
}
fn eval_child(h: &Harness, script: &str) -> Result<(), String> {
    state(h)?
        .child()?
        .view
        .eval(script)
        .map_err(|_| "about-child-eval-failed".into())
}
fn eval_popup(app: &AppHandle, h: &Harness, script: &str) -> Result<(), String> {
    let label = state(h)?
        .popup_label
        .lock()
        .clone()
        .ok_or("about-popup-missing")?;
    app.get_webview_window(&label)
        .ok_or("about-popup-missing")?
        .eval(script)
        .map_err(|_| "about-popup-eval-failed".into())
}
async fn wait_child(app: &AppHandle, h: &Harness, count: usize) -> Result<(), String> {
    wait_until(|| {
        Ok(state(h)?.children.lock().len() == count
            && crate::renderer_settings_view::snapshot(app)["childPresent"] == true)
    })
    .await
}
async fn wait_popup(app: &AppHandle, h: &Harness) -> Result<(), String> {
    wait_until(|| {
        Ok(state(h)?
            .popup_label
            .lock()
            .as_ref()
            .is_some_and(|label| app.get_webview_window(label).is_some()))
    })
    .await
}
async fn wait_settings_empty(app: &AppHandle, h: &Harness) -> Result<(), String> {
    wait_until(|| {
        Ok(super::validate::settings_empty(
            &facts::snapshots(app, h, "cleanup")?["settings"],
        ))
    })
    .await
}
async fn wait_empty(app: &AppHandle, h: &Harness) -> Result<(), String> {
    wait_until(|| {
        Ok(super::validate::resources_empty(&facts::snapshots(
            app, h, "cleanup",
        )?))
    })
    .await
}
async fn wait_until(test: impl Fn() -> Result<bool, String>) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if test()? {
                return Ok(());
            }
            tokio::time::sleep(POLL).await;
        }
    })
    .await
    .map_err(|_| "about-resource-wait-timeout".to_owned())?
}
async fn cleanup(app: &AppHandle, h: &Harness) -> Result<(), String> {
    h.control.release();
    if let (Ok(main), Ok(window)) = (
        crate::window::main_webview(app),
        crate::window::main_window(app),
    ) {
        let children = window
            .webviews()
            .into_iter()
            .filter_map(|v| {
                v.label()
                    .strip_prefix("ztools-settings-")
                    .filter(|s| auth::valid_id(s))
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        if children.len() == 1 {
            let _ = crate::renderer_settings_view::fixture_close_renderer_settings(
                app.clone(),
                main,
                window,
                children[0].clone(),
                "failed".into(),
            )
            .await;
        }
    }
    let label = crate::renderer_updater::fixture_observation::snapshot(app)
        .ok()
        .and_then(|n| n["session"]["label"].as_str().map(str::to_owned));
    if let Some(label) = label {
        *state(h)?.popup_label.lock() = Some(label.clone());
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
    crate::renderer_updater::stop(app);
    wait_empty(app, h).await
}
