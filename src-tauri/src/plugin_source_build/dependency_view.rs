//! A writable staging directory with read-only links to reviewed dependency packages.
#[cfg(unix)]
use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;
#[cfg(unix)]
use std::sync::atomic::Ordering;

#[cfg(unix)]
use std::os::unix::fs::symlink;

#[cfg(unix)]
const ENTRY_LIMIT: usize = 4096;
#[cfg(unix)]
const NAME_LIMIT: usize = 214;
#[cfg(unix)]
const SKIPPED_ROOT_ENTRIES: [&str; 5] = [
    ".pnpm",
    ".vite",
    ".vite-temp",
    ".package-lock.json",
    ".vue-global-types",
];

/// Create a new stage-owned `node_modules`; no cache or package data is copied.
#[cfg(unix)]
pub(super) fn create(root: &Path, destination: &Path, cancel: &AtomicBool) -> Result<(), String> {
    create_with_limit(root, destination, cancel, ENTRY_LIMIT)
}

#[cfg(unix)]
fn create_with_limit(
    root: &Path,
    destination: &Path,
    cancel: &AtomicBool,
    entry_limit: usize,
) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|_| "SourceBuildDependencyRootUnavailable")?;
    if !root.is_dir() {
        return Err("SourceBuildExpectedDirectory".into());
    }
    fs::create_dir(destination).map_err(|_| "SourceBuildDependencyViewCreateFailed")?;
    let mut budget = ScanBudget {
        entries: 0,
        limit: entry_limit,
        cancel,
    };
    let mut entries = read_entries(&root, &mut budget)?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        budget.check_cancelled()?;
        let name = entry.file_name();
        let Some(name_text) = name.to_str() else {
            return Err("SourceBuildDependencyEntryInvalid".into());
        };
        if name_text == ".bin" {
            add_bin_view(&root, &entry.path(), &destination.join(".bin"), &mut budget)?;
        } else if SKIPPED_ROOT_ENTRIES.contains(&name_text) {
            // Package-manager stores and tool-generated caches are not packages.
            continue;
        } else if name_text.starts_with('@') {
            add_scope(&root, &entry.path(), destination, name_text, &mut budget)?;
        } else {
            if !valid_segment(name_text) {
                return Err("SourceBuildDependencyEntryInvalid".into());
            }
            add_directory_link(&root, &entry.path(), &destination.join(name_text))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
struct ScanBudget<'a> {
    entries: usize,
    limit: usize,
    cancel: &'a AtomicBool,
}

#[cfg(unix)]
impl ScanBudget<'_> {
    fn check_cancelled(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("SOURCE_BUILD_CANCELLED".into());
        }
        Ok(())
    }

    fn visit(&mut self) -> Result<(), String> {
        self.check_cancelled()?;
        self.entries = self.entries.saturating_add(1);
        if self.entries > self.limit {
            return Err("SourceBuildDependencyViewLimitExceeded".into());
        }
        Ok(())
    }
}

#[cfg(unix)]
fn read_entries(
    directory: &Path,
    budget: &mut ScanBudget<'_>,
) -> Result<Vec<fs::DirEntry>, String> {
    let iter = fs::read_dir(directory).map_err(|_| "SourceBuildDependencyReadFailed")?;
    let mut entries = Vec::new();
    for item in iter {
        budget.visit()?;
        entries.push(item.map_err(|_| "SourceBuildDependencyReadFailed")?);
    }
    Ok(entries)
}

#[cfg(unix)]
fn add_scope(
    root: &Path,
    source: &Path,
    destination: &Path,
    scope: &str,
    budget: &mut ScanBudget<'_>,
) -> Result<(), String> {
    let scope_name = scope
        .strip_prefix('@')
        .ok_or("SourceBuildDependencyEntryInvalid")?;
    if !valid_segment(scope_name) {
        return Err("SourceBuildDependencyEntryInvalid".into());
    }
    let meta = fs::symlink_metadata(source).map_err(|_| "SourceBuildDependencyReadFailed")?;
    if !meta.is_dir() {
        return Err("SourceBuildDependencyEntryInvalid".into());
    }
    let canonical = source
        .canonicalize()
        .map_err(|_| "SourceBuildDependencyReadFailed")?;
    if !canonical.starts_with(root) {
        return Err("SourceBuildDependencyEscapeRejected".into());
    }
    let scope_destination = destination.join(scope);
    fs::create_dir(&scope_destination).map_err(|_| "SourceBuildDependencyViewCreateFailed")?;
    let mut members = read_entries(&canonical, budget)?;
    members.sort_by_key(|entry| entry.file_name());
    for member in members {
        budget.check_cancelled()?;
        let name = member
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or("SourceBuildDependencyEntryInvalid")?;
        if !valid_segment(&name) {
            return Err("SourceBuildDependencyEntryInvalid".into());
        }
        add_directory_link(root, &member.path(), &scope_destination.join(name))?;
    }
    Ok(())
}

#[cfg(unix)]
fn add_directory_link(root: &Path, source: &Path, destination: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(source).map_err(|_| "SourceBuildDependencyReadFailed")?;
    if !meta.is_dir() && !meta.file_type().is_symlink() {
        return Err("SourceBuildDependencyEntryInvalid".into());
    }
    let canonical = source
        .canonicalize()
        .map_err(|_| "SourceBuildDependencyReadFailed")?;
    if !canonical.starts_with(root) {
        return Err("SourceBuildDependencyEscapeRejected".into());
    }
    if !canonical.is_dir() {
        return Err("SourceBuildDependencyEntryInvalid".into());
    }
    symlink(canonical, destination).map_err(|_| "SourceBuildDependencyLinkFailed".into())
}

#[cfg(unix)]
fn add_bin_view(
    root: &Path,
    source: &Path,
    destination: &Path,
    budget: &mut ScanBudget<'_>,
) -> Result<(), String> {
    let canonical_dir = source
        .canonicalize()
        .map_err(|_| "SourceBuildDependencyReadFailed")?;
    if !canonical_dir.starts_with(root) || !canonical_dir.is_dir() {
        return Err("SourceBuildDependencyEscapeRejected".into());
    }
    fs::create_dir(destination).map_err(|_| "SourceBuildDependencyViewCreateFailed")?;
    let mut entries = read_entries(&canonical_dir, budget)?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        budget.check_cancelled()?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or("SourceBuildDependencyEntryInvalid")?;
        if !valid_segment(&name) {
            return Err("SourceBuildDependencyEntryInvalid".into());
        }
        let entry_path = entry.path();
        let meta =
            fs::symlink_metadata(&entry_path).map_err(|_| "SourceBuildDependencyReadFailed")?;
        if !meta.is_file() && !meta.file_type().is_symlink() {
            return Err("SourceBuildDependencyEntryInvalid".into());
        }
        let canonical = entry_path
            .canonicalize()
            .map_err(|_| "SourceBuildDependencyReadFailed")?;
        if !canonical.starts_with(root) || !canonical.is_file() {
            return Err("SourceBuildDependencyEscapeRejected".into());
        }
        symlink(canonical, destination.join(name))
            .map_err(|_| String::from("SourceBuildDependencyLinkFailed"))?;
    }
    Ok(())
}

#[cfg(unix)]
fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= NAME_LIMIT
        && value != "."
        && value != ".."
        && !value.starts_with('.')
        && !value.starts_with('_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(not(unix))]
pub(super) fn create(_: &Path, _: &Path, _: &AtomicBool) -> Result<(), String> {
    Err("SourceBuildSandboxUnsupported".into())
}

#[cfg(all(test, unix))]
#[path = "dependency_view_tests.rs"]
mod tests;
