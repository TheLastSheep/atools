use super::{path, ZipLimits};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
};

#[derive(Clone, Copy, Debug)]
pub(crate) struct FileEntry {
    pub(crate) index: usize,
    pub(crate) mode: Option<u32>,
    size: u64,
}

struct AliasEntry {
    path: String,
    target_text: String,
}

pub(crate) struct ZipArchiveIndex<'a> {
    pub(super) archive: ::zip::ZipArchive<Cursor<Cow<'a, [u8]>>>,
    pub(super) files: BTreeMap<String, FileEntry>,
    pub(super) directories: BTreeSet<String>,
    pub(super) aliases: BTreeMap<String, String>,
    pub(super) manifest_roots: BTreeSet<String>,
    pub(super) limits: ZipLimits,
}

impl ZipArchiveIndex<'static> {
    pub(crate) fn open(bytes: Vec<u8>, limits: ZipLimits) -> Result<Self, String> {
        Self::open_source(Cow::Owned(bytes), limits)
    }
}

impl<'a> ZipArchiveIndex<'a> {
    pub(crate) fn open_borrowed(bytes: &'a [u8], limits: ZipLimits) -> Result<Self, String> {
        Self::open_source(Cow::Borrowed(bytes), limits)
    }

    fn open_source(bytes: Cow<'a, [u8]>, limits: ZipLimits) -> Result<Self, String> {
        if bytes.len() > limits.compressed_bytes {
            return Err("ZIP compressed archive exceeds budget".into());
        }
        let mut archive = ::zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|error| format!("Invalid plugin ZIP: {error}"))?;
        if archive.is_empty() || archive.len() > limits.entries {
            return Err("ZIP entry count exceeds budget".into());
        }
        let mut declared = 0u64;
        let mut projected = 0u64;
        let mut seen = BTreeSet::new();
        let mut files = BTreeMap::new();
        let mut directories = BTreeSet::new();
        let mut aliases = Vec::new();
        let mut manifest_roots = BTreeSet::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
            if entry.encrypted() {
                return Err("Encrypted ZIP entries are unsupported".into());
            }
            let raw = entry.name();
            let is_dir = entry.is_dir() || raw.ends_with('/');
            let safe = path::archive_path(raw, limits)?;
            if !seen.insert(safe.to_lowercase()) {
                return Err("ZIP contains a duplicate or case-colliding path".into());
            }
            declared = declared
                .checked_add(entry.size())
                .ok_or("ZIP size overflow")?;
            if entry.size() > limits.entry_bytes as u64 || declared > limits.declared_bytes as u64 {
                return Err("ZIP declared expanded size exceeds budget".into());
            }
            let unix_mode = entry.unix_mode();
            let kind = unix_mode.unwrap_or(0) & 0o170000;
            if is_dir || kind == 0o040000 {
                if kind != 0 && kind != 0o040000 {
                    return Err("ZIP contains an unsupported directory type".into());
                }
                directories.insert(safe);
                continue;
            }
            match kind {
                0 | 0o100000 => {
                    if safe == "plugin.json" {
                        manifest_roots.insert(String::new());
                    } else if let Some(root) = safe.strip_suffix("/plugin.json") {
                        manifest_roots.insert(root.to_string());
                    }
                    projected = projected
                        .checked_add(entry.size())
                        .ok_or("ZIP size overflow")?;
                    files.insert(
                        safe,
                        FileEntry {
                            index,
                            mode: unix_mode.map(|mode| mode & 0o777),
                            size: entry.size(),
                        },
                    );
                }
                0o120000 => {
                    if !path::is_cli_alias(&safe) {
                        return Err(
                            "ZIP links are unsupported outside node_modules/.bin/<leaf>".into()
                        );
                    }
                    let size = usize::try_from(entry.size()).map_err(|_| "ZIP size overflow")?;
                    if size > 4096 {
                        return Err("ZIP CLI alias target exceeds byte limit".into());
                    }
                    let mut target = Vec::with_capacity(size);
                    entry
                        .by_ref()
                        .take(4097)
                        .read_to_end(&mut target)
                        .map_err(|error| error.to_string())?;
                    if target.len() > 4096 {
                        return Err("ZIP CLI alias target exceeds byte limit".into());
                    }
                    let target = String::from_utf8(target)
                        .map_err(|_| "ZIP CLI alias target is not UTF-8")?;
                    aliases.push(AliasEntry {
                        path: safe,
                        target_text: target,
                    });
                }
                _ => return Err("ZIP links and special files are unsupported".into()),
            }
        }
        let mut resolved = BTreeMap::new();
        for alias in aliases {
            let target = path::resolve_alias_target(&alias.path, &alias.target_text)?;
            let file = files
                .get(&target)
                .ok_or("ZIP CLI alias target is not an archive regular file")?;
            projected = projected
                .checked_add(file.size)
                .ok_or("ZIP size overflow")?;
            if projected > limits.projected_bytes as u64 {
                return Err("ZIP projected materialized size exceeds budget".into());
            }
            resolved.insert(alias.path, target);
        }
        if declared > limits.declared_bytes as u64 || projected > limits.projected_bytes as u64 {
            return Err("ZIP declared or projected size exceeds budget".into());
        }
        let mut materialized_paths: Vec<&str> = files.keys().map(String::as_str).collect();
        materialized_paths.extend(resolved.keys().map(String::as_str));
        for path in materialized_paths {
            let mut ancestor = path;
            while let Some((parent, _)) = ancestor.rsplit_once('/') {
                if files.contains_key(parent) || resolved.contains_key(parent) {
                    return Err("ZIP file path conflicts with a nested entry".into());
                }
                ancestor = parent;
            }
        }
        Ok(Self {
            archive,
            files,
            directories,
            aliases: resolved,
            manifest_roots,
            limits,
        })
    }

    pub(crate) fn exists(&self, path: &str) -> bool {
        self.files.contains_key(path) || self.aliases.contains_key(path)
    }
    pub(crate) fn file_entry(&self, path: &str) -> Option<FileEntry> {
        self.files
            .get(self.aliases.get(path).map_or(path, String::as_str))
            .copied()
    }
    pub(crate) fn paths(&self) -> impl Iterator<Item = &str> {
        self.files
            .keys()
            .chain(self.aliases.keys())
            .map(String::as_str)
    }
    pub(crate) fn read_asset(&mut self, path: &str, limit: usize) -> Result<Vec<u8>, String> {
        let file = self
            .file_entry(path)
            .ok_or_else(|| format!("Missing ZIP entry: {path}"))?;
        if file.size > limit as u64 {
            return Err(format!("ZIP entry exceeds read budget: {path}"));
        }
        let mut entry = self
            .archive
            .by_index(file.index)
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::with_capacity(usize::try_from(file.size).unwrap_or(0));
        entry
            .by_ref()
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > limit {
            return Err(format!("ZIP entry exceeded read budget: {path}"));
        }
        Ok(bytes)
    }
    pub(crate) fn select_local_prefix(&self) -> Result<String, String> {
        if self.files.contains_key("plugin.json") {
            return Ok(String::new());
        }
        if self.manifest_roots.len() != 1 {
            return Err("ZIP must contain one published plugin package".into());
        }
        self.manifest_roots
            .iter()
            .next()
            .cloned()
            .ok_or("ZIP has no plugin manifest".into())
    }
    pub(crate) fn validate_scope(
        &self,
        prefix: &str,
        reject_outside_aliases: bool,
    ) -> Result<(), String> {
        for (alias, target) in &self.aliases {
            let in_selected = path::in_scope(alias, prefix);
            if !in_selected {
                if reject_outside_aliases {
                    return Err("ZIP CLI alias is outside the selected package".into());
                }
                continue;
            }
            if !path::in_scope(target, prefix) {
                return Err("ZIP CLI alias target escapes selected package".into());
            }
            if reject_outside_aliases {
                for nested in &self.manifest_roots {
                    if nested == prefix || nested.is_empty() {
                        continue;
                    }
                    let is_descendant = prefix.is_empty() || path::in_scope(nested, prefix);
                    if is_descendant
                        && (path::in_scope(alias, nested) || path::in_scope(target, nested))
                    {
                        return Err("ZIP CLI alias crosses a nested plugin package boundary".into());
                    }
                }
            } else if self.manifest_owner(alias, prefix) != self.manifest_owner(target, prefix) {
                return Err("ZIP CLI alias crosses a nested plugin package boundary".into());
            }
        }
        Ok(())
    }

    fn manifest_owner(&self, path: &str, selected_prefix: &str) -> String {
        self.manifest_roots
            .iter()
            .filter(|root| {
                !root.is_empty()
                    && root.as_str() != selected_prefix
                    && path::in_scope(root.as_str(), selected_prefix)
                    && path::in_scope(path, root.as_str())
            })
            .max_by_key(|root| root.len())
            .cloned()
            .unwrap_or_else(|| selected_prefix.to_owned())
    }

    pub(crate) fn validate_market_scope(
        &self,
        stage_root: &std::path::Path,
        package_root: &std::path::Path,
    ) -> Result<String, String> {
        let stage = stage_root
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let package = package_root
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let relative = package
            .strip_prefix(&stage)
            .map_err(|_| "Selected plugin package escaped market staging root")?;
        let prefix = relative
            .components()
            .map(|component| match component {
                std::path::Component::Normal(value) => value
                    .to_str()
                    .map(str::to_owned)
                    .ok_or("Selected package path is not UTF-8"),
                _ => Err("Selected package path is unsafe"),
            })
            .collect::<Result<Vec<_>, _>>()?
            .join("/");
        if !prefix.is_empty() {
            path::archive_path(&prefix, self.limits)?;
        }
        self.validate_scope(&prefix, false)?;
        Ok(prefix)
    }
}
