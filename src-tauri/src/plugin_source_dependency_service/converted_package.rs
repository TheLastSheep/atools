//! Narrow descriptor-relative access for the fixed converted-package handoff.
use super::{tree_inventory, ConvertedPackageTree};
use crate::plugin_source_build::staging::Directory;
use std::{ffi::OsStr, io::Read, os::unix::fs::MetadataExt, path::Path};

const HANDOFF_FILE: &str = "converted-ui-handoff-v1.json";
const SOURCE_EVIDENCE_FILE: &str = "converted-source-evidence-v1.json";
const HANDOFF_LIMIT: u64 = 64 * 1024;
const PACKAGE_MANIFEST_LIMIT: u64 = 256 * 1024;

pub(in crate::plugin_source_build) fn read_converted_handoff(
    root: &Path,
) -> Result<Vec<u8>, String> {
    read_pinned_handoff(root, HANDOFF_FILE)
}

pub(in crate::plugin_source_build) fn read_converted_source_evidence(
    root: &Path,
) -> Result<Vec<u8>, String> {
    read_pinned_handoff(root, SOURCE_EVIDENCE_FILE)
}

fn read_pinned_handoff(root: &Path, handoff_file: &str) -> Result<Vec<u8>, String> {
    let directory = Directory::absolute(root)?;
    let meta = directory.metadata()?;
    if meta.st_uid != unsafe { libc::geteuid() }
        || meta.st_mode & libc::S_IFMT != libc::S_IFDIR
        || meta.st_mode & 0o777 != 0o700
        || meta.st_mode & 0o7000 != 0
    {
        return Err("CONVERTED_HANDOFF_ROOT_INVALID".into());
    }
    let name = OsStr::new(handoff_file);
    let before = directory.child_metadata(name)?;
    if before.st_uid != unsafe { libc::geteuid() }
        || before.st_mode & libc::S_IFMT != libc::S_IFREG
        || before.st_nlink != 1
        || before.st_mode & 0o777 != 0o600
        || before.st_mode & 0o7000 != 0
        || before.st_size < 0
        || before.st_size as u64 > HANDOFF_LIMIT
    {
        return Err("CONVERTED_HANDOFF_FILE_INVALID".into());
    }
    let mut file = directory.open_file(name, Some(&before))?;
    let opened = file.metadata().map_err(|_| "CONVERTED_HANDOFF_FILE_READ")?;
    if opened.uid() != unsafe { libc::geteuid() }
        || opened.nlink() != 1
        || opened.mode() & 0o777 != 0o600
        || opened.mode() & 0o7000 != 0
        || opened.len() > HANDOFF_LIMIT
    {
        return Err("CONVERTED_HANDOFF_FILE_INVALID".into());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    (&mut file)
        .take(HANDOFF_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "CONVERTED_HANDOFF_FILE_READ")?;
    let after = file.metadata().map_err(|_| "CONVERTED_HANDOFF_FILE_READ")?;
    if bytes.len() as u64 != opened.len()
        || bytes.len() as u64 > HANDOFF_LIMIT
        || after.dev() != opened.dev()
        || after.ino() != opened.ino()
        || after.len() != opened.len()
        || after.mtime() != opened.mtime()
        || after.mtime_nsec() != opened.mtime_nsec()
        || after.ctime() != opened.ctime()
        || after.ctime_nsec() != opened.ctime_nsec()
    {
        return Err("CONVERTED_HANDOFF_FILE_CHANGED".into());
    }
    Ok(bytes)
}

pub(in crate::plugin_source_build) fn calculate_converted_package_tree(
    path: &Path,
) -> Result<ConvertedPackageTree, String> {
    let root = Directory::absolute(path)?;
    let tree = tree_inventory::calculate_package(&root)?;
    Ok(ConvertedPackageTree {
        sha256: tree.sha256,
        entries: tree.entries,
        files: tree.files,
        bytes: tree.bytes,
    })
}

pub(in crate::plugin_source_build) fn read_converted_package_manifest(
    root: &Path,
) -> Result<Vec<u8>, String> {
    read_regular_child(root, "plugin.json", PACKAGE_MANIFEST_LIMIT)
}

fn read_regular_child(root: &Path, name: &str, limit: u64) -> Result<Vec<u8>, String> {
    let directory = Directory::absolute(root)?;
    let metadata = directory.child_metadata(OsStr::new(name))?;
    if metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_mode & libc::S_IFMT != libc::S_IFREG
        || metadata.st_nlink != 1
        || metadata.st_mode & 0o022 != 0
        || metadata.st_mode & 0o7000 != 0
        || metadata.st_size < 0
        || metadata.st_size as u64 > limit
    {
        return Err("CONVERTED_HANDOFF_PACKAGE_FILE_INVALID".into());
    }
    let mut file = directory.open_file(OsStr::new(name), Some(&metadata))?;
    let before = file
        .metadata()
        .map_err(|_| "CONVERTED_HANDOFF_PACKAGE_FILE_READ")?;
    if before.uid() != unsafe { libc::geteuid() }
        || before.nlink() != 1
        || before.len() > limit
        || before.mode() & 0o022 != 0
        || before.mode() & 0o7000 != 0
    {
        return Err("CONVERTED_HANDOFF_PACKAGE_FILE_INVALID".into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "CONVERTED_HANDOFF_PACKAGE_FILE_READ")?;
    let after = file
        .metadata()
        .map_err(|_| "CONVERTED_HANDOFF_PACKAGE_FILE_READ")?;
    if bytes.len() as u64 != before.len()
        || after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.mtime_nsec() != before.mtime_nsec()
        || after.ctime() != before.ctime()
        || after.ctime_nsec() != before.ctime_nsec()
    {
        return Err("CONVERTED_HANDOFF_PACKAGE_FILE_CHANGED".into());
    }
    Ok(bytes)
}
