use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub(super) fn snapshots(app: &AppHandle, h: &Harness, stage: &str) -> Result<Value, String> {
    h.verify(app)?;
    let state = state(h)?;
    let settings = crate::renderer_settings_view::snapshot(app);
    require_available(&settings)?;
    let child_count = crate::window::main_window(app)
        .map_err(|_| "about-main-missing")?
        .webviews()
        .iter()
        .filter(|v| v.label().starts_with("ztools-settings-"))
        .count();
    let settings = project_settings(
        &settings,
        child_count,
        &crate::renderer_settings_view::bundle::compiled_revision()?,
    )?;
    let n = crate::renderer_updater::fixture_observation::snapshot(app)?;
    let updater = json!({"sessionId":n["session"]["windowId"],"sessionCandidateId":n["session"]["candidateId"],"candidateId":n["candidateId"],"phase":n["phase"],"ready":n["session"]["ready"].as_bool().unwrap_or(false),"alive":n["session"]["alive"].as_bool().unwrap_or(false),"closing":n["session"]["closing"].as_bool().unwrap_or(false),"windowExists":n["window"]["exists"].as_bool().unwrap_or(false),"windowCount":n["windowCount"],"opening":n["opening"],"busy":n["busy"],"operationId":n["operationId"],"windowVisible":n["window"]["visible"],"windowFocused":n["window"]["focused"]});
    let raw =
        h.db.get_setting("settings-general")
            .map_err(|_| "about-general-unavailable")?
            .ok_or("about-general-missing")?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| "about-general-invalid")?;
    let enabled = parsed["autoCheckUpdate"]
        .as_bool()
        .ok_or("about-general-invalid")?;
    let mut baseline = state.baseline.lock();
    if stage == "about-ready" && baseline.is_none() {
        *baseline = Some(parsed.clone());
    }
    let only = baseline.as_ref().map(|base| {
        let mut left = base.clone();
        let mut right = parsed.clone();
        left.as_object_mut().map(|m| m.remove("autoCheckUpdate"));
        right.as_object_mut().map(|m| m.remove("autoCheckUpdate"));
        left == right
    });
    let general = json!({"autoCheckUpdate":enabled,"sentinelMatches":parsed["r79Unknown"]==json!({"runId":h.profile.run_id,"keep":["owned",7]}),"onlyAutoFieldChanged":only,"rawSha256":format!("{:x}",Sha256::digest(raw.as_bytes())),"casWrites":null,"casWritesDirectlyObserved":false});
    let runtime = crate::updater::UpdateCoordinator::about_fixture_snapshot(app)?;
    Ok(json!({"settings":settings,"updater":updater,"general":general,"runtime":runtime}))
}
pub(super) fn row(
    app: &AppHandle,
    h: &Harness,
    stage: &str,
    kind: &str,
    label: Option<&str>,
    id: Option<&str>,
    dom: Value,
    receipt: Value,
) -> Result<Value, String> {
    Ok(
        json!({"stage":stage,"sourceKind":kind,"sourceLabel":label,"sessionId":id,"dom":dom,"receipt":receipt,"native":snapshots(app,h,stage)?}),
    )
}

fn require_available(snapshot: &Value) -> Result<(), String> {
    if snapshot.get("stateAvailable").and_then(Value::as_bool) != Some(true) {
        return Err("about-settings-state-unavailable".into());
    }
    Ok(())
}
fn project_settings(settings: &Value, child_count: usize, revision: &str) -> Result<Value, String> {
    require_available(settings)?;
    Ok(
        json!({"sessionCount":settings["sessionCount"],"childCount":child_count,"ready":settings["ready"],"phase":settings["phase"],"documentAuthorized":settings["documentAuthorized"],"revoked":settings["revoked"],"pendingCalls":settings["pendingCalls"],"pendingWrites":settings["pendingWrites"],"bundleRevisionPresent":settings["bundleRevisionPresent"],"compiledBundleRevision":revision,"layoutRegistrationCount":settings["layoutRegistrationCount"]}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_poisoned_settings_diagnostics_cannot_become_successful_closed_facts() {
        let actual = crate::renderer_settings_view::poisoned_snapshot_for_test();
        assert_eq!(actual["stateAvailable"], false);
        assert_eq!(actual["sessionCount"], 0);
        assert!(project_settings(&actual, 0, &"a".repeat(64)).is_err());
        let mut missing = actual;
        missing.as_object_mut().unwrap().remove("stateAvailable");
        assert!(project_settings(&missing, 0, &"a".repeat(64)).is_err());
    }
}
