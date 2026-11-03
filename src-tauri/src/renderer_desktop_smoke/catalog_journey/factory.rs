use crate::{
    launcher_app_catalog_source::LauncherAppCatalogSource,
    renderer_desktop_smoke::{fixture_owner, profile::Profile},
};
use atools_core::Database;
use serde_json::{json, Value};
use std::{
    fs::{self, DirBuilder},
    path::{Path, PathBuf},
    sync::Arc,
};

const INITIAL_APP: &str = "ATools Catalog Initial.app";
const ADDED_APP: &str = "ATools Catalog Added.app";
const AFTER_DISPOSE_APP: &str = "ATools Catalog AfterDispose.app";

pub(super) struct Prepared {
    pub(super) source: LauncherAppCatalogSource,
    pub(super) added_path: PathBuf,
    pub(super) after_dispose_path: PathBuf,
    pub(super) task_runs_before: u64,
    pub(super) history_before: u64,
}

pub(super) fn prepare(profile: Arc<Profile>, db: Arc<Database>) -> Result<Prepared, String> {
    fixture_owner::verify(&profile).map_err(str::to_owned)?;
    if profile.auto_clear != "never" {
        return Err("catalog-auto-clear-not-never".to_owned());
    }
    let (task_runs_before, history_before) = database_counts(&db)?;
    if task_runs_before != 0 || history_before != 0 {
        return Err("catalog-fixture-database-not-empty".to_owned());
    }

    seed_renderer_settings(&db)?;
    let requested_apps_root = profile.root.join("launcher-apps");
    create_private_directory(&requested_apps_root)?;
    let canonical_profile_root = fs::canonicalize(&profile.root)
        .map_err(|_| "catalog-fixture-directory-create-failed".to_owned())?;
    let apps_root = fs::canonicalize(&requested_apps_root)
        .map_err(|_| "catalog-fixture-directory-create-failed".to_owned())?;
    if apps_root != canonical_profile_root.join("launcher-apps") {
        return Err("catalog-fixture-directory-create-failed".to_owned());
    }
    let initial_path = apps_root.join(INITIAL_APP);
    create_private_directory(&initial_path)?;

    let source = LauncherAppCatalogSource::from_owned_fixture_directory(&apps_root)
        .map_err(|_| "catalog-owned-source-not-verified".to_owned())?;
    let initial = source
        .snapshot()
        .map_err(|_| "catalog-initial-snapshot-failed".to_owned())?;
    if initial.len() != 1 || initial[0].path() != initial_path.to_string_lossy().as_ref() {
        return Err("catalog-initial-fixture-not-isolated".to_owned());
    }

    Ok(Prepared {
        source,
        added_path: apps_root.join(ADDED_APP),
        after_dispose_path: apps_root.join(AFTER_DISPOSE_APP),
        task_runs_before,
        history_before,
    })
}

pub(super) fn database_counts(db: &Database) -> Result<(u64, u64), String> {
    let task_runs = db
        .list_task_runs(32)
        .map_err(|_| "catalog-task-run-read-failed".to_owned())?;
    let snapshot = db
        .read_renderer_app_state()
        .map_err(|_| "catalog-history-read-failed".to_owned())?;
    let history = match snapshot
        .values
        .get("command-history")
        .and_then(|value| value.as_deref())
    {
        Some(raw) => serde_json::from_str::<Vec<Value>>(raw)
            .map_err(|_| "catalog-history-read-failed".to_owned())?,
        None => Vec::new(),
    };
    Ok((task_runs.len() as u64, history.len() as u64))
}

fn seed_renderer_settings(db: &Database) -> Result<(), String> {
    let settings = json!({
        "theme": "system",
        "primaryColor": "blue",
        "autoClear": "never",
        "autoPaste": "never",
        "placeholder": "ATools Catalog",
        "searchMode": "list",
        "showMatchRecommendation": false,
        "tabKeyFunction": "navigate",
        "spaceOpenCommand": false,
    });
    db.set_setting("settings-general", &settings.to_string())
        .map_err(|_| "catalog-general-settings-seed-failed".to_owned())
}

fn create_private_directory(path: &Path) -> Result<(), String> {
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| "catalog-fixture-directory-create-failed".to_owned())?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "catalog-fixture-directory-create-failed".to_owned())?;
    if !metadata.file_type().is_dir() {
        return Err("catalog-fixture-directory-create-failed".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "catalog-fixture-directory-create-failed".to_owned())?;
    }
    Ok(())
}
