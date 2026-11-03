//! Owned test fixtures only; registration itself must enter through the real Child binding.
use super::local_targets::{self, Prepared};
use crate::renderer_desktop_smoke::profile::Profile;
use atools_core::Database;
use std::{
    fs::{self, DirBuilder, OpenOptions},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
};

pub(super) fn paths(profile: &Profile) -> [PathBuf; 4] {
    [
        profile.root.join("launcher-apps/AToolsOwnedProbeFirst.app"),
        profile
            .root
            .join("launcher-apps/AToolsOwnedProbeSecond.app"),
        profile.root.join("settings-registration/owned-file.txt"),
        profile.root.join("settings-registration/owned-folder"),
    ]
}

pub(super) fn prepare(
    profile: &Profile,
    db: &Database,
    first: &str,
    second: &str,
) -> Result<Prepared, String> {
    profile.validate_settings_child_fixture()?;
    local_targets::validate_probe_bundle(profile, first, "AToolsOwnedProbeFirst.app")?;
    local_targets::validate_probe_bundle(profile, second, "AToolsOwnedProbeSecond.app")?;
    if !db
        .read_renderer_local_shortcuts()
        .map_err(|_| "settings-registration-initial-rows-unavailable")?
        .is_empty()
        || db
            .get_setting("ztools-renderer:local-shortcuts-revision")
            .map_err(|_| "settings-registration-initial-revision-unavailable")?
            .is_some()
    {
        return Err("settings-registration-initial-state-not-empty".into());
    }
    let source = local_targets::empty_catalog_source(&profile.root)?;
    local_targets::set_local_app_search(db, false).map_err(str::to_owned)?;
    let [_, _, file, folder] = paths(profile);
    let directory = profile.root.join("settings-registration");
    DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(|_| "settings-registration-fixture-create-failed")?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&file)
        .map_err(|_| "settings-registration-fixture-create-failed")?;
    DirBuilder::new()
        .mode(0o700)
        .create(&folder)
        .map_err(|_| "settings-registration-fixture-create-failed")?;
    for path in [&directory, &file, &folder] {
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| "settings-registration-fixture-create-failed")?;
        if metadata.file_type().is_symlink()
            || fs::canonicalize(path).ok().as_deref() != Some(path.as_path())
        {
            return Err("settings-registration-fixture-create-failed".into());
        }
    }
    Ok(Prepared {
        source,
        local_shortcut_items: 0,
    })
}
