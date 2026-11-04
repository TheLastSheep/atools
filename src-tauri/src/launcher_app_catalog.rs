//! Bounded snapshot of installed application entries for the launcher across macOS, Linux, and Windows.

#[allow(unused_imports)]
pub(crate) use crate::launcher_app_catalog_source::{
    linux_default_roots_from_env, windows_default_roots_from_env,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

pub(crate) const MAX_DEPTH: usize = 4;
pub(crate) const MAX_ENTRIES: usize = 4096;
const MAX_APPS: usize = 1024;
pub(super) const CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct LauncherApp {
    name: String,
    path: String,
    icon: Option<String>,
    #[serde(skip)]
    aliases: Vec<String>,
}

impl LauncherApp {
    #[allow(dead_code)]
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn path(&self) -> &str {
        &self.path
    }

    pub(crate) fn icon_url(&self) -> Option<&str> {
        self.icon.as_deref()
    }

    #[allow(dead_code)]
    pub(crate) fn aliases(&self) -> &[String] {
        &self.aliases
    }
}

#[derive(Default)]
pub(super) struct CatalogCache {
    roots: Vec<PathBuf>,
    entries: Vec<LauncherApp>,
    scanned_at: Option<Instant>,
}

impl CatalogCache {
    pub(super) fn snapshot(
        &mut self,
        roots: &[PathBuf],
        now: Instant,
    ) -> Result<Vec<LauncherApp>, String> {
        let fresh = self.roots == roots
            && self.scanned_at.is_some_and(|scanned_at| {
                now.checked_duration_since(scanned_at)
                    .is_some_and(|elapsed| elapsed <= CACHE_TTL)
            });
        if fresh {
            return Ok(self.entries.clone());
        }

        let entries = scan_roots_with_limits(roots, MAX_DEPTH, MAX_ENTRIES, MAX_APPS)?;
        self.roots = roots.to_vec();
        self.entries = entries.clone();
        self.scanned_at = Some(now);
        Ok(entries)
    }

    pub(super) fn invalidate(&mut self) {
        self.scanned_at = None;
    }
}

static CATALOG_CACHE: LazyLock<Mutex<CatalogCache>> =
    LazyLock::new(|| Mutex::new(CatalogCache::default()));

#[tauri::command]
pub(crate) async fn list_launcher_apps(
    webview: tauri::Webview,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<LauncherApp>, String> {
    ensure_main_webview(webview.label())?;
    let catalog = std::sync::Arc::clone(&state.launcher_app_catalog);
    tauri::async_runtime::spawn_blocking(move || catalog.snapshot())
        .await
        .map_err(|error| format!("Launcher app catalog worker failed: {error}"))?
}

pub(crate) fn ensure_main_webview(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Launcher app catalog is available only to the main window".into())
    }
}

pub(crate) fn snapshot_launcher_app_catalog() -> Result<Vec<LauncherApp>, String> {
    let roots = default_roots()?;
    CATALOG_CACHE
        .lock()
        .map_err(|_| "Launcher app catalog cache lock poisoned".to_string())?
        .snapshot(&roots, Instant::now())
}

pub(crate) fn invalidate_system_catalog() -> Result<(), String> {
    CATALOG_CACHE
        .lock()
        .map_err(|_| "Launcher app catalog cache lock poisoned".to_string())?
        .invalidate();
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn default_roots() -> Result<Vec<PathBuf>, String> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    Ok(roots)
}

#[cfg(target_os = "linux")]
pub(super) fn default_roots() -> Result<Vec<PathBuf>, String> {
    Ok(linux_default_roots_from_env(dirs::home_dir().as_deref()))
}

#[cfg(target_os = "windows")]
pub(super) fn default_roots() -> Result<Vec<PathBuf>, String> {
    let program_data = std::env::var_os("ProgramData").map(PathBuf::from);
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let roots = windows_default_roots_from_env(program_data.as_deref(), app_data.as_deref());
    if roots.is_empty() {
        Err("No Windows Start Menu application roots could be resolved".into())
    } else {
        Ok(roots)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(super) fn default_roots() -> Result<Vec<PathBuf>, String> {
    Err("Launcher app catalog is unsupported on this platform".into())
}

fn scan_roots_with_limits(
    roots: &[PathBuf],
    max_depth: usize,
    max_entries: usize,
    max_apps: usize,
) -> Result<Vec<LauncherApp>, String> {
    scan_roots_with_stats(roots, max_depth, max_entries, max_apps).map(|(apps, _)| apps)
}

fn scan_roots_with_stats(
    roots: &[PathBuf],
    max_depth: usize,
    max_entries: usize,
    max_apps: usize,
) -> Result<(Vec<LauncherApp>, usize), String> {
    let mut remaining_entries = max_entries;
    let mut readable_roots = 0usize;
    let mut seen = HashSet::new();
    let mut apps = Vec::new();

    for root in roots {
        if remaining_entries == 0 || apps.len() >= max_apps {
            break;
        }
        if !is_real_directory(root) {
            continue;
        }
        if scan_directory(
            root,
            0,
            max_depth,
            &mut remaining_entries,
            max_apps,
            &mut seen,
            &mut apps,
        ) {
            readable_roots += 1;
        }
    }

    if readable_roots == 0 {
        return Err("No launcher application roots could be read".into());
    }

    apps.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok((apps, max_entries - remaining_entries))
}

fn scan_directory(
    directory: &Path,
    depth: usize,
    max_depth: usize,
    remaining_entries: &mut usize,
    max_apps: usize,
    seen: &mut HashSet<PathBuf>,
    apps: &mut Vec<LauncherApp>,
) -> bool {
    let Ok(mut entries) = fs::read_dir(directory) else {
        return false;
    };
    while *remaining_entries > 0 && apps.len() < max_apps {
        let Some(entry) = entries.next() else {
            break;
        };
        *remaining_entries -= 1;
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        let path = entry.path();
        if file_type.is_dir() {
            if is_app_bundle(&path) {
                if seen.insert(path.clone()) {
                    apps.push(LauncherApp {
                        name: app_name(&path),
                        path: path.to_string_lossy().into_owned(),
                        icon: Some(crate::launcher_app_icons::icon_url(&path.to_string_lossy())),
                        aliases: Vec::new(),
                    });
                }
            } else if depth < max_depth {
                // Depth-first traversal bounds retained metadata; final rows are sorted below.
                scan_directory(
                    &path,
                    depth + 1,
                    max_depth,
                    remaining_entries,
                    max_apps,
                    seen,
                    apps,
                );
            }
        } else if file_type.is_file() {
            if is_desktop_file(&path) {
                if let Some(item) = parse_desktop_entry(&path) {
                    if seen.insert(path) {
                        apps.push(item);
                    }
                }
            } else if is_windows_app_entry(&path) && seen.insert(path.clone()) {
                apps.push(LauncherApp {
                    name: app_name(&path),
                    path: path.to_string_lossy().into_owned(),
                    icon: Some(crate::launcher_app_icons::icon_url(&path.to_string_lossy())),
                    aliases: Vec::new(),
                });
            }
        }
    }
    true
}

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
}

fn is_app_bundle(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
}

fn is_desktop_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("desktop"))
}

fn is_windows_app_entry(path: &Path) -> bool {
    let valid_ext = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk") || ext.eq_ignore_ascii_case("exe"));
    if !valid_ext {
        return false;
    }
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    !stem.starts_with("uninstall") && !stem.starts_with("unins0")
}

fn parse_desktop_entry(path: &Path) -> Option<LauncherApp> {
    let raw = fs::read_to_string(path).ok()?;
    let mut in_desktop_entry = false;
    let mut entry_type: Option<String> = None;
    let mut name: Option<String> = None;
    let mut aliases: Vec<String> = Vec::new();
    let mut icon_value: Option<String> = None;

    for raw_line in raw.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if (key == "NoDisplay" || key == "Hidden") && value.eq_ignore_ascii_case("true") {
            return None;
        }
        if key == "Type" {
            entry_type = Some(value.to_string());
        } else if key == "Name" {
            name = Some(value.to_string());
        } else if key.starts_with("Name[")
            || key == "GenericName"
            || key.starts_with("GenericName[")
        {
            if !aliases.iter().any(|existing| existing == value) {
                aliases.push(value.to_string());
            }
        } else if key == "Icon" {
            icon_value = Some(value.to_string());
        }
    }

    if entry_type.as_deref().is_some_and(|t| t != "Application") {
        return None;
    }
    let primary_name = name.filter(|n| !n.is_empty())?;
    aliases.retain(|alias| alias != &primary_name);
    let icon = icon_value.filter(|icon_path| Path::new(icon_path).exists());

    Some(LauncherApp {
        name: primary_name,
        path: path.to_string_lossy().into_owned(),
        icon,
        aliases,
    })
}

fn app_name(path: &Path) -> String {
    path.file_stem()
        .or_else(|| path.file_name())
        .map(|name| name.to_string_lossy().trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Application".into())
}

#[cfg(test)]
#[path = "launcher_app_catalog_tests.rs"]
mod tests;
