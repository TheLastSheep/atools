//! UI command mutation services. Blocking package work stays off the event loop.
use crate::{
    commands,
    plugin_lifecycle::{self as lifecycle, ChangeReason},
    plugin_packages,
};
use atools_core::{config::AppConfig, db::Database, Plugin};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::AppHandle;

pub(crate) mod market;
pub(crate) use market::{install_from_market, update_from_market};

pub(crate) async fn install(
    app: &AppHandle,
    db: Arc<Database>,
    config: AppConfig,
    source: PathBuf,
) -> Result<Plugin, String> {
    let read_source = source.clone();
    let id = tauri::async_runtime::spawn_blocking(move || {
        plugin_packages::local_package(&read_source)
            .map(|package| atools_core::utils::sanitize_id(&package.manifest.name))
    })
    .await
    .map_err(|error| error.to_string())??;
    let operation_db = db.clone();
    let expected = id.clone();
    lifecycle::mutate(app, db, &id, ChangeReason::Installed, move || {
        commands::install_plugin_from_directory_checked_inner(
            &operation_db,
            &config,
            &source,
            Some(&expected),
        )
    })
    .await
}

pub(crate) async fn update(
    app: &AppHandle,
    db: Arc<Database>,
    config: AppConfig,
    id: String,
    source: PathBuf,
) -> Result<Plugin, String> {
    let operation_db = db.clone();
    let expected = id.clone();
    lifecycle::mutate(app, db, &id, ChangeReason::Updated, move || {
        commands::plugin_update_from_path_inner(&operation_db, &config, &expected, &source)
    })
    .await
}

pub(crate) async fn uninstall(
    app: &AppHandle,
    db: Arc<Database>,
    config: AppConfig,
    id: String,
) -> Result<(), String> {
    // Validate ownership before resetting any currently running builtin plugin.
    let current = db.get_plugin(&id).map_err(|error| error.to_string())?;
    if !commands::plugin_uninstall_path_allowed(Path::new(&current.path), &config.plugins_dir()) {
        return Err(
            "Only imported plugins in the ATools plugins directory can be uninstalled".into(),
        );
    }
    let operation_db = db.clone();
    let expected = id.clone();
    lifecycle::mutate(app, db, &id, ChangeReason::Removed, move || {
        commands::uninstall_plugin_inner(&operation_db, &config, &expected)
    })
    .await
}

pub(crate) async fn toggle(
    app: &AppHandle,
    db: Arc<Database>,
    id: String,
    enabled: bool,
) -> Result<Plugin, String> {
    db.get_plugin(&id).map_err(|error| error.to_string())?;
    let operation_db = db.clone();
    let expected = id.clone();
    let reason = if enabled {
        ChangeReason::Enabled
    } else {
        ChangeReason::Disabled
    };
    lifecycle::mutate(app, db, &id, reason, move || {
        let _mutation = commands::acquire_plugin_mutation_lock()?;
        let mut plugin = operation_db
            .get_plugin(&expected)
            .map_err(|error| error.to_string())?;
        plugin.enabled = enabled;
        plugin.updated_at = atools_core::utils::now_iso();
        operation_db
            .save_plugin_with_features(&plugin, &plugin.manifest.features)
            .map_err(|error| error.to_string())?;
        Ok(plugin)
    })
    .await
}

pub(crate) async fn import(
    app: &AppHandle,
    db: Arc<Database>,
    install_root: PathBuf,
    paths: Vec<String>,
    overwrite: bool,
) -> Result<crate::ztools_import::ZToolsImportReport, String> {
    use crate::ztools_import::{self, ZToolsImportFailure, ZToolsImportReport};
    let mut report = ZToolsImportReport {
        imported: Vec::new(),
        skipped: Vec::new(),
        failed: Vec::new(),
    };
    // Complete the shared identity plan before any lifecycle reset or filesystem/DB mutation.
    let plan =
        tauri::async_runtime::spawn_blocking(move || ztools_import::plan_import_batch(&paths))
            .await
            .map_err(|error| error.to_string())??;
    report.skipped = plan.report.skipped;
    report.failed = plan.report.failed;
    for mut prepared in plan.ready {
        let path = prepared.path();
        let id = prepared.id().to_owned();
        if prepared.skip_existing(&install_root, overwrite) {
            report.skipped.push(prepared.into_candidate());
            continue;
        }
        let operation_db = db.clone();
        let target = install_root.clone();
        let result = lifecycle::mutate_when(
            app,
            db.clone(),
            &id,
            None,
            |part: &ZToolsImportReport| !part.imported.is_empty(),
            move || ztools_import::execute_prepared(&operation_db, &target, prepared, overwrite),
        )
        .await;
        match result {
            Ok(mut part) => {
                report.imported.append(&mut part.imported);
                report.skipped.append(&mut part.skipped);
                report.failed.append(&mut part.failed);
            }
            Err(error) => report.failed.push(ZToolsImportFailure { path, error }),
        }
    }
    // Emit final changes in one burst so every window coalesces this batch to one
    // catalog refresh. Reset notices were already sent before each replacement.
    let ids: std::collections::BTreeSet<_> = report.imported.iter().collect();
    for id in ids {
        lifecycle::notify(app, id, ChangeReason::Installed);
    }
    Ok(report)
}
