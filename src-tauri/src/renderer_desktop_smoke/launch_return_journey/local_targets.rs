use crate::{
    launcher_app_catalog_source::LauncherAppCatalogSource,
    renderer_desktop_smoke::{fixture_owner, profile::Profile},
};
use atools_core::{
    db::{RendererLocalShortcut, RendererLocalShortcutMutation, RendererLocalShortcutType},
    Database,
};
use serde_json::Value;
use std::{
    fs::{self, DirBuilder},
    path::Path,
};

const LOCAL_CATALOG_ROOT: &str = "local-only-catalog";
const LAUNCHER_APPS: &str = "launcher-apps";

pub(super) struct Prepared {
    pub(super) source: LauncherAppCatalogSource,
    pub(super) local_shortcut_items: u64,
}

pub(super) fn prepare(
    profile: &Profile,
    db: &Database,
    first_path: &str,
    second_path: &str,
) -> Result<Prepared, String> {
    fixture_owner::verify(profile).map_err(str::to_owned)?;
    validate_probe_bundle(profile, first_path, "AToolsOwnedProbeFirst.app")?;
    validate_probe_bundle(profile, second_path, "AToolsOwnedProbeSecond.app")?;

    let source = empty_catalog_source(&profile.root)?;
    set_local_app_search(db, false).map_err(str::to_owned)?;
    let rows = register_shortcuts(
        db,
        profile.run_id.as_str(),
        [
            ("first", "AToolsOwnedProbeFirst", first_path),
            ("second", "AToolsOwnedProbeSecond", second_path),
        ],
    )
    .map_err(str::to_owned)?;
    if rows.len() != 2 {
        return Err("launch-return-local-shortcut-fixture-not-verified".to_owned());
    }

    Ok(Prepared {
        source,
        local_shortcut_items: rows.len() as u64,
    })
}

pub(super) fn validate_probe_bundle(
    profile: &Profile,
    path: &str,
    name: &str,
) -> Result<(), String> {
    let expected = profile.root.join(LAUNCHER_APPS).join(name);
    if path != expected.to_string_lossy().as_ref() {
        return Err("launch-return-local-shortcut-fixture-not-verified".to_owned());
    }
    let metadata = fs::symlink_metadata(&expected)
        .map_err(|_| "launch-return-local-shortcut-fixture-not-verified".to_owned())?;
    if !metadata.file_type().is_dir() {
        return Err("launch-return-local-shortcut-fixture-not-verified".to_owned());
    }
    Ok(())
}

pub(super) fn empty_catalog_source(
    profile_root: &Path,
) -> Result<LauncherAppCatalogSource, String> {
    let parent = profile_root.join(LOCAL_CATALOG_ROOT);
    create_private_directory(&parent)?;
    let requested = parent.join(LAUNCHER_APPS);
    create_private_directory(&requested)?;

    let canonical_profile = fs::canonicalize(profile_root)
        .map_err(|_| "launch-return-local-catalog-not-confined".to_owned())?;
    let canonical_root = fs::canonicalize(&requested)
        .map_err(|_| "launch-return-local-catalog-not-confined".to_owned())?;
    if canonical_root
        != canonical_profile
            .join(LOCAL_CATALOG_ROOT)
            .join(LAUNCHER_APPS)
        || !directory_is_empty(&canonical_root)?
    {
        return Err("launch-return-local-catalog-not-confined".to_owned());
    }

    let source = LauncherAppCatalogSource::from_owned_fixture_directory(&canonical_root)
        .map_err(|_| "launch-return-local-catalog-not-confined".to_owned())?;
    if !source
        .snapshot()
        .map_err(|_| "launch-return-local-catalog-not-empty".to_owned())?
        .is_empty()
    {
        return Err("launch-return-local-catalog-not-empty".to_owned());
    }
    Ok(source)
}

fn directory_is_empty(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "launch-return-local-catalog-not-confined".to_owned())?;
    if !metadata.file_type().is_dir() {
        return Err("launch-return-local-catalog-not-confined".to_owned());
    }
    let mut entries =
        fs::read_dir(path).map_err(|_| "launch-return-local-catalog-not-confined".to_owned())?;
    Ok(entries.next().is_none())
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
        .map_err(|_| "launch-return-local-catalog-not-confined".to_owned())?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "launch-return-local-catalog-not-confined".to_owned())?;
    if !metadata.file_type().is_dir() {
        return Err("launch-return-local-catalog-not-confined".to_owned());
    }
    Ok(())
}

pub(super) fn set_local_app_search(db: &Database, enabled: bool) -> Result<(), &'static str> {
    let raw = db
        .get_setting("settings-general")
        .map_err(|_| "launch-return-general-settings-not-readable")?
        .unwrap_or_else(|| "{}".to_owned());
    let mut settings: Value =
        serde_json::from_str(&raw).map_err(|_| "launch-return-general-settings-invalid")?;
    let object = settings
        .as_object_mut()
        .ok_or("launch-return-general-settings-invalid")?;
    object.insert("localAppSearch".to_owned(), Value::Bool(enabled));
    db.set_setting("settings-general", &settings.to_string())
        .map_err(|_| "launch-return-general-settings-write-failed")
}

fn register_shortcuts<const N: usize>(
    db: &Database,
    run_id: &str,
    targets: [(&str, &str, &str); N],
) -> Result<Vec<RendererLocalShortcut>, &'static str> {
    if run_id.len() != 32 || !run_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("launch-return-local-shortcut-fixture-not-verified");
    }
    if !db
        .read_renderer_local_shortcuts()
        .map_err(|_| "launch-return-local-shortcut-fixture-not-verified")?
        .is_empty()
    {
        return Err("launch-return-local-shortcut-fixture-not-verified");
    }

    for (index, (suffix, name, path)) in targets.iter().enumerate() {
        let row = RendererLocalShortcut {
            id: format!("launch-return-{run_id}-{suffix}"),
            name: (*name).to_owned(),
            path: (*path).to_owned(),
            kind: RendererLocalShortcutType::App,
            added_at: index as u64 + 1,
            alias: None,
            icon: None,
            keywords: None,
            pinyin: None,
            pinyin_abbr: None,
        };
        let written = db
            .apply_renderer_local_shortcut_guarded(
                RendererLocalShortcutMutation::Add { record: row },
                || true,
            )
            .map_err(|_| "launch-return-local-shortcut-fixture-registration-failed")?;
        if !written.changed {
            return Err("launch-return-local-shortcut-fixture-registration-failed");
        }
    }

    let rows = db
        .read_renderer_local_shortcuts()
        .map_err(|_| "launch-return-local-shortcut-fixture-not-verified")?;
    if rows.len() != N
        || rows.iter().zip(targets).any(|(row, (suffix, name, path))| {
            row.id != format!("launch-return-{run_id}-{suffix}")
                || row.name != name
                || row.path != path
                || row.kind != RendererLocalShortcutType::App
        })
    {
        return Err("launch-return-local-shortcut-fixture-not-verified");
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::{empty_catalog_source, register_shortcuts, set_local_app_search};
    use atools_core::{db::RendererLocalShortcutType, Database};
    use serde_json::json;

    #[test]
    fn local_catalog_is_an_owned_empty_directory() {
        let root = tempfile::tempdir().unwrap();
        let source = empty_catalog_source(root.path()).unwrap();
        assert!(source.snapshot().unwrap().is_empty());
        assert!(root
            .path()
            .join("local-only-catalog/launcher-apps")
            .is_dir());
    }

    #[test]
    fn local_rows_are_core_registered_app_shortcuts_and_app_search_is_disabled() {
        let db = Database::in_memory().unwrap();
        db.set_setting(
            "settings-general",
            &json!({"theme":"dark","preserve":true}).to_string(),
        )
        .unwrap();
        set_local_app_search(&db, false).unwrap();
        let raw = db.get_setting("settings-general").unwrap().unwrap();
        let settings: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(settings["localAppSearch"], false);
        assert_eq!(settings["preserve"], true);

        let rows = register_shortcuts(
            &db,
            "0123456789abcdef0123456789abcdef",
            [
                ("first", "AToolsOwnedProbeFirst", "/private/tmp/first.app"),
                (
                    "second",
                    "AToolsOwnedProbeSecond",
                    "/private/tmp/second.app",
                ),
            ],
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|row| row.kind == RendererLocalShortcutType::App));
        assert_eq!(rows[0].name, "AToolsOwnedProbeFirst");
        assert_eq!(rows[1].name, "AToolsOwnedProbeSecond");
    }

    #[test]
    fn missing_general_settings_are_initialized_without_enabling_app_search() {
        let db = Database::in_memory().unwrap();
        set_local_app_search(&db, false).unwrap();
        let raw = db.get_setting("settings-general").unwrap().unwrap();
        let settings: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(settings, json!({"localAppSearch": false}));
    }
}
