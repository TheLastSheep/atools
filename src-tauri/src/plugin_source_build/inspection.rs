//! Read-only inspection that can recognize a matching, already-prepared dependency set.
use super::{api, dependency_service, staging};
use atools_plugin::source_build::{
    inspect_source_build_with_dependency_root_and_manifest_selection,
    inspect_source_build_with_manifest_selection, ManifestSelection, SourceBuildInspection,
    SourceBuildStatus,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
use tauri::AppHandle;

pub(super) async fn inspect(app: &AppHandle, path: String) -> Result<Value, String> {
    inspect_with_manifest_selection(app, path, None).await
}

pub(super) async fn inspect_with_manifest_selection(
    app: &AppHandle,
    path: String,
    selection: Option<ManifestSelection>,
) -> Result<Value, String> {
    api::validate_path(&path)?;
    let root = PathBuf::from(path);
    let root_for_read = root.clone();
    let selection_for_read = selection;
    let (local, revision) = tauri::async_runtime::spawn_blocking(move || {
        let inspection =
            inspect_source_build_with_manifest_selection(&root_for_read, selection_for_read)?;
        let should_pin = cfg!(target_os = "macos")
            && (inspection.status == SourceBuildStatus::Eligible
                || dependency_service::allows_conversion_fallback(
                    inspection.status,
                    &inspection.blockers,
                ));
        let revision = if should_pin {
            Some(staging::source_digest(&root_for_read, &AtomicBool::new(false))?.0)
        } else {
            None
        };
        Ok::<_, String>((inspection, revision))
    })
    .await
    .map_err(|error| error.to_string())??;

    if local.status == SourceBuildStatus::Eligible {
        return encode_inspection(local, revision.as_deref());
    }
    if !cfg!(target_os = "macos")
        || !dependency_service::allows_conversion_fallback(local.status, &local.blockers)
    {
        return encode_inspection(local, None);
    }
    let Some(expected_revision) = revision else {
        return encode_inspection(local, None);
    };
    let prepared = match dependency_service::prepared_for_conversion(
        app,
        &root,
        &expected_revision,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    {
        Ok(Some(prepared)) => prepared,
        Ok(None) => return encode_inspection(local, None),
        Err(error) if error == "SOURCE_DEPENDENCY_SOURCE_CHANGED" => {
            return Err("SOURCE_BUILD_SOURCE_CHANGED".into());
        }
        Err(_) => return encode_inspection(local, None),
    };

    let root_for_check = root.clone();
    let expected_for_check = expected_revision.clone();
    let dependency_home = prepared.dependency_home;
    let selection_for_check = selection;
    let checked = tauri::async_runtime::spawn_blocking(move || {
        let before = staging::source_digest(&root_for_check, &AtomicBool::new(false))?.0;
        if before != expected_for_check {
            return Err("SOURCE_BUILD_SOURCE_CHANGED".to_owned());
        }
        let inspection = inspect_source_build_with_dependency_root_and_manifest_selection(
            &root_for_check,
            &dependency_home,
            selection_for_check,
        )?;
        let after = staging::source_digest(&root_for_check, &AtomicBool::new(false))?.0;
        if after != expected_for_check {
            return Err("SOURCE_BUILD_SOURCE_CHANGED".to_owned());
        }
        Ok::<_, String>(inspection)
    })
    .await
    .map_err(|error| error.to_string())?;
    let checked = match checked {
        Ok(inspection) => inspection,
        Err(error) if error == "SOURCE_BUILD_SOURCE_CHANGED" => return Err(error),
        Err(_) => return encode_inspection(local, None),
    };
    if checked.status == SourceBuildStatus::Eligible {
        encode_inspection(checked, Some(&expected_revision))
    } else {
        encode_inspection(checked, None)
    }
}

fn encode_inspection(
    inspection: SourceBuildInspection,
    revision: Option<&str>,
) -> Result<Value, String> {
    let eligible = inspection.status == SourceBuildStatus::Eligible;
    let result = serde_json::to_value(inspection).map_err(|error| error.to_string())?;
    Ok(annotate_inspection(result, eligible, revision))
}

fn annotate_inspection(mut result: Value, eligible: bool, revision: Option<&str>) -> Value {
    if eligible {
        if !cfg!(target_os = "macos") {
            result["status"] = json!("blocked");
            result["blockers"] = json!([{"code":"platform_unsupported","message":"Source conversion is not available on this platform"}]);
        } else if let Some(revision) = revision {
            result["sourceRevision"] = json!(revision);
        }
    }
    result
}
