//! Bounded source hint, never an authorization or proof of complete API coverage.
use atools_core::Plugin;
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Usage {
    Detected,
    NotDetected,
    Unknown,
}
#[derive(Default)]
pub(super) struct Hints(Mutex<HashMap<(String, String, String, super::registry::Access), Usage>>);
impl Hints {
    pub fn scan(
        &self,
        plugin: &Plugin,
        revision: Option<&str>,
        access: super::registry::Access,
    ) -> Usage {
        let Ok(root) = std::fs::canonicalize(&plugin.path) else {
            return Usage::Unknown;
        };
        let cache_key = revision.map(|r| {
            (
                plugin.id.clone(),
                root.to_string_lossy().to_string(),
                r.to_string(),
                access,
            )
        });
        if let Some(cached) = cache_key
            .as_ref()
            .and_then(|key| self.0.lock().get(key).copied())
        {
            return cached;
        }
        let result = inspect(&root, access);
        if let Some(key) = cache_key {
            let mut cache = self.0.lock();
            if cache.len() >= 32 {
                cache.clear();
            }
            cache.insert(key, result);
        }
        result
    }
    pub fn invalidate(&self, plugin: &str) {
        self.0.lock().retain(|(id, _, _, _), _| id != plugin);
    }
}
pub(super) fn inspect(root: &Path, access: super::registry::Access) -> Usage {
    let mut pending = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let (mut entries, mut sources, mut bytes) = (0usize, 0usize, 0usize);
    let mut unknown = false;
    while let Some((directory, depth)) = pending.pop_front() {
        let Ok(children) = std::fs::read_dir(&directory) else {
            unknown = true;
            continue;
        };
        for child in children {
            entries += 1;
            if entries > 4096 {
                return Usage::Unknown;
            }
            let Ok(child) = child else {
                unknown = true;
                continue;
            };
            let path = child.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                unknown = true;
                continue;
            };
            if metadata.file_type().is_symlink() {
                unknown = true;
                continue;
            }
            if metadata.is_dir() {
                if child.file_name() == "node_modules" || child.file_name() == ".git" {
                    continue;
                }
                if depth >= 16 {
                    unknown = true;
                } else {
                    pending.push_back((path, depth + 1));
                }
                continue;
            }
            if !metadata.is_file() {
                unknown = true;
                continue;
            }
            let extension = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(
                extension.as_str(),
                "js" | "mjs" | "cjs" | "html" | "htm" | "ts" | "jsx" | "tsx"
            ) {
                continue;
            }
            sources += 1;
            if sources > 128
                || metadata.len() > 2 * 1024 * 1024
                || bytes.saturating_add(metadata.len() as usize) > 8 * 1024 * 1024
            {
                unknown = true;
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                unknown = true;
                continue;
            };
            let Ok(Some(source)) = atools_plugin::package_resolution::read_package_asset_bytes(
                root,
                relative,
                2 * 1024 * 1024,
            ) else {
                unknown = true;
                continue;
            };
            bytes += source.len();
            // Whitespace removal recognizes ordinary dot/bracket spellings. It
            // does not evaluate computed properties, decode strings, or run code.
            let compact = source
                .into_iter()
                .filter(|b| !b.is_ascii_whitespace())
                .collect::<Vec<_>>();
            if compact
                .windows(access.method().len())
                .any(|w| w == access.method().as_bytes())
            {
                return Usage::Detected;
            }
        }
    }
    if unknown || sources == 0 {
        Usage::Unknown
    } else {
        Usage::NotDetected
    }
}
