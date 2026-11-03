//! Exact HEAD provenance and activation TaskRun checks for one Web-only plugin.
use serde_json::{json, Value};
use tauri::Manager;

pub(super) fn registered_profile() -> Result<Value, String> {
    let registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/head-developer-codec-tools-cases.json"
    ))
    .map_err(|_| "Developer codec HEAD fixture registry is invalid")?;
    let profile = registry["cases"]
        .as_array()
        .and_then(|cases| {
            cases
                .iter()
                .find(|profile| profile["caseId"] == "local-developer-codec-tools-head")
        })
        .ok_or("Developer codec HEAD fixture profile is missing")?;
    if registry["repository"] != "ZTools-plugins"
        || registry["commit"] != "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
        || registry["packagePath"] != "plugins/developer-codec-tools"
        || registry["packageTree"] != "f758b127a8af4e225d75cca1bc6d7c7b690b2008"
        || registry["directorySha256"]
            != "676b43a647856c945633863bcdea514218115c55c69ae770682ac76d9a36894a"
        || profile["id"] != "developer-codec-tools"
        || profile["version"] != "0.1.0"
        || profile["featureCode"] != "codec-tools"
        || profile["runtime"] != "web"
        || profile["preload"] != Value::Null
        || profile["main"] != "index.html"
        || profile["fileCount"] != 15
        || registry["expandedBytes"] != 59561
    {
        return Err(
            "Developer codec HEAD fixture profile is not the registered exact package".into(),
        );
    }
    Ok(profile.clone())
}

#[tauri::command]
pub(super) fn native_developer_codec_tools_profile(app: tauri::AppHandle) -> Result<Value, String> {
    if !app
        .state::<super::PanelFixture>()
        .head_developer_codec_tools_acceptance
    {
        return Err("Developer codec profile is restricted to its dedicated fixture".into());
    }
    let profile = registered_profile()?;
    Ok(
        json!({"caseId":profile["caseId"],"id":profile["id"],"version":profile["version"],
        "featureCode":profile["featureCode"],"sourceCommit":profile["sourceCommit"],"sourceTree":profile["sourceTree"],
        "directorySha256":profile["directorySha256"],"fileCount":profile["fileCount"],"expandedBytes":registry_expanded_bytes()?}),
    )
}

fn registry_expanded_bytes() -> Result<u64, String> {
    let registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/head-developer-codec-tools-cases.json"
    ))
    .map_err(|_| "Developer codec HEAD fixture registry is invalid")?;
    registry["expandedBytes"]
        .as_u64()
        .ok_or_else(|| "Developer codec HEAD fixture size is invalid".into())
}

#[tauri::command]
pub(super) fn native_developer_codec_tools_task_run_evidence(
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let fixture = app.state::<super::PanelFixture>();
    if !fixture.head_developer_codec_tools_acceptance {
        return Err(
            "Developer codec TaskRun evidence is restricted to its dedicated fixture".into(),
        );
    }
    let rows = fixture
        .db
        .list_task_runs(1000)
        .map_err(|_| "TaskRun evidence is unavailable")?;
    let selected = rows
        .iter()
        .filter(|run| {
            run.capability_id == "plugin.feature.codec-tools"
                && run.initiator.client_id.as_deref() == Some("atools-ui")
                && run.input["code"] == "codec-tools"
        })
        .collect::<Vec<_>>();
    let run = selected.first().copied();
    let owner = run.is_some_and(|run| run.input["expectedPluginId"] == "developer-codec-tools");
    let succeeded = run.is_some_and(|run| run.status.as_str() == "succeeded");
    let terminal = run.is_some_and(|run| run.status.is_terminal());
    let capability = run.is_some_and(|run| run.capability_id == "plugin.feature.codec-tools");
    let passed = selected.len() == 1 && owner && succeeded && terminal && capability;
    Ok(
        json!({"matchedTaskRuns":selected.len(),"succeeded":succeeded,"terminal":terminal,
        "expectedOwnerMatched":owner,"expectedCapabilityMatched":capability,"passed":passed}),
    )
}

#[cfg(test)]
mod tests {
    use super::registered_profile;

    #[test]
    fn profile_is_exact_source_bound_web_base64_fixture() {
        let profile = registered_profile().unwrap();
        assert_eq!(profile["caseId"], "local-developer-codec-tools-head");
        assert_eq!(profile["featureCode"], "codec-tools");
        assert_eq!(profile["preload"], serde_json::Value::Null);
        assert_eq!(
            profile["sourceTree"],
            "f758b127a8af4e225d75cca1bc6d7c7b690b2008"
        );
    }
}
