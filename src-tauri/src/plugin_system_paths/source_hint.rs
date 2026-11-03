//! A bounded usage hint, never a permission or executable-code scanner.
use atools_core::Plugin;
use parking_lot::Mutex;
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
};

#[derive(Clone, Copy, Default)]
pub(super) struct Usage {
    pub standard: bool,
    pub plugin_data: bool,
    pub unknown: bool,
}
#[derive(Default)]
pub(super) struct Hints(Mutex<HashMap<(String, String, String), Usage>>);
impl Hints {
    pub fn scan(&self, plugin: &Plugin, revision: Option<&str>) -> Usage {
        let Ok(root) = std::fs::canonicalize(&plugin.path) else {
            return Usage {
                unknown: true,
                ..Usage::default()
            };
        };
        let key = revision.map(|r| {
            (
                plugin.id.clone(),
                root.to_string_lossy().into_owned(),
                r.to_string(),
            )
        });
        if let Some(value) = key.as_ref().and_then(|k| self.0.lock().get(k).copied()) {
            return value;
        }
        let usage = inspect(&root);
        if let Some(key) = key {
            let mut cache = self.0.lock();
            if cache.len() >= 32 {
                cache.clear();
            }
            cache.insert(key, usage);
        }
        usage
    }
    pub fn invalidate(&self, plugin: Option<&str>) {
        self.0
            .lock()
            .retain(|(id, _, _), _| plugin.is_some_and(|p| p != id));
    }
}
pub(super) fn inspect(root: &Path) -> Usage {
    let mut usage = Usage::default();
    let mut pending = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let (mut entries, mut sources, mut bytes) = (0usize, 0usize, 0usize);
    while let Some((directory, depth)) = pending.pop_front() {
        let Ok(children) = std::fs::read_dir(directory) else {
            usage.unknown = true;
            continue;
        };
        for child in children {
            entries += 1;
            if entries > 4096 {
                usage.unknown = true;
                return usage;
            }
            let Ok(child) = child else {
                usage.unknown = true;
                continue;
            };
            let path = child.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                usage.unknown = true;
                continue;
            };
            if metadata.file_type().is_symlink() {
                usage.unknown = true;
                continue;
            }
            if metadata.is_dir() {
                if child.file_name() == "node_modules" || child.file_name() == ".git" {
                    continue;
                }
                if depth >= 16 {
                    usage.unknown = true;
                } else {
                    pending.push_back((path, depth + 1));
                }
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let extension = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(
                extension.as_str(),
                "js" | "mjs" | "cjs" | "html" | "htm" | "ts" | "jsx" | "tsx" | "vue" | "svelte"
            ) {
                continue;
            }
            sources += 1;
            if sources > 128
                || metadata.len() > 2 * 1024 * 1024
                || bytes.saturating_add(metadata.len() as usize) > 8 * 1024 * 1024
            {
                usage.unknown = true;
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                usage.unknown = true;
                continue;
            };
            let Ok(Some(source)) = atools_plugin::package_resolution::read_package_asset_bytes(
                root,
                relative,
                2 * 1024 * 1024,
            ) else {
                usage.unknown = true;
                continue;
            };
            bytes += source.len();
            let compact: Vec<_> = source
                .into_iter()
                .filter(|b| !b.is_ascii_whitespace())
                .collect();
            if [b".getPath(".as_slice(), b"['getPath'](", b"[\"getPath\"]("]
                .iter()
                .any(|s| contains(&compact, s))
            {
                usage.standard = true;
            }
            if [
                b"getPath('pluginData')".as_slice(),
                b"getPath(\"pluginData\")",
                b"['getPath']('pluginData')",
                b"[\"getPath\"](\"pluginData\")",
            ]
            .iter()
            .any(|s| contains(&compact, s))
            {
                usage.plugin_data = true;
            }
        }
    }
    usage.unknown |= sources == 0;
    usage
}
fn contains(source: &[u8], needle: &[u8]) -> bool {
    source.windows(needle.len()).any(|w| w == needle)
}
