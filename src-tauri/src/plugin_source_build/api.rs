use super::{manager, registry, service};
use atools_core::task_run::TaskRunStatus;
use atools_plugin::source_build::ManifestSelection;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InspectionArguments {
    pub source_path: String,
    #[serde(default)]
    pub manifest_selection: Option<ManifestSelection>,
}

impl InspectionArguments {
    pub(super) fn parse(value: Value) -> Result<Self, String> {
        reject_explicit_null(
            &value,
            "manifestSelection",
            "SOURCE_BUILD_MANIFEST_SELECTION_INVALID",
        )?;
        serde_json::from_value(value).map_err(|_| "SOURCE_BUILD_INVALID_ARGUMENTS".into())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BuildArguments {
    pub source_path: String,
    pub expected_revision: String,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub manifest_selection: Option<ManifestSelection>,
    #[serde(default)]
    pub expected_manifest_sha256: Option<String>,
}

pub(super) fn validate_path(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || !Path::new(value).is_absolute()
    {
        return Err("SOURCE_BUILD_ABSOLUTE_PATH_REQUIRED".into());
    }
    Ok(())
}

impl BuildArguments {
    pub(super) fn parse(value: Value) -> Result<Self, String> {
        reject_explicit_null(
            &value,
            "manifestSelection",
            "SOURCE_BUILD_MANIFEST_SELECTION_INVALID",
        )?;
        reject_explicit_null(
            &value,
            "expectedManifestSha256",
            "SOURCE_BUILD_MANIFEST_SHA256_INVALID",
        )?;
        let args: Self =
            serde_json::from_value(value).map_err(|_| "SOURCE_BUILD_INVALID_ARGUMENTS")?;
        validate_path(&args.source_path)?;
        if args.expected_revision.len() != 64
            || !args
                .expected_revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("SOURCE_BUILD_REVISION_REQUIRED".into());
        }
        match (&args.manifest_selection, &args.expected_manifest_sha256) {
            (None, None) => {}
            (Some(_), Some(hash)) if valid_sha256(hash) => {}
            (Some(_), Some(_)) => return Err("SOURCE_BUILD_MANIFEST_SHA256_INVALID".into()),
            _ => return Err("SOURCE_BUILD_MANIFEST_SELECTION_PAIR_REQUIRED".into()),
        }
        Ok(args)
    }
}

fn reject_explicit_null(value: &Value, field: &str, error: &'static str) -> Result<(), String> {
    if value
        .as_object()
        .and_then(|object| object.get(field))
        .is_some_and(Value::is_null)
    {
        return Err(error.into());
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Package discovery, like the existing import scan, never executes the selected source.
#[tauri::command]
pub(crate) async fn inspect_ztools_source_build(
    app: AppHandle,
    path: String,
) -> Result<Value, String> {
    service::inspect(&app, path).await
}

#[tauri::command]
pub(crate) fn get_plugin_source_build_state(
    state: tauri::State<crate::state::AppState>,
    id: String,
) -> Result<manager::BuildState, String> {
    let run = state
        .db
        .get_task_run(&id)
        .map_err(|_| "SOURCE_BUILD_TASK_READ")?
        .ok_or("SOURCE_BUILD_TASK_MISSING")?;
    if run.capability_id != registry::TOOL
        && !super::dependency_service::is_tool(&run.capability_id)
    {
        return Err("SOURCE_BUILD_TASK_IDENTITY".into());
    }
    if run.capability_id == registry::TOOL {
        Ok(manager::global().state(&id))
    } else {
        super::dependency_service::state(&run)
    }
}

pub(super) fn finish_cancelled(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    let mut run = state
        .db
        .get_task_run(id)
        .map_err(|_| "SOURCE_BUILD_TASK_READ")?
        .ok_or("SOURCE_BUILD_TASK_MISSING")?;
    if run.capability_id != registry::TOOL || run.status != TaskRunStatus::Running {
        return Err("SOURCE_BUILD_TASK_IDENTITY".into());
    }
    run.summary = Some("Source conversion cancelled after its worker finished".into());
    run.transition(TaskRunStatus::Cancelled)
        .map_err(|error| error.to_string())?;
    if !state
        .db
        .finish_running_task_run(&run)
        .map_err(|error| error.to_string())?
    {
        return Err("SOURCE_BUILD_TASK_CHANGED".into());
    }
    crate::permission_requests::remove_for_run(app, id);
    let _ = app.emit("task-run-updated", id);
    Ok(())
}
