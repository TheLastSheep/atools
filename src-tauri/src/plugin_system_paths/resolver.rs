//! Actual host paths only. Resolving standard metadata never creates directories.
use atools_core::config::AppConfig;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(super) const STANDARD_NAMES: [&str; 12] = [
    "home",
    "appData",
    "userData",
    "temp",
    "exe",
    "desktop",
    "documents",
    "downloads",
    "music",
    "pictures",
    "videos",
    "logs",
];
pub(super) const MAX_PATH_BYTES: usize = 16 * 1024;
pub(super) const MAX_SNAPSHOT_BYTES: usize = 128 * 1024;
pub(super) type Paths = BTreeMap<String, String>;

pub(super) fn validate_paths(paths: &Paths) -> Result<(), String> {
    if paths.len() > 13
        || paths.iter().any(|(name, value)| {
            (!STANDARD_NAMES.contains(&name.as_str()) && name != "pluginData")
                || value.len() > MAX_PATH_BYTES
        })
        || serde_json::to_vec(paths)
            .map_err(|_| "Invalid path snapshot")?
            .len()
            > MAX_SNAPSHOT_BYTES
    {
        return Err("Path metadata exceeds its budget".into());
    }
    Ok(())
}

pub(super) fn standard(config: &AppConfig) -> Result<Paths, String> {
    let mut paths = Paths::new();
    for name in STANDARD_NAMES {
        let value = match name {
            "home" => dirs::home_dir(),
            "appData" => dirs::config_dir(),
            "userData" => Some(config.base_dir().to_path_buf()),
            "temp" => Some(std::env::temp_dir()),
            "exe" => std::env::current_exe().ok(),
            "desktop" => dirs::desktop_dir(),
            "documents" => dirs::document_dir(),
            "downloads" => dirs::download_dir(),
            "music" => dirs::audio_dir(),
            "pictures" => dirs::picture_dir(),
            "videos" => dirs::video_dir(),
            "logs" => Some(config.base_dir().join("logs")),
            _ => None,
        };
        paths.insert(
            name.into(),
            value
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        );
    }
    validate_paths(&paths)?;
    Ok(paths)
}

fn real_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| "Plugin data directory is unavailable")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Plugin data directory cannot be a reparse point".into());
        }
    }
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Plugin data directory must be a real directory".into());
    }
    std::fs::canonicalize(path).map_err(|_| "Plugin data directory is unavailable".into())
}

pub(super) fn plugin_data(config: &AppConfig, plugin: &str) -> Result<Paths, String> {
    // Never use an untrusted plugin ID as a path component.
    if plugin.is_empty() || plugin.len() > 256 {
        return Err("Invalid plugin identity".into());
    }
    let base = real_directory(config.base_dir())?;
    let root = base.join("plugin-data");
    let name = format!("{:x}", Sha256::digest(plugin.as_bytes()));
    #[cfg(unix)]
    create_anchored(&base, &name)?;
    #[cfg(not(unix))]
    create_child(&root)?;
    if real_directory(&root)?.parent() != Some(base.as_path()) {
        return Err("Plugin data directory escaped the host root".into());
    }
    let target = root.join(name);
    #[cfg(not(unix))]
    create_child(&target)?;
    let actual = real_directory(&target)?;
    if actual.parent() != Some(root.as_path()) {
        return Err("Plugin data directory escaped its container".into());
    }
    let paths = Paths::from([("pluginData".into(), actual.to_string_lossy().into_owned())]);
    validate_paths(&paths)?;
    Ok(paths)
}

#[cfg(not(unix))]
fn create_child(path: &Path) -> Result<(), String> {
    match std::fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            real_directory(path).map(|_| ())
        }
        Err(_) => Err("Unable to create the plugin data directory".into()),
    }
}

#[cfg(unix)]
fn create_anchored(base: &Path, name: &str) -> Result<(), String> {
    use std::{
        ffi::CString,
        fs::{File, OpenOptions},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        },
    };
    fn child(parent: &File, name: &str) -> Result<File, String> {
        let name = CString::new(name).map_err(|_| "Invalid plugin data component")?;
        // Descriptor-relative creation cannot follow a swapped parent symlink.
        let created = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
        if created != 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err("Unable to create the plugin data directory".into());
        }
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("Plugin data directory must be a real directory".into());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    let base = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(base)
        .map_err(|_| "Plugin data root is unavailable")?;
    let root = child(&base, "plugin-data")?;
    let _target = child(&root, name)?;
    Ok(())
}
