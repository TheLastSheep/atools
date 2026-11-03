use super::report::CatalogReport;
use crate::launcher_app_catalog_source::LauncherAppCatalogSource;
use atools_core::Database;
use serde_json::json;
use std::{
    env, fs,
    fs::OpenOptions,
    io::{Cursor, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

const PROBE_BINARY_LIMIT: usize = 32 * 1024 * 1024;
const PLIST_LIMIT: usize = 4 * 1024;
const CONFIG_LIMIT: usize = 128;

pub(super) struct Prepared {
    pub(super) source: LauncherAppCatalogSource,
    pub(super) first_path: String,
    pub(super) second_path: String,
    pub(super) fixture_valid: bool,
    pub(super) errors: Vec<&'static str>,
    pub(super) catalog: CatalogReport,
}

pub(super) fn prepare(
    profile: &super::super::profile::Profile,
    db: &Database,
    background_only: bool,
) -> Result<Prepared, &'static str> {
    super::super::fixture_owner::verify(profile)
        .map_err(|_| "launcher-owned-fixture-not-verified")?;
    let target_root = profile.root.join("launcher-apps");
    create_private_directory(&target_root)?;
    let mut errors = Vec::new();

    let source_root = match host_launcher_resource_root() {
        Ok(root) => Some(root),
        Err(()) => {
            errors.push("launcher-owned-fixture-not-verified");
            None
        }
    };
    if let Some(source_root) = source_root {
        if ensure_exact_entries(
            &source_root,
            &["AToolsOwnedProbeFirst.app", "AToolsOwnedProbeSecond.app"],
        )
        .is_err()
        {
            errors.push("launcher-owned-fixture-not-verified");
        } else {
            for probe_id in ["first", "second"] {
                if copy_bundle(
                    &source_root,
                    &target_root,
                    &profile.run_id,
                    probe_id,
                    background_only,
                )
                .is_err()
                {
                    errors.push("launcher-owned-fixture-not-verified");
                    break;
                }
            }
        }
    }

    if seed_renderer_settings(db, profile.auto_clear.as_str()).is_err() {
        errors.push("launcher-owned-fixture-not-verified");
    }
    if crate::agent_tools::sync_builtin_tools(db).is_err() {
        errors.push("launcher-owned-fixture-not-verified");
    }

    let source = LauncherAppCatalogSource::from_owned_fixture_directory(&target_root)
        .map_err(|_| "launcher-owned-fixture-not-verified")?;
    let first_path = target_root
        .join("AToolsOwnedProbeFirst.app")
        .to_string_lossy()
        .into_owned();
    let second_path = target_root
        .join("AToolsOwnedProbeSecond.app")
        .to_string_lossy()
        .into_owned();
    let apps = source
        .snapshot()
        .map_err(|_| "launcher-owned-fixture-not-verified")?;
    let exact_paths = apps.len() == 2
        && apps.iter().any(|app| app.path() == first_path.as_str())
        && apps.iter().any(|app| app.path() == second_path.as_str());
    if !exact_paths {
        errors.push("launcher-owned-fixture-not-verified");
    }
    let confined = apps.iter().all(|app| {
        let path = Path::new(app.path());
        path.parent() == Some(target_root.as_path())
            && matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("AToolsOwnedProbeFirst.app" | "AToolsOwnedProbeSecond.app")
            )
    });
    let catalog = CatalogReport {
        fixture_only: true,
        item_count: apps.len() as u64,
        confined,
    };

    Ok(Prepared {
        source,
        first_path,
        second_path,
        fixture_valid: exact_paths && confined && errors.is_empty(),
        errors,
        catalog,
    })
}

fn host_launcher_resource_root() -> Result<PathBuf, ()> {
    let executable = fs::canonicalize(env::current_exe().map_err(|_| ())?).map_err(|_| ())?;
    let macos = executable
        .parent()
        .filter(|path| path.file_name().is_some_and(|name| name == "MacOS"))
        .ok_or(())?;
    let contents = macos
        .parent()
        .filter(|path| path.file_name().is_some_and(|name| name == "Contents"))
        .ok_or(())?;
    let resources = contents.join("Resources");
    if !real_directory(&resources) {
        return Err(());
    }
    let launcher_apps = resources.join("launcher-apps");
    if !real_directory(&launcher_apps) {
        return Err(());
    }
    fs::canonicalize(launcher_apps).map_err(|_| ())
}

fn copy_bundle(
    source_root: &Path,
    target_root: &Path,
    run_id: &str,
    probe_id: &str,
    background_only: bool,
) -> Result<(), ()> {
    let (bundle_name, id_suffix) = match probe_id {
        "first" => ("AToolsOwnedProbeFirst.app", "first"),
        "second" => ("AToolsOwnedProbeSecond.app", "second"),
        _ => return Err(()),
    };
    let source_bundle = source_root.join(bundle_name);
    if !real_directory(&source_bundle) {
        return Err(());
    }
    ensure_exact_entries(&source_bundle, &["Contents"])?;
    let source_contents = source_bundle.join("Contents");
    if !real_directory(&source_contents) {
        return Err(());
    }
    ensure_exact_entries(&source_contents, &["Info.plist", "MacOS", "Resources"])?;

    let source_plist = source_contents.join("Info.plist");
    let source_macos = source_contents.join("MacOS");
    let source_resources = source_contents.join("Resources");
    if !real_directory(&source_macos) || !real_directory(&source_resources) {
        return Err(());
    }
    ensure_exact_entries(&source_macos, &["AToolsOwnedLaunchProbe"])?;
    ensure_exact_entries(&source_resources, &["probe-config.txt"])?;

    let plist_bytes = read_regular_nofollow(&source_plist, PLIST_LIMIT)?;
    let executable_bytes = read_regular_nofollow(
        &source_macos.join("AToolsOwnedLaunchProbe"),
        PROBE_BINARY_LIMIT,
    )?;
    let config_bytes =
        read_regular_nofollow(&source_resources.join("probe-config.txt"), CONFIG_LIMIT)?;
    validate_plist(&plist_bytes, run_id, id_suffix, background_only)?;
    let expected_config = format!("{run_id}\n{probe_id}\n");
    if config_bytes != expected_config.as_bytes() || !is_macho(&executable_bytes) {
        return Err(());
    }

    let target_bundle = target_root.join(bundle_name);
    create_private_directory(&target_bundle).map_err(|_| ())?;
    let target_contents = target_bundle.join("Contents");
    create_private_directory(&target_contents).map_err(|_| ())?;
    let target_macos = target_contents.join("MacOS");
    let target_resources = target_contents.join("Resources");
    create_private_directory(&target_macos).map_err(|_| ())?;
    create_private_directory(&target_resources).map_err(|_| ())?;
    write_new_private_file(&target_contents.join("Info.plist"), &plist_bytes, 0o600)?;
    write_new_private_file(
        &target_macos.join("AToolsOwnedLaunchProbe"),
        &executable_bytes,
        0o700,
    )?;
    write_new_private_file(
        &target_resources.join("probe-config.txt"),
        &config_bytes,
        0o600,
    )?;
    Ok(())
}

fn validate_plist(
    bytes: &[u8],
    run_id: &str,
    probe_id: &str,
    background_only: bool,
) -> Result<(), ()> {
    let value = plist::Value::from_reader(Cursor::new(bytes)).map_err(|_| ())?;
    let dictionary = value.as_dictionary().ok_or(())?;
    let expected_identifier = format!("dev.atools.launch-probe.{run_id}.{probe_id}");
    if dictionary
        .get("CFBundleExecutable")
        .and_then(plist::Value::as_string)
        != Some("AToolsOwnedLaunchProbe")
        || dictionary
            .get("CFBundleIdentifier")
            .and_then(plist::Value::as_string)
            != Some(expected_identifier.as_str())
        || dictionary
            .get("CFBundlePackageType")
            .and_then(plist::Value::as_string)
            != Some("APPL")
        || dictionary
            .get("LSBackgroundOnly")
            .and_then(plist::Value::as_boolean)
            .unwrap_or(false)
            != background_only
    {
        return Err(());
    }
    Ok(())
}

fn seed_renderer_settings(db: &Database, auto_clear: &str) -> Result<(), ()> {
    if !matches!(auto_clear, "immediately" | "never") {
        return Err(());
    }
    db.set_setting(
        "settings-general",
        &json!({
            "theme": "dark",
            "primaryColor": "blue",
            "customColor": "#db2777",
            "autoClear": auto_clear,
            "autoPaste": "off",
            "searchMode": "list",
            "tabKeyFunction": "navigate",
            "showRecentInSearch": true,
            "spaceOpenCommand": auto_clear == "never"
        })
        .to_string(),
    )
    .map_err(|_| ())
}

fn ensure_exact_entries(path: &Path, expected: &[&str]) -> Result<(), ()> {
    let mut names = fs::read_dir(path)
        .map_err(|_| ())?
        .map(|entry| {
            let entry = entry.map_err(|_| ())?;
            if entry.file_type().map_err(|_| ())?.is_symlink() {
                return Err(());
            }
            entry.file_name().into_string().map_err(|_| ())
        })
        .collect::<Result<Vec<_>, ()>>()?;
    names.sort();
    let mut expected = expected
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    expected.sort();
    if names == expected {
        Ok(())
    } else {
        Err(())
    }
}

fn real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
}

fn read_regular_nofollow(path: &Path, limit: usize) -> Result<Vec<u8>, ()> {
    let before = fs::symlink_metadata(path).map_err(|_| ())?;
    if !before.file_type().is_file() || before.len() > limit as u64 {
        return Err(());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| ())?;
    let opened = file.metadata().map_err(|_| ())?;
    if !opened.is_file() || opened.dev() != before.dev() || opened.ino() != before.ino() {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > limit {
        return Err(());
    }
    Ok(bytes)
}

fn write_new_private_file(path: &Path, bytes: &[u8], mode: u32) -> Result<(), ()> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW);
    options.mode(mode);
    let mut file = options.open(path).map_err(|_| ())?;
    file.write_all(bytes).map_err(|_| ())?;
    file.sync_all().map_err(|_| ())?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|_| ())
}

fn create_private_directory(path: &Path) -> Result<(), &'static str> {
    fs::create_dir(path).map_err(|_| "launcher-owned-fixture-not-verified")?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "launcher-owned-fixture-not-verified")
}

fn is_macho(bytes: &[u8]) -> bool {
    let Some(magic) = bytes.get(0..4) else {
        return false;
    };
    magic == &[0xcf, 0xfa, 0xed, 0xfe] || magic == &[0xfe, 0xed, 0xfa, 0xcf]
}
