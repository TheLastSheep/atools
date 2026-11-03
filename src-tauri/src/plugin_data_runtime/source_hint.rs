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
pub(super) struct Hints(Mutex<HashMap<(String, String, String), Usage>>);
impl Hints {
    pub fn scan(&self, plugin: &Plugin, revision: Option<&str>) -> Usage {
        let Ok(root) = std::fs::canonicalize(&plugin.path) else {
            return Usage::Unknown;
        };
        let cache_key = revision.map(|r| {
            (
                plugin.id.clone(),
                root.to_string_lossy().to_string(),
                r.to_string(),
            )
        });
        if let Some(cached) = cache_key
            .as_ref()
            .and_then(|key| self.0.lock().get(key).copied())
        {
            return cached;
        }
        let result = inspect(&root);
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
        self.0.lock().retain(|(id, _, _), _| id != plugin);
    }
}
fn inspect(root: &Path) -> Usage {
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
            let source = strip_javascript_comments(&source);
            let startup_preference = detects_startup_preference(&source);
            let compact = source
                .into_iter()
                .filter(|b| !b.is_ascii_whitespace())
                .collect::<Vec<_>>();
            if [
                b"localStorage".as_slice(),
                b"dbStorage".as_slice(),
                b".db.",
                b".db[",
                b"['db']",
                b"[\"db\"]",
                b".getFeatures",
                b".setFeature",
                b".removeFeature",
                b"['getFeatures']",
                b"['setFeature']",
                b"['removeFeature']",
                b"[\"getFeatures\"]",
                b"[\"setFeature\"]",
                b"[\"removeFeature\"]",
            ]
            .iter()
            .any(|needle| compact.windows(needle.len()).any(|w| w == *needle))
                || startup_preference
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

fn detects_startup_preference(source: &[u8]) -> bool {
    let raw = String::from_utf8_lossy(source);
    let compact = raw
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .map(char::from)
        .collect::<String>();
    for quote in ['\'', '"'] {
        let key = format!("{quote}auto-start-plugin{quote}");
        let mut keys = Vec::new();
        for (start, _) in raw.match_indices(&key) {
            let before = raw[..start].trim_end();
            let Some(equal) = before.strip_suffix('=').map(str::trim_end) else {
                continue;
            };
            let name_start = equal
                .char_indices()
                .rev()
                .find_map(|(index, character)| {
                    (!character.is_ascii_alphanumeric() && character != '_')
                        .then_some(index + character.len_utf8())
                })
                .unwrap_or(0);
            let name = &equal[name_start..];
            if !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                keys.push(name.to_string());
            }
        }
        for channel in ["ztools:db-get", "ztools:db-put"] {
            for channel_quote in ['\'', '"'] {
                let channel = format!("{channel_quote}{channel}{channel_quote}");
                for name in &keys {
                    if compact.contains(&format!("invoke({channel},{name})"))
                        || compact.contains(&format!("invoke({channel},{name},"))
                    {
                        return true;
                    }
                }
                if compact.contains(&format!(
                    "invoke({channel},{quote}auto-start-plugin{quote})"
                )) || compact.contains(&format!(
                    "invoke({channel},{quote}auto-start-plugin{quote},"
                )) {
                    return true;
                }
            }
        }
    }
    false
}

fn strip_javascript_comments(source: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(source.len());
    let mut index = 0;
    let mut quote = None;
    let mut escaped = false;
    while index < source.len() {
        let byte = source[index];
        if let Some(delimiter) = quote {
            result.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == delimiter {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            quote = Some(byte);
            result.push(byte);
            index += 1;
        } else if byte == b'/' && source.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < source.len() && !matches!(source[index], b'\n' | b'\r') {
                index += 1;
            }
        } else if byte == b'/' && source.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < source.len() && !(source[index] == b'*' && source[index + 1] == b'/')
            {
                index += 1;
            }
            index = (index + 2).min(source.len());
        } else {
            result.push(byte);
            index += 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{Hints, Usage};
    use atools_core::{models::Plugin, Database};
    use serde_json::json;

    #[test]
    fn source_hint_recognizes_original_startup_key_constant_shapes_only_with_ipc() {
        let db = Database::in_memory().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let plugin: Plugin = serde_json::from_value(json!({
            "id":"startup-source",
            "name":"Snipaste",
            "version":"1.0.0",
            "path":directory.path().to_string_lossy(),
            "enabled":true,
            "manifest":{"name":"snipaste"},
            "created_at":"now",
            "updated_at":"now"
        }))
        .unwrap();
        db.save_plugin(&plugin).unwrap();
        let hints = Hints::default();
        let source = directory.path().join("preload.js");

        for original_shape in [
            "const AUTO_START_DB_KEY = 'auto-start-plugin'; ipcRenderer.invoke('ztools:db-get', AUTO_START_DB_KEY);",
            "const STORAGE_KEY = \"auto-start-plugin\"; ipcRenderer.invoke(\"ztools:db-put\", STORAGE_KEY, value);",
        ] {
            std::fs::write(&source, original_shape).unwrap();
            assert_eq!(hints.scan(&plugin, None), Usage::Detected, "{original_shape}");
        }

        for unrelated in [
            "// auto-start-plugin",
            "ipcRenderer.invoke('ztools:db-get', 'some-other-key')",
            "const key = 'auto-start-plugin'; someOtherCall(key)",
            "// auto-start-plugin\nipcRenderer.invoke('ztools:db-get', 'some-other-key')",
            "const key = 'auto-start-plugin'; ipcRenderer.invoke('ztools:db-get', otherKey)",
        ] {
            std::fs::write(&source, unrelated).unwrap();
            hints.invalidate(&plugin.id);
            assert_eq!(hints.scan(&plugin, None), Usage::NotDetected, "{unrelated}");
        }
    }
}
