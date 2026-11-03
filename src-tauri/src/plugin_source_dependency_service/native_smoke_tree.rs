//! Reuse the production no-follow bounded walker for installed-package evidence.
use std::{path::Path, sync::atomic::AtomicBool};

pub(super) struct TreeSummary {
    pub sha256: String,
    pub entries: u64,
    pub files: u64,
    pub bytes: u64,
}

pub(super) fn digest(root: &Path) -> Result<TreeSummary, String> {
    let directory = super::super::super::staging::Directory::absolute(root)?;
    let inventory = super::super::tree_inventory::calculate(&directory, &AtomicBool::new(false))?;
    Ok(TreeSummary {
        sha256: inventory.sha256,
        entries: inventory.entries,
        files: inventory.files,
        bytes: inventory.bytes,
    })
}
