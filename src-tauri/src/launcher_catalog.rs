//! Desktop presentation over the shared core snapshot. No plugin code is executed.
use crate::commands::SearchResult;
use atools_core::{
    feature_catalog::{CatalogFeature, FeatureCatalogSnapshot},
    Database,
};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, Weak},
};

const MAX_ICON_GENERATIONS: usize = 4;
const MAX_ICON_METADATA_BYTES: usize = 8 * 1024 * 1024;
static ICONS: LazyLock<Mutex<VecDeque<SnapshotIcons>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

struct SnapshotIcons {
    snapshot: Weak<FeatureCatalogSnapshot>,
    builtin_root: Option<PathBuf>,
    icons: Arc<IconMap>,
}

pub(crate) fn search(
    db: &Database,
    query: &str,
    builtin_root: Option<&Path>,
) -> Result<Vec<SearchResult>, String> {
    let snapshot = db
        .feature_catalog_snapshot()
        .map_err(|error| error.to_string())?;
    let icons = icons_for(&snapshot, builtin_root)?;
    Ok(snapshot
        .search_checked(query)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|matched| {
            snapshot
                .find(&matched.plugin_id, &matched.feature_code)
                .map(|entry| project(entry, &icons, matched.score, matched.match_type))
        })
        .collect())
}

/// Project selected command matches without copying the complete presentation catalog.
pub(crate) fn project_matches(
    snapshot: &Arc<FeatureCatalogSnapshot>,
    matches: Vec<atools_core::MatchResult>,
    builtin_root: Option<&Path>,
) -> Result<Vec<SearchResult>, String> {
    let icons = icons_for(snapshot, builtin_root)?;
    Ok(matches
        .into_iter()
        .filter_map(|matched| {
            snapshot
                .find(&matched.plugin_id, &matched.feature_code)
                .map(|entry| project(entry, &icons, matched.score, matched.match_type))
        })
        .collect())
}

/// Resolve typed content once; later UI name filtering needs no further content IPC.
pub(crate) fn search_text_content(
    db: &Database,
    content: &str,
    builtin_root: Option<&Path>,
) -> Result<Vec<crate::content_search::TextContentResult>, String> {
    let snapshot = db
        .feature_catalog_snapshot()
        .map_err(|error| error.to_string())?;
    let matches = snapshot
        .search_text_content(content)
        .map_err(|error| error.to_string())?;
    project_content_matches(&snapshot, matches, builtin_root)
}

pub(crate) fn search_file_content(
    db: &Database,
    files: &[atools_core::matcher::MediaFile],
    builtin_root: Option<&Path>,
) -> Result<Vec<crate::content_search::TextContentResult>, String> {
    let snapshot = db.feature_catalog_snapshot().map_err(|e| e.to_string())?;
    let matches = snapshot
        .search_file_content(files)
        .map_err(|e| e.to_string())?;
    project_content_matches(&snapshot, matches, builtin_root)
}
pub(crate) fn search_image_content(
    db: &Database,
    builtin_root: Option<&Path>,
) -> Result<Vec<crate::content_search::TextContentResult>, String> {
    let snapshot = db.feature_catalog_snapshot().map_err(|e| e.to_string())?;
    let matches = snapshot.search_image_content();
    project_content_matches(&snapshot, matches, builtin_root)
}
fn project_content_matches(
    snapshot: &Arc<FeatureCatalogSnapshot>,
    matches: Vec<atools_core::MatchResult>,
    builtin_root: Option<&Path>,
) -> Result<Vec<crate::content_search::TextContentResult>, String> {
    let icons = icons_for(snapshot, builtin_root)?;
    Ok(matches
        .into_iter()
        .filter_map(|matched| {
            let entry = snapshot.find(&matched.plugin_id, &matched.feature_code)?;
            let mut terms = vec![
                entry.display_label.clone(),
                entry.plugin_display_name.clone(),
                entry.feature.explain.clone(),
            ];
            for command in &entry.feature.cmds {
                match command {
                    atools_core::Cmd::Text(text) => terms.push(text.clone()),
                    atools_core::Cmd::Typed(rule) => {
                        if let Some(label) = &rule.label {
                            terms.push(label.clone());
                        }
                    }
                }
            }
            terms.retain(|term| !term.trim().is_empty());
            terms.sort();
            terms.dedup();
            Some(crate::content_search::TextContentResult {
                result: project(entry, &icons, matched.score, matched.match_type),
                content_search_terms: terms,
            })
        })
        .collect())
}

pub(crate) fn catalog(
    db: &Database,
    builtin_root: Option<&Path>,
) -> Result<Vec<SearchResult>, String> {
    let snapshot = db
        .feature_catalog_snapshot()
        .map_err(|error| error.to_string())?;
    let icons = icons_for(&snapshot, builtin_root)?;
    Ok(snapshot
        .entries()
        .iter()
        .map(|entry| project(entry, &icons, entry.feature.priority, "catalog"))
        .collect())
}

type IconMap = HashMap<String, HashMap<String, Option<String>>>;

fn icons_for(
    snapshot: &Arc<FeatureCatalogSnapshot>,
    builtin_root: Option<&Path>,
) -> Result<Arc<IconMap>, String> {
    let mut cache = ICONS
        .lock()
        .map_err(|_| "Launcher icon cache lock poisoned".to_string())?;
    cache.retain(|entry| entry.snapshot.strong_count() > 0);
    if let Some(entry) = cache.iter().find(|entry| {
        entry.builtin_root.as_deref() == builtin_root
            && entry
                .snapshot
                .upgrade()
                .is_some_and(|cached| Arc::ptr_eq(&cached, snapshot))
    }) {
        return Ok(entry.icons.clone());
    }
    let mut icons: IconMap = HashMap::new();
    let mut bytes = 0usize;
    for entry in snapshot.entries() {
        let icon = resolve_icon(entry, builtin_root);
        bytes = bytes.saturating_add(
            entry.feature.plugin_id.len()
                + entry.feature.code.len()
                + icon.as_ref().map_or(0, String::len)
                + 128,
        );
        if bytes > MAX_ICON_METADATA_BYTES {
            return Err("Launcher icon metadata exceeds 8 MiB budget".into());
        }
        icons
            .entry(entry.feature.plugin_id.clone())
            .or_default()
            .insert(entry.feature.code.clone(), icon);
    }
    let icons = Arc::new(icons);
    if cache.len() >= MAX_ICON_GENERATIONS {
        cache.pop_front();
    }
    cache.push_back(SnapshotIcons {
        snapshot: Arc::downgrade(snapshot),
        builtin_root: builtin_root.map(Path::to_path_buf),
        icons: icons.clone(),
    });
    Ok(icons)
}

fn project(
    entry: &CatalogFeature,
    icons: &IconMap,
    score: i32,
    match_type: &'static str,
) -> SearchResult {
    SearchResult {
        code: entry.feature.code.clone(),
        plugin_id: entry.feature.plugin_id.clone(),
        plugin_name: entry.plugin_display_name.clone(),
        label: entry.display_label.clone(),
        icon: icons
            .get(&entry.feature.plugin_id)
            .and_then(|items| items.get(&entry.feature.code))
            .cloned()
            .flatten(),
        explain: entry.feature.explain.clone(),
        score,
        match_type,
    }
}

fn resolve_icon(entry: &CatalogFeature, builtin_root: Option<&Path>) -> Option<String> {
    resolve_icon_value(
        entry.icon.as_deref()?,
        Some(&entry.plugin_path),
        builtin_root,
    )
}

pub(crate) fn resolve_icon_value(
    value: &str,
    plugin_path: Option<&str>,
    builtin_root: Option<&Path>,
) -> Option<String> {
    if ["data:", "http://", "https://", "asset:"]
        .iter()
        .any(|prefix| value.starts_with(prefix))
    {
        return Some(value.to_string());
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return canonical_icon(path);
    }
    let plugin_path = plugin_path?;
    let plugin_root = Path::new(plugin_path);
    if crate::builtin_plugins::is_builtin_plugin_path(plugin_path) {
        if let (Some(root), Some(folder)) = (builtin_root, plugin_root.file_name()) {
            if let Some(icon) = canonical_icon(&root.join(folder).join(path)) {
                return Some(icon);
            }
        }
    }
    canonical_icon(&plugin_root.join(path))
}

fn canonical_icon(path: &Path) -> Option<String> {
    path.canonicalize()
        .ok()
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(test)]
#[path = "launcher_catalog_tests.rs"]
mod tests;
