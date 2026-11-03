//! Owned workspaces: explicit cleanup, pinned directory operations and recovery.
use super::directory::{self, Directory};
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(in crate::plugin_source_build) struct Workspace {
    pub root: PathBuf,
    parent: Directory,
    anchor: Directory,
    name: OsString,
    cleanup_safe: bool,
    attempted: bool,
    cleaned: bool,
    cleanup_unconfirmed: Arc<AtomicBool>,
    cleanup_entry_limit: usize,
}
impl Workspace {
    pub fn create() -> Result<Self, String> {
        Self::with_signal(Arc::new(AtomicBool::new(false)))
    }
    pub fn with_signal(cleanup_unconfirmed: Arc<AtomicBool>) -> Result<Self, String> {
        Self::with_signal_and_entry_limit(cleanup_unconfirmed, 16_384)
    }

    /// Construct a private workspace with an explicit cleanup bound for a
    /// bounded dependency tree. Existing source-build workspaces retain the
    /// smaller historical default.
    pub(crate) fn with_signal_and_entry_limit(
        cleanup_unconfirmed: Arc<AtomicBool>,
        cleanup_entry_limit: usize,
    ) -> Result<Self, String> {
        if cleanup_entry_limit == 0 || cleanup_entry_limit > 210_000 {
            return Err("SOURCE_BUILD_CLEANUP_LIMIT_INVALID".into());
        }
        use std::os::unix::fs::DirBuilderExt;
        let parent_path = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| "SourceBuildTempUnavailable")?;
        let parent = Directory::absolute(&parent_path)?;
        let name: OsString = format!("atools-source-build-{}", uuid::Uuid::new_v4()).into();
        let root = parent_path.join(&name);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|_| "SourceBuildTempCreateFailed")?;
        let anchor = parent.open_directory(&name, None)?;
        Ok(Self {
            root,
            parent,
            anchor,
            name,
            cleanup_safe: true,
            attempted: false,
            cleaned: false,
            cleanup_unconfirmed,
            cleanup_entry_limit,
        })
    }
    /// Publish the owned workspace root into a pinned destination using an
    /// atomic no-replace rename. Cross-volume moves fail closed.
    pub(in crate::plugin_source_build) fn publish_to(
        mut self,
        destination: &Directory,
        name: &std::ffi::OsStr,
    ) -> Result<(), String> {
        let expected = self.anchor.metadata()?;
        if !self.parent.is_same_child(&self.name, &expected)? {
            return Err("SOURCE_BUILD_WORKSPACE_CHANGED".into());
        }
        self.parent
            .rename_child_to_noreplace(&self.name, destination, name)?;
        self.cleaned = true;
        destination.sync()?;
        Ok(())
    }

    pub fn mark_running(&mut self) {
        self.cleanup_safe = false;
    }
    pub fn mark_quiescent(&mut self) {
        self.cleanup_safe = true;
    }

    pub fn root_directory(&self) -> Result<Directory, String> {
        self.anchor.duplicate()
    }

    pub fn cleanup(&mut self) -> Result<(), String> {
        if self.cleaned {
            return Ok(());
        }
        self.attempted = true;
        let result = if self.cleanup_safe {
            self.remove()
        } else {
            Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into())
        };
        match result {
            Ok(()) => {
                self.cleaned = true;
                Ok(())
            }
            Err(_) => {
                self.record_failure();
                Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into())
            }
        }
    }
    fn remove(&self) -> Result<(), String> {
        let mut entries = 0;
        clear(&self.anchor, 0, &mut entries, self.cleanup_entry_limit)?;
        self.parent
            .unlink(&self.name, true, Some(&self.anchor.metadata()?))
    }
    fn record_failure(&self) {
        self.cleanup_unconfirmed.store(true, Ordering::Release);
        // Diagnostic only, inside this job's private stage. An unknown writer
        // could alter it; only the shared process-wide flag is authoritative.
        // This is never a cross-restart admission marker or a global temp index.
        let _ = self.anchor.owner_access();
        let record = serde_json::json!({"schemaVersion":1,"workspace":self.name.to_string_lossy(),"reason":"cleanup_unconfirmed"});
        let _ = self.anchor.write_recovery(record.to_string().as_bytes());
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        if !self.cleaned && !self.attempted {
            let _ = self.cleanup();
        }
    }
}

fn clear(
    directory: &Directory,
    depth: usize,
    entries: &mut usize,
    entry_limit: usize,
) -> Result<(), String> {
    if depth > 64 {
        return Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into());
    }
    let meta = directory.metadata()?;
    if meta.st_uid != unsafe { libc::geteuid() } {
        return Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into());
    }
    directory.owner_access()?;
    let names = directory.names(entry_limit.saturating_sub(*entries))?;
    *entries = entries
        .checked_add(names.len())
        .ok_or("SOURCE_BUILD_CLEANUP_UNCONFIRMED")?;
    if *entries > entry_limit {
        return Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into());
    }
    for name in names {
        let meta = directory.child_metadata(&name)?;
        if directory::kind(&meta) == libc::S_IFDIR {
            let child = directory.open_directory(&name, Some(&meta))?;
            clear(&child, depth + 1, entries, entry_limit)?;
            directory.unlink(&name, true, Some(&meta))?;
        } else {
            // Unlink owned names, including links/special files; never chmod a
            // regular file that may share its inode with a dependency canary.
            directory.unlink(&name, false, Some(&meta))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod dependency_cleanup_bound_tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicBool};

    #[test]
    fn dependency_cleanup_bound_exceeds_legacy_limit_without_changing_legacy_default() {
        let signal = Arc::new(AtomicBool::new(false));
        let mut workspace = Workspace::with_signal_and_entry_limit(signal, 16_385).unwrap();
        for index in 0..16_385 {
            fs::write(workspace.root.join(format!("f{index:05}")), []).unwrap();
        }
        let root = Directory::absolute(&workspace.root).unwrap();
        let mut entries = 0;
        assert!(clear(&root, 0, &mut entries, 16_384).is_err());
        assert_eq!(entries, 0);
        workspace.cleanup().unwrap();
        assert!(!workspace.root.exists());
        assert_eq!(
            Workspace::with_signal(Arc::new(AtomicBool::new(false)))
                .unwrap()
                .cleanup_entry_limit,
            16_384
        );
    }
}
