//! Non-authorizing Node usage hints and the trusted package entry selector.
use atools_core::Plugin;
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
};

const MAX_ENTRY_BYTES: usize = 2 * 1024 * 1024;
const CACHE_CAPACITY: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Usage {
    Detected,
    NotDetected,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryMode {
    Preload,
    Page,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub usage: Usage,
    pub requires_node: bool,
    pub entry_mode: Option<EntryMode>,
}
impl UsageReport {
    fn unknown() -> Self {
        Self {
            usage: Usage::Unknown,
            requires_node: false,
            entry_mode: None,
        }
    }
}

type CacheKey = (String, String, String);
#[derive(Default)]
pub struct Hints {
    cache: Mutex<HashMap<CacheKey, UsageReport>>,
    order: Mutex<VecDeque<CacheKey>>,
}
impl Hints {
    pub fn scan(&self, plugin: &Plugin, revision: Option<&str>) -> UsageReport {
        let Ok(root) = std::fs::canonicalize(&plugin.path) else {
            return UsageReport::unknown();
        };
        let key = revision.map(|rev| {
            (
                plugin.id.clone(),
                root.to_string_lossy().into_owned(),
                rev.to_owned(),
            )
        });
        if let Some(report) = key
            .as_ref()
            .and_then(|key| self.cache.lock().get(key).copied())
        {
            return report;
        }
        let report = inspect(&root, plugin);
        if let Some(key) = key {
            let mut cache = self.cache.lock();
            let mut order = self.order.lock();
            while order.len() >= CACHE_CAPACITY {
                if let Some(old) = order.pop_front() {
                    cache.remove(&old);
                }
            }
            order.push_back(key.clone());
            cache.insert(key, report);
        }
        report
    }
    pub fn invalidate(&self, plugin: &str) {
        self.cache.lock().retain(|(id, _, _), _| id != plugin);
        self.order.lock().retain(|(id, _, _)| id != plugin);
    }
}

#[derive(Debug, Clone)]
pub struct SelectedEntry {
    pub package_root: PathBuf,
    pub entry: PathBuf,
}

/// Resolves an entry only from the installed manifest; callers cannot supply paths.
pub fn select_entry(plugin: &Plugin) -> Result<SelectedEntry, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let package =
        atools_plugin::package_resolution::resolve_plugin_package(Path::new(&plugin.path))
            .map_err(|_| "Plugin package is unavailable")?;
    let mode = if package.manifest.preload.is_some() {
        EntryMode::Preload
    } else {
        EntryMode::Page
    };
    let requirements = match mode {
        EntryMode::Preload => {
            atools_plugin::package_resolution::page_requirements::inspect_plugin_preload(
                &package.source_root,
                package.manifest.preload.as_deref().unwrap_or_default(),
            )
        }
        EntryMode::Page => {
            atools_plugin::package_resolution::page_requirements::inspect_plugin_page(
                &package.source_root,
            )
        }
    }
    .map_err(|_| "Unable to inspect the plugin Node entry")?;
    if requirements.node_usage
        != atools_plugin::package_resolution::page_requirements::Usage::Detected
    {
        return Err("Plugin has no detected Node module entry".into());
    }
    let relative = match mode {
        EntryMode::Preload => package
            .manifest
            .preload
            .as_deref()
            .ok_or("Plugin preload is missing")?,
        EntryMode::Page => package
            .manifest
            .effective_runtime_entry()
            .ok_or("Plugin main page is missing")?,
    };
    if mode == EntryMode::Page && atools_plugin::package_resolution::html::is_remote_entry(relative)
    {
        return Err("Remote plugin pages cannot be Node module anchors".into());
    }
    let relative_path = atools_plugin::package_resolution::normalize_package_asset_path(relative)
        .map_err(|_| "Plugin Node entry must stay inside its package")?;
    let bytes = atools_plugin::package_resolution::read_package_asset_bytes(
        &package.package_root,
        &relative_path,
        MAX_ENTRY_BYTES,
    )
    .map_err(|_| "Plugin Node entry is unsafe or exceeds its size limit")?
    .ok_or("Plugin Node entry is missing")?;
    if bytes.is_empty() {
        return Err("Plugin Node entry is empty".into());
    }
    let entry = package.package_root.join(relative_path);
    Ok(SelectedEntry {
        package_root: package.package_root,
        entry,
    })
}

fn inspect(root: &Path, plugin: &Plugin) -> UsageReport {
    let package = match atools_plugin::package_resolution::resolve_plugin_package(root) {
        Ok(package) => package,
        Err(_) => return UsageReport::unknown(),
    };
    let (result, mode) = if let Some(preload) = package.manifest.preload.as_deref() {
        (
            atools_plugin::package_resolution::page_requirements::inspect_plugin_preload(
                root, preload,
            ),
            Some(EntryMode::Preload),
        )
    } else {
        (
            atools_plugin::package_resolution::page_requirements::inspect_plugin_page(root),
            Some(EntryMode::Page),
        )
    };
    let Ok(requirements) = result else {
        return UsageReport::unknown();
    };
    let usage = match requirements.node_usage {
        atools_plugin::package_resolution::page_requirements::Usage::Detected => Usage::Detected,
        atools_plugin::package_resolution::page_requirements::Usage::NotDetected => {
            Usage::NotDetected
        }
        atools_plugin::package_resolution::page_requirements::Usage::Unknown => Usage::Unknown,
    };
    let entry_mode = if usage == Usage::Detected { mode } else { None };
    UsageReport {
        usage,
        requires_node: usage == Usage::Detected && plugin.enabled,
        entry_mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plugin(root: &Path, main: &str, preload: Option<&str>) -> Plugin {
        let mut manifest = json!({"name":"fixture","version":"1","main":main});
        if let Some(preload) = preload {
            manifest["preload"] = json!(preload);
        }
        Plugin {
            id: "fixture".into(),
            name: "Fixture".into(),
            version: "1".into(),
            path: root.to_string_lossy().into_owned(),
            enabled: true,
            manifest: serde_json::from_value(manifest).unwrap(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn page_selector_uses_only_manifest_main_as_the_module_anchor() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("plugin.json"),
            r#"{"name":"fixture","version":"1","main":"index.html"}"#,
        )
        .unwrap();
        std::fs::write(
            temp.path().join("index.html"),
            r#"<script>require('fs')</script>"#,
        )
        .unwrap();
        let selected = select_entry(&plugin(temp.path(), "index.html", None)).unwrap();
        assert_eq!(
            selected.entry,
            temp.path().canonicalize().unwrap().join("index.html")
        );
    }

    #[test]
    fn preload_selector_normalizes_manifest_relative_dot_segments() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("plugin.json"),
            r#"{"name":"fixture","version":"1","main":"index.html","preload":"./preload.js"}"#,
        )
        .unwrap();
        std::fs::write(temp.path().join("index.html"), "<h1>fixture</h1>").unwrap();
        std::fs::write(temp.path().join("preload.js"), "require('fs')").unwrap();
        let selected =
            select_entry(&plugin(temp.path(), "index.html", Some("./preload.js"))).unwrap();
        assert_eq!(
            selected.entry,
            temp.path().canonicalize().unwrap().join("preload.js")
        );
    }

    #[test]
    fn remote_or_pure_web_pages_cannot_open_a_node_session() {
        let remote = tempfile::tempdir().unwrap();
        std::fs::write(
            remote.path().join("plugin.json"),
            r#"{"name":"fixture","version":"1","main":"https://example.invalid/app.html"}"#,
        )
        .unwrap();
        assert!(select_entry(&plugin(
            remote.path(),
            "https://example.invalid/app.html",
            None
        ))
        .is_err());

        let web = tempfile::tempdir().unwrap();
        std::fs::write(
            web.path().join("plugin.json"),
            r#"{"name":"fixture","version":"1","main":"index.html"}"#,
        )
        .unwrap();
        std::fs::write(web.path().join("index.html"), "<h1>offline web</h1>").unwrap();
        assert!(select_entry(&plugin(web.path(), "index.html", None)).is_err());
    }

    #[test]
    fn usage_report_is_metadata_only_revision_scoped_and_absent_revision_is_not_cached() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("plugin.json"),
            r#"{"name":"fixture","version":"1","main":"index.html"}"#,
        )
        .unwrap();
        let record = plugin(temp.path(), "index.html", None);
        std::fs::write(
            temp.path().join("index.html"),
            "<script>require('fs')</script>",
        )
        .unwrap();
        let hints = Hints::default();
        let detected = hints.scan(&record, Some("revision-1"));
        assert_eq!(detected.usage, Usage::Detected);
        assert!(detected.requires_node);
        assert_eq!(detected.entry_mode, Some(EntryMode::Page));
        assert_eq!(serde_json::to_value(detected).unwrap()["entryMode"], "page");

        std::fs::write(temp.path().join("index.html"), "<h1>pure web</h1>").unwrap();
        assert_eq!(hints.scan(&record, Some("revision-1")), detected);
        assert_eq!(
            hints.scan(&record, Some("revision-2")).usage,
            Usage::NotDetected
        );
        assert_eq!(hints.scan(&record, None).usage, Usage::NotDetected);

        std::fs::write(
            temp.path().join("index.html"),
            "<script>require('fs')</script>",
        )
        .unwrap();
        assert_eq!(hints.scan(&record, None).usage, Usage::Detected);
    }
}
