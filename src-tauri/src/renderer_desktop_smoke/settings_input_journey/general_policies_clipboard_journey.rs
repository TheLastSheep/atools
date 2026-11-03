use super::{
    general_policies_clipboard_runtime::ClipboardRetentionFixture,
    general_policies_journey as flow, general_policies_probe as policy_probe,
    general_policies_schema as schema, state::Harness,
};
use serde_json::Value;
use tauri::{AppHandle, Webview, Wry};

pub(super) async fn run(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    fixture: &ClipboardRetentionFixture,
    observations: &mut Value,
) -> Result<(), &'static str> {
    for (days, sequence, name, before_phase, after_phase) in [
        (30, 1, "at30", "after30Save", "after30Capture"),
        (1, 2, "at1", "after1Save", "after1Capture"),
    ] {
        let changed = policy_probe::child_general_policies_set_retention(app, harness, child, days)
            .await
            .map_err(|_| schema::CLIPBOARD_EDIT_FAILED)?;
        observations["clipboard"][name]["uiDays"] = changed["uiDays"].clone();
        observations["clipboard"][name]["resetDispatched"] = Value::Bool(false);
        let stored_days = flow::read_days(&flow::read_general_settings(harness).await?)?;
        observations["clipboard"][name]["storedDays"] =
            stored_days.map(Value::from).unwrap_or(Value::Null);
        let edit_ok = changed["routeGeneral"].as_bool() == Some(true)
            && changed["retentionControlUnique"].as_bool() == Some(true)
            && changed["inputDispatched"].as_bool() == Some(true)
            && changed["changeDispatched"].as_bool() == Some(true)
            && changed["blurDispatched"].as_bool() == Some(true)
            && changed["uiDays"].as_u64() == Some(days)
            && changed["storedDays"].as_u64() == Some(days)
            && stored_days == Some(days);
        observations["clipboard"][name]["beforeCapture"] = fixture.snapshot()?;
        if !edit_ok {
            return Err(schema::CLIPBOARD_EDIT_FAILED);
        }
        flow::checkpoint(app, harness, observations, before_phase)?;
        let capture_ok = fixture.capture(sequence).await?;
        observations["clipboard"][name]["captureSucceeded"] = Value::Bool(capture_ok);
        observations["clipboard"][name]["afterCapture"] = fixture.snapshot()?;
        if !capture_ok {
            return Err(schema::CLIPBOARD_CAPTURE_FAILED);
        }
        flow::checkpoint(app, harness, observations, after_phase)?;
    }

    let before_reset = fixture.snapshot()?;
    observations["clipboard"]["afterReset180"]["beforeReset"] = before_reset;
    let reset = policy_probe::child_general_policies_reset_retention(app, harness, child)
        .await
        .map_err(|_| schema::CLIPBOARD_EDIT_FAILED)?;
    observations["clipboard"]["afterReset180"]["uiDays"] = reset["uiDays"].clone();
    observations["clipboard"]["afterReset180"]["resetDispatched"] =
        reset["resetDispatched"].clone();
    let after_reset = fixture.snapshot()?;
    observations["clipboard"]["afterReset180"]["afterReset"] = after_reset;
    let reset_stored = flow::read_days(&flow::read_general_settings(harness).await?)?;
    observations["clipboard"]["afterReset180"]["storedDays"] =
        reset_stored.map(Value::from).unwrap_or(Value::Null);
    if reset["routeGeneral"].as_bool() != Some(true)
        || reset["retentionControlUnique"].as_bool() != Some(true)
        // The original button is v-if days != 180; it disappears after reset.
        || reset["resetButtonUnique"].as_bool() != Some(false)
        || reset["resetDispatched"].as_bool() != Some(true)
        || reset["uiDays"].as_u64() != Some(180)
        || reset_stored != Some(180)
    {
        return Err(schema::CLIPBOARD_EDIT_FAILED);
    }
    flow::checkpoint(app, harness, observations, "afterReset180")?;
    fixture.insert_reset_history()?;
    observations["clipboard"]["afterReset180"]["beforeCapture"] = fixture.snapshot()?;
    let capture_ok = fixture.capture(3).await?;
    observations["clipboard"]["afterReset180"]["captureSucceeded"] = Value::Bool(capture_ok);
    observations["clipboard"]["afterReset180"]["afterCapture"] = fixture.snapshot()?;
    if !capture_ok {
        return Err(schema::CLIPBOARD_CAPTURE_FAILED);
    }
    flow::checkpoint(app, harness, observations, "afterResetCapture")?;
    Ok(())
}
