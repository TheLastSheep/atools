use atools_core::{db::Database, models::Cmd, Plugin};
use atools_plugin::loader::load_plugin_from_disk;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

const INVALID_FIXTURE: &str = "settings-input-local-app-search-fixture-control-invalid";
const EXPECTED_FILES: [&str; 3] = ["index.html", "logo.svg", "plugin.json"];

pub(super) fn register_timestamp_control(db: &Database) -> Result<String, &'static str> {
    let executable = std::env::current_exe().map_err(|_| INVALID_FIXTURE)?;
    register_from_executable(db, &executable)
}

pub(in crate::renderer_desktop_smoke) fn staged_builtin_plugins_dir(
) -> Result<PathBuf, &'static str> {
    let executable = std::env::current_exe().map_err(|_| INVALID_FIXTURE)?;
    let package_dir = staged_timestamp_package(&executable)?;
    load_verified_timestamp(&package_dir)?;
    let builtin_dir = package_dir.parent().ok_or(INVALID_FIXTURE)?;
    let mut entries = fs::read_dir(builtin_dir).map_err(|_| INVALID_FIXTURE)?;
    let timestamp = entries
        .next()
        .ok_or(INVALID_FIXTURE)?
        .map_err(|_| INVALID_FIXTURE)?;
    let timestamp_type = timestamp.file_type().map_err(|_| INVALID_FIXTURE)?;
    if timestamp.file_name() != "timestamp"
        || !timestamp_type.is_dir()
        || timestamp_type.is_symlink()
        || entries.next().is_some()
    {
        return Err(INVALID_FIXTURE);
    }
    Ok(builtin_dir.to_path_buf())
}

fn register_from_executable(db: &Database, executable: &Path) -> Result<String, &'static str> {
    let package_dir = staged_timestamp_package(executable)?;
    let plugin = load_verified_timestamp(&package_dir)?;
    let plugin_id = plugin.id.clone();
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .map_err(|_| INVALID_FIXTURE)?;
    let stored = db.get_plugin(&plugin_id).map_err(|_| INVALID_FIXTURE)?;
    if stored.id != plugin_id || stored.name != "timestamp" || !stored.enabled {
        return Err(INVALID_FIXTURE);
    }
    Ok(plugin_id)
}

fn staged_timestamp_package(executable: &Path) -> Result<PathBuf, &'static str> {
    let executable = executable.canonicalize().map_err(|_| INVALID_FIXTURE)?;
    if !executable.is_file() {
        return Err(INVALID_FIXTURE);
    }
    let macos_dir = executable.parent().ok_or(INVALID_FIXTURE)?;
    if macos_dir.file_name().and_then(|name| name.to_str()) != Some("MacOS") {
        return Err(INVALID_FIXTURE);
    }
    let contents_dir = macos_dir.parent().ok_or(INVALID_FIXTURE)?;
    if contents_dir.file_name().and_then(|name| name.to_str()) != Some("Contents") {
        return Err(INVALID_FIXTURE);
    }
    let bundle_dir = contents_dir.parent().ok_or(INVALID_FIXTURE)?;
    if bundle_dir.extension().and_then(|name| name.to_str()) != Some("app") {
        return Err(INVALID_FIXTURE);
    }

    let resources_dir = contents_dir.join("Resources");
    let canonical_resources = resources_dir.canonicalize().map_err(|_| INVALID_FIXTURE)?;
    if canonical_resources != resources_dir {
        return Err(INVALID_FIXTURE);
    }
    let package_dir = resources_dir.join("plugins/builtin/timestamp");
    let canonical_package = package_dir.canonicalize().map_err(|_| INVALID_FIXTURE)?;
    if canonical_package != package_dir || !canonical_package.starts_with(&resources_dir) {
        return Err(INVALID_FIXTURE);
    }
    Ok(canonical_package)
}

fn load_verified_timestamp(package_dir: &Path) -> Result<Plugin, &'static str> {
    validate_exact_package_files(package_dir)?;
    let canonical_dir = package_dir.canonicalize().map_err(|_| INVALID_FIXTURE)?;
    let plugin = load_plugin_from_disk(&canonical_dir).map_err(|_| INVALID_FIXTURE)?;
    let plugin_path = Path::new(&plugin.path)
        .canonicalize()
        .map_err(|_| INVALID_FIXTURE)?;
    let manifest = &plugin.manifest;
    let feature = manifest.features.first().ok_or(INVALID_FIXTURE)?;
    if plugin.name != "timestamp"
        || manifest.name != "timestamp"
        || plugin_path != canonical_dir
        || manifest.main.as_deref() != Some("index.html")
        || manifest.logo.as_deref() != Some("logo.svg")
        || manifest.preload.is_some()
        || manifest.runtime.is_some()
        || manifest.features.len() != 1
        || feature.code != "timestamp"
        || feature.label.as_deref() != Some("时间戳")
        || !feature.main_push
        || feature.main_hide
        || !feature
            .cmds
            .iter()
            .any(|command| matches!(command, Cmd::Text(value) if value == "时间戳"))
    {
        return Err(INVALID_FIXTURE);
    }
    Ok(plugin)
}

fn validate_exact_package_files(package_dir: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(package_dir).map_err(|_| INVALID_FIXTURE)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(INVALID_FIXTURE);
    }
    let mut files = BTreeSet::new();
    for entry in fs::read_dir(package_dir).map_err(|_| INVALID_FIXTURE)? {
        let entry = entry.map_err(|_| INVALID_FIXTURE)?;
        if !entry.file_type().map_err(|_| INVALID_FIXTURE)?.is_file() {
            return Err(INVALID_FIXTURE);
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| INVALID_FIXTURE)?;
        if !EXPECTED_FILES.contains(&name.as_str()) || !files.insert(name) {
            return Err(INVALID_FIXTURE);
        }
    }
    if files.len() != EXPECTED_FILES.len() {
        return Err(INVALID_FIXTURE);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        load_verified_timestamp, register_from_executable, staged_timestamp_package,
        EXPECTED_FILES, INVALID_FIXTURE,
    };
    use atools_core::Database;
    use atools_plugin::loader::load_plugin_from_disk;
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn stage_bundle(root: &Path) -> (PathBuf, PathBuf) {
        let bundle = root.join("Fixture.app");
        let executable = bundle.join("Contents/MacOS/atools");
        let package = bundle.join("Contents/Resources/plugins/builtin/timestamp");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::create_dir_all(&package).unwrap();
        fs::write(&executable, b"test executable").unwrap();
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../resources/plugins/builtin/timestamp");
        for file in EXPECTED_FILES {
            fs::copy(source.join(file), package.join(file)).unwrap();
        }
        (executable, package)
    }

    #[test]
    fn registers_real_timestamp_metadata_without_running_plugin_code() {
        let root = tempfile::tempdir().unwrap();
        let (executable, package) = stage_bundle(root.path());
        let loaded = load_plugin_from_disk(&package).unwrap();
        let canonical_package = package.canonicalize().unwrap();
        assert_eq!(loaded.name, "timestamp");
        assert_eq!(loaded.manifest.name, "timestamp");
        assert_eq!(
            Path::new(&loaded.path).canonicalize().unwrap(),
            canonical_package
        );
        assert_eq!(loaded.manifest.main.as_deref(), Some("index.html"));
        assert_eq!(loaded.manifest.logo.as_deref(), Some("logo.svg"));
        assert!(loaded.manifest.preload.is_none());
        assert!(loaded.manifest.runtime.is_none());
        assert_eq!(loaded.manifest.features.len(), 1);
        let feature = &loaded.manifest.features[0];
        assert_eq!(feature.code, "timestamp");
        assert_eq!(feature.label.as_deref(), Some("时间戳"));
        assert!(feature.main_push);
        assert!(!feature.main_hide);
        assert!(feature.cmds.iter().any(
            |command| matches!(command, atools_core::models::Cmd::Text(value) if value == "时间戳")
        ));

        let plugin = load_verified_timestamp(&package).unwrap();
        assert_eq!(plugin.name, "timestamp");
        assert!(plugin.manifest.preload.is_none());
        assert!(plugin.manifest.runtime.is_none());

        let db = Database::in_memory().unwrap();
        let plugin_id = register_from_executable(&db, &executable).unwrap();
        let stored = db.list_plugins().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, plugin_id);
        assert_eq!(stored[0].name, "timestamp");
        let features = db.features_by_plugin(&plugin_id).unwrap();
        assert_eq!(features.len(), 1);
        assert_eq!(features[0].code, "timestamp");
        assert_eq!(features[0].plugin_name, "timestamp");
        assert!(
            matches!(&features[0].cmds[0], atools_core::models::Cmd::Text(value) if value == "时间戳")
        );
    }

    #[test]
    fn rejects_unknown_files_and_executables_outside_a_staged_app_bundle() {
        let root = tempfile::tempdir().unwrap();
        let (executable, package) = stage_bundle(root.path());
        fs::write(
            package.join("unrecognized.js"),
            "throw new Error('must not run')",
        )
        .unwrap();
        assert_eq!(
            load_verified_timestamp(&package).unwrap_err(),
            INVALID_FIXTURE
        );
        assert_eq!(
            staged_timestamp_package(Path::new("/tmp/atools")).unwrap_err(),
            INVALID_FIXTURE
        );
        assert!(executable.exists());
    }
}
