//! Private filesystem paths and write helpers for renderer smoke profiles.

use std::{
    env, fs,
    fs::OpenOptions,
    io::Write,
    path::{Component, Path, PathBuf},
};

pub(super) fn validate_absolute_path(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{label} path must be absolute"));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!("{label} path must not contain '..'"));
    }
    Ok(())
}

pub(super) fn validate_fixture_root_path(root: &Path) -> Result<(), String> {
    validate_absolute_path(root, "fixture-root")?;
    let parent = root.parent().ok_or_else(|| {
        "fixture-root must be a direct child of an allowed temp directory".to_string()
    })?;
    if root.file_name().is_none() {
        return Err("fixture-root must name a new child directory".to_string());
    }

    let temp_dir = env::temp_dir();
    let private_tmp = Path::new("/private/tmp");
    if parent != temp_dir && parent != private_tmp {
        return Err("fixture-root must be a direct child of temp_dir or /private/tmp".to_string());
    }

    let parent_canonical = fs::canonicalize(parent)
        .map_err(|error| format!("cannot resolve fixture-root parent: {error}"))?;
    let allowed = [temp_dir.as_path(), private_tmp]
        .into_iter()
        .filter_map(|candidate| fs::canonicalize(candidate).ok())
        .any(|candidate| candidate == parent_canonical);
    if !allowed {
        return Err(
            "fixture-root parent resolves outside the allowed temp directories".to_string(),
        );
    }

    if let Some(home) = env::var_os("HOME") {
        let atools_home = PathBuf::from(home).join(".atools");
        if root == atools_home || root.starts_with(&atools_home) {
            return Err("fixture-root must not use HOME/.atools".to_string());
        }
    }
    Ok(())
}

pub(super) fn create_private_child(root: &Path, name: &str) -> Result<(), String> {
    let path = root.join(name);
    fs::create_dir(&path).map_err(|error| format!("cannot create {name} directory: {error}"))?;
    set_directory_mode(&path)
}

pub(super) fn create_private_root(root: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(root)
        .map_err(|error| format!("cannot atomically create new fixture-root: {error}"))?;
    set_directory_mode(root)
}

pub(super) fn write_new_private_file(
    path: &Path,
    bytes: &[u8],
    operation: &str,
) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("{operation}: {error}"))?;
    set_file_mode(&file)?;
    file.write_all(bytes)
        .map_err(|error| format!("write private file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync private file: {error}"))?;
    Ok(())
}

#[cfg(unix)]
fn set_directory_mode(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| format!("open private directory without following links: {error}"))?;
    if !directory
        .metadata()
        .map_err(|error| format!("inspect private directory: {error}"))?
        .is_dir()
    {
        return Err("private directory path is not a directory".to_string());
    }
    directory
        .set_permissions(fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("set private directory permissions: {error}"))
}

#[cfg(not(unix))]
fn set_directory_mode(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_file_mode(file: &fs::File) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("set private report permissions: {error}"))
}

#[cfg(not(unix))]
fn set_file_mode(_file: &fs::File) -> Result<(), String> {
    Ok(())
}
