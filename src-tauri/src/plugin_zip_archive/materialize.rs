use super::{index::ZipArchiveIndex, path, ZipLimits};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

impl<'a> ZipArchiveIndex<'a> {
    pub(crate) fn materialize_all(&mut self, destination: &Path) -> Result<(), String> {
        self.materialize_scope(destination, "")
    }

    pub(crate) fn materialize_scope(
        &mut self,
        destination: &Path,
        prefix: &str,
    ) -> Result<(), String> {
        let mut dirs = self.directories_for_scope(prefix);
        for path in self.paths() {
            if path::in_scope(path, prefix) {
                let relative = strip_prefix(path, prefix)?;
                if let Some(parent) = relative.rsplit_once('/').map(|(parent, _)| parent) {
                    let mut accumulated = String::new();
                    for part in parent.split('/') {
                        if !accumulated.is_empty() {
                            accumulated.push('/');
                        }
                        accumulated.push_str(part);
                        dirs.insert(accumulated.clone());
                    }
                }
            }
        }
        for directory in dirs {
            let target = safe_join(destination, &directory)?;
            fs::create_dir_all(target).map_err(|error| error.to_string())?;
        }
        let paths: Vec<String> = self
            .paths()
            .filter(|path| path::in_scope(path, prefix))
            .map(str::to_owned)
            .collect();
        let mut total = 0usize;
        for path in paths {
            let relative = strip_prefix(&path, prefix)?;
            let bytes = self.read_asset(&path, self.limits.entry_bytes)?;
            total = total.checked_add(bytes.len()).ok_or("ZIP size overflow")?;
            if total > self.limits.actual_bytes {
                return Err("ZIP actual materialized size exceeds budget".into());
            }
            let target = safe_join(destination, &relative)?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|error| error.to_string())?;
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            if let Some(mode) = self.file_entry(&path).and_then(|entry| entry.mode) {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777))
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    fn directories_for_scope(&self, prefix: &str) -> std::collections::BTreeSet<String> {
        self.directories
            .iter()
            .filter_map(|path| {
                if path::in_scope(path, prefix) {
                    strip_prefix(path, prefix).ok()
                } else {
                    None
                }
            })
            .filter(|path| !path.is_empty())
            .collect()
    }
}

fn strip_prefix(path: &str, prefix: &str) -> Result<String, String> {
    if prefix.is_empty() {
        return Ok(path.to_owned());
    }
    path.strip_prefix(prefix)
        .and_then(|rest| rest.strip_prefix('/'))
        .map(str::to_owned)
        .ok_or_else(|| "ZIP path is outside selected package".into())
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut target = root.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', '\0', ':']) {
            return Err("Unsafe materialized ZIP path".into());
        }
        target.push(part);
    }
    Ok(target)
}
