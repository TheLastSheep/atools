use super::{
    api::{self, BuildArguments},
    failure::SourceBuildFailure,
    manager::{self, Phase},
    process, registry, staging,
};
use atools_core::{db::Database, task_run::TaskRun};
use atools_plugin::source_build::{
    inspect_source_build_with_manifest_selection,
    prepare_source_build_with_dependency_root_and_manifest_selection,
    prepare_source_build_with_manifest_selection, resolve_build_node, summarize_build_steps,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub(crate) async fn inspect_tool(app: &AppHandle, arguments: Value) -> Result<Value, String> {
    let args = api::InspectionArguments::parse(arguments)?;
    super::inspection::inspect_with_manifest_selection(
        app,
        args.source_path,
        args.manifest_selection,
    )
    .await
}

pub(crate) async fn inspect(app: &AppHandle, path: String) -> Result<Value, String> {
    super::inspection::inspect(app, path).await
}

/// Running conversions cancel cooperatively. Commit is a single, non-cancellable boundary.
pub(crate) fn request_cancel(app: &AppHandle, run: &TaskRun) -> Result<TaskRun, String> {
    if run.capability_id != registry::TOOL {
        return Err("SOURCE_BUILD_TASK_IDENTITY".into());
    }
    manager::global().cancel(&run.id)?;
    let _ = app;
    Ok(run.clone())
}

pub(crate) async fn execute(
    app: &AppHandle,
    db: &Database,
    arguments: Value,
    run_id: &str,
) -> Result<Value, SourceBuildFailure> {
    let args = BuildArguments::parse(arguments)?;
    if !cfg!(target_os = "macos") {
        return Err("SOURCE_BUILD_PLATFORM_UNSUPPORTED".into());
    }
    let lease = manager::global().claim(run_id)?;
    let result = execute_claimed(app, db, args, &lease).await;
    if result
        .as_ref()
        .err()
        .is_some_and(SourceBuildFailure::cleanup_unconfirmed)
    {
        lease.quarantine();
    }
    let cancellation_won = lease.finish()?;
    if cancellation_won {
        api::finish_cancelled(app, run_id)?;
        return Err("SOURCE_BUILD_CANCELLED".into());
    }
    result
}

async fn execute_claimed(
    app: &AppHandle,
    _db: &Database,
    args: BuildArguments,
    lease: &manager::Lease,
) -> Result<Value, SourceBuildFailure> {
    if lease.cancelled() {
        return Err("SOURCE_BUILD_CANCELLED".into());
    }
    let source = PathBuf::from(&args.source_path);
    let revision = args.expected_revision.clone();
    let cancellation = lease.cancel.clone();
    let source_for_plan = source.clone();
    let revision_for_plan = revision.clone();
    let selection_for_plan = args.manifest_selection;
    let expected_manifest_sha256 = args.expected_manifest_sha256.clone();
    let cancel_for_plan = cancellation.clone();
    let local_plan = tauri::async_runtime::spawn_blocking(move || {
        match prepare_source_build_with_manifest_selection(&source_for_plan, selection_for_plan) {
            Ok(plan) => {
                if expected_manifest_sha256
                    .as_ref()
                    .is_some_and(|expected| expected != &plan.manifest_sha256)
                    || selection_for_plan
                        .is_some_and(|selection| selection != plan.manifest_selection)
                {
                    return Err("SOURCE_BUILD_MANIFEST_CHANGED".to_owned());
                }
                let (actual, _) = staging::source_digest(&source_for_plan, &cancel_for_plan)?;
                if actual != revision_for_plan {
                    return Err("SOURCE_BUILD_SOURCE_CHANGED".to_owned());
                }
                Ok(Some((plan, resolve_build_node()?)))
            }
            Err(original_error) => {
                let fallback_allowed = inspect_source_build_with_manifest_selection(
                    &source_for_plan,
                    selection_for_plan,
                )
                .is_ok_and(|inspection| {
                    super::allows_conversion_fallback(inspection.status, &inspection.blockers)
                });
                if fallback_allowed {
                    Ok(None)
                } else {
                    Err(original_error)
                }
            }
        }
    })
    .await
    .map_err(|error| error.to_string())??;
    let (plan, node, dependency_set_identity) = match local_plan {
        Some((plan, node)) => (plan, node, None),
        None => {
            let prepared =
                super::prepared_for_conversion(app, &source, &revision, lease.cancel.clone())
                    .await?
                    .ok_or("SOURCE_BUILD_DEPENDENCY_SET_NOT_PREPARED")?;
            let source_for_plan = source.clone();
            let revision_for_plan = revision.clone();
            let home = prepared.dependency_home.clone();
            let selection_for_plan = args.manifest_selection;
            let expected_manifest_sha256 = args.expected_manifest_sha256.clone();
            let cancel_for_plan = lease.cancel.clone();
            let plan = tauri::async_runtime::spawn_blocking(move || {
                let plan = prepare_source_build_with_dependency_root_and_manifest_selection(
                    &source_for_plan,
                    &home,
                    selection_for_plan,
                )?;
                if expected_manifest_sha256
                    .as_ref()
                    .is_some_and(|expected| expected != &plan.manifest_sha256)
                    || selection_for_plan
                        .is_some_and(|selection| selection != plan.manifest_selection)
                {
                    return Err("SOURCE_BUILD_MANIFEST_CHANGED".into());
                }
                let (actual, _) = staging::source_digest(&source_for_plan, &cancel_for_plan)?;
                if actual != revision_for_plan {
                    return Err("SOURCE_BUILD_SOURCE_CHANGED".to_owned());
                }
                let expected_root = home
                    .join("node_modules")
                    .canonicalize()
                    .map_err(|_| "SOURCE_BUILD_DEPENDENCY_SET_CHANGED")?;
                if plan.dependency_root != expected_root {
                    return Err("SOURCE_BUILD_DEPENDENCY_SET_CHANGED".into());
                }
                Ok(plan)
            })
            .await
            .map_err(|error| error.to_string())??;
            let identity = Some((
                prepared.dependency_set_id_sha256,
                prepared.dependency_tree_sha256,
                prepared.toolchain_fingerprint_sha256,
            ));
            (plan, prepared.node_path, identity)
        }
    };
    lease.phase(Phase::Building)?;
    let built = process::build(
        plan.clone(),
        node,
        lease.cancel.clone(),
        lease.worker_finished.clone(),
        lease.cleanup_unconfirmed.clone(),
        args.expected_revision.clone(),
    )
    .await?;
    let build_plan = summarize_build_steps(&plan.build_steps);
    let source = plan.source_root.clone();
    let expected = args.expected_revision.clone();
    let cancellation = lease.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (actual, _) = staging::source_digest(&source, &cancellation)?;
        if actual != expected {
            return Err("SOURCE_BUILD_SOURCE_CHANGED".to_owned());
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())??;
    lease.phase(Phase::Installing)?;
    let state = app.state::<crate::state::AppState>();
    // All build work and validation has completed before taking any plugin lifecycle lock.
    let report = crate::plugin_mutations::import(
        app,
        state.db.clone(),
        state.config.plugins_dir(),
        vec![built
            .output_dir
            .to_str()
            .ok_or("SOURCE_BUILD_OUTPUT_PATH")?
            .to_owned()],
        args.overwrite,
    )
    .await?;
    if report.imported != vec![plan.plugin_id.clone()] {
        return Err(super::install_report::installation_failure(&report).into());
    }
    let plugin = state
        .db
        .get_plugin(&plan.plugin_id)
        .map_err(|error| error.to_string())?;
    if plugin.version != plan.version {
        return Err("SOURCE_BUILD_INSTALL_IDENTITY".into());
    }
    Ok(
        json!({"installed":true,"pluginId":plugin.id,"name":plugin.name,"version":plugin.version,
        "sourceRevision":args.expected_revision,"buildSteps":build_plan,"build":built.diagnostics,
        "manifestSelection":plan.manifest_selection,"manifestSha256":plan.manifest_sha256,
        "dependencySetIdSha256":dependency_set_identity.as_ref().map(|value| value.0.as_str()),
        "dependencyTreeSha256":dependency_set_identity.as_ref().map(|value| value.1.as_str()),
        "toolchainFingerprintSha256":dependency_set_identity.as_ref().map(|value| value.2.as_str()),
        "businessOperationVerified":false,"dependencyClosureVerified":false}),
    )
}
