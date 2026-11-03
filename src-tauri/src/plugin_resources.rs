//! Bounded source reads for the isolated preload module graph.
//! The caller selects an installed plugin ID; it cannot supply a different root.

use std::fs::OpenOptions;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::state::AppState;

const MAX_PRELOAD_SOURCE_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub async fn read_plugin_preload_module(
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    module_path: String,
) -> Result<String, String> {
    let plugin = state
        .db
        .get_plugin(&plugin_id)
        .map_err(|_| "ERR_ATOOLS_PRELOAD_PLUGIN_NOT_FOUND".to_string())?;
    if !plugin.enabled {
        return Err("ERR_ATOOLS_PRELOAD_PLUGIN_DISABLED".to_string());
    }
    tokio::task::spawn_blocking(move || {
        read_preload_source(Path::new(&plugin.path), Path::new(&module_path))
    })
    .await
    .map_err(|error| format!("ERR_ATOOLS_PRELOAD_READ_TASK: {error}"))?
}

fn read_preload_source(plugin_root: &Path, requested: &Path) -> Result<String, String> {
    let root = plugin_root
        .canonicalize()
        .map_err(|error| format!("ERR_ATOOLS_PRELOAD_ROOT: {error}"))?;
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        plugin_root.join(requested)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "ERR_ATOOLS_PRELOAD_NOT_FOUND".to_string(),
            _ => format!("ERR_ATOOLS_PRELOAD_RESOLVE: {error}"),
        })?;
    if !resolved.starts_with(&root) {
        return Err("ERR_ATOOLS_PRELOAD_PATH_OUTSIDE_PLUGIN".to_string());
    }
    reject_module_symlinks(plugin_root, &candidate)?;
    let before_open = std::fs::metadata(&resolved)
        .map_err(|error| format!("ERR_ATOOLS_PRELOAD_METADATA: {error}"))?;
    validate_source_metadata(&before_open)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(&resolved)
        .map_err(|error| format!("ERR_ATOOLS_PRELOAD_OPEN: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("ERR_ATOOLS_PRELOAD_METADATA: {error}"))?;
    validate_source_metadata(&metadata)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PRELOAD_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("ERR_ATOOLS_PRELOAD_READ: {error}"))?;
    if bytes.len() as u64 > MAX_PRELOAD_SOURCE_BYTES {
        return Err("ERR_ATOOLS_PRELOAD_BUDGET: source grew beyond 2 MiB".to_string());
    }
    // Do not return bytes if the requested path changed while it was read.
    if candidate.canonicalize().ok().as_ref() != Some(&resolved) {
        return Err("ERR_ATOOLS_PRELOAD_PATH_CHANGED".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = std::fs::metadata(&resolved)
            .map_err(|_| "ERR_ATOOLS_PRELOAD_PATH_CHANGED".to_string())?;
        if metadata.dev() != current.dev() || metadata.ino() != current.ino() {
            return Err("ERR_ATOOLS_PRELOAD_PATH_CHANGED".to_string());
        }
    }
    String::from_utf8(bytes).map_err(|_| "ERR_ATOOLS_PRELOAD_UTF8".to_string())
}

fn validate_source_metadata(metadata: &std::fs::Metadata) -> Result<(), String> {
    if !metadata.is_file() {
        return Err("ERR_ATOOLS_PRELOAD_NOT_FILE".to_string());
    }
    if metadata.len() > MAX_PRELOAD_SOURCE_BYTES {
        return Err("ERR_ATOOLS_PRELOAD_BUDGET: source exceeds 2 MiB".to_string());
    }
    Ok(())
}

fn reject_module_symlinks(plugin_root: &Path, candidate: &Path) -> Result<(), String> {
    // The installed root itself may be a configured development symlink. Module
    // paths below that authoritative root must not add another symlink.
    let relative = candidate
        .strip_prefix(plugin_root)
        .map_err(|_| "ERR_ATOOLS_PRELOAD_PATH_OUTSIDE_PLUGIN".to_string())?;
    let mut current = PathBuf::from(plugin_root);
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => current.push(part),
            std::path::Component::CurDir => continue,
            _ => return Err("ERR_ATOOLS_PRELOAD_PATH_OUTSIDE_PLUGIN".to_string()),
        }
        if std::fs::symlink_metadata(&current)
            .map_err(|error| format!("ERR_ATOOLS_PRELOAD_METADATA: {error}"))?
            .file_type()
            .is_symlink()
        {
            return Err("ERR_ATOOLS_PRELOAD_SYMLINK".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use tempfile::tempdir;

    #[test]
    fn reads_only_module_files_under_the_installed_root() {
        let temp = tempdir().unwrap();
        fs::create_dir(temp.path().join("preload")).unwrap();
        fs::write(
            temp.path().join("preload/helper.cjs"),
            "module.exports = 42;",
        )
        .unwrap();
        assert_eq!(
            read_preload_source(temp.path(), Path::new("preload/helper.cjs")).unwrap(),
            "module.exports = 42;"
        );
        assert_eq!(
            read_preload_source(temp.path(), &temp.path().join("preload/helper.cjs")).unwrap(),
            "module.exports = 42;"
        );
        assert!(read_preload_source(temp.path(), Path::new("missing.js"))
            .unwrap_err()
            .contains("NOT_FOUND"));
        assert!(read_preload_source(temp.path(), Path::new("preload"))
            .unwrap_err()
            .contains("NOT_FILE"));
    }

    #[test]
    fn rejects_traversal_absolute_escape_and_root_prefix_collisions() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("plugin");
        let outside = temp.path().join("plugin-other");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("private.json"), "{\"secret\":true}").unwrap();
        for path in [
            PathBuf::from("../plugin-other/private.json"),
            outside.join("private.json"),
        ] {
            assert!(read_preload_source(&root, &path)
                .unwrap_err()
                .contains("OUTSIDE_PLUGIN"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_external_and_internal_module_symlinks() {
        use std::os::unix::fs::symlink;
        let temp = tempdir().unwrap();
        let root = temp.path().join("plugin");
        fs::create_dir_all(&root).unwrap();
        fs::write(temp.path().join("private.json"), "{\"secret\":true}").unwrap();
        fs::write(root.join("local.json"), "{}").unwrap();
        symlink(temp.path().join("private.json"), root.join("escape.json")).unwrap();
        symlink(root.join("local.json"), root.join("alias.json")).unwrap();
        assert!(read_preload_source(&root, Path::new("escape.json"))
            .unwrap_err()
            .contains("OUTSIDE_PLUGIN"));
        assert!(read_preload_source(&root, Path::new("alias.json"))
            .unwrap_err()
            .contains("SYMLINK"));
    }

    #[test]
    fn bounds_reads_and_rejects_non_utf8_source() {
        let temp = tempdir().unwrap();
        File::create(temp.path().join("large.js"))
            .unwrap()
            .set_len(MAX_PRELOAD_SOURCE_BYTES + 1)
            .unwrap();
        fs::write(temp.path().join("invalid.js"), [0xff]).unwrap();
        assert!(read_preload_source(temp.path(), Path::new("large.js"))
            .unwrap_err()
            .contains("BUDGET"));
        assert!(read_preload_source(temp.path(), Path::new("invalid.js"))
            .unwrap_err()
            .contains("UTF8"));
    }
}
