//! Direct calls to the actual production commands, retaining caller/session authorization.
use super::super::profile::HeightCase;
use super::{geometry, report, Session};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn raw(app: &AppHandle) -> Result<Option<String>, String> {
    app.state::<crate::state::AppState>()
        .db
        .read_renderer_general_settings()
        .map_err(|e| e.to_string())
}
pub(super) fn validate_initial_raw(
    db: &atools_core::Database,
    case: HeightCase,
) -> Result<(), String> {
    let raw = db
        .read_renderer_general_settings()
        .map_err(|e| e.to_string())?
        .ok_or("height initial General missing")?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let height = value.get("windowDefaultHeight");
    let expected = if case == HeightCase::A {
        None
    } else {
        Some(case.desired())
    };
    if height.map(Value::as_f64) != expected.map(Some)
        || value["r76Unknown"] != json!({"keep":"unchanged"})
    {
        return Err("height initial raw/seed precondition mismatch".into());
    }
    Ok(())
}
async fn open(app: &AppHandle) -> Result<String, String> {
    super::main_entry::open(app).await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(18);
    loop {
        let state = crate::renderer_settings_view::snapshot(app);
        let children: Vec<String> = app
            .webviews()
            .keys()
            .filter_map(|label| label.strip_prefix("ztools-settings-").map(str::to_owned))
            .collect();
        if state["ready"] == true && state["sessionCount"] == 1 && children.len() == 1 {
            super::main_entry::wait(app, "loaded").await?;
            return Ok(children[0].clone());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("height production Main open did not create a ready owned Child".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
}

async fn child_call(
    app: &AppHandle,
    id: &str,
    operation: &str,
    payload: Value,
) -> Result<Value, String> {
    super::validate(app)?;
    let child = app
        .get_webview(&format!("ztools-settings-{id}"))
        .ok_or("height owned child missing")?;
    let parent = child.window();
    crate::renderer_settings_view::fixture_call_renderer_settings(
        app.clone(),
        child,
        parent,
        id.into(),
        operation.into(),
        payload,
    )
    .await
    .map_err(|e| format!("height {operation}: {e:?}"))
}
async fn record(app: &AppHandle, id: &str, stage: &str) -> Result<Value, String> {
    let main = super::main_entry::wait(app, "loaded").await?;
    let mut value = geometry::observe(app, id, stage)?;
    value["mainClient"] = main["client"].clone();
    value["mainWindowNotifications"] = main["windowNotifications"].clone();
    geometry::append(app, value.clone());
    if value["checks"]
        .as_object()
        .unwrap()
        .values()
        .any(|value| value != true)
    {
        return Err(format!("height measured geometry failed at {stage}"));
    }
    if app.state::<Session>().profile.settings_height_case == Some(HeightCase::D)
        && value["parentClipped"] != true
    {
        return Err("height case d did not observe real parent clipping".into());
    }
    Ok(value)
}
async fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    super::validate(app)?;
    let main = crate::window::main_webview(app).map_err(|e| e.to_string())?;
    let parent = main.window();
    crate::renderer_settings_view::fixture_close_renderer_settings(
        app.clone(),
        main,
        parent,
        id.into(),
        "child-out".into(),
    )
    .await
    .map_err(|e| format!("height close: {e:?}"))?;
    let main = super::main_entry::wait(app, "back-to-search").await?;
    let diagnostics = crate::renderer_settings_view::snapshot(app);
    let child_absent = app.get_webview(&format!("ztools-settings-{id}")).is_none();
    let layout_absent = diagnostics["layoutRegistrationCount"] == 0;
    let drained = diagnostics["pendingCalls"] == 0 && diagnostics["pendingWrites"] == 0;
    let parent = crate::window::main_window(app).map_err(|e| e.to_string())?;
    let hidden = !parent.is_visible().map_err(|e| e.to_string())?;
    let unfocused = !parent.is_focused().map_err(|e| e.to_string())?;
    report::update(app, |report| {
        report["closes"].as_array_mut().unwrap().push(json!({"sessionId":id,"diagnostics":diagnostics,
        "childAbsent":child_absent,"layoutAbsent":layout_absent,"pendingDrained":drained,"hidden":hidden,"unfocused":unfocused,"mainClient":main["client"],"mainWindowNotifications":main["windowNotifications"]}))
    });
    if !child_absent
        || !layout_absent
        || !drained
        || diagnostics["sessionCount"] != 0
        || !hidden
        || !unfocused
    {
        return Err("height close cleanup/hidden state unconfirmed".into());
    }
    Ok(())
}
pub(super) async fn close_current(app: &AppHandle) -> Result<(), String> {
    let children: Vec<String> = app
        .webviews()
        .keys()
        .filter_map(|label| label.strip_prefix("ztools-settings-").map(str::to_owned))
        .collect();
    if children.len() != 1 {
        return Err("height cleanup current child identity missing".into());
    }
    close(app, &children[0]).await
}

pub(super) async fn run(app: &AppHandle) -> Result<(), String> {
    let case = app.state::<Session>().profile.settings_height_case.unwrap();
    let before = raw(app)?;
    report::update(app, |report| report["rawGeneral"]["before"] = json!(before));
    let id = open(app).await?;
    let initial = record(app, &id, "initial").await?;
    report::stage(app, "initial-open");
    if let Some(target) = case.target() {
        let current = child_call(app, &id, "readGeneral", json!({})).await?;
        let revision = current["revision"]
            .as_str()
            .ok_or("height revision missing")?;
        child_call(
            app,
            &id,
            "patchGeneral",
            json!({"revision":revision,"changes":{"windowDefaultHeight":target}}),
        )
        .await?;
        let after = raw(app)?.ok_or("height committed raw missing")?;
        let value: Value = serde_json::from_str(&after).map_err(|e| e.to_string())?;
        if value["windowDefaultHeight"].as_f64() != Some(target)
            || value["r76Unknown"] != json!({"keep":"unchanged"})
        {
            return Err("height committed value/unknown field mismatch".into());
        }
        report::update(app, |report| report["rawGeneral"]["after"] = json!(after));
        report::stage(app, "patch-committed");
        let same = record(app, &id, "after-write").await?;
        if initial["parent"] != same["parent"] || initial["child"] != same["child"] {
            return Err("height default write unexpectedly changed current Native geometry".into());
        }
        report::stage(app, "after-write-observed");
        close(app, &id).await?;
        report::stage(app, "initial-closed");
        let reopened = open(app).await?;
        if reopened == id {
            return Err("height reopen reused retired session identity".into());
        }
        let new_geometry = record(app, &reopened, "reopened").await?;
        if initial["parent"]["scale"] == new_geometry["parent"]["scale"]
            && initial["parent"]["workArea"] == new_geometry["parent"]["workArea"]
            && !geometry::same_geometry(&initial, &new_geometry)
        {
            return Err(
                "height cached reopen changed actual geometry at the same scale/workarea".into(),
            );
        }
        report::stage(app, "reopened");
        close(app, &reopened).await?;
        report::stage(app, "reopened-closed");
    } else {
        close(app, &id).await?;
        report::stage(app, "initial-closed");
        report::update(app, |report| {
            report["rawGeneral"]["after"] = json!(raw(app).ok().flatten())
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copied_db_case_precondition_preserves_unknowns_and_rejects_wrong_or_missing_height() {
        let db = atools_core::Database::in_memory().unwrap();
        db.set_setting("settings-general", super::super::source::A_RAW)
            .unwrap();
        assert!(validate_initial_raw(&db, HeightCase::A).is_ok());
        assert!(validate_initial_raw(&db, HeightCase::B).is_err());
        for (case, height) in [
            (HeightCase::B, 200.5),
            (HeightCase::C, 541.0),
            (HeightCase::D, 2001.0),
        ] {
            db.set_setting(
                "settings-general",
                &json!({"windowDefaultHeight":height,"r76Unknown":{"keep":"unchanged"}})
                    .to_string(),
            )
            .unwrap();
            assert!(validate_initial_raw(&db, case).is_ok());
        }
        db.set_setting(
            "settings-general",
            r#"{"windowDefaultHeight":2001,"r76Unknown":{"keep":"changed"}}"#,
        )
        .unwrap();
        assert!(validate_initial_raw(&db, HeightCase::D).is_err());
    }
}
