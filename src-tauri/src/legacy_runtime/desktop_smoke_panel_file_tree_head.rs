//! Evidence for the exact fixture-only FileTree file-entry TaskRun.
use serde_json::{json, Value};
use tauri::Manager;

pub(super) fn registered_profile() -> Result<Value, String> {
    let registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/head-file-tree-cases.json"
    ))
    .map_err(|_| "FileTree HEAD fixture registry is invalid")?;
    let profile = registry["cases"]
        .as_array()
        .and_then(|cases| {
            cases
                .iter()
                .find(|profile| profile["caseId"] == "local-file-tree-head")
        })
        .ok_or("FileTree HEAD fixture profile is missing")?;
    if profile["id"] != "file-tree"
        || profile["version"] != "1.0.5"
        || profile["sourceCommit"] != registry["commit"]
        || profile["sourceTree"] != registry["packageTree"]
        || profile["directorySha256"] != registry["directorySha256"]
        || profile["featureCode"] != "file-tree"
        || profile["runtime"] != "node"
        || profile["sourceKind"] != "local_full_directory"
    {
        return Err("FileTree HEAD fixture profile is not the registered exact package".into());
    }
    Ok(profile.clone())
}

#[tauri::command]
pub(super) fn native_file_tree_head_task_run_evidence(
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let fixture = app.state::<super::PanelFixture>();
    if !fixture.head_file_tree_acceptance {
        return Err("FileTree HEAD evidence is restricted to its dedicated fixture".into());
    }
    let rows = fixture
        .db
        .list_task_runs(1000)
        .map_err(|_| "TaskRun evidence is unavailable")?;
    let selected = rows
        .iter()
        .filter(|run| {
            run.capability_id == "plugin.feature.file-tree"
                && run.initiator.client_id.as_deref() == Some("atools-ui")
                && run.input["code"] == "file-tree"
        })
        .collect::<Vec<_>>();
    let run = selected.first().copied();
    let payload_redacted = run.is_some_and(|run| {
        run.input["payloadSummary"]["type"] == "array"
            && run.input["payloadSummary"]["contentRedacted"] == true
            && run.input["expectedPluginId"] == "file-tree"
            && run.output["payload_summary"]["contentRedacted"] == true
    });
    let entry_type_files = run.is_some_and(|run| run.output["entry_type"] == "files");
    let success = selected.len() == 1
        && run.is_some_and(|run| run.status.as_str() == "succeeded")
        && payload_redacted
        && entry_type_files;
    Ok(
        json!({"matchedTaskRuns":selected.len(),"succeeded":run.is_some_and(|run|run.status.as_str()=="succeeded"),
        "terminal":run.is_some_and(|run|run.status.is_terminal()),"entryTypeFiles":entry_type_files,
        "payloadSummaryRedacted":payload_redacted,"expectedOwnerMatched":run.is_some_and(|run|run.input["expectedPluginId"]=="file-tree"),"passed":success}),
    )
}

#[cfg(test)]
mod tests {
    use super::registered_profile;

    #[test]
    fn profile_is_exact_registered_head_file_tree_with_file_entry() {
        let profile = registered_profile().unwrap();
        assert_eq!(profile["caseId"], "local-file-tree-head");
        assert_eq!(profile["featureCode"], "file-tree");
        assert_eq!(
            profile["directorySha256"],
            "01f6804db14c5b7629674f6fb532cc59be65213e5ae14fab247ed8a51bd14a0a"
        );
        assert_eq!(profile["runtime"], "node");
        assert_eq!(profile["pathAccess"], "legacy-node-file-read");
    }
}
