pub use crate::state::RuntimeEvent;
use crate::state::{AppState, ReleaseSmokeConfig, ReleaseSmokeProgress};
use crate::webdav::{
    WebdavBackupPreview, WebdavClipboardRestoreEntry, WebdavClipboardRestorePlan,
    WebdavPluginDataRestorePlan, WebdavRestoreLocalSnapshot, WebdavRestorePlan,
    WebdavScopeSelection, WebdavSettingsRestoreResult, WebdavSyncConfig, WebdavSyncSnapshot,
    WebdavSyncSummary,
};
use atools_core::agent::{
    AgentToolGrant, AuditLogEntry, AuditLogPage, AuditLogQuery, PendingAgentToolRequest,
    PermissionMode, ToolDefinition,
};
use atools_core::config::AppConfig;
use atools_core::db::Database;
use atools_core::matcher;
use atools_core::memory::{MemoryApproval, MemoryItem, MemoryScope, MemoryType};
use atools_core::models::*;
use atools_core::skill::{
    SkillDefinition, SkillFailureMode, SkillResultSuggestion, SkillStep, SkillValidationRule,
};
use atools_core::task_run::{
    Artifact, ArtifactKind, TaskIssue, TaskRun, TaskRunInitiator, TaskRunStatus,
    TaskValidationStatus,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use std::fs;
use tauri::{AppHandle, Emitter, Manager};

const LOCAL_APP_PLUGIN_ID: &str = "local-apps";
const LOCAL_APP_SEARCH_MAX_DEPTH: usize = 4;
const LOCAL_APP_SEARCH_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(45);

static LOCAL_APP_SEARCH_CACHE: std::sync::LazyLock<std::sync::Mutex<LocalAppSearchCache>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(LocalAppSearchCache::default()));
static PLUGIN_MARKET_CANCELLED_OPERATIONS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::BTreeSet<String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::BTreeSet::new()));
static PLUGIN_MUTATION_LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

#[tauri::command]
pub fn search_features(
    state: tauri::State<AppState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    let features = state.db.all_features().map_err(|e| e.to_string())?;
    let match_results = matcher::search_all(&features, &query);

    // Join MatchResult back to FeatureEntry to fill in label/explain/icon/name.
    let feature_map: std::collections::HashMap<&str, &atools_core::FeatureEntry> =
        features.iter().map(|f| (f.code.as_str(), f)).collect();
    let plugin_map: std::collections::HashMap<String, String> = features
        .iter()
        .map(|f| (f.code.clone(), f.plugin_name.clone()))
        .collect();

    let results: Vec<SearchResult> = match_results
        .into_iter()
        .map(|m| {
            let feature = feature_map.get(m.feature_code.as_str());
            SearchResult {
                code: m.feature_code.clone(),
                plugin_id: m.plugin_id,
                plugin_name: plugin_map.get(&m.feature_code).cloned().unwrap_or_default(),
                label: feature.map(|f| f.label.clone()).unwrap_or_default(),
                icon: feature.and_then(|f| f.icon.clone()),
                explain: feature.map(|f| f.explain.clone()).unwrap_or_default(),
                score: m.score,
                match_type: m.match_type,
            }
        })
        .collect();
    Ok(results)
}

#[tauri::command]
pub fn search_local_apps(query: String, limit: Option<usize>) -> Result<Vec<SearchResult>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let roots = default_local_app_roots();
    let mut cache = LOCAL_APP_SEARCH_CACHE
        .lock()
        .map_err(|_| "Local app search cache lock poisoned".to_string())?;
    Ok(search_local_apps_with_cache(
        &mut cache, &roots, &query, limit,
    ))
}

#[tauri::command]
pub fn activate_feature(
    state: tauri::State<AppState>,
    code: String,
    payload: Option<serde_json::Value>,
) -> Result<FeatureAction, String> {
    let started = std::time::Instant::now();
    let input = serde_json::json!({ "code": code.clone(), "payload": payload.clone() });
    let mut run = TaskRun::new(
        format!("plugin.feature.{code}"),
        TaskRunInitiator::human(Some("atools-ui".to_string())),
        input,
    );
    run.transition(TaskRunStatus::Running);
    state
        .db
        .upsert_task_run(&run)
        .map_err(|error| error.to_string())?;

    match activate_feature_inner(&state.db, &code, payload) {
        Ok(action) => {
            run.output = serde_json::to_value(&action).unwrap_or(serde_json::Value::Null);
            run.summary = Some(format!(
                "Opened {} / {}",
                action.plugin_name, action.feature_code
            ));
            run.artifacts = vec![Artifact {
                id: format!("artifact-{}", atools_core::utils::generate_rev()),
                kind: ArtifactKind::Json,
                label: format!("{} activation result", action.plugin_name),
                media_type: Some("application/json".to_string()),
                uri: Some(format!("atools://task-runs/{}/output", run.id)),
                path: None,
                size_bytes: None,
                metadata: serde_json::json!({
                    "pluginId": action.plugin_id.clone(),
                    "featureCode": action.feature_code.clone(),
                }),
            }];
            run.validation.status = TaskValidationStatus::Passed;
            run.validation.summary = Some(
                "Plugin feature resolved through the shared local capability store".to_string(),
            );
            run.metrics = serde_json::json!({ "durationMs": started.elapsed().as_millis() as u64 });
            run.transition(TaskRunStatus::Succeeded);
            state
                .db
                .upsert_task_run(&run)
                .map_err(|error| error.to_string())?;
            *state.active_plugin.lock() = Some(action.plugin_id.clone());
            Ok(action)
        }
        Err(error) => {
            run.summary = Some(format!("Failed to open plugin feature {code}"));
            run.errors
                .push(TaskIssue::error("activation_failed", error.clone()));
            run.validation.status = TaskValidationStatus::Failed;
            run.validation.summary = Some("Plugin feature activation failed".to_string());
            run.metrics = serde_json::json!({ "durationMs": started.elapsed().as_millis() as u64 });
            run.transition(TaskRunStatus::Failed);
            let _ = state.db.upsert_task_run(&run);
            Err(error)
        }
    }
}

pub(crate) fn activate_feature_inner(
    db: &Database,
    code: &str,
    payload: Option<serde_json::Value>,
) -> Result<FeatureAction, String> {
    let entry = db.get_feature(code).map_err(|e| e.to_string())?;
    let plugin = db.get_plugin(&entry.plugin_id).map_err(|e| e.to_string())?;
    let height = plugin_window_height(plugin.manifest.plugin_setting.as_ref().map(|s| s.height));

    let plugin_path = plugin.path.clone();
    let preload_path = plugin.manifest.preload.as_ref().map(|p| {
        std::path::Path::new(&plugin.path)
            .join(p)
            .to_string_lossy()
            .to_string()
    });

    Ok(FeatureAction {
        plugin_id: entry.plugin_id,
        plugin_name: entry.plugin_name,
        feature_code: code.to_string(),
        main_url: plugin.manifest.main.clone().unwrap_or_default(),
        plugin_path,
        preload_path,
        expand_height: height,
        plugin_permissions: normalized_plugin_permissions(&plugin.manifest.permissions),
        payload: payload.unwrap_or(serde_json::Value::Null),
    })
}

const ZTOOLS_DEFAULT_WINDOW_HEIGHT: u32 = 541;

fn normalized_plugin_permissions(permissions: &[String]) -> Vec<String> {
    let mut normalized = permissions
        .iter()
        .map(|permission| permission.trim())
        .filter(|permission| !permission.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn plugin_window_height(manifest_height: Option<u32>) -> u32 {
    manifest_height
        .unwrap_or(ZTOOLS_DEFAULT_WINDOW_HEIGHT)
        .min(ZTOOLS_DEFAULT_WINDOW_HEIGHT)
}

#[derive(Default)]
pub struct LocalAppSearchCache {
    roots_key: Vec<String>,
    entries: Vec<LocalAppEntry>,
    scanned_at: Option<std::time::Instant>,
}

#[derive(Clone)]
struct LocalAppEntry {
    name: String,
    path: String,
    icon: Option<String>,
    aliases: Vec<String>,
}

pub fn search_local_apps_with_cache(
    cache: &mut LocalAppSearchCache,
    roots: &[std::path::PathBuf],
    query: &str,
    limit: usize,
) -> Vec<SearchResult> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Vec::new();
    }

    let roots_key = local_app_roots_key(roots);
    if !cache.is_fresh_for(&roots_key) {
        cache.entries = scan_local_app_entries(roots);
        cache.roots_key = roots_key;
        cache.scanned_at = Some(std::time::Instant::now());
    }

    search_local_app_entries(&cache.entries, &query, limit)
}

impl LocalAppSearchCache {
    fn is_fresh_for(&self, roots_key: &[String]) -> bool {
        self.roots_key == roots_key
            && self
                .scanned_at
                .is_some_and(|scanned_at| scanned_at.elapsed() <= LOCAL_APP_SEARCH_CACHE_TTL)
    }
}

#[cfg(test)]
pub fn search_local_apps_in_roots(
    roots: &[std::path::PathBuf],
    query: &str,
    limit: usize,
) -> Vec<SearchResult> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Vec::new();
    }

    let entries = scan_local_app_entries(roots);
    search_local_app_entries(&entries, &query, limit)
}

fn local_app_roots_key(roots: &[std::path::PathBuf]) -> Vec<String> {
    roots
        .iter()
        .map(|root| root.to_string_lossy().to_string())
        .collect()
}

fn scan_local_app_entries(roots: &[std::path::PathBuf]) -> Vec<LocalAppEntry> {
    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        collect_app_bundles(root, 0, LOCAL_APP_SEARCH_MAX_DEPTH, &mut seen, &mut paths);
    }

    let mut entries = paths
        .into_iter()
        .filter_map(local_app_entry)
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });
    entries
}

fn search_local_app_entries(
    entries: &[LocalAppEntry],
    query: &str,
    limit: usize,
) -> Vec<SearchResult> {
    let mut results = entries
        .iter()
        .filter_map(|entry| local_app_result(entry, query))
        .collect::<Vec<_>>();
    results.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.label.cmp(&b.label))
            .then_with(|| a.explain.cmp(&b.explain))
    });
    results.truncate(limit);
    results
}

fn default_local_app_roots() -> Vec<std::path::PathBuf> {
    let mut roots = vec![
        std::path::PathBuf::from("/Applications"),
        std::path::PathBuf::from("/System/Applications"),
        std::path::PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
}

pub(crate) fn search_local_apps_for_smoke(query: &str, limit: usize) -> Vec<SearchResult> {
    let mut cache = LocalAppSearchCache::default();
    search_local_apps_with_cache(&mut cache, &default_local_app_roots(), query, limit)
}

fn collect_app_bundles(
    root: &std::path::Path,
    depth: usize,
    max_depth: usize,
    seen: &mut std::collections::HashSet<String>,
    paths: &mut Vec<std::path::PathBuf>,
) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if is_app_bundle(&path) {
            let key = path.to_string_lossy().to_string();
            if seen.insert(key) {
                paths.push(path);
            }
            continue;
        }
        collect_app_bundles(&path, depth + 1, max_depth, seen, paths);
    }
}

fn local_app_entry(path: std::path::PathBuf) -> Option<LocalAppEntry> {
    let plist = local_app_info_plist(&path);
    let name = app_display_name(&path, plist.as_deref())?;
    let icon = local_app_icon_path(&path, plist.as_deref());
    let aliases = local_app_metadata_aliases(plist.as_deref());
    Some(LocalAppEntry {
        name,
        path: path.to_string_lossy().to_string(),
        icon,
        aliases,
    })
}

fn local_app_result(entry: &LocalAppEntry, query: &str) -> Option<SearchResult> {
    let normalized_query = normalize_local_app_text(query);
    let normalized_name = normalize_local_app_text(&entry.name);
    let (score, match_type) = if normalized_name == normalized_query {
        (112, "exact")
    } else if normalized_name.starts_with(&normalized_query) {
        (96, "prefix")
    } else if normalized_name.contains(&normalized_query) {
        (80, "contains")
    } else if local_app_alias_matches(&normalized_query, &entry.aliases) {
        (88, "alias")
    } else if is_subsequence(&normalized_query, &normalized_name) {
        (62, "fuzzy")
    } else {
        return None;
    };

    Some(SearchResult {
        code: format!("local-app:{}", entry.path),
        plugin_id: LOCAL_APP_PLUGIN_ID.to_string(),
        plugin_name: "本地应用".to_string(),
        label: format!("打开 {}", entry.name),
        icon: entry.icon.clone(),
        explain: entry.path.clone(),
        score,
        match_type,
    })
}

fn is_app_bundle(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
}

fn app_display_name(path: &std::path::Path, plist: Option<&str>) -> Option<String> {
    if let Some(plist) = plist {
        if let Some(name) = plist_string_value(plist, "CFBundleDisplayName")
            .or_else(|| plist_string_value(plist, "CFBundleName"))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Some(name);
        }
    }

    fallback_app_display_name(path)
}

fn fallback_app_display_name(path: &std::path::Path) -> Option<String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn local_app_icon_path(app_path: &std::path::Path, plist: Option<&str>) -> Option<String> {
    let plist = plist?;
    let icon_name = plist_string_value(plist, "CFBundleIconFile")
        .or_else(|| plist_string_value(plist, "CFBundleIconName"))?;
    let icon_name = icon_name.trim();
    if icon_name.is_empty() {
        return None;
    }

    let resources = app_path.join("Contents").join("Resources");
    let mut candidates = vec![resources.join(icon_name)];
    if std::path::Path::new(icon_name).extension().is_none() {
        candidates.push(resources.join(format!("{icon_name}.icns")));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().to_string())
}

fn local_app_info_plist(app_path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(app_path.join("Contents").join("Info.plist")).ok()
}

fn local_app_metadata_aliases(plist: Option<&str>) -> Vec<String> {
    let Some(plist) = plist else {
        return Vec::new();
    };
    ["CFBundleIdentifier", "CFBundleExecutable"]
        .into_iter()
        .filter_map(|key| plist_string_value(plist, key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn local_app_alias_matches(query: &str, aliases: &[String]) -> bool {
    aliases.iter().any(|alias| {
        let normalized_alias = normalize_local_app_text(alias);
        normalized_alias == query
            || normalized_alias.starts_with(query)
            || normalized_alias.contains(query)
    })
}

fn normalize_local_app_text(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn plist_string_value(plist: &str, key: &str) -> Option<String> {
    let key_marker = format!("<key>{key}</key>");
    let after_key = plist.get(plist.find(&key_marker)? + key_marker.len()..)?;
    let string_start_marker = "<string>";
    let string_start = after_key.find(string_start_marker)? + string_start_marker.len();
    let after_string_start = after_key.get(string_start..)?;
    let value = after_string_start.get(..after_string_start.find("</string>")?)?;
    Some(xml_unescape(value.trim()))
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn is_subsequence(query: &str, value: &str) -> bool {
    if query.len() < 2 {
        return false;
    }
    let mut chars = query.chars();
    let Some(mut current) = chars.next() else {
        return false;
    };
    for char in value.chars() {
        if char == current {
            if let Some(next) = chars.next() {
                current = next;
            } else {
                return true;
            }
        }
    }
    false
}

#[tauri::command]
pub fn install_plugin(state: tauri::State<AppState>, path: String) -> Result<Plugin, String> {
    let plugin =
        install_plugin_from_directory_inner(&state.db, &state.config, std::path::Path::new(&path))?;
    crate::agent_tools::sync_plugin_tools(&state.db)?;

    tracing::info!("Installed plugin: {} ({})", plugin.name, plugin.id);
    Ok(plugin)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri maps each IPC field to a command argument.
pub async fn install_plugin_from_market(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    plugin_id: Option<String>,
    download_url: String,
    checksum: Option<String>,
    signature: Option<String>,
    public_key: Option<String>,
    operation_id: Option<String>,
) -> Result<Plugin, String> {
    validate_plugin_market_trust(&state.config, signature.as_deref(), public_key.as_deref())?;
    let progress_context = PluginMarketProgressContext {
        plugin_id: plugin_id.clone(),
        operation: "install".to_string(),
        operation_id: operation_id.and_then(trimmed_optional_string),
    };
    let progress_app = app.clone();
    let result = install_plugin_from_market_checked_url_inner_with_progress(
        &state.db,
        &state.config,
        plugin_id.as_deref(),
        &download_url,
        checksum.as_deref(),
        signature.as_deref(),
        public_key.as_deref(),
        progress_context,
        move |event| emit_plugin_market_progress(&progress_app, event),
    )
    .await;
    let plugin = result?;
    crate::agent_tools::sync_plugin_tools(&state.db)?;
    tracing::info!(
        "Installed plugin from market: {} ({})",
        plugin.name,
        plugin.id
    );
    Ok(plugin)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri maps each IPC field to a command argument.
pub async fn update_plugin_from_market(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    download_url: String,
    checksum: Option<String>,
    signature: Option<String>,
    public_key: Option<String>,
    operation_id: Option<String>,
) -> Result<Plugin, String> {
    validate_plugin_market_trust(&state.config, signature.as_deref(), public_key.as_deref())?;
    let progress_context = PluginMarketProgressContext {
        plugin_id: Some(plugin_id.clone()),
        operation: "update".to_string(),
        operation_id: operation_id.and_then(trimmed_optional_string),
    };
    let progress_app = app.clone();
    let result = update_plugin_from_market_checked_url_inner_with_progress(
        &state.db,
        &state.config,
        &plugin_id,
        &download_url,
        checksum.as_deref(),
        signature.as_deref(),
        public_key.as_deref(),
        progress_context,
        move |event| emit_plugin_market_progress(&progress_app, event),
    )
    .await;
    let plugin = result?;
    crate::agent_tools::sync_plugin_tools(&state.db)?;
    tracing::info!(
        "Updated plugin from market: {} ({})",
        plugin.name,
        plugin.id
    );
    Ok(plugin)
}

#[tauri::command]
pub fn cancel_plugin_market_operation(operation_id: String) -> Result<(), String> {
    cancel_plugin_market_operation_inner(&operation_id)
}

pub(crate) fn cancel_plugin_market_operation_inner(operation_id: &str) -> Result<(), String> {
    let trimmed = operation_id.trim();
    if trimmed.is_empty() {
        return Err("Plugin market operation id is required".to_string());
    }
    PLUGIN_MARKET_CANCELLED_OPERATIONS
        .lock()
        .map_err(|_| "Plugin market cancellation state lock poisoned".to_string())?
        .insert(trimmed.to_string());
    Ok(())
}

fn plugin_market_operation_cancelled(context: &PluginMarketProgressContext) -> bool {
    let Some(operation_id) = context.operation_id.as_deref() else {
        return false;
    };
    PLUGIN_MARKET_CANCELLED_OPERATIONS
        .lock()
        .map(|cancelled| cancelled.contains(operation_id))
        .unwrap_or(false)
}

fn clear_plugin_market_operation_cancelled(context: &PluginMarketProgressContext) {
    let Some(operation_id) = context.operation_id.as_deref() else {
        return;
    };
    if let Ok(mut cancelled) = PLUGIN_MARKET_CANCELLED_OPERATIONS.lock() {
        cancelled.remove(operation_id);
    }
}

#[tauri::command]
pub fn update_plugin_from_path(
    state: tauri::State<AppState>,
    plugin_id: String,
    path: String,
) -> Result<Plugin, String> {
    let source_dir = std::path::Path::new(&path);
    let plugin = plugin_update_from_path_inner(&state.db, &state.config, &plugin_id, source_dir)?;
    crate::agent_tools::sync_plugin_tools(&state.db)?;
    Ok(plugin)
}

#[tauri::command]
pub fn authorize_plugin_permissions(
    state: tauri::State<AppState>,
    plugin_id: String,
) -> Result<Plugin, String> {
    authorize_plugin_permissions_inner(&state.db, &plugin_id)
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct PluginMarketCatalog {
    pub source_url: String,
    pub updated_at: Option<String>,
    pub plugins: Vec<PluginMarketCatalogPlugin>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct PluginMarketCatalogPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Option<String>,
    pub download_url: String,
    pub checksum: Option<String>,
    pub rating: Option<String>,
    pub rating_count: Option<u64>,
    pub downloads: Option<u64>,
    pub updated_at: Option<String>,
    pub publisher: Option<String>,
    pub publisher_url: Option<String>,
    pub signature: Option<String>,
    pub public_key: Option<String>,
    pub homepage: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PluginMarketProgressContext {
    pub plugin_id: Option<String>,
    pub operation: String,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub(crate) struct PluginMarketProgressEvent {
    pub plugin_id: Option<String>,
    pub operation: String,
    pub operation_id: Option<String>,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
    pub attempt: u8,
    pub max_attempts: u8,
    pub message: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct RawPluginMarketCatalog {
    #[serde(default, rename = "updatedAt", alias = "updated_at")]
    updated_at: Option<String>,
    #[serde(default)]
    plugins: Vec<RawPluginMarketCatalogPlugin>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct RawPluginMarketCatalogPlugin {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default, rename = "downloadUrl", alias = "download_url")]
    download_url: String,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(
        default,
        rename = "sha256",
        alias = "sha256Checksum",
        alias = "sha256_checksum"
    )]
    sha256: Option<String>,
    #[serde(default)]
    rating: Option<serde_json::Value>,
    #[serde(default, rename = "ratingCount", alias = "rating_count")]
    rating_count: Option<serde_json::Value>,
    #[serde(default)]
    downloads: Option<serde_json::Value>,
    #[serde(default, rename = "updatedAt", alias = "updated_at")]
    updated_at: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default, rename = "publisherUrl", alias = "publisher_url")]
    publisher_url: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default, rename = "publicKey", alias = "public_key")]
    public_key: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
}

#[tauri::command]
pub async fn fetch_plugin_market_catalog(url: String) -> Result<PluginMarketCatalog, String> {
    fetch_plugin_market_catalog_from_url(&url).await
}

pub(crate) async fn fetch_plugin_market_catalog_from_url(
    url: &str,
) -> Result<PluginMarketCatalog, String> {
    let source_url = plugin_market_catalog_url(url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Plugin market HTTP client failed: {error}"))?;
    let response = client
        .get(source_url.clone())
        .send()
        .await
        .map_err(|error| format!("Plugin market catalog request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Plugin market catalog returned HTTP {status}"));
    }
    let raw = response
        .json::<RawPluginMarketCatalog>()
        .await
        .map_err(|error| format!("Invalid plugin market catalog JSON: {error}"))?;
    Ok(normalize_plugin_market_catalog(source_url.to_string(), raw))
}

fn plugin_market_catalog_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|error| format!("Invalid plugin market URL: {error}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Plugin market URL must use http or https".to_string());
    }
    Ok(parsed)
}

fn normalize_plugin_market_catalog(
    source_url: String,
    raw: RawPluginMarketCatalog,
) -> PluginMarketCatalog {
    let plugins = raw
        .plugins
        .into_iter()
        .filter_map(normalize_plugin_market_catalog_plugin)
        .collect();
    PluginMarketCatalog {
        source_url,
        updated_at: raw.updated_at.and_then(trimmed_optional_string),
        plugins,
    }
}

fn normalize_plugin_market_catalog_plugin(
    raw: RawPluginMarketCatalogPlugin,
) -> Option<PluginMarketCatalogPlugin> {
    let name = raw.name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let download_url = trimmed_http_url(&raw.download_url)?;
    let id =
        trimmed_optional_string(raw.id).unwrap_or_else(|| atools_core::utils::sanitize_id(&name));
    Some(PluginMarketCatalogPlugin {
        id,
        name,
        version: trimmed_optional_string(raw.version).unwrap_or_else(|| "0.0.0".to_string()),
        description: trimmed_optional_string(raw.description).unwrap_or_default(),
        author: raw.author.and_then(trimmed_optional_string),
        download_url,
        checksum: normalize_plugin_market_catalog_checksum(raw.checksum.or(raw.sha256)),
        rating: normalize_plugin_market_catalog_rating(raw.rating),
        rating_count: normalize_plugin_market_catalog_count(raw.rating_count),
        downloads: normalize_plugin_market_catalog_count(raw.downloads),
        updated_at: raw.updated_at.and_then(trimmed_optional_string),
        publisher: raw.publisher.and_then(trimmed_optional_string),
        publisher_url: raw.publisher_url.and_then(|url| trimmed_http_url(&url)),
        signature: raw.signature.and_then(trimmed_optional_string),
        public_key: raw.public_key.and_then(trimmed_optional_string),
        homepage: raw.homepage.and_then(|url| trimmed_http_url(&url)),
    })
}

fn normalize_plugin_market_catalog_rating(value: Option<serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::String(rating) => trimmed_optional_string(rating),
        _ => None,
    }
}

fn normalize_plugin_market_catalog_count(value: Option<serde_json::Value>) -> Option<u64> {
    match value? {
        serde_json::Value::Number(number) => number.as_u64(),
        serde_json::Value::String(count) => count.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn normalize_plugin_market_catalog_checksum(value: Option<String>) -> Option<String> {
    value.and_then(|checksum| {
        let trimmed = checksum.trim();
        if trimmed.is_empty() {
            None
        } else {
            normalize_plugin_market_checksum(trimmed).ok()
        }
    })
}

fn trimmed_optional_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn trimmed_http_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let Ok(url) = reqwest::Url::parse(trimmed) else {
        return None;
    };
    (url.scheme() == "http" || url.scheme() == "https").then(|| trimmed.to_string())
}

const PLUGIN_MARKET_MAX_ARCHIVE_BYTES: usize = 50 * 1024 * 1024;
const PLUGIN_MARKET_DOWNLOAD_MAX_ATTEMPTS: u8 = 3;
const PLUGIN_MARKET_MAX_ZIP_ENTRIES: usize = 4096;
const PLUGIN_MARKET_MAX_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
const PLUGIN_MARKET_MAX_SINGLE_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
const PLUGIN_MARKET_MAX_PATH_DEPTH: usize = 32;

#[cfg(test)]
pub(crate) async fn install_plugin_from_market_url_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    download_url: &str,
) -> Result<Plugin, String> {
    install_plugin_from_market_checked_url_inner(db, config, None, download_url, None).await
}

#[cfg(test)]
pub(crate) async fn install_plugin_from_market_checked_url_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    expected_plugin_id: Option<&str>,
    download_url: &str,
    checksum: Option<&str>,
) -> Result<Plugin, String> {
    install_plugin_from_market_trusted_url_inner(
        db,
        config,
        expected_plugin_id,
        download_url,
        checksum,
        None,
        None,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn install_plugin_from_market_trusted_url_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    expected_plugin_id: Option<&str>,
    download_url: &str,
    checksum: Option<&str>,
    signature: Option<&str>,
    public_key: Option<&str>,
) -> Result<Plugin, String> {
    let progress_context = PluginMarketProgressContext {
        plugin_id: expected_plugin_id.map(str::to_string),
        operation: "install".to_string(),
        operation_id: None,
    };
    install_plugin_from_market_checked_url_inner_with_progress(
        db,
        config,
        expected_plugin_id,
        download_url,
        checksum,
        signature,
        public_key,
        progress_context,
        |_| {},
    )
    .await
}

#[allow(clippy::too_many_arguments)] // Keeps the progress callback explicit at the download boundary.
pub(crate) async fn install_plugin_from_market_checked_url_inner_with_progress(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    expected_plugin_id: Option<&str>,
    download_url: &str,
    checksum: Option<&str>,
    signature: Option<&str>,
    public_key: Option<&str>,
    progress_context: PluginMarketProgressContext,
    mut progress: impl FnMut(PluginMarketProgressEvent),
) -> Result<Plugin, String> {
    let (bytes, source_url) = download_plugin_market_archive_with_progress_ref(
        download_url,
        checksum,
        signature,
        public_key,
        progress_context.clone(),
        &mut progress,
    )
    .await?;
    progress(plugin_market_progress_event(
        &progress_context,
        "installing",
        bytes.len() as u64,
        Some(bytes.len() as u64),
        1,
        "正在写入插件目录",
    ));
    let plugin = install_plugin_from_market_archive_inner(
        db,
        config,
        &bytes,
        &source_url,
        expected_plugin_id,
    )?;
    progress(plugin_market_progress_event(
        &progress_context,
        "finished",
        bytes.len() as u64,
        Some(bytes.len() as u64),
        1,
        "插件安装完成",
    ));
    Ok(plugin)
}

#[allow(clippy::too_many_arguments)] // Keeps the progress callback explicit at the download boundary.
pub(crate) async fn update_plugin_from_market_checked_url_inner_with_progress(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_id: &str,
    download_url: &str,
    checksum: Option<&str>,
    signature: Option<&str>,
    public_key: Option<&str>,
    progress_context: PluginMarketProgressContext,
    mut progress: impl FnMut(PluginMarketProgressEvent),
) -> Result<Plugin, String> {
    let (bytes, source_url) = download_plugin_market_archive_with_progress_ref(
        download_url,
        checksum,
        signature,
        public_key,
        progress_context.clone(),
        &mut progress,
    )
    .await?;
    progress(plugin_market_progress_event(
        &progress_context,
        "installing",
        bytes.len() as u64,
        Some(bytes.len() as u64),
        1,
        "正在更新插件目录",
    ));
    let plugin =
        update_plugin_from_market_archive_inner(db, config, plugin_id, &bytes, &source_url)?;
    progress(plugin_market_progress_event(
        &progress_context,
        "finished",
        bytes.len() as u64,
        Some(bytes.len() as u64),
        1,
        "插件更新完成",
    ));
    Ok(plugin)
}

fn emit_plugin_market_progress(app: &AppHandle, event: PluginMarketProgressEvent) {
    let _ = app.emit("plugin-market-progress", event);
}

fn plugin_market_progress_event(
    context: &PluginMarketProgressContext,
    stage: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    attempt: u8,
    message: &str,
) -> PluginMarketProgressEvent {
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| ((downloaded_bytes as f64 / total as f64) * 100.0).clamp(0.0, 100.0));
    PluginMarketProgressEvent {
        plugin_id: context.plugin_id.clone(),
        operation: context.operation.clone(),
        operation_id: context.operation_id.clone(),
        stage: stage.to_string(),
        downloaded_bytes,
        total_bytes,
        percent,
        attempt,
        max_attempts: PLUGIN_MARKET_DOWNLOAD_MAX_ATTEMPTS,
        message: message.to_string(),
    }
}

#[cfg(test)]
async fn download_plugin_market_archive_with_progress(
    download_url: &str,
    checksum: Option<&str>,
    progress_context: PluginMarketProgressContext,
    mut progress: impl FnMut(PluginMarketProgressEvent),
) -> Result<(Vec<u8>, String), String> {
    download_plugin_market_archive_with_progress_ref(
        download_url,
        checksum,
        None,
        None,
        progress_context,
        &mut progress,
    )
    .await
}

async fn download_plugin_market_archive_with_progress_ref(
    download_url: &str,
    checksum: Option<&str>,
    signature: Option<&str>,
    public_key: Option<&str>,
    progress_context: PluginMarketProgressContext,
    progress: &mut impl FnMut(PluginMarketProgressEvent),
) -> Result<(Vec<u8>, String), String> {
    let parsed = plugin_market_download_url(download_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Plugin market download HTTP client failed: {error}"))?;

    for attempt in 1..=PLUGIN_MARKET_DOWNLOAD_MAX_ATTEMPTS {
        if let Err(error) = ensure_plugin_market_operation_not_cancelled(
            &progress_context,
            progress,
            attempt,
            0,
            None,
        ) {
            clear_plugin_market_operation_cancelled(&progress_context);
            return Err(error.message);
        }

        progress(plugin_market_progress_event(
            &progress_context,
            "requesting",
            0,
            None,
            attempt,
            "正在连接插件市场",
        ));

        match download_plugin_market_archive_attempt(
            &client,
            parsed.clone(),
            checksum,
            signature,
            public_key,
            &progress_context,
            progress,
            attempt,
        )
        .await
        {
            Ok(result) => {
                clear_plugin_market_operation_cancelled(&progress_context);
                return Ok(result);
            }
            Err(error) if error.retryable && attempt < PLUGIN_MARKET_DOWNLOAD_MAX_ATTEMPTS => {
                progress(plugin_market_progress_event(
                    &progress_context,
                    "retrying",
                    0,
                    None,
                    attempt,
                    "下载失败，正在重试",
                ));
            }
            Err(error) => {
                clear_plugin_market_operation_cancelled(&progress_context);
                return Err(error.message);
            }
        }
    }

    Err("Plugin market download failed after retries".to_string())
}

#[derive(Debug)]
struct PluginMarketDownloadError {
    message: String,
    retryable: bool,
}

impl PluginMarketDownloadError {
    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
}

#[allow(clippy::too_many_arguments)] // Download integrity and progress inputs are intentionally independent.
async fn download_plugin_market_archive_attempt(
    client: &reqwest::Client,
    parsed: reqwest::Url,
    checksum: Option<&str>,
    signature: Option<&str>,
    public_key: Option<&str>,
    progress_context: &PluginMarketProgressContext,
    progress: &mut impl FnMut(PluginMarketProgressEvent),
    attempt: u8,
) -> Result<(Vec<u8>, String), PluginMarketDownloadError> {
    let mut response = client.get(parsed.clone()).send().await.map_err(|error| {
        PluginMarketDownloadError::retryable(format!(
            "Plugin market download request failed: {error}"
        ))
    })?;
    let status = response.status();
    if !status.is_success() {
        let message = format!("Plugin market download returned HTTP {status}");
        return Err(if status.is_server_error() || status.as_u16() == 429 {
            PluginMarketDownloadError::retryable(message)
        } else {
            PluginMarketDownloadError::fatal(message)
        });
    }
    let total_bytes = response.content_length();
    let mut archive_bytes = Vec::new();
    let mut downloaded_bytes = 0_u64;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        PluginMarketDownloadError::retryable(format!("Plugin market download body failed: {error}"))
    })? {
        downloaded_bytes += chunk.len() as u64;
        if downloaded_bytes as usize > PLUGIN_MARKET_MAX_ARCHIVE_BYTES {
            return Err(PluginMarketDownloadError::fatal(format!(
                "Plugin market archive is too large: {} bytes (max {})",
                downloaded_bytes, PLUGIN_MARKET_MAX_ARCHIVE_BYTES
            )));
        }
        archive_bytes.extend_from_slice(&chunk);
        progress(plugin_market_progress_event(
            progress_context,
            "downloading",
            downloaded_bytes,
            total_bytes,
            attempt,
            "正在下载插件 ZIP",
        ));
        ensure_plugin_market_operation_not_cancelled(
            progress_context,
            progress,
            attempt,
            downloaded_bytes,
            total_bytes,
        )?;
    }
    progress(plugin_market_progress_event(
        progress_context,
        "verifying",
        downloaded_bytes,
        total_bytes,
        attempt,
        "正在校验插件 ZIP",
    ));
    verify_plugin_market_archive_checksum(&archive_bytes, checksum)
        .map_err(PluginMarketDownloadError::fatal)?;
    verify_plugin_market_archive_signature(&archive_bytes, signature, public_key)
        .map_err(PluginMarketDownloadError::fatal)?;
    progress(plugin_market_progress_event(
        progress_context,
        "verified",
        downloaded_bytes,
        total_bytes,
        attempt,
        "插件 ZIP 校验完成",
    ));

    Ok((archive_bytes, parsed.to_string()))
}

fn ensure_plugin_market_operation_not_cancelled(
    context: &PluginMarketProgressContext,
    progress: &mut impl FnMut(PluginMarketProgressEvent),
    attempt: u8,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) -> Result<(), PluginMarketDownloadError> {
    if !plugin_market_operation_cancelled(context) {
        return Ok(());
    }
    progress(plugin_market_progress_event(
        context,
        "cancelled",
        downloaded_bytes,
        total_bytes,
        attempt,
        "插件市场任务已取消",
    ));
    Err(PluginMarketDownloadError::fatal(
        "Plugin market operation cancelled",
    ))
}

#[cfg(test)]
pub(crate) async fn update_plugin_from_market_checked_url_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_id: &str,
    download_url: &str,
    checksum: Option<&str>,
) -> Result<Plugin, String> {
    update_plugin_from_market_trusted_url_inner(
        db,
        config,
        plugin_id,
        download_url,
        checksum,
        None,
        None,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn update_plugin_from_market_trusted_url_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_id: &str,
    download_url: &str,
    checksum: Option<&str>,
    signature: Option<&str>,
    public_key: Option<&str>,
) -> Result<Plugin, String> {
    let progress_context = PluginMarketProgressContext {
        plugin_id: Some(plugin_id.to_string()),
        operation: "update".to_string(),
        operation_id: None,
    };
    update_plugin_from_market_checked_url_inner_with_progress(
        db,
        config,
        plugin_id,
        download_url,
        checksum,
        signature,
        public_key,
        progress_context,
        |_| {},
    )
    .await
}

#[cfg(test)]
pub(crate) async fn update_plugin_from_market_url_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_id: &str,
    download_url: &str,
) -> Result<Plugin, String> {
    update_plugin_from_market_checked_url_inner(db, config, plugin_id, download_url, None).await
}

fn verify_plugin_market_archive_checksum(
    archive_bytes: &[u8],
    checksum: Option<&str>,
) -> Result<(), String> {
    let Some(checksum) = checksum else {
        return Ok(());
    };
    let expected = normalize_plugin_market_checksum(checksum)?;
    let actual = plugin_market_archive_sha256(archive_bytes);
    if actual != expected {
        return Err(format!(
            "Plugin market archive checksum mismatch: expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

fn verify_plugin_market_archive_signature(
    archive_bytes: &[u8],
    signature: Option<&str>,
    public_key: Option<&str>,
) -> Result<(), String> {
    let (Some(signature), Some(public_key)) = (signature, public_key) else {
        if signature.is_some() || public_key.is_some() {
            return Err(
                "Plugin market signature verification requires both signature and public key"
                    .to_string(),
            );
        }
        return Ok(());
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let signature_bytes: [u8; 64] = STANDARD
        .decode(signature.trim())
        .map_err(|error| format!("Plugin market signature is not valid base64: {error}"))?
        .try_into()
        .map_err(|bytes: Vec<u8>| {
            format!(
                "Plugin market signature must decode to 64 bytes, got {}",
                bytes.len()
            )
        })?;
    let public_key_bytes: [u8; 32] = STANDARD
        .decode(public_key.trim())
        .map_err(|error| format!("Plugin market public key is not valid base64: {error}"))?
        .try_into()
        .map_err(|bytes: Vec<u8>| {
            format!(
                "Plugin market public key must decode to 32 bytes, got {}",
                bytes.len()
            )
        })?;
    let verifying_key = VerifyingKey::from_bytes(&public_key_bytes)
        .map_err(|error| format!("Plugin market public key is invalid: {error}"))?;
    let signature = Signature::from_bytes(&signature_bytes);
    verifying_key
        .verify(archive_bytes, &signature)
        .map_err(|error| format!("Plugin market archive signature mismatch: {error}"))
}

fn validate_plugin_market_trust(
    config: &atools_core::config::AppConfig,
    signature: Option<&str>,
    public_key: Option<&str>,
) -> Result<(), String> {
    let signature = signature
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Plugin market install requires an Ed25519 signature".to_string())?;
    let public_key = public_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Plugin market install requires an Ed25519 public key".to_string())?;
    let _: [u8; 64] = STANDARD
        .decode(signature)
        .map_err(|error| format!("Plugin market signature is not valid base64: {error}"))?
        .try_into()
        .map_err(|bytes: Vec<u8>| {
            format!(
                "Plugin market signature must decode to 64 bytes, got {}",
                bytes.len()
            )
        })?;
    let presented_key = decode_plugin_market_public_key(public_key)?;
    let trusted_keys = trusted_plugin_market_public_keys(config)?;
    if trusted_keys.is_empty() {
        return Err(
            "No trusted plugin market public keys are pinned in local settings".to_string(),
        );
    }
    if !trusted_keys.contains(&presented_key) {
        return Err(
            "Plugin market public key is not trusted; pin it locally before installing".to_string(),
        );
    }
    Ok(())
}

fn trusted_plugin_market_public_keys(
    config: &atools_core::config::AppConfig,
) -> Result<std::collections::BTreeSet<[u8; 32]>, String> {
    let settings = config
        .load_settings()
        .map_err(|error| format!("Failed to load plugin market trust settings: {error}"))?;
    let mut encoded_keys = Vec::new();
    if let Some(value) = settings.get("pluginMarketTrustedPublicKeys") {
        let keys = value.as_array().ok_or_else(|| {
            "pluginMarketTrustedPublicKeys must be an array of base64 Ed25519 public keys"
                .to_string()
        })?;
        for key in keys {
            encoded_keys.push(
                key.as_str()
                    .ok_or_else(|| {
                        "pluginMarketTrustedPublicKeys entries must be strings".to_string()
                    })?
                    .to_string(),
            );
        }
    }
    if let Ok(environment_keys) = std::env::var("ATOOLS_PLUGIN_MARKET_TRUSTED_PUBLIC_KEYS") {
        encoded_keys.extend(
            environment_keys
                .split(|character: char| {
                    character == ',' || character == ';' || character.is_whitespace()
                })
                .filter(|key| !key.is_empty())
                .map(str::to_string),
        );
    }

    encoded_keys
        .into_iter()
        .map(|key| decode_plugin_market_public_key(&key))
        .collect()
}

fn decode_plugin_market_public_key(public_key: &str) -> Result<[u8; 32], String> {
    STANDARD
        .decode(public_key.trim())
        .map_err(|error| format!("Plugin market public key is not valid base64: {error}"))?
        .try_into()
        .map_err(|bytes: Vec<u8>| {
            format!(
                "Plugin market public key must decode to 32 bytes, got {}",
                bytes.len()
            )
        })
}

fn normalize_plugin_market_checksum(checksum: &str) -> Result<String, String> {
    let trimmed = checksum.trim();
    let hex = trimmed
        .strip_prefix("sha256:")
        .or_else(|| trimmed.strip_prefix("SHA256:"))
        .unwrap_or(trimmed);
    if hex.len() != 64 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("Plugin market checksum must be a SHA-256 hex digest".to_string());
    }
    Ok(format!("sha256:{}", hex.to_ascii_lowercase()))
}

fn plugin_market_archive_sha256(archive_bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;

    let digest = Sha256::digest(archive_bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    format!("sha256:{hex}")
}

fn plugin_market_download_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = plugin_market_catalog_url(url)?;
    if !parsed.path().to_ascii_lowercase().ends_with(".zip") {
        return Err("Plugin market download URL must point to a .zip archive".to_string());
    }
    Ok(parsed)
}

fn install_plugin_from_market_archive_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    archive_bytes: &[u8],
    source_url: &str,
    expected_plugin_id: Option<&str>,
) -> Result<Plugin, String> {
    let staging_dir = plugin_market_staging_dir(config);
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir).map_err(|error| {
            format!(
                "Failed to reset plugin market staging directory {}: {error}",
                staging_dir.display()
            )
        })?;
    }
    std::fs::create_dir_all(&staging_dir).map_err(|error| {
        format!(
            "Failed to create plugin market staging directory {}: {error}",
            staging_dir.display()
        )
    })?;

    let result = (|| {
        extract_plugin_market_zip(archive_bytes, &staging_dir, source_url)?;
        let plugin_dir = plugin_market_staged_plugin_dir(&staging_dir)?;
        let plugin = install_plugin_from_directory_checked_with_policy_inner(
            db,
            config,
            &plugin_dir,
            expected_plugin_id,
            PluginPersistencePolicy::Market,
        )?;
        Ok(plugin)
    })();

    cleanup_plugin_market_staging(&staging_dir, result)
}

fn update_plugin_from_market_archive_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_id: &str,
    archive_bytes: &[u8],
    source_url: &str,
) -> Result<Plugin, String> {
    let staging_dir = plugin_market_staging_dir(config);
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir).map_err(|error| {
            format!(
                "Failed to reset plugin market staging directory {}: {error}",
                staging_dir.display()
            )
        })?;
    }
    std::fs::create_dir_all(&staging_dir).map_err(|error| {
        format!(
            "Failed to create plugin market staging directory {}: {error}",
            staging_dir.display()
        )
    })?;

    let result = (|| {
        extract_plugin_market_zip(archive_bytes, &staging_dir, source_url)?;
        let plugin_dir = plugin_market_staged_plugin_dir(&staging_dir)?;
        let plugin = plugin_update_from_path_with_policy_inner(
            db,
            config,
            plugin_id,
            &plugin_dir,
            PluginPersistencePolicy::Market,
        )?;
        Ok(plugin)
    })();

    cleanup_plugin_market_staging(&staging_dir, result)
}

fn cleanup_plugin_market_staging(
    staging_dir: &std::path::Path,
    result: Result<Plugin, String>,
) -> Result<Plugin, String> {
    let cleanup_result = std::fs::remove_dir_all(staging_dir);
    match (result, cleanup_result) {
        (Ok(plugin), Ok(())) => Ok(plugin),
        (Ok(plugin), Err(error)) => {
            tracing::warn!(
                "Failed to remove plugin market staging directory {}: {}",
                staging_dir.display(),
                error
            );
            Ok(plugin)
        }
        (Err(error), _) => Err(error),
    }
}

fn plugin_market_staging_dir(config: &atools_core::config::AppConfig) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    config
        .base_dir()
        .join("plugin-market-staging")
        .join(format!("download-{}-{nanos}", std::process::id()))
}

fn extract_plugin_market_zip(
    archive_bytes: &[u8],
    staging_dir: &std::path::Path,
    source_url: &str,
) -> Result<(), String> {
    let cursor = std::io::Cursor::new(archive_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("Invalid plugin market zip from {source_url}: {error}"))?;
    if archive.is_empty() {
        return Err("Plugin market zip is empty".to_string());
    }
    if archive.len() > PLUGIN_MARKET_MAX_ZIP_ENTRIES {
        return Err(format!(
            "Plugin market zip contains too many entries: {} (max {})",
            archive.len(),
            PLUGIN_MARKET_MAX_ZIP_ENTRIES
        ));
    }

    let mut total_uncompressed = 0_u64;
    let mut normalized_paths = std::collections::BTreeSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Invalid plugin market zip entry {index}: {error}"))?;
        validate_plugin_market_zip_entry(&entry, index)?;
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or_else(|| "Plugin market zip uncompressed size overflow".to_string())?;
        if total_uncompressed > PLUGIN_MARKET_MAX_UNCOMPRESSED_BYTES {
            return Err(format!(
                "Plugin market zip uncompressed size is too large: {total_uncompressed} bytes (max {PLUGIN_MARKET_MAX_UNCOMPRESSED_BYTES})"
            ));
        }
        if let Some(path) = entry.enclosed_name() {
            let normalized = path.to_path_buf();
            if !normalized.as_os_str().is_empty() && !normalized_paths.insert(normalized.clone()) {
                return Err(format!(
                    "Plugin market zip contains duplicate path: {}",
                    normalized.display()
                ));
            }
        }
    }

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Invalid plugin market zip entry {index}: {error}"))?;
        let Some(relative_path) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            return Err(format!(
                "Plugin market zip contains unsafe path: {}",
                entry.name()
            ));
        };
        if relative_path.as_os_str().is_empty() {
            continue;
        }
        let target_path = staging_dir.join(relative_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&target_path).map_err(|error| {
                format!(
                    "Failed to create plugin market directory {}: {error}",
                    target_path.display()
                )
            })?;
            continue;
        }
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create plugin market directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let mut output = std::fs::File::create(&target_path).map_err(|error| {
            format!(
                "Failed to create plugin market file {}: {error}",
                target_path.display()
            )
        })?;
        std::io::copy(&mut entry, &mut output).map_err(|error| {
            format!(
                "Failed to extract plugin market file {}: {error}",
                target_path.display()
            )
        })?;
    }
    Ok(())
}

fn validate_plugin_market_zip_entry(
    entry: &zip::read::ZipFile<'_>,
    index: usize,
) -> Result<(), String> {
    if entry.encrypted() {
        return Err(format!(
            "Plugin market zip contains encrypted entry {index}: {}",
            entry.name()
        ));
    }
    if entry
        .unix_mode()
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
    {
        return Err(format!(
            "Plugin market zip contains unsupported symlink entry: {}",
            entry.name()
        ));
    }
    let Some(relative_path) = entry.enclosed_name() else {
        return Err(format!(
            "Plugin market zip contains unsafe path: {}",
            entry.name()
        ));
    };
    if relative_path.components().count() > PLUGIN_MARKET_MAX_PATH_DEPTH {
        return Err(format!(
            "Plugin market zip path is too deep: {} (max {} components)",
            entry.name(),
            PLUGIN_MARKET_MAX_PATH_DEPTH
        ));
    }
    if entry.size() > PLUGIN_MARKET_MAX_SINGLE_ENTRY_BYTES {
        return Err(format!(
            "Plugin market zip entry uncompressed size is too large: {} is {} bytes (max {})",
            entry.name(),
            entry.size(),
            PLUGIN_MARKET_MAX_SINGLE_ENTRY_BYTES
        ));
    }
    Ok(())
}

fn plugin_market_staged_plugin_dir(
    staging_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let mut manifest_dirs = Vec::new();
    collect_plugin_manifest_dirs(staging_dir, &mut manifest_dirs).map_err(|error| {
        format!(
            "Failed to inspect plugin market staging directory {}: {error}",
            staging_dir.display()
        )
    })?;
    match manifest_dirs.len() {
        0 => Err("Plugin market zip does not contain plugin.json".to_string()),
        1 => Ok(manifest_dirs.remove(0)),
        count => Err(format!(
            "Plugin market zip contains {count} plugin.json files; install one plugin per archive"
        )),
    }
}

fn collect_plugin_manifest_dirs(
    dir: &std::path::Path,
    manifest_dirs: &mut Vec<std::path::PathBuf>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_plugin_manifest_dirs(&path, manifest_dirs)?;
        } else if path.file_name().and_then(|name| name.to_str()) == Some("plugin.json") {
            if let Some(parent) = path.parent() {
                manifest_dirs.push(parent.to_path_buf());
            }
        }
    }
    Ok(())
}

fn install_plugin_from_directory_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_dir: &std::path::Path,
) -> Result<Plugin, String> {
    install_plugin_from_directory_checked_inner(db, config, plugin_dir, None)
}

fn install_plugin_from_directory_checked_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_dir: &std::path::Path,
    expected_plugin_id: Option<&str>,
) -> Result<Plugin, String> {
    install_plugin_from_directory_checked_with_policy_inner(
        db,
        config,
        plugin_dir,
        expected_plugin_id,
        PluginPersistencePolicy::Local,
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PluginPersistencePolicy {
    Local,
    Market,
}

fn install_plugin_from_directory_checked_with_policy_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_dir: &std::path::Path,
    expected_plugin_id: Option<&str>,
    policy: PluginPersistencePolicy,
) -> Result<Plugin, String> {
    let _mutation_guard = acquire_plugin_mutation_lock()?;
    let manifest_path = plugin_dir.join("plugin.json");
    let manifest_content = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read plugin.json: {}", e))?;
    let manifest: PluginManifest = serde_json::from_str(&manifest_content)
        .map_err(|e| format!("Invalid plugin.json: {}", e))?;

    let plugin_id = atools_core::utils::sanitize_id(&manifest.name);
    if let Some(expected_plugin_id) = expected_plugin_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if plugin_id != expected_plugin_id {
            return Err(format!(
                "Plugin market archive id {} does not match catalog plugin {}",
                plugin_id, expected_plugin_id
            ));
        }
    }
    let install_dir = config.plugin_dir(&plugin_id);

    let existing = db.get_plugin(&plugin_id).ok();
    if policy == PluginPersistencePolicy::Market {
        if let Some(existing) = &existing {
            persist_disabled_plugin_before_market_copy(db, existing)?;
        }
    }

    let staged_dir = stage_plugin_directory(plugin_dir, &install_dir)
        .map_err(|error| format!("Failed to copy plugin: {error}"))?;

    let now = atools_core::utils::now_iso();
    let plugin = Plugin {
        id: plugin_id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: install_dir.to_string_lossy().to_string(),
        enabled: policy != PluginPersistencePolicy::Market,
        manifest: manifest.clone(),
        created_at: existing
            .as_ref()
            .map(|plugin| plugin.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    };

    replace_plugin_directory_transactionally(&staged_dir, &install_dir, || {
        db.save_plugin_with_features(&plugin, &manifest.features)
            .map_err(|error| error.to_string())?;
        Ok(plugin.clone())
    })
}

pub(crate) fn plugin_update_from_path_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_id: &str,
    source_dir: &std::path::Path,
) -> Result<Plugin, String> {
    plugin_update_from_path_with_policy_inner(
        db,
        config,
        plugin_id,
        source_dir,
        PluginPersistencePolicy::Local,
    )
}

fn plugin_update_from_path_with_policy_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_id: &str,
    source_dir: &std::path::Path,
    policy: PluginPersistencePolicy,
) -> Result<Plugin, String> {
    let _mutation_guard = acquire_plugin_mutation_lock()?;
    let existing = db.get_plugin(plugin_id).map_err(|e| e.to_string())?;
    let install_dir = config.plugin_dir(plugin_id);
    if !plugin_uninstall_path_allowed(std::path::Path::new(&existing.path), &config.plugins_dir()) {
        return Err(
            "Only imported plugins in the ATools plugins directory can be updated".to_string(),
        );
    }
    if plugin_update_source_overlaps_install_dir(source_dir, &install_dir) {
        return Err(
            "Cannot update from the installed plugin directory or its parent/child directories"
                .to_string(),
        );
    }

    let manifest_path = source_dir.join("plugin.json");
    let manifest_content = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read plugin.json: {}", e))?;
    let manifest: PluginManifest = serde_json::from_str(&manifest_content)
        .map_err(|e| format!("Invalid plugin.json: {}", e))?;
    let source_plugin_id = atools_core::utils::sanitize_id(&manifest.name);
    if source_plugin_id != plugin_id {
        return Err(format!(
            "Selected plugin id {} does not match current plugin {}",
            source_plugin_id, plugin_id
        ));
    }

    if policy == PluginPersistencePolicy::Market {
        persist_disabled_plugin_before_market_copy(db, &existing)?;
    }

    let staged_dir = stage_plugin_directory(source_dir, &install_dir)
        .map_err(|error| format!("Failed to copy plugin: {error}"))?;

    let plugin = Plugin {
        id: plugin_id.to_string(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: install_dir.to_string_lossy().to_string(),
        enabled: if policy == PluginPersistencePolicy::Market {
            false
        } else {
            existing.enabled
        },
        manifest: manifest.clone(),
        created_at: existing.created_at,
        updated_at: atools_core::utils::now_iso(),
    };

    replace_plugin_directory_transactionally(&staged_dir, &install_dir, || {
        db.save_plugin_with_features(&plugin, &manifest.features)
            .map_err(|error| error.to_string())?;
        Ok(plugin.clone())
    })
}

fn persist_disabled_plugin_before_market_copy(
    db: &atools_core::db::Database,
    existing: &Plugin,
) -> Result<(), String> {
    if !existing.enabled {
        return Ok(());
    }
    let mut disabled = existing.clone();
    disabled.enabled = false;
    disabled.updated_at = atools_core::utils::now_iso();
    db.save_plugin(&disabled).map_err(|error| error.to_string())
}

fn plugin_update_source_overlaps_install_dir(
    source_dir: &std::path::Path,
    install_dir: &std::path::Path,
) -> bool {
    let Some(source_dir) = canonical_existing_or_child_path(source_dir) else {
        return false;
    };
    let Some(install_dir) = canonical_existing_or_child_path(install_dir) else {
        return false;
    };
    source_dir == install_dir
        || source_dir.starts_with(&install_dir)
        || install_dir.starts_with(&source_dir)
}

#[tauri::command]
pub fn scan_ztools_plugins(
    root: String,
) -> Result<Vec<crate::ztools_import::ZToolsImportCandidate>, String> {
    crate::ztools_import::scan_ztools_plugin_candidates(std::path::Path::new(&root))
}

#[tauri::command]
pub fn import_ztools_plugins(
    state: tauri::State<AppState>,
    paths: Vec<String>,
    overwrite: Option<bool>,
) -> Result<crate::ztools_import::ZToolsImportReport, String> {
    let report = crate::ztools_import::import_ztools_plugins(
        &state.db,
        &state.config.plugins_dir(),
        &paths,
        overwrite.unwrap_or(true),
    )?;
    crate::agent_tools::sync_plugin_tools(&state.db)?;
    Ok(report)
}

#[tauri::command]
pub fn uninstall_plugin(state: tauri::State<AppState>, plugin_id: String) -> Result<(), String> {
    uninstall_plugin_inner(&state.db, &state.config, &plugin_id)?;
    crate::agent_tools::sync_plugin_tools(&state.db)?;
    tracing::info!("Uninstalled plugin: {}", plugin_id);
    Ok(())
}

fn uninstall_plugin_inner(
    db: &atools_core::db::Database,
    config: &atools_core::config::AppConfig,
    plugin_id: &str,
) -> Result<(), String> {
    let _mutation_guard = acquire_plugin_mutation_lock()?;
    let plugin = db.get_plugin(plugin_id).map_err(|e| e.to_string())?;
    let plugin_path = std::path::Path::new(&plugin.path);
    let plugins_dir = config.plugins_dir();
    if !plugin_uninstall_path_allowed(plugin_path, &plugins_dir) {
        return Err(
            "Only imported plugins in the ATools plugins directory can be uninstalled".to_string(),
        );
    }
    uninstall_plugin_files_transactionally(plugin_path, || {
        db.delete_plugin(plugin_id)
            .map_err(|error| error.to_string())
    })
}

pub(crate) fn plugin_uninstall_path_allowed(
    plugin_path: &std::path::Path,
    plugins_dir: &std::path::Path,
) -> bool {
    let Some(plugin_path) = canonical_existing_or_child_path(plugin_path) else {
        return false;
    };
    let Some(plugins_dir) = canonical_existing_or_child_path(plugins_dir) else {
        return false;
    };
    plugin_path.starts_with(&plugins_dir) && plugin_path != plugins_dir
}

fn canonical_existing_or_child_path(path: &std::path::Path) -> Option<std::path::PathBuf> {
    if let Ok(canonical) = path.canonicalize() {
        return Some(canonical);
    }
    let parent = path.parent()?.canonicalize().ok()?;
    Some(parent.join(path.file_name()?))
}

#[tauri::command]
pub fn list_plugins(state: tauri::State<AppState>) -> Result<Vec<Plugin>, String> {
    state.db.list_plugins().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_plugin(
    state: tauri::State<AppState>,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut plugin = state.db.get_plugin(&plugin_id).map_err(|e| e.to_string())?;
    plugin.enabled = enabled;
    plugin.updated_at = atools_core::utils::now_iso();
    state
        .db
        .save_plugin_with_features(&plugin, &plugin.manifest.features)
        .map_err(|e| e.to_string())?;
    crate::agent_tools::sync_plugin_tools(&state.db)?;
    Ok(())
}

pub(crate) fn authorize_plugin_permissions_inner(
    db: &atools_core::db::Database,
    plugin_id: &str,
) -> Result<Plugin, String> {
    let mut plugin = db
        .get_plugin(plugin_id.trim())
        .map_err(|error| error.to_string())?;
    plugin.enabled = true;
    plugin.updated_at = atools_core::utils::now_iso();
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .map_err(|error| error.to_string())?;
    crate::agent_tools::sync_plugin_tools(db)?;
    Ok(plugin)
}

#[tauri::command]
pub fn get_setting(state: tauri::State<AppState>, key: String) -> Result<Option<String>, String> {
    state.db.get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(
    state: tauri::State<AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state
        .db
        .set_setting(&key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_plugin_data(
    state: tauri::State<AppState>,
    plugin_id: String,
) -> Result<Vec<Document>, String> {
    state
        .db
        .plugin_data_all(&plugin_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn put_plugin_data(
    state: tauri::State<AppState>,
    plugin_id: String,
    doc: Document,
) -> Result<(), String> {
    state
        .db
        .plugin_data_put(&plugin_id, &doc)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_plugin_data(
    state: tauri::State<AppState>,
    plugin_id: String,
    doc_id: String,
) -> Result<(), String> {
    state
        .db
        .plugin_data_remove(&plugin_id, &doc_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_clipboard_history(
    state: tauri::State<AppState>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ClipboardHistoryEntry>, String> {
    state
        .db
        .search_clipboard_history(query.as_deref().unwrap_or_default(), limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_clipboard_history(state: tauri::State<AppState>) -> Result<usize, String> {
    state
        .db
        .clear_clipboard_history()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_clipboard_history_json(
    state: tauri::State<AppState>,
    limit: Option<usize>,
) -> Result<String, String> {
    state
        .db
        .export_clipboard_history_json(limit.unwrap_or(1000))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.center().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn release_smoke_info(state: tauri::State<AppState>) -> Option<ReleaseSmokeConfig> {
    state.release_smoke.lock().clone()
}

#[derive(Debug, Deserialize)]
pub struct ReleaseSmokeProgressReport {
    token: String,
    option_z_toggled: Option<bool>,
    settings_page_opened: Option<bool>,
    plugin_page_opened: Option<bool>,
    agent_page_opened: Option<bool>,
    errors: Option<Vec<String>>,
    completed: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum ReleaseSmokeProgressReportPayload {
    Wrapped { report: ReleaseSmokeProgressReport },
    Unwrapped(ReleaseSmokeProgressReport),
}

impl ReleaseSmokeProgressReportPayload {
    fn unwrap(self) -> ReleaseSmokeProgressReport {
        match self {
            Self::Wrapped { report } => report,
            Self::Unwrapped(report) => report,
        }
    }
}

#[tauri::command]
pub fn report_release_smoke_progress(
    state: tauri::State<AppState>,
    report: ReleaseSmokeProgressReportPayload,
) -> Result<(), String> {
    let report = report.unwrap();
    let config = {
        let config = state.release_smoke.lock();
        config
            .as_ref()
            .cloned()
            .ok_or_else(|| "Release smoke is not enabled".to_string())?
    };
    tracing::debug!(
        "Release smoke report received: token={} completed={} option_z={} settings={} plugin={} agent={}",
        report.token,
        report.completed.unwrap_or(false),
        report.option_z_toggled.unwrap_or_default(),
        report.settings_page_opened.unwrap_or_default(),
        report.plugin_page_opened.unwrap_or_default(),
        report.agent_page_opened.unwrap_or_default(),
    );
    if config.token != report.token {
        return Err("Invalid release smoke token".to_string());
    }

    let mut progress = state.release_smoke_progress.lock();
    progress.token = config.token.clone();
    progress.report_path = config.report_path.clone();
    if let Some(value) = report.option_z_toggled {
        progress.option_z_toggled = Some(value);
    }
    if let Some(value) = report.settings_page_opened {
        progress.settings_page_opened = Some(value);
    }
    if let Some(value) = report.plugin_page_opened {
        progress.plugin_page_opened = Some(value);
    }
    if let Some(value) = report.agent_page_opened {
        progress.agent_page_opened = Some(value);
    }
    if let Some(errors) = report.errors {
        progress.errors = errors;
    }
    if let Some(completed) = report.completed {
        progress.completed = completed;
    }

    if let Some(path) = &progress.report_path {
        persist_release_smoke_progress(path, &progress)?;
    }
    Ok(())
}

fn persist_release_smoke_progress(
    path: &str,
    progress: &ReleaseSmokeProgress,
) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let text = serde_json::to_string_pretty(progress).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn expand_window(app: AppHandle, height: u32) -> Result<(), String> {
    crate::window::expand_main_window(&app, height).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reset_window(app: AppHandle) -> Result<(), String> {
    crate::window::reset_main_window(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_floating_ball_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    crate::window::set_floating_ball_visible(&app, visible).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_super_panel_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    crate::window::set_super_panel_visible(&app, visible).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_plugin_detach_window(
    app: AppHandle,
    feature_code: Option<String>,
) -> Result<(), String> {
    let feature_code = feature_code.and_then(|code| {
        let trimmed = code.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let window = crate::window::ensure_plugin_detach_window(&app, feature_code.as_deref())
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct DevtoolsOpenResult {
    pub window_label: String,
    pub mode: String,
    pub detail: String,
}

#[tauri::command]
pub fn open_devtools_for_window(
    app: AppHandle,
    settings: serde_json::Value,
    window_label: Option<String>,
) -> Result<DevtoolsOpenResult, String> {
    let mode = devtools_mode_from_settings(&settings)?;
    let target = devtools_target_label(window_label);
    if !matches!(target.as_str(), "main" | "settings") {
        return Err(format!("Unsupported DevTools window label: {target}"));
    }
    let window = app
        .get_webview_window(&target)
        .ok_or_else(|| format!("DevTools target window not found: {target}"))?;
    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        window.open_devtools();
    }
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    {
        let _ = window;
    }
    let detail = if cfg!(any(debug_assertions, feature = "devtools")) {
        devtools_open_detail(&target, &mode)
    } else {
        format!(
            "Release build does not enable Tauri DevTools for {}. Use a dev build to inspect it.",
            devtools_window_label(&target)
        )
    };
    Ok(DevtoolsOpenResult {
        window_label: target.clone(),
        detail,
        mode,
    })
}

fn devtools_mode_from_settings(settings: &serde_json::Value) -> Result<String, String> {
    let mode = settings
        .get("devToolsMode")
        .and_then(|value| value.as_str())
        .unwrap_or("detach")
        .trim();
    match mode {
        "detach" | "right" | "bottom" | "undocked" => Ok(mode.to_string()),
        _ => Err(format!("Invalid DevTools mode: {mode}")),
    }
}

fn devtools_target_label(window_label: Option<String>) -> String {
    window_label.as_deref().unwrap_or("main").trim().to_string()
}

fn devtools_open_detail(window_label: &str, mode: &str) -> String {
    let mode_label = match mode {
        "right" => "靠右",
        "bottom" => "靠下",
        "undocked" => "独立窗口（可停靠）",
        _ => "独立窗口",
    };
    format!("已请求打开 {window_label} DevTools；偏好位置：{mode_label}")
}

fn devtools_window_label(window_label: &str) -> &'static str {
    match window_label {
        "settings" => "settings window",
        _ => "main window",
    }
}

#[derive(Debug, PartialEq, Eq)]
enum HotkeyUpdatePlan<'a> {
    ExplicitPrevious {
        previous: &'a str,
        requested: &'a str,
    },
    ConfiguredPrevious {
        requested: &'a str,
    },
}

fn hotkey_update_plan<'a>(requested: &'a str, previous: Option<&'a str>) -> HotkeyUpdatePlan<'a> {
    match previous {
        Some(previous) => HotkeyUpdatePlan::ExplicitPrevious {
            previous,
            requested,
        },
        None => HotkeyUpdatePlan::ConfiguredPrevious { requested },
    }
}

#[tauri::command]
pub fn update_global_hotkey(
    app: AppHandle,
    shortcut: String,
    previous_shortcut: Option<String>,
) -> Result<(), String> {
    let result = match hotkey_update_plan(&shortcut, previous_shortcut.as_deref()) {
        HotkeyUpdatePlan::ExplicitPrevious {
            previous,
            requested,
        } => crate::hotkey::update_hotkey_from(&app, previous, requested),
        HotkeyUpdatePlan::ConfiguredPrevious { requested } => {
            crate::hotkey::update_hotkey(&app, requested)
        }
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_tray_icon_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let tray = app
        .tray_by_id("atools-tray")
        .ok_or_else(|| "Tray icon not found".to_string())?;
    tray.set_visible(visible).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        set_macos_launch_at_login(enabled)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn set_macos_launch_at_login(enabled: bool) -> Result<(), String> {
    let path = launch_agent_path()?;
    let executable = if enabled {
        std::env::current_exe().map_err(|e| e.to_string())?
    } else {
        std::path::PathBuf::new()
    };
    apply_macos_launch_at_login(&path, &executable, enabled, launchctl)
}

#[cfg(target_os = "macos")]
fn apply_macos_launch_at_login<F>(
    path: &std::path::Path,
    executable: &std::path::Path,
    enabled: bool,
    mut launchctl: F,
) -> Result<(), String>
where
    F: FnMut(&str, &std::path::Path) -> Result<(), String>,
{
    let exists = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "Refusing to modify LaunchAgent symlink: {}",
                path.display()
            ));
        }
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "Failed to inspect LaunchAgent {}: {}",
                path.display(),
                error
            ));
        }
    };

    if enabled {
        let previous = if exists {
            Some(std::fs::read(path).map_err(|error| {
                format!(
                    "Failed to read existing LaunchAgent {}: {}",
                    path.display(),
                    error
                )
            })?)
        } else {
            None
        };
        let plist = launch_agent_plist(&executable.to_string_lossy());
        atomic_write_launch_agent(path, plist.as_bytes())?;

        if let Err(primary_error) = launchctl("bootstrap", path) {
            let mut compensation_failures = Vec::new();
            if let Err(error) = launchctl("bootout", path) {
                compensation_failures.push(format!("bootout new service failed: {error}"));
            }

            match previous.as_deref() {
                Some(contents) => {
                    if let Err(error) = atomic_write_launch_agent(path, contents) {
                        compensation_failures
                            .push(format!("restore previous plist failed: {error}"));
                    }
                }
                None => {
                    if let Err(error) = std::fs::remove_file(path) {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            compensation_failures.push(format!("remove new plist failed: {error}"));
                        }
                    }
                }
            }

            if previous.is_some() {
                if let Err(error) = launchctl("bootstrap", path) {
                    compensation_failures
                        .push(format!("bootstrap previous service failed: {error}"));
                }
            }

            let primary = format!("launchctl bootstrap failed: {primary_error}");
            return Err(with_compensation_failures(primary, compensation_failures));
        }
        return Ok(());
    }

    if !exists {
        return Ok(());
    }
    launchctl("bootout", path).map_err(|error| format!("launchctl bootout failed: {error}"))?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(remove_error) => match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(_) => {
                let compensation = match launchctl("bootstrap", path) {
                    Ok(()) => "compensation bootstrap succeeded".to_string(),
                    Err(error) => format!("compensation bootstrap failed: {error}"),
                };
                Err(format!(
                    "Failed to remove LaunchAgent {} after bootout: {}; {}",
                    path.display(),
                    remove_error,
                    compensation
                ))
            }
            Err(inspect_error) => Err(format!(
                "Failed to remove LaunchAgent {} after bootout: {}; failed to inspect file after removal error: {}",
                path.display(),
                remove_error,
                inspect_error
            )),
        },
    }
}

#[cfg(target_os = "macos")]
fn with_compensation_failures(primary: String, failures: Vec<String>) -> String {
    if failures.is_empty() {
        primary
    } else {
        format!("{primary}; compensation failures: {}", failures.join("; "))
    }
}

#[cfg(target_os = "macos")]
fn atomic_write_launch_agent(path: &std::path::Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid LaunchAgent path: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create LaunchAgent directory {}: {}",
            parent.display(),
            error
        )
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid LaunchAgent path: {}", path.display()))?
        .to_string_lossy();

    let (temporary_path, mut temporary_file) = (0..128)
        .find_map(|_| {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let candidate = parent.join(format!(
                ".{file_name}.atools-tmp-{}-{id}",
                std::process::id()
            ));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((candidate, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(format!(
                    "Failed to create temporary LaunchAgent file {}: {}",
                    candidate.display(),
                    error
                ))),
            }
        })
        .transpose()?
        .ok_or_else(|| {
            format!(
                "Failed to allocate a unique temporary LaunchAgent file beside {}",
                path.display()
            )
        })?;

    let write_result = (|| -> Result<(), String> {
        temporary_file
            .write_all(contents)
            .map_err(|error| format!("Failed to write temporary LaunchAgent file: {error}"))?;
        temporary_file
            .flush()
            .map_err(|error| format!("Failed to flush temporary LaunchAgent file: {error}"))?;
        temporary_file
            .sync_all()
            .map_err(|error| format!("Failed to sync temporary LaunchAgent file: {error}"))?;
        Ok(())
    })();
    drop(temporary_file);

    if let Err(error) = write_result {
        return Err(clean_up_launch_agent_temp(&temporary_path, error));
    }
    if let Err(error) = std::fs::rename(&temporary_path, path) {
        return Err(clean_up_launch_agent_temp(
            &temporary_path,
            format!(
                "Failed to atomically replace LaunchAgent {}: {}",
                path.display(),
                error
            ),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn clean_up_launch_agent_temp(path: &std::path::Path, primary: String) -> String {
    match std::fs::remove_file(path) {
        Ok(()) => primary,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => primary,
        Err(error) => format!(
            "{primary}; failed to clean up temporary file {}: {}",
            path.display(),
            error
        ),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn launch_agent_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join("com.atools.desktop.plist"))
}

#[cfg(target_os = "macos")]
fn launchctl(action: &str, path: &std::path::Path) -> Result<(), String> {
    let uid = std::process::Command::new("id")
        .arg("-u")
        .output()
        .map_err(|e| e.to_string())
        .and_then(|output| String::from_utf8(output.stdout).map_err(|e| e.to_string()))?;
    let target = format!("gui/{}", uid.trim());
    let output = std::process::Command::new("launchctl")
        .arg(action)
        .arg(target)
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8(output.stdout).unwrap_or_default();
    let stderr = String::from_utf8(output.stderr).unwrap_or_default();
    let combined = [stdout, stderr].join("\n");
    if output.status.success() || is_launchctl_action_noop(action, &combined) {
        Ok(())
    } else {
        let detail = combined.trim();
        if detail.is_empty() {
            Err(format!(
                "launchctl {} failed for {} with status {}",
                action,
                path.display(),
                output.status
            ))
        } else {
            Err(format!(
                "launchctl {} failed for {}: {}",
                action,
                path.display(),
                detail
            ))
        }
    }
}

#[cfg(target_os = "macos")]
fn is_launchctl_action_noop(action: &str, message: &str) -> bool {
    let normalized = message.to_lowercase();
    match action {
        "bootstrap" => {
            normalized.contains("already")
                && (normalized.contains("loaded") || normalized.contains("bootstrap"))
        }
        "bootout" => {
            normalized.contains("not found")
                || normalized.contains("could not find service")
                || normalized.contains("no such process")
                || normalized.contains("does not exist")
                || normalized.contains("doesn't exist")
                || normalized.contains("already unloaded")
        }
        _ => false,
    }
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod launchctl_action_tests {
    use super::{apply_macos_launch_at_login, is_launchctl_action_noop};
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};

    #[derive(Default)]
    struct FakeLaunchctl {
        calls: Vec<(String, PathBuf, Option<Vec<u8>>)>,
        outcomes: VecDeque<Result<(), String>>,
    }

    impl FakeLaunchctl {
        fn with_outcomes(outcomes: impl IntoIterator<Item = Result<(), String>>) -> Self {
            Self {
                calls: Vec::new(),
                outcomes: outcomes.into_iter().collect(),
            }
        }

        fn run(&mut self, action: &str, path: &Path) -> Result<(), String> {
            self.calls.push((
                action.to_string(),
                path.to_path_buf(),
                std::fs::read(path).ok(),
            ));
            self.outcomes.pop_front().unwrap_or(Ok(()))
        }

        fn actions(&self) -> Vec<&str> {
            self.calls
                .iter()
                .map(|(action, _, _)| action.as_str())
                .collect()
        }
    }

    #[test]
    fn launchctl_noop_bootstrap_output() {
        assert!(is_launchctl_action_noop(
            "bootstrap",
            "Service bootstrap failed: 48: Service already loaded"
        ));
        assert!(!is_launchctl_action_noop(
            "bootstrap",
            "Could not connect to service manager"
        ));
    }

    #[test]
    fn launchctl_noop_bootout_output() {
        assert!(is_launchctl_action_noop(
            "bootout",
            "Could not find service \"com.atools.desktop\" in domain"
        ));
        assert!(is_launchctl_action_noop("bootout", "No such process"));
        assert!(!is_launchctl_action_noop("bootout", "Permission denied"));
    }

    #[test]
    fn enable_bootstrap_failure_removes_new_plist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("com.atools.desktop.plist");
        let executable = Path::new("/Applications/ATools.app/Contents/MacOS/ATools");
        let mut fake = FakeLaunchctl::with_outcomes([Err("bootstrap denied".to_string()), Ok(())]);

        let error = apply_macos_launch_at_login(&path, executable, true, |action, path| {
            fake.run(action, path)
        })
        .unwrap_err();

        assert!(error.contains("bootstrap denied"));
        assert_eq!(fake.actions(), vec!["bootstrap", "bootout"]);
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn enable_bootstrap_failure_restores_old_plist_and_service() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("com.atools.desktop.plist");
        let old_plist = b"old launch agent";
        std::fs::write(&path, old_plist).unwrap();
        let executable = Path::new("/Applications/ATools.app/Contents/MacOS/ATools");
        let mut fake =
            FakeLaunchctl::with_outcomes([Err("bootstrap denied".to_string()), Ok(()), Ok(())]);

        let error = apply_macos_launch_at_login(&path, executable, true, |action, path| {
            fake.run(action, path)
        })
        .unwrap_err();

        assert!(error.contains("bootstrap denied"));
        assert_eq!(fake.actions(), vec!["bootstrap", "bootout", "bootstrap"]);
        assert_ne!(fake.calls[0].2.as_deref(), Some(old_plist.as_slice()));
        assert_eq!(fake.calls[2].2.as_deref(), Some(old_plist.as_slice()));
        assert_eq!(std::fs::read(&path).unwrap(), old_plist);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn symlink_is_rejected_without_changing_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.plist");
        let path = dir.path().join("com.atools.desktop.plist");
        let original = b"target launch agent";
        std::fs::write(&target, original).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let mut fake = FakeLaunchctl::default();

        let error = apply_macos_launch_at_login(
            &path,
            Path::new("/Applications/ATools.app/Contents/MacOS/ATools"),
            true,
            |action, path| fake.run(action, path),
        )
        .unwrap_err();

        assert!(error.to_lowercase().contains("symlink"));
        assert!(fake.calls.is_empty());
        assert_eq!(std::fs::read(&target).unwrap(), original);
    }

    #[test]
    fn disable_bootout_failure_preserves_plist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("com.atools.desktop.plist");
        let original = b"existing launch agent";
        std::fs::write(&path, original).unwrap();
        let mut fake = FakeLaunchctl::with_outcomes([Err("bootout denied".to_string())]);

        let error =
            apply_macos_launch_at_login(&path, Path::new("/unused"), false, |action, path| {
                fake.run(action, path)
            })
            .unwrap_err();

        assert!(error.contains("bootout denied"));
        assert_eq!(fake.actions(), vec!["bootout"]);
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn enable_success_writes_plist_and_bootstraps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("com.atools.desktop.plist");
        let executable = Path::new("/Applications/A&B.app/Contents/MacOS/ATools");
        let mut fake = FakeLaunchctl::default();

        apply_macos_launch_at_login(&path, executable, true, |action, path| {
            fake.run(action, path)
        })
        .unwrap();

        assert_eq!(fake.actions(), vec!["bootstrap"]);
        let plist = std::fs::read_to_string(&path).unwrap();
        assert!(plist.contains("/Applications/A&amp;B.app/Contents/MacOS/ATools"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn disable_success_boots_out_and_removes_plist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("com.atools.desktop.plist");
        std::fs::write(&path, b"existing launch agent").unwrap();
        let mut fake = FakeLaunchctl::default();

        apply_macos_launch_at_login(&path, Path::new("/unused"), false, |action, path| {
            fake.run(action, path)
        })
        .unwrap();

        assert_eq!(fake.actions(), vec!["bootout"]);
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

pub(crate) fn launch_agent_plist(executable_path: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.atools.desktop</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
        xml_escape(executable_path)
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod settings_command_tests {
    use super::{
        ai_connection_config_from_settings, ai_models_url,
        apply_webdav_plugin_data_payload_with_mode, devtools_mode_from_settings,
        devtools_target_label, hotkey_update_plan, launch_agent_plist,
        macos_current_browser_url_script, macos_current_folder_path_script,
        macos_frontmost_app_name_script, macos_open_reveal_args, macos_screencapture_args,
        merge_mcp_client_config, native_command_error, record_webdav_clipboard_entries,
        screen_capture_file_to_data_url, screen_capture_smoke_guard_error,
        shell_show_item_in_folder, test_ai_connection_config, webdav_config_from_settings,
        write_audit_archive_file, write_mcp_client_config_file, HotkeyUpdatePlan,
        WebdavPluginDataConflictSelection, WebdavPluginDataRestoreMode,
    };
    use crate::webdav::WebdavClipboardRestoreEntry;
    use atools_core::agent::{AuditLogEntry, AuditStatus};
    use atools_core::models::{Document, Plugin, PluginManifest};
    use atools_core::Database;

    #[test]
    fn launch_agent_plist_uses_current_executable() {
        let plist = launch_agent_plist("/Applications/ATools.app/Contents/MacOS/ATools");

        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<true/>"));
        assert!(plist.contains("<string>/Applications/ATools.app/Contents/MacOS/ATools</string>"));
    }

    #[test]
    fn launch_agent_plist_escapes_xml_entities_in_path() {
        let plist = launch_agent_plist("/tmp/A&B<ATools>.app/ATools");

        assert!(plist.contains("/tmp/A&amp;B&lt;ATools&gt;.app/ATools"));
    }

    #[test]
    fn macos_open_reveal_uses_open_dash_r() {
        let args = macos_open_reveal_args("/Users/me/file.txt");

        assert_eq!(args, vec!["-R", "/Users/me/file.txt"]);
    }

    #[test]
    fn macos_screencapture_uses_interactive_clipboard_command() {
        let args = macos_screencapture_args(Some("/tmp/atools-shot.png"));

        assert_eq!(args, vec!["-i", "/tmp/atools-shot.png"]);
    }

    #[test]
    fn apple_scripts_cover_browser_and_finder_context() {
        assert!(macos_current_browser_url_script().contains("Google Chrome"));
        assert!(macos_current_browser_url_script().contains("Safari"));
        assert!(macos_current_folder_path_script().contains("Finder"));
        assert!(macos_current_folder_path_script().contains("POSIX path"));
        assert!(macos_frontmost_app_name_script().contains("frontmost is true"));
        assert!(macos_frontmost_app_name_script().contains("System Events"));
    }

    #[test]
    fn native_command_error_is_explicit() {
        let error = native_command_error("screenCapture", "permission denied");

        assert!(error.contains("screenCapture failed"));
        assert!(error.contains("permission denied"));
    }

    #[test]
    fn hotkey_command_prefers_explicit_previous_shortcut() {
        assert_eq!(
            hotkey_update_plan("Option+N", Some("Option+P")),
            HotkeyUpdatePlan::ExplicitPrevious {
                previous: "Option+P",
                requested: "Option+N",
            }
        );
    }

    #[test]
    fn hotkey_command_uses_configured_previous_when_explicit_value_is_missing() {
        assert_eq!(
            hotkey_update_plan("Option+N", None),
            HotkeyUpdatePlan::ConfiguredPrevious {
                requested: "Option+N",
            }
        );
    }

    #[test]
    fn screen_capture_smoke_guard_is_explicit_and_noninteractive() {
        let error = screen_capture_smoke_guard_error();

        assert!(error.contains("screenCapture"));
        assert!(error.contains("desktop smoke"));
        assert!(error.contains("interactive"));
    }

    #[test]
    fn screen_capture_file_to_data_url_encodes_png_and_removes_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("atools-screen-test.png");
        std::fs::write(&path, b"png-bytes").unwrap();

        let data_url = screen_capture_file_to_data_url(&path).unwrap();

        assert_eq!(data_url, "data:image/png;base64,cG5nLWJ5dGVz");
        assert!(!path.exists());
    }

    #[test]
    fn devtools_mode_settings_are_parsed_for_window_opening() {
        assert_eq!(
            devtools_mode_from_settings(&serde_json::json!({ "devToolsMode": "right" })).unwrap(),
            "right"
        );
        assert_eq!(
            devtools_mode_from_settings(&serde_json::json!({ "devToolsMode": "bottom" })).unwrap(),
            "bottom"
        );
        assert_eq!(
            devtools_mode_from_settings(&serde_json::json!({ "devToolsMode": "undocked" }))
                .unwrap(),
            "undocked"
        );
        assert_eq!(
            devtools_mode_from_settings(&serde_json::json!({})).unwrap(),
            "detach"
        );
        assert!(
            devtools_mode_from_settings(&serde_json::json!({ "devToolsMode": "attach" }))
                .unwrap_err()
                .contains("DevTools")
        );
        assert_eq!(
            devtools_target_label(Some("settings".to_string())),
            "settings"
        );
        assert_eq!(devtools_target_label(None), "main");
    }

    #[test]
    fn mcp_client_config_merge_preserves_existing_servers_and_replaces_atools() {
        let existing = serde_json::json!({
            "theme": "dark",
            "mcpServers": {
                "other": { "command": "/bin/other" },
                "atools": { "command": "/old/atools", "args": ["--old"] }
            }
        });
        let desired = serde_json::json!({
            "mcpServers": {
                "atools": {
                    "url": "http://127.0.0.1:54556/mcp",
                    "headers": { "Authorization": "Bearer local-token" }
                }
            }
        });

        let merged = merge_mcp_client_config(existing, desired, "atools").unwrap();

        assert_eq!(merged["theme"], "dark");
        assert_eq!(merged["mcpServers"]["other"]["command"], "/bin/other");
        assert_eq!(
            merged["mcpServers"]["atools"]["url"],
            "http://127.0.0.1:54556/mcp"
        );
        assert!(merged["mcpServers"]["atools"].get("command").is_none());
    }

    #[test]
    fn mcp_client_config_write_requires_confirmation_and_backs_up_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested").join("mcp.json");
        let desired = serde_json::json!({
            "mcpServers": {
                "atools": { "command": "/Applications/ATools", "args": ["--mcp-stdio"] }
            }
        });

        let unconfirmed =
            write_mcp_client_config_file(&target, desired.clone(), "atools", false).unwrap_err();
        assert!(unconfirmed.contains("explicit confirmation"));
        assert!(!target.exists());

        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(
            &target,
            r#"{"mcpServers":{"other":{"command":"/bin/other"},"atools":{"command":"/old"}}}"#,
        )
        .unwrap();

        let result = write_mcp_client_config_file(&target, desired, "atools", true).unwrap();

        assert!(!result.created);
        assert!(result.changed);
        let backup_path = result.backup_path.expect("backup path");
        assert!(std::path::Path::new(&backup_path).is_file());
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(written["mcpServers"]["other"]["command"], "/bin/other");
        assert_eq!(
            written["mcpServers"]["atools"]["args"],
            serde_json::json!(["--mcp-stdio"])
        );
    }

    #[test]
    fn mcp_client_config_write_rejects_invalid_existing_json_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("mcp.json");
        let original = r#"{"mcpServers":{"other":{"command":"/bin/other"}},"#;
        let desired = serde_json::json!({
            "mcpServers": {
                "atools": { "command": "/Applications/ATools", "args": ["--mcp-stdio"] }
            }
        });
        std::fs::write(&target, original).unwrap();

        let error = write_mcp_client_config_file(&target, desired, "atools", true).unwrap_err();

        assert!(error.contains("not valid JSON"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), original);
        let backups = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".atools-backup-")
            })
            .count();
        assert_eq!(backups, 0);
    }

    #[test]
    fn mcp_client_config_write_rejects_non_object_mcp_servers_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("mcp.json");
        let original = r#"{"theme":"dark","mcpServers":[]}"#;
        let desired = serde_json::json!({
            "mcpServers": {
                "atools": { "command": "/Applications/ATools", "args": ["--mcp-stdio"] }
            }
        });
        std::fs::write(&target, original).unwrap();

        let error = write_mcp_client_config_file(&target, desired, "atools", true).unwrap_err();

        assert!(error.contains("Existing mcpServers must be a JSON object"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), original);
        let backups = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".atools-backup-")
            })
            .count();
        assert_eq!(backups, 0);
    }

    #[test]
    fn audit_archive_file_requires_confirmation_and_writes_jsonl() {
        let db = Database::in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested").join("audit.jsonl");
        let mut entry = AuditLogEntry::new(
            "codex",
            "search_clipboard",
            serde_json::json!({ "query": "invoice" }),
            AuditStatus::Allowed,
        )
        .with_output(serde_json::json!({ "items": 2 }))
        .with_duration_ms(12);
        entry.id = "audit-archive-test".to_string();
        entry.timestamp = "2026-06-04T08:00:00Z".to_string();
        db.insert_audit_entry(&entry).unwrap();

        let unconfirmed = write_audit_archive_file(&db, &target, 1000, false).unwrap_err();
        assert!(unconfirmed.contains("explicit confirmation"));
        assert!(!target.exists());

        let result = write_audit_archive_file(&db, &target, 1000, true).unwrap();

        assert_eq!(result.count, 1);
        assert_eq!(result.path, target.to_string_lossy());
        let lines = std::fs::read_to_string(&target).unwrap();
        assert!(lines.ends_with('\n'));
        let archived: serde_json::Value =
            serde_json::from_str(lines.lines().next().expect("jsonl row")).unwrap();
        assert_eq!(archived["id"], "audit-archive-test");
        assert_eq!(archived["client_id"], "codex");
        assert_eq!(archived["tool_name"], "search_clipboard");
    }

    #[test]
    fn shell_show_item_in_folder_missing_path_reports_bridge_method() {
        let missing_path = std::env::temp_dir()
            .join("atools-shell-show-item-missing-test")
            .to_string_lossy()
            .to_string();
        let error = shell_show_item_in_folder(missing_path).unwrap_err();

        assert!(error.contains("shellShowItemInFolder"));
        assert!(error.contains("unsupported") || error.contains("does not exist"));
    }

    #[test]
    fn webdav_clipboard_import_appends_missing_entries_without_touching_existing_text() {
        let db = Database::in_memory().unwrap();
        db.record_clipboard_text("local note", "2026-06-03T08:00:00Z")
            .unwrap();

        let result = record_webdav_clipboard_entries(
            &db,
            &[
                WebdavClipboardRestoreEntry {
                    text: "remote invoice".to_string(),
                    copied_at: "2026-06-03T09:00:00Z".to_string(),
                },
                WebdavClipboardRestoreEntry {
                    text: "local note".to_string(),
                    copied_at: "2026-06-03T10:00:00Z".to_string(),
                },
            ],
        )
        .unwrap();

        assert_eq!(result.imported_entries, 1);
        assert_eq!(result.skipped_entries, 1);
        let history = db.search_clipboard_history("", 10).unwrap();
        assert_eq!(history.len(), 2);
        assert!(history.iter().any(|entry| entry.text == "remote invoice"));
        let existing = history
            .iter()
            .find(|entry| entry.text == "local note")
            .unwrap();
        assert_eq!(existing.used_count, 1);
        assert_eq!(existing.last_copied_at, "2026-06-03T08:00:00Z");
    }

    #[test]
    fn webdav_plugin_data_restore_imports_missing_docs_and_skips_conflicts() {
        let db = Database::in_memory().unwrap();
        db.save_plugin(&Plugin {
            id: "plugin-json".to_string(),
            name: "JSON".to_string(),
            version: "1.0.0".to_string(),
            path: "/tmp/plugin-json".to_string(),
            manifest: serde_json::from_value::<PluginManifest>(serde_json::json!({
                "name": "JSON",
                "version": "1.0.0",
                "features": []
            }))
            .unwrap(),
            enabled: true,
            created_at: "2026-06-04T08:00:00Z".to_string(),
            updated_at: "2026-06-04T08:00:00Z".to_string(),
        })
        .unwrap();
        db.plugin_data_put(
            "plugin-json",
            &Document {
                id: "conflict-doc".to_string(),
                rev: None,
                data: serde_json::json!({ "value": "local" }),
            },
        )
        .unwrap();

        let payload = serde_json::json!({
            "version": 1,
            "plugins": [
                {
                    "id": "plugin-json",
                    "documents": [
                        { "_id": "new-doc", "value": "remote" },
                        { "_id": "conflict-doc", "value": "remote" }
                    ]
                },
                {
                    "id": "missing-plugin",
                    "documents": [
                        { "_id": "missing-doc", "value": "skip" }
                    ]
                }
            ]
        });

        let unconfirmed = apply_webdav_plugin_data_payload_with_mode(
            &db,
            &payload,
            false,
            WebdavPluginDataRestoreMode::AppendMissing,
            &[],
        )
        .unwrap_err();
        assert!(unconfirmed.contains("explicit confirmation"));
        assert!(db
            .plugin_data_get("plugin-json", "new-doc")
            .unwrap()
            .is_none());

        let result = apply_webdav_plugin_data_payload_with_mode(
            &db,
            &payload,
            true,
            WebdavPluginDataRestoreMode::AppendMissing,
            &[],
        )
        .unwrap();

        assert_eq!(result.remote_plugins, 2);
        assert_eq!(result.remote_documents, 3);
        assert_eq!(result.imported_documents, 1);
        assert_eq!(result.conflict_documents, 1);
        assert_eq!(result.missing_plugins, 1);
        assert_eq!(result.skipped_documents, 2);
        assert_eq!(result.status, "imported");
        assert_eq!(
            db.plugin_data_get("plugin-json", "new-doc")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "value": "remote" })
        );
        assert_eq!(
            db.plugin_data_get("plugin-json", "conflict-doc")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "value": "local" })
        );
    }

    #[test]
    fn webdav_plugin_data_restore_overwrite_mode_replaces_conflicts() {
        let db = Database::in_memory().unwrap();
        db.save_plugin(&Plugin {
            id: "plugin-json".to_string(),
            name: "JSON".to_string(),
            version: "1.0.0".to_string(),
            path: "/tmp/plugin-json".to_string(),
            manifest: serde_json::from_value::<PluginManifest>(serde_json::json!({
                "name": "JSON",
                "version": "1.0.0",
                "features": []
            }))
            .unwrap(),
            enabled: true,
            created_at: "2026-06-04T08:00:00Z".to_string(),
            updated_at: "2026-06-04T08:00:00Z".to_string(),
        })
        .unwrap();
        db.plugin_data_put(
            "plugin-json",
            &Document {
                id: "conflict-doc".to_string(),
                rev: None,
                data: serde_json::json!({ "value": "local" }),
            },
        )
        .unwrap();
        db.plugin_data_put(
            "plugin-json",
            &Document {
                id: "same-doc".to_string(),
                rev: None,
                data: serde_json::json!({ "value": "same" }),
            },
        )
        .unwrap();

        let payload = serde_json::json!({
            "version": 1,
            "plugins": [
                {
                    "id": "plugin-json",
                    "documents": [
                        { "_id": "new-doc", "value": "remote" },
                        { "_id": "conflict-doc", "value": "remote" },
                        { "_id": "same-doc", "value": "same" }
                    ]
                }
            ]
        });

        let result = apply_webdav_plugin_data_payload_with_mode(
            &db,
            &payload,
            true,
            WebdavPluginDataRestoreMode::OverwriteConflicts,
            &[],
        )
        .unwrap();

        assert_eq!(result.remote_plugins, 1);
        assert_eq!(result.remote_documents, 3);
        assert_eq!(result.imported_documents, 1);
        assert_eq!(result.overwritten_documents, 1);
        assert_eq!(result.conflict_documents, 1);
        assert_eq!(result.unchanged_documents, 1);
        assert_eq!(result.skipped_documents, 1);
        assert_eq!(result.status, "applied");
        assert_eq!(
            db.plugin_data_get("plugin-json", "conflict-doc")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "value": "remote" })
        );
        assert_eq!(
            db.plugin_data_get("plugin-json", "same-doc")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "value": "same" })
        );
    }

    #[test]
    fn webdav_plugin_data_restore_selected_conflicts_only_replaces_chosen_docs() {
        let db = Database::in_memory().unwrap();
        db.save_plugin(&Plugin {
            id: "plugin-json".to_string(),
            name: "JSON".to_string(),
            version: "1.0.0".to_string(),
            path: "/tmp/plugin-json".to_string(),
            manifest: serde_json::from_value::<PluginManifest>(serde_json::json!({
                "name": "JSON",
                "version": "1.0.0",
                "features": []
            }))
            .unwrap(),
            enabled: true,
            created_at: "2026-06-04T08:00:00Z".to_string(),
            updated_at: "2026-06-04T08:00:00Z".to_string(),
        })
        .unwrap();
        db.plugin_data_put(
            "plugin-json",
            &Document {
                id: "selected-conflict".to_string(),
                rev: None,
                data: serde_json::json!({ "value": "local-selected" }),
            },
        )
        .unwrap();
        db.plugin_data_put(
            "plugin-json",
            &Document {
                id: "unselected-conflict".to_string(),
                rev: None,
                data: serde_json::json!({ "value": "local-unselected" }),
            },
        )
        .unwrap();

        let payload = serde_json::json!({
            "version": 1,
            "plugins": [
                {
                    "id": "plugin-json",
                    "documents": [
                        { "_id": "new-doc", "value": "remote-new" },
                        { "_id": "selected-conflict", "value": "remote-selected" },
                        { "_id": "unselected-conflict", "value": "remote-unselected" }
                    ]
                }
            ]
        });

        let result = apply_webdav_plugin_data_payload_with_mode(
            &db,
            &payload,
            true,
            WebdavPluginDataRestoreMode::OverwriteSelectedConflicts,
            &[WebdavPluginDataConflictSelection {
                plugin_id: "plugin-json".to_string(),
                doc_id: "selected-conflict".to_string(),
            }],
        )
        .unwrap();

        assert_eq!(result.imported_documents, 1);
        assert_eq!(result.conflict_documents, 2);
        assert_eq!(result.overwritten_documents, 1);
        assert_eq!(result.skipped_documents, 1);
        assert_eq!(result.status, "applied");
        assert_eq!(
            db.plugin_data_get("plugin-json", "selected-conflict")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "value": "remote-selected" })
        );
        assert_eq!(
            db.plugin_data_get("plugin-json", "unselected-conflict")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "value": "local-unselected" })
        );
    }

    #[test]
    fn ai_models_url_appends_models_to_openai_compatible_base() {
        assert_eq!(
            ai_models_url("https://api.example.com/v1").unwrap(),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            ai_models_url("http://127.0.0.1:11434/v1/").unwrap(),
            "http://127.0.0.1:11434/v1/models"
        );
    }

    #[test]
    fn ai_connection_config_rejects_disabled_or_incomplete_settings() {
        let disabled = ai_connection_config_from_settings(&serde_json::json!({
            "aiProvider": "disabled",
        }))
        .unwrap_err();
        assert!(disabled.contains("disabled"));

        let incomplete = ai_connection_config_from_settings(&serde_json::json!({
            "aiProvider": "compatible",
            "aiBaseUrl": "https://api.example.com/v1",
            "aiDefaultModel": "qwen-max",
            "aiApiKey": ""
        }))
        .unwrap_err();
        assert!(incomplete.contains("API key"));
    }

    #[test]
    fn network_proxy_settings_are_parsed_for_ai_and_webdav_requests() {
        let ai = ai_connection_config_from_settings(&serde_json::json!({
            "aiProvider": "compatible",
            "aiBaseUrl": "https://api.example.com/v1",
            "aiDefaultModel": "qwen-max",
            "aiApiKey": "sk-local",
            "proxyEnabled": true,
            "proxyUrl": " http://127.0.0.1:7890 "
        }))
        .unwrap();
        assert_eq!(ai.proxy_url.as_deref(), Some("http://127.0.0.1:7890"));

        let webdav = webdav_config_from_settings(&serde_json::json!({
            "webdavEnabled": true,
            "webdavUrl": "https://dav.example.com/remote.php/dav/files/me/",
            "webdavUsername": "harris",
            "webdavPassword": "secret",
            "webdavRemotePath": "/ATools",
            "proxyEnabled": true,
            "proxyUrl": "https://proxy.example.com:8443"
        }))
        .unwrap();
        assert_eq!(
            webdav.proxy_url.as_deref(),
            Some("https://proxy.example.com:8443")
        );

        let disabled_proxy = ai_connection_config_from_settings(&serde_json::json!({
            "aiProvider": "compatible",
            "aiBaseUrl": "https://api.example.com/v1",
            "aiDefaultModel": "qwen-max",
            "aiApiKey": "sk-local",
            "proxyEnabled": false,
            "proxyUrl": "http://127.0.0.1:7890"
        }))
        .unwrap();
        assert_eq!(disabled_proxy.proxy_url, None);

        let invalid_proxy = ai_connection_config_from_settings(&serde_json::json!({
            "aiProvider": "compatible",
            "aiBaseUrl": "https://api.example.com/v1",
            "aiDefaultModel": "qwen-max",
            "aiApiKey": "sk-local",
            "proxyEnabled": true,
            "proxyUrl": "ftp://127.0.0.1:7890"
        }))
        .unwrap_err();
        assert!(invalid_proxy.contains("proxy"));
    }

    #[tokio::test]
    async fn ai_connection_test_fetches_models_and_reports_selected_model() {
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        #[derive(Clone, Debug)]
        struct RecordedRequest {
            path: String,
            authorization: String,
        }

        let requests: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server_requests = requests.clone();

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let requests = server_requests.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0; 64 * 1024];
                    let bytes_read = socket.read(&mut buffer).await.unwrap();
                    let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                    let path = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or_default()
                        .to_string();
                    let authorization = request
                        .lines()
                        .find_map(|line| {
                            line.split_once(": ").and_then(|(name, value)| {
                                name.eq_ignore_ascii_case("authorization").then_some(value)
                            })
                        })
                        .unwrap_or_default()
                        .to_string();
                    requests.lock().unwrap().push(RecordedRequest {
                        path,
                        authorization,
                    });

                    let body =
                        r#"{"object":"list","data":[{"id":"qwen-max"},{"id":"other-model"}]}"#;
                    socket
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                                body.len(),
                                body
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                });
            }
        });

        let config = ai_connection_config_from_settings(&serde_json::json!({
            "aiProvider": "compatible",
            "aiBaseUrl": base_url,
            "aiDefaultModel": "qwen-max",
            "aiApiKey": "sk-local",
        }))
        .unwrap();
        let result = test_ai_connection_config(config).await.unwrap();

        assert_eq!(result.status, "ok");
        assert_eq!(result.provider, "compatible");
        assert_eq!(result.model, "qwen-max");
        assert_eq!(result.models_count, 2);
        assert!(result.model_found);
        assert!(result.duration_ms < 30_000);

        let requests = requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/models");
        assert_eq!(requests[0].authorization, "Bearer sk-local");
    }

    #[tokio::test]
    async fn plugin_market_catalog_fetches_and_normalizes_remote_json() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/catalog.json", listener.local_addr().unwrap());

        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = vec![0; 16 * 1024];
            let _ = socket.read(&mut buffer).await.unwrap();
            let body = r#"{
              "updatedAt": "2026-06-04T00:00:00Z",
              "plugins": [
                {
                  "id": "calculator",
                  "name": "Calculator",
                  "version": "1.2.3",
                  "description": "Math utilities",
                  "author": "ATools",
                  "downloadUrl": "https://market.example.com/calculator.zip",
                  "checksum": "sha256:9a1048629d74b6e3ecf2c886447c2ba773b31edeea98c3c40bbaac8fd99efacd",
                  "rating": 4.8,
                  "ratingCount": 128,
                  "downloads": 4096,
                  "updatedAt": "2026-06-04T12:00:00Z",
                  "publisher": "ATools Verified",
                  "publisherUrl": "https://market.example.com/publishers/atools",
                  "signature": "sig-base64",
                  "publicKey": "pub-base64",
                  "homepage": "https://market.example.com/calculator"
                },
                {
                  "name": "No download",
                  "version": "0.1.0"
                }
              ]
            }"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let catalog = super::fetch_plugin_market_catalog_from_url(&url)
            .await
            .expect("catalog");

        assert_eq!(catalog.source_url, url);
        assert_eq!(catalog.updated_at.as_deref(), Some("2026-06-04T00:00:00Z"));
        assert_eq!(catalog.plugins.len(), 1);
        let plugin = &catalog.plugins[0];
        assert_eq!(plugin.id, "calculator");
        assert_eq!(plugin.name, "Calculator");
        assert_eq!(plugin.version, "1.2.3");
        assert_eq!(plugin.description, "Math utilities");
        assert_eq!(plugin.author.as_deref(), Some("ATools"));
        assert_eq!(
            plugin.download_url,
            "https://market.example.com/calculator.zip"
        );
        assert_eq!(
            plugin.checksum.as_deref(),
            Some("sha256:9a1048629d74b6e3ecf2c886447c2ba773b31edeea98c3c40bbaac8fd99efacd")
        );
        assert_eq!(plugin.rating.as_deref(), Some("4.8"));
        assert_eq!(plugin.rating_count, Some(128));
        assert_eq!(plugin.downloads, Some(4096));
        assert_eq!(plugin.updated_at.as_deref(), Some("2026-06-04T12:00:00Z"));
        assert_eq!(plugin.publisher.as_deref(), Some("ATools Verified"));
        assert_eq!(
            plugin.publisher_url.as_deref(),
            Some("https://market.example.com/publishers/atools")
        );
        assert_eq!(plugin.signature.as_deref(), Some("sig-base64"));
        assert_eq!(plugin.public_key.as_deref(), Some("pub-base64"));
        assert_eq!(
            plugin.homepage.as_deref(),
            Some("https://market.example.com/calculator")
        );
    }
}

// --- Plugin utility commands (called from iframe via utools bridge) ---

#[tauri::command]
pub async fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn show_notification(app: AppHandle, message: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title("ATools")
        .body(&message)
        .show()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn system_get_path(name: String) -> String {
    match name.as_str() {
        "home" => dirs::home_dir(),
        "desktop" => dirs::desktop_dir(),
        "downloads" => dirs::download_dir(),
        "documents" => dirs::document_dir(),
        "pictures" => dirs::picture_dir(),
        "music" => dirs::audio_dir(),
        "videos" => dirs::video_dir(),
        "appData" | "appdata" => dirs::data_dir(),
        "temp" => Some(std::env::temp_dir()),
        _ => None,
    }
    .map(|p| p.to_string_lossy().to_string())
    .unwrap_or_default()
}

#[tauri::command]
pub async fn shell_open(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    match shell_open_target(&url) {
        ShellOpenTarget::Url(target) => app
            .opener()
            .open_url(target, None::<&str>)
            .map_err(|e| e.to_string()),
        ShellOpenTarget::Path(target) => app
            .opener()
            .open_path(target, None::<&str>)
            .map_err(|e| e.to_string()),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ShellOpenTarget<'a> {
    Url(&'a str),
    Path(&'a str),
}

pub(crate) fn shell_open_target(value: &str) -> ShellOpenTarget<'_> {
    let target = value.trim();
    if has_url_scheme(target) {
        ShellOpenTarget::Url(target)
    } else {
        ShellOpenTarget::Path(target)
    }
}

fn has_url_scheme(value: &str) -> bool {
    let Some(colon_index) = value.find(':') else {
        return false;
    };
    if colon_index < 2 {
        return false;
    }
    let scheme = &value[..colon_index];
    let mut chars = scheme.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

#[tauri::command]
pub fn shell_show_item_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        run_native_command("open", &macos_open_reveal_args(&path))
            .map(|_| ())
            .map_err(|error| native_command_error("shellShowItemInFolder", &error))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("shellShowItemInFolder unsupported on this platform".to_string())
    }
}

#[tauri::command]
pub fn screen_capture() -> Result<String, String> {
    if screen_capture_smoke_guard_enabled() {
        return Err(screen_capture_smoke_guard_error());
    }

    #[cfg(target_os = "macos")]
    {
        let path = std::env::temp_dir().join(format!(
            "atools-screen-{}.png",
            atools_core::utils::now_iso().replace([':', '.'], "-")
        ));
        let path_str = path.to_string_lossy().to_string();
        run_native_command("screencapture", &macos_screencapture_args(Some(&path_str))).map_err(
            |error| {
                if error.to_lowercase().contains("permission") {
                    native_command_error(
                        "screenCapture",
                        "macOS Screen Recording permission denied",
                    )
                } else {
                    native_command_error("screenCapture", &error)
                }
            },
        )?;
        screen_capture_file_to_data_url(&path)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("screenCapture unsupported on this platform".to_string())
    }
}

pub(crate) fn screen_capture_smoke_guard_error() -> String {
    "screenCapture skipped during desktop smoke to avoid interactive screenshot UI".to_string()
}

fn screen_capture_file_to_data_url(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| native_command_error("screenCapture", &error.to_string()))?;
    let _ = std::fs::remove_file(path);
    Ok(format!("data:image/png;base64,{}", encode_base64(&bytes)))
}

fn screen_capture_smoke_guard_enabled() -> bool {
    std::env::var("ATOOLS_DESKTOP_SMOKE")
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes")
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn read_current_browser_url() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = run_native_command(
            "osascript",
            &[
                "-e".to_string(),
                macos_current_browser_url_script().to_string(),
            ],
        )?;
        let trimmed = output.trim();
        if trimmed.is_empty() || trimmed == "missing value" {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_string()))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("readCurrentBrowserUrl unsupported on this platform".to_string())
    }
}

#[tauri::command]
pub fn read_current_folder_path() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = run_native_command(
            "osascript",
            &[
                "-e".to_string(),
                macos_current_folder_path_script().to_string(),
            ],
        )?;
        let trimmed = output.trim();
        if trimmed.is_empty() || trimmed == "missing value" {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_string()))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("readCurrentFolderPath unsupported on this platform".to_string())
    }
}

#[tauri::command]
pub fn read_frontmost_app_name() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = run_native_command(
            "osascript",
            &[
                "-e".to_string(),
                macos_frontmost_app_name_script().to_string(),
            ],
        )?;
        let trimmed = output.trim();
        if trimmed.is_empty() || trimmed == "missing value" {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_string()))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("readFrontmostAppName unsupported on this platform".to_string())
    }
}

#[tauri::command]
pub fn copy_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if !std::path::Path::new(&path).exists() {
            return Err(format!("copyFile failed: file does not exist: {}", path));
        }
        let script = format!(
            "set the clipboard to (POSIX file {})",
            applescript_string(&path)
        );
        run_native_command("osascript", &["-e".to_string(), script])
            .map(|_| ())
            .map_err(|error| native_command_error("copyFile", &error))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("copyFile unsupported on this platform".to_string())
    }
}

#[tauri::command]
pub fn copy_image(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if !std::path::Path::new(&path).exists() {
            return Err(format!(
                "copyImage failed: image file does not exist: {}",
                path
            ));
        }
        let script = format!(
            "set the clipboard to (read (POSIX file {}) as TIFF picture)",
            applescript_string(&path)
        );
        run_native_command("osascript", &["-e".to_string(), script])
            .map(|_| ())
            .map_err(|error| native_command_error("copyImage", &error))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("copyImage unsupported on this platform".to_string())
    }
}

#[tauri::command]
pub fn get_copyed_files() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"
set clipboardItems to the clipboard as list
set output to {}
repeat with itemRef in clipboardItems
  try
    set end of output to POSIX path of itemRef
  end try
end repeat
set AppleScript's text item delimiters to linefeed
return output as text
"#;
        let output = run_native_command("osascript", &["-e".to_string(), script.to_string()])
            .map_err(|error| native_command_error("getCopyedFiles", &error))?;
        Ok(output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(String::from)
            .collect())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("getCopyedFiles unsupported on this platform".to_string())
    }
}

#[tauri::command]
pub fn get_plugin_data_item(
    state: tauri::State<AppState>,
    plugin_id: String,
    doc_id: String,
) -> Result<Option<Document>, String> {
    state
        .db
        .plugin_data_get(&plugin_id, &doc_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn put_plugin_data_bulk(
    state: tauri::State<AppState>,
    plugin_id: String,
    docs: Vec<Document>,
) -> Result<(), String> {
    state
        .db
        .plugin_data_bulk(&plugin_id, &docs)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn put_plugin_data_attachment(
    state: tauri::State<AppState>,
    plugin_id: String,
    doc_id: String,
    name: String,
    data: String,
    content_type: Option<String>,
) -> Result<(), String> {
    let decoded = decode_base64(&data).unwrap_or_else(|| data.into_bytes());
    state
        .db
        .put_attachment(
            &plugin_id,
            &doc_id,
            &name,
            &decoded,
            content_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_plugin_data_attachment(
    state: tauri::State<AppState>,
    plugin_id: String,
    doc_id: String,
    name: String,
) -> Result<Option<String>, String> {
    state
        .db
        .get_attachment(&plugin_id, &doc_id, &name)
        .map(|attachment| attachment.map(|(data, _)| encode_base64(&data)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_agent_tools(state: tauri::State<AppState>) -> Result<Vec<ToolDefinition>, String> {
    state.db.list_agent_tools().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_agent_tool_enabled(
    state: tauri::State<AppState>,
    name: String,
    enabled: bool,
) -> Result<bool, String> {
    state
        .db
        .set_agent_tool_enabled(&name, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn grant_agent_tool(
    state: tauri::State<AppState>,
    client_id: String,
    tool_name: String,
) -> Result<(), String> {
    state
        .db
        .grant_agent_tool(&client_id, &tool_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn revoke_agent_tool(
    state: tauri::State<AppState>,
    client_id: String,
    tool_name: String,
) -> Result<bool, String> {
    state
        .db
        .revoke_agent_tool(&client_id, &tool_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_agent_tool_grants(
    state: tauri::State<AppState>,
) -> Result<Vec<AgentToolGrant>, String> {
    state.db.list_agent_tool_grants().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_agent_scope_policies(
    state: tauri::State<AppState>,
) -> Result<Vec<crate::agent_tools::AgentScopePolicy>, String> {
    crate::agent_tools::list_agent_scope_policies(&state.db)
}

#[tauri::command]
pub fn set_agent_scope_policy(
    state: tauri::State<AppState>,
    scope: String,
    decision: String,
) -> Result<Vec<crate::agent_tools::AgentScopePolicy>, String> {
    crate::agent_tools::set_agent_scope_policy(&state.db, &scope, &decision)
}

#[tauri::command]
pub fn list_pending_agent_requests(state: tauri::State<AppState>) -> Vec<PendingAgentToolRequest> {
    state
        .pending_agent_requests
        .lock()
        .values()
        .cloned()
        .collect()
}

#[tauri::command]
pub fn dismiss_pending_agent_request(state: tauri::State<AppState>, request_id: String) -> bool {
    let pending = state.pending_agent_requests.lock().remove(&request_id);
    if let Some(run_id) = pending
        .as_ref()
        .and_then(|request| request.run_id.as_deref())
    {
        if let Ok(Some(mut run)) = state.db.get_task_run(run_id) {
            if !run.status.is_terminal() {
                run.summary = Some("Permission request was dismissed".to_string());
                run.transition(TaskRunStatus::Cancelled);
                let _ = state.db.upsert_task_run(&run);
            }
        }
    }
    pending.is_some()
}

#[tauri::command]
pub async fn call_agent_tool(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    arguments: serde_json::Value,
    client_id: Option<String>,
    confirmed: Option<bool>,
    run_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let result = crate::agent_tools::resume_tool_with_audit(
        &app,
        &state.db,
        client_id.as_deref().unwrap_or("atools-ui"),
        &name,
        arguments,
        confirmed.unwrap_or(false),
        run_id.as_deref(),
    )
    .await;

    if result.is_error {
        Err(result.structured_content.to_string())
    } else {
        Ok(result.structured_content)
    }
}

#[tauri::command]
pub fn list_task_runs(
    state: tauri::State<AppState>,
    limit: Option<usize>,
) -> Result<Vec<TaskRun>, String> {
    state
        .db
        .list_task_runs(limit.unwrap_or(100))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_task_run(state: tauri::State<AppState>, id: String) -> Result<Option<TaskRun>, String> {
    state
        .db
        .get_task_run(&id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_task_run(state: tauri::State<AppState>, id: String) -> Result<TaskRun, String> {
    let mut run = state
        .db
        .get_task_run(&id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("TaskRun not found: {id}"))?;
    if !matches!(
        run.status,
        TaskRunStatus::Created | TaskRunStatus::AwaitingPermission
    ) {
        return Err(format!(
            "TaskRun {} cannot be cancelled from status {}",
            run.id,
            run.status.as_str()
        ));
    }
    state
        .pending_agent_requests
        .lock()
        .retain(|_, request| request.run_id.as_deref() != Some(run.id.as_str()));
    run.summary = Some("TaskRun was cancelled by the user".to_string());
    run.transition(TaskRunStatus::Cancelled);
    state
        .db
        .upsert_task_run(&run)
        .map_err(|error| error.to_string())?;
    Ok(run)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDefinitionInput {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    #[serde(default)]
    pub triggers: Vec<String>,
    pub capability_ids: Vec<String>,
    pub steps: Vec<SkillStep>,
    pub permission_scopes: Vec<String>,
    pub failure_modes: Vec<SkillFailureMode>,
    pub validation: Vec<SkillValidationRule>,
    pub result_suggestions: Vec<SkillResultSuggestion>,
    #[serde(default = "default_skill_source")]
    pub source: String,
}

fn default_skill_source() -> String {
    "local".to_string()
}

fn skill_from_input(input: SkillDefinitionInput) -> Result<SkillDefinition, String> {
    SkillDefinition::new(
        input.id,
        input.name,
        input.description,
        input.version,
        input.triggers,
        input.capability_ids,
        input.steps,
        input.permission_scopes,
        input.failure_modes,
        input.validation,
        input.result_suggestions,
        input.source,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_skills(
    state: tauri::State<AppState>,
    include_disabled: Option<bool>,
    limit: Option<usize>,
) -> Result<Vec<SkillDefinition>, String> {
    state
        .db
        .list_skills(include_disabled.unwrap_or(true), limit.unwrap_or(500))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_skill(
    state: tauri::State<AppState>,
    input: SkillDefinitionInput,
) -> Result<SkillDefinition, String> {
    if state
        .db
        .get_skill(&input.id)
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err(format!("Skill already exists: {}", input.id));
    }
    let skill = skill_from_input(input)?;
    state
        .db
        .upsert_skill(&skill)
        .map_err(|error| error.to_string())?;
    Ok(skill)
}

#[tauri::command]
pub fn update_skill(
    state: tauri::State<AppState>,
    id: String,
    input: SkillDefinitionInput,
) -> Result<SkillDefinition, String> {
    let previous = state
        .db
        .get_skill(&id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Skill not found: {id}"))?;
    if input.id != id {
        return Err("Skill id cannot be changed during update".to_string());
    }
    let mut skill = skill_from_input(input)?;
    skill.enabled = previous.enabled;
    skill.created_at = previous.created_at;
    state
        .db
        .upsert_skill(&skill)
        .map_err(|error| error.to_string())?;
    Ok(skill)
}

#[tauri::command]
pub fn set_skill_enabled(
    state: tauri::State<AppState>,
    id: String,
    enabled: bool,
) -> Result<bool, String> {
    state
        .db
        .set_skill_enabled(&id, enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_skill(state: tauri::State<AppState>, id: String) -> Result<bool, String> {
    state
        .db
        .delete_skill(&id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_skills_json(state: tauri::State<AppState>) -> Result<String, String> {
    state
        .db
        .export_skills_json()
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItemInput {
    #[serde(rename = "type")]
    pub kind: MemoryType,
    #[serde(default)]
    pub scope: MemoryScope,
    pub content: serde_json::Value,
    #[serde(default)]
    pub source_run_id: Option<String>,
    #[serde(default = "default_memory_confidence")]
    pub confidence: f64,
    pub approval: MemoryApproval,
    #[serde(default)]
    pub expires_at: Option<String>,
}

fn default_memory_confidence() -> f64 {
    1.0
}

#[tauri::command]
pub fn list_memory_items(
    state: tauri::State<AppState>,
    include_disabled: Option<bool>,
    limit: Option<usize>,
) -> Result<Vec<MemoryItem>, String> {
    state
        .db
        .list_memory_items(include_disabled.unwrap_or(true), limit.unwrap_or(500))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_memory_item(
    state: tauri::State<AppState>,
    input: MemoryItemInput,
) -> Result<MemoryItem, String> {
    let item = MemoryItem::new(
        input.kind,
        input.scope,
        input.content,
        input.source_run_id,
        input.confidence,
        input.approval,
        input.expires_at,
    )
    .map_err(|error| error.to_string())?;
    state
        .db
        .upsert_memory_item(&item)
        .map_err(|error| error.to_string())?;
    Ok(item)
}

#[tauri::command]
pub fn update_memory_item(
    state: tauri::State<AppState>,
    id: String,
    input: MemoryItemInput,
) -> Result<MemoryItem, String> {
    let previous = state
        .db
        .get_memory_item(&id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Memory item not found: {id}"))?;
    let mut item = MemoryItem::new(
        input.kind,
        input.scope,
        input.content,
        input.source_run_id,
        input.confidence,
        input.approval,
        input.expires_at,
    )
    .map_err(|error| error.to_string())?;
    item.id = previous.id;
    item.enabled = previous.enabled;
    item.use_count = previous.use_count;
    item.success_count = previous.success_count;
    item.last_used_at = previous.last_used_at;
    item.created_at = previous.created_at;
    state
        .db
        .upsert_memory_item(&item)
        .map_err(|error| error.to_string())?;
    Ok(item)
}

#[tauri::command]
pub fn set_memory_item_enabled(
    state: tauri::State<AppState>,
    id: String,
    enabled: bool,
) -> Result<bool, String> {
    state
        .db
        .set_memory_item_enabled(&id, enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_memory_item(state: tauri::State<AppState>, id: String) -> Result<bool, String> {
    state
        .db
        .delete_memory_item(&id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_memory_items(state: tauri::State<AppState>) -> Result<usize, String> {
    state
        .db
        .clear_memory_items()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_memory_items_json(state: tauri::State<AppState>) -> Result<String, String> {
    state
        .db
        .export_memory_items_json()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_audit_entries(
    state: tauri::State<AppState>,
    limit: Option<usize>,
) -> Result<Vec<AuditLogEntry>, String> {
    state
        .db
        .list_audit_entries(limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn query_audit_entries(
    state: tauri::State<AppState>,
    query: AuditLogQuery,
) -> Result<Vec<AuditLogEntry>, String> {
    state
        .db
        .query_audit_entries(&query)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn query_audit_entries_page(
    state: tauri::State<AppState>,
    query: AuditLogQuery,
) -> Result<AuditLogPage, String> {
    state
        .db
        .query_audit_entries_page(&query)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_audit_entries(state: tauri::State<AppState>) -> Result<usize, String> {
    state.db.clear_audit_entries().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn prune_audit_entries(
    state: tauri::State<AppState>,
    retention_days: Option<u64>,
    keep_latest: Option<usize>,
) -> Result<usize, String> {
    let older_than = match retention_days {
        Some(0) => return Err("retentionDays must be at least 1".to_string()),
        Some(days) => Some(atools_core::utils::iso_days_ago(days)),
        None => None,
    };
    state
        .db
        .prune_audit_entries(older_than.as_deref(), keep_latest)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_audit_entries_jsonl(
    state: tauri::State<AppState>,
    limit: Option<usize>,
) -> Result<String, String> {
    state
        .db
        .export_audit_entries_jsonl(limit.unwrap_or(1000))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_audit_entries_jsonl_filtered(
    state: tauri::State<AppState>,
    query: AuditLogQuery,
) -> Result<String, String> {
    state
        .db
        .export_audit_entries_jsonl_filtered(&query)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditArchiveResult {
    pub path: String,
    pub count: usize,
}

#[tauri::command]
pub fn archive_audit_entries_jsonl(
    state: tauri::State<AppState>,
    path: String,
    limit: Option<usize>,
    confirmed: bool,
) -> Result<AuditArchiveResult, String> {
    write_audit_archive_file(
        &state.db,
        std::path::Path::new(&path),
        limit.unwrap_or(1000),
        confirmed,
    )
}

pub(crate) fn write_audit_archive_file(
    db: &Database,
    target_path: &std::path::Path,
    limit: usize,
    confirmed: bool,
) -> Result<AuditArchiveResult, String> {
    if !confirmed {
        return Err("Audit archive requires explicit confirmation".to_string());
    }
    if target_path.as_os_str().is_empty() {
        return Err("Audit archive target path is required".to_string());
    }

    let jsonl = db
        .export_audit_entries_jsonl(limit.clamp(1, 50_000))
        .map_err(|error| error.to_string())?;
    let count = jsonl.lines().filter(|line| !line.trim().is_empty()).count();

    if let Some(parent) = target_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create audit archive directory {}: {error}",
                parent.display()
            )
        })?;
    }

    std::fs::write(target_path, jsonl.as_bytes()).map_err(|error| {
        format!(
            "Failed to write audit archive {}: {error}",
            target_path.display()
        )
    })?;

    Ok(AuditArchiveResult {
        path: target_path.to_string_lossy().to_string(),
        count,
    })
}

#[tauri::command]
pub fn get_permission_mode(state: tauri::State<AppState>) -> Result<String, String> {
    Ok(state
        .db
        .get_setting("agent.permission_mode")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| {
            crate::agent_tools::permission_mode_to_str(PermissionMode::Conservative).to_string()
        }))
}

#[tauri::command]
pub fn set_permission_mode(state: tauri::State<AppState>, mode: String) -> Result<(), String> {
    let normalized = crate::agent_tools::permission_mode_to_str(
        crate::agent_tools::permission_mode_from_str(&mode),
    );
    state
        .db
        .set_setting("agent.permission_mode", normalized)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_mcp_status(state: tauri::State<AppState>) -> Option<crate::mcp_server::McpServerStatus> {
    state.mcp_status.lock().clone()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct McpClientConfigInstallResult {
    pub target_path: String,
    pub backup_path: Option<String>,
    pub created: bool,
    pub changed: bool,
    pub server_name: String,
}

#[tauri::command]
pub fn install_mcp_client_config(
    target_path: String,
    config: serde_json::Value,
    server_name: Option<String>,
    confirmed: bool,
) -> Result<McpClientConfigInstallResult, String> {
    let server_name = normalized_mcp_server_name(server_name.as_deref());
    write_mcp_client_config_file(
        std::path::Path::new(&target_path),
        config,
        &server_name,
        confirmed,
    )
}

pub(crate) fn merge_mcp_client_config(
    existing: serde_json::Value,
    desired: serde_json::Value,
    server_name: &str,
) -> Result<serde_json::Value, String> {
    let server_name = normalized_mcp_server_name(Some(server_name));
    let desired_server = desired
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
        .and_then(|servers| servers.get(&server_name))
        .cloned()
        .ok_or_else(|| format!("MCP client config must include mcpServers.{server_name}"))?;

    let mut merged = match existing {
        serde_json::Value::Null => serde_json::Map::new(),
        serde_json::Value::Object(map) => map,
        _ => return Err("Existing MCP client config must be a JSON object".to_string()),
    };

    let servers_value = merged
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let servers = servers_value
        .as_object_mut()
        .ok_or_else(|| "Existing mcpServers must be a JSON object".to_string())?;
    servers.insert(server_name, desired_server);

    Ok(serde_json::Value::Object(merged))
}

pub(crate) fn write_mcp_client_config_file(
    target_path: &std::path::Path,
    config: serde_json::Value,
    server_name: &str,
    confirmed: bool,
) -> Result<McpClientConfigInstallResult, String> {
    if !confirmed {
        return Err("MCP client config install requires explicit confirmation".to_string());
    }
    if target_path.as_os_str().is_empty() {
        return Err("MCP client config target path is required".to_string());
    }

    let server_name = normalized_mcp_server_name(Some(server_name));
    let existed = target_path.exists();
    let existing_text = if existed {
        Some(std::fs::read_to_string(target_path).map_err(|error| {
            format!(
                "Failed to read MCP client config {}: {error}",
                target_path.display()
            )
        })?)
    } else {
        None
    };
    let existing = match existing_text.as_deref().map(str::trim) {
        Some("") | None => serde_json::json!({}),
        Some(text) => serde_json::from_str::<serde_json::Value>(text).map_err(|error| {
            format!(
                "Existing MCP client config is not valid JSON at {}: {error}",
                target_path.display()
            )
        })?,
    };
    let merged = merge_mcp_client_config(existing, config, &server_name)?;
    let output = serde_json::to_string_pretty(&merged).map_err(|error| error.to_string())?;
    let current = existing_text.unwrap_or_default();
    let changed = current.trim_end() != output;
    let backup_path = if existed && changed {
        let backup = target_path.with_file_name(format!(
            "{}.atools-backup-{}",
            target_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("mcp-client-config.json"),
            atools_core::utils::generate_rev()
        ));
        std::fs::copy(target_path, &backup).map_err(|error| {
            format!(
                "Failed to back up MCP client config {}: {error}",
                target_path.display()
            )
        })?;
        Some(backup.to_string_lossy().to_string())
    } else {
        None
    };

    if changed {
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create MCP client config directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        std::fs::write(target_path, format!("{output}\n")).map_err(|error| {
            format!(
                "Failed to write MCP client config {}: {error}",
                target_path.display()
            )
        })?;
    }

    Ok(McpClientConfigInstallResult {
        target_path: target_path.to_string_lossy().to_string(),
        backup_path,
        created: !existed,
        changed,
        server_name,
    })
}

fn normalized_mcp_server_name(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("atools")
        .to_string()
}

#[tauri::command]
pub fn get_runtime_diagnostics(
    state: tauri::State<AppState>,
) -> Result<RuntimeDiagnostics, String> {
    let mcp_status = state.mcp_status.lock().clone();
    let active_plugin = state.active_plugin.lock().clone();
    let runtime_events = state.runtime_events.lock().clone();
    runtime_diagnostics_snapshot(
        &state.config,
        &state.db,
        mcp_status,
        active_plugin,
        &runtime_events,
    )
}

#[tauri::command]
pub fn list_crash_logs(
    state: tauri::State<AppState>,
    limit: Option<usize>,
) -> Result<Vec<crate::crash::CrashLogEntry>, String> {
    crate::crash::list_crash_logs(&state.config, limit.unwrap_or(20).clamp(1, 200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_crash_log(state: tauri::State<AppState>) -> Result<String, String> {
    crate::crash::export_crash_log(&state.config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_crash_log(state: tauri::State<AppState>) -> Result<usize, String> {
    crate::crash::clear_crash_log(&state.config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_webdav_now(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<WebdavSyncSummary, String> {
    let config = webdav_config_from_settings(&settings)?;
    let snapshot = webdav_snapshot_from_settings(&state.db, settings)?;
    let summary = crate::webdav::sync_webdav_snapshot(config, snapshot).await?;
    state.record_runtime_event(
        "info",
        format!(
            "WebDAV sync uploaded {} files ({} bytes)",
            summary.files_uploaded.len(),
            summary.uploaded_bytes
        ),
    );
    Ok(summary)
}

#[tauri::command]
pub async fn preview_webdav_backup(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<WebdavBackupPreview, String> {
    let config = webdav_config_from_settings(&settings)?;
    let preview = crate::webdav::preview_webdav_backup(config).await?;
    state.record_runtime_event(
        "info",
        format!("WebDAV preview read {} files", preview.files.len()),
    );
    Ok(preview)
}

#[tauri::command]
pub async fn plan_webdav_restore(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<WebdavRestorePlan, String> {
    let config = webdav_config_from_settings(&settings)?;
    let local = webdav_restore_local_snapshot(&state.db, settings)?;
    let plan = crate::webdav::plan_webdav_restore(config, local).await?;
    state.record_runtime_event(
        "info",
        format!("WebDAV restore plan prepared {} items", plan.items.len()),
    );
    Ok(plan)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AiConnectionConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct AiConnectionTestResult {
    pub status: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub models_count: usize,
    pub model_found: bool,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn test_ai_connection(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<AiConnectionTestResult, String> {
    let config = ai_connection_config_from_settings(&settings)?;
    let result = test_ai_connection_config(config).await?;
    state.record_runtime_event(
        "info",
        format!(
            "AI connection tested provider={} model_found={}",
            result.provider, result.model_found
        ),
    );
    Ok(result)
}

pub(crate) async fn test_ai_connection_config(
    config: AiConnectionConfig,
) -> Result<AiConnectionTestResult, String> {
    let started = std::time::Instant::now();
    let url = ai_models_url(&config.base_url)?;
    let mut client_builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15));
    if let Some(proxy_url) = &config.proxy_url {
        client_builder = client_builder.proxy(
            reqwest::Proxy::all(proxy_url)
                .map_err(|error| format!("Invalid network proxy URL: {error}"))?,
        );
    }
    let client = client_builder
        .build()
        .map_err(|error| format!("Failed to create AI client: {error}"))?;
    let mut request = client.get(&url);
    if !config.api_key.trim().is_empty() {
        request = request.bearer_auth(config.api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("AI model list request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "AI model list request failed: HTTP {}",
            status.as_u16()
        ));
    }
    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("AI model list JSON failed: {error}"))?;
    let models = ai_model_ids(&payload);

    Ok(AiConnectionTestResult {
        status: "ok".to_string(),
        provider: config.provider,
        base_url: config.base_url,
        model_found: models.iter().any(|model| model == &config.model),
        model: config.model,
        models_count: models.len(),
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub(crate) fn ai_connection_config_from_settings(
    settings: &serde_json::Value,
) -> Result<AiConnectionConfig, String> {
    let provider = settings_string(settings, "aiProvider");
    if provider == "disabled" || provider.is_empty() {
        return Err("AI provider is disabled".to_string());
    }
    if !matches!(provider.as_str(), "openai" | "compatible" | "local") {
        return Err(format!("Unsupported AI provider: {provider}"));
    }
    let base_url = settings_string(settings, "aiBaseUrl");
    if base_url.is_empty() {
        return Err("AI Base URL is required".to_string());
    }
    let model = settings_string(settings, "aiDefaultModel");
    if model.is_empty() {
        return Err("AI default model is required".to_string());
    }
    let api_key = settings_string(settings, "aiApiKey");
    if provider != "local" && api_key.is_empty() {
        return Err("AI API key is required".to_string());
    }

    Ok(AiConnectionConfig {
        provider,
        base_url,
        model,
        api_key,
        proxy_url: network_proxy_url_from_settings(settings)?,
    })
}

pub(crate) fn network_proxy_url_from_settings(
    settings: &serde_json::Value,
) -> Result<Option<String>, String> {
    if !settings
        .get("proxyEnabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(None);
    }
    let proxy_url = settings_string(settings, "proxyUrl");
    if proxy_url.is_empty() {
        return Err("Network proxy URL is required when proxy is enabled".to_string());
    }
    let url = reqwest::Url::parse(&proxy_url)
        .map_err(|error| format!("Invalid network proxy URL: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Network proxy URL must use http or https".to_string());
    }
    Ok(Some(proxy_url))
}

pub(crate) fn ai_models_url(base_url: &str) -> Result<String, String> {
    let mut url =
        reqwest::Url::parse(base_url.trim()).map_err(|error| format!("Invalid AI URL: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("AI Base URL must use http or https".to_string());
    }
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "AI Base URL cannot be used as a base path".to_string())?;
        segments.pop_if_empty();
        segments.push("models");
    }
    Ok(url.to_string())
}

fn ai_model_ids(payload: &serde_json::Value) -> Vec<String> {
    payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(serde_json::Value::as_str))
        .map(ToString::to_string)
        .collect()
}

#[tauri::command]
pub async fn restore_webdav_settings(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
    confirmed: bool,
) -> Result<WebdavSettingsRestoreResult, String> {
    let config = webdav_config_from_settings(&settings)?;
    let result = crate::webdav::restore_webdav_settings(config, settings, confirmed).await?;
    state.record_runtime_event(
        "info",
        format!(
            "WebDAV settings restore prepared {} keys ({} skipped)",
            result.applied_keys.len(),
            result.skipped_keys.len()
        ),
    );
    Ok(result)
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct WebdavClipboardImportSummary {
    pub imported_entries: usize,
    pub skipped_entries: usize,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct WebdavClipboardRestoreResult {
    pub status: String,
    pub remote_path: String,
    pub manifest_kind: Option<String>,
    pub exported_at: Option<String>,
    pub remote_entries: usize,
    pub imported_entries: usize,
    pub skipped_entries: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct WebdavPluginDataRestoreResult {
    pub status: String,
    pub remote_path: String,
    pub manifest_kind: Option<String>,
    pub exported_at: Option<String>,
    pub remote_plugins: usize,
    pub remote_documents: usize,
    pub imported_documents: usize,
    pub overwritten_documents: usize,
    pub skipped_documents: usize,
    pub conflict_documents: usize,
    pub unchanged_documents: usize,
    pub missing_plugins: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebdavPluginDataRestoreMode {
    AppendMissing,
    OverwriteConflicts,
    OverwriteSelectedConflicts,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
pub struct WebdavPluginDataConflictSelection {
    pub plugin_id: String,
    pub doc_id: String,
}

#[tauri::command]
pub async fn restore_webdav_clipboard_history(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
    confirmed: bool,
) -> Result<WebdavClipboardRestoreResult, String> {
    let config = webdav_config_from_settings(&settings)?;
    let plan = crate::webdav::restore_webdav_clipboard_history(config, confirmed).await?;
    let import = record_webdav_clipboard_entries(&state.db, &plan.entries)?;
    let result = webdav_clipboard_restore_result(plan, import);
    state.record_runtime_event(
        "info",
        format!(
            "WebDAV clipboard restore imported {} entries ({} skipped)",
            result.imported_entries, result.skipped_entries
        ),
    );
    Ok(result)
}

#[tauri::command]
pub async fn restore_webdav_plugin_data(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
    confirmed: bool,
    mode: Option<String>,
    selected_conflict_documents: Option<Vec<WebdavPluginDataConflictSelection>>,
) -> Result<WebdavPluginDataRestoreResult, String> {
    let config = webdav_config_from_settings(&settings)?;
    let plan = crate::webdav::restore_webdav_plugin_data(config, confirmed).await?;
    let mode = webdav_plugin_data_restore_mode(mode.as_deref())?;
    let selected_conflict_documents = selected_conflict_documents.unwrap_or_default();
    let result = apply_webdav_plugin_data_restore_plan(
        &state.db,
        plan,
        true,
        mode,
        &selected_conflict_documents,
    )?;
    state.record_runtime_event(
        "info",
        format!(
            "WebDAV plugin data restore imported {} docs, overwrote {} docs ({} skipped, {} conflicts)",
            result.imported_documents,
            result.overwritten_documents,
            result.skipped_documents,
            result.conflict_documents
        ),
    );
    Ok(result)
}

pub fn runtime_diagnostics_snapshot(
    config: &AppConfig,
    db: &Database,
    mcp_status: Option<crate::mcp_server::McpServerStatus>,
    active_plugin: Option<String>,
    events: &[RuntimeEvent],
) -> Result<RuntimeDiagnostics, String> {
    let plugins = db.list_plugins().map_err(|e| e.to_string())?;
    let features = db.all_features().map_err(|e| e.to_string())?;
    let tools = db.list_agent_tools().map_err(|e| e.to_string())?;
    let enabled_tools = tools.iter().filter(|tool| tool.enabled).count();
    let mut recent_events = events.iter().rev().take(20).cloned().collect::<Vec<_>>();
    recent_events.reverse();

    Ok(RuntimeDiagnostics {
        runtime: "Tauri WebView".to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        debug: cfg!(debug_assertions),
        base_dir: config.base_dir().to_string_lossy().to_string(),
        db_path: config.db_path().to_string_lossy().to_string(),
        plugins_dir: config.plugins_dir().to_string_lossy().to_string(),
        plugin_count: plugins.len(),
        feature_count: features.len(),
        agent_tool_count: tools.len(),
        enabled_agent_tool_count: enabled_tools,
        mcp_enabled: mcp_status.as_ref().is_some_and(|status| status.enabled),
        mcp_bind: mcp_status.map(|status| status.bind),
        active_plugin,
        recent_events,
    })
}

fn webdav_config_from_settings(settings: &serde_json::Value) -> Result<WebdavSyncConfig, String> {
    if !settings
        .get("webdavEnabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Err("WebDAV sync is disabled".to_string());
    }
    let config = WebdavSyncConfig {
        url: settings_string(settings, "webdavUrl"),
        username: settings_string(settings, "webdavUsername"),
        password: settings_string(settings, "webdavPassword"),
        remote_path: settings_string(settings, "webdavRemotePath"),
        proxy_url: network_proxy_url_from_settings(settings)?,
    };
    crate::webdav::validate_webdav_config(&config)?;
    Ok(config)
}

fn webdav_snapshot_from_settings(
    db: &Database,
    settings: serde_json::Value,
) -> Result<WebdavSyncSnapshot, String> {
    let scopes = WebdavScopeSelection {
        settings: settings
            .get("webdavSyncSettings")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        plugins: settings
            .get("webdavSyncPlugins")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        clipboard: settings
            .get("webdavSyncClipboard")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    };
    Ok(WebdavSyncSnapshot {
        settings,
        plugin_data: webdav_plugin_data_snapshot(db)?,
        clipboard_history: webdav_clipboard_snapshot(db)?,
        scopes,
    })
}

fn webdav_plugin_data_snapshot(db: &Database) -> Result<serde_json::Value, String> {
    let plugins = db.list_plugins().map_err(|error| error.to_string())?;
    let mut plugin_snapshots = Vec::new();
    for plugin in plugins {
        let documents = db
            .plugin_data_all(&plugin.id)
            .map_err(|error| error.to_string())?;
        plugin_snapshots.push(serde_json::json!({
            "id": plugin.id,
            "name": plugin.name,
            "version": plugin.version,
            "enabled": plugin.enabled,
            "updatedAt": plugin.updated_at,
            "documentCount": documents.len(),
            "documents": documents,
        }));
    }
    Ok(serde_json::json!({
        "version": 1,
        "exportedAt": atools_core::utils::now_iso(),
        "count": plugin_snapshots.len(),
        "plugins": plugin_snapshots,
    }))
}

fn webdav_clipboard_snapshot(db: &Database) -> Result<serde_json::Value, String> {
    let exported = db
        .export_clipboard_history_json(1000)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&exported).map_err(|error| error.to_string())
}

fn webdav_restore_local_snapshot(
    db: &Database,
    settings: serde_json::Value,
) -> Result<WebdavRestoreLocalSnapshot, String> {
    Ok(WebdavRestoreLocalSnapshot {
        settings,
        plugin_data: webdav_plugin_data_snapshot(db)?,
        clipboard_history: webdav_clipboard_snapshot(db)?,
    })
}

pub(crate) fn record_webdav_clipboard_entries(
    db: &Database,
    entries: &[WebdavClipboardRestoreEntry],
) -> Result<WebdavClipboardImportSummary, String> {
    let mut imported_entries = 0;
    let mut skipped_entries = 0;
    for entry in entries {
        let text = entry.text.trim();
        if text.is_empty() {
            skipped_entries += 1;
            continue;
        }
        let existing = db
            .search_clipboard_history(text, 500)
            .map_err(|error| error.to_string())?
            .into_iter()
            .any(|item| item.text == text);
        if existing {
            skipped_entries += 1;
            continue;
        }
        db.record_clipboard_text(text, &entry.copied_at)
            .map_err(|error| error.to_string())?;
        imported_entries += 1;
    }
    Ok(WebdavClipboardImportSummary {
        imported_entries,
        skipped_entries,
    })
}

fn webdav_clipboard_restore_result(
    plan: WebdavClipboardRestorePlan,
    import: WebdavClipboardImportSummary,
) -> WebdavClipboardRestoreResult {
    WebdavClipboardRestoreResult {
        status: if import.imported_entries == 0 {
            "unchanged".to_string()
        } else {
            "imported".to_string()
        },
        remote_path: plan.remote_path,
        manifest_kind: plan.manifest_kind,
        exported_at: plan.exported_at,
        remote_entries: plan.remote_entries,
        imported_entries: import.imported_entries,
        skipped_entries: plan.skipped_entries + import.skipped_entries,
        duration_ms: plan.duration_ms,
    }
}

pub(crate) fn apply_webdav_plugin_data_payload_with_mode(
    db: &Database,
    payload: &serde_json::Value,
    confirmed: bool,
    mode: WebdavPluginDataRestoreMode,
    selected_conflict_documents: &[WebdavPluginDataConflictSelection],
) -> Result<WebdavPluginDataRestoreResult, String> {
    if !confirmed {
        return Err("WebDAV plugin data restore requires explicit confirmation".to_string());
    }
    let selected_conflicts = webdav_plugin_data_selected_conflict_set(selected_conflict_documents);
    if mode == WebdavPluginDataRestoreMode::OverwriteSelectedConflicts
        && selected_conflicts.is_empty()
    {
        return Err(
            "WebDAV selected plugin data conflict restore requires at least one selected document"
                .to_string(),
        );
    }

    let mut result = WebdavPluginDataRestoreResult {
        status: "unchanged".to_string(),
        remote_path: String::new(),
        manifest_kind: None,
        exported_at: None,
        remote_plugins: 0,
        remote_documents: 0,
        imported_documents: 0,
        overwritten_documents: 0,
        skipped_documents: 0,
        conflict_documents: 0,
        unchanged_documents: 0,
        missing_plugins: 0,
        duration_ms: 0,
    };

    let installed_plugins = db.list_plugins().map_err(|error| error.to_string())?;
    let installed_ids = installed_plugins
        .iter()
        .map(|plugin| plugin.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let plugins = payload
        .get("plugins")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Remote plugin data backup must contain plugins array".to_string())?;
    result.remote_plugins = plugins.len();

    for plugin in plugins {
        let plugin_id = plugin
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let documents = plugin
            .get("documents")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        result.remote_documents += documents.len();

        let Some(plugin_id) = plugin_id else {
            result.skipped_documents += documents.len();
            continue;
        };
        if !installed_ids.contains(plugin_id) {
            result.missing_plugins += 1;
            result.skipped_documents += documents.len();
            continue;
        }

        let mut write_docs = Vec::new();
        for raw_doc in documents {
            let doc = serde_json::from_value::<Document>(raw_doc).map_err(|error| {
                format!("Invalid plugin data document for {plugin_id}: {error}")
            })?;
            if doc.id.trim().is_empty() {
                result.skipped_documents += 1;
                continue;
            }
            match db
                .plugin_data_get(plugin_id, &doc.id)
                .map_err(|error| error.to_string())?
            {
                Some(existing) if existing.data == doc.data => {
                    result.unchanged_documents += 1;
                    result.skipped_documents += 1;
                }
                Some(_) => {
                    result.conflict_documents += 1;
                    if webdav_plugin_data_should_overwrite_conflict(
                        mode,
                        &selected_conflicts,
                        plugin_id,
                        &doc.id,
                    ) {
                        result.overwritten_documents += 1;
                        write_docs.push(doc);
                    } else {
                        result.skipped_documents += 1;
                    }
                }
                None => {
                    result.imported_documents += 1;
                    write_docs.push(doc);
                }
            }
        }

        if !write_docs.is_empty() {
            db.plugin_data_bulk(plugin_id, &write_docs)
                .map_err(|error| error.to_string())?;
        }
    }

    if result.overwritten_documents > 0 {
        result.status = "applied".to_string();
    } else if result.imported_documents > 0 {
        result.status = "imported".to_string();
    }
    Ok(result)
}

fn apply_webdav_plugin_data_restore_plan(
    db: &Database,
    plan: WebdavPluginDataRestorePlan,
    confirmed: bool,
    mode: WebdavPluginDataRestoreMode,
    selected_conflict_documents: &[WebdavPluginDataConflictSelection],
) -> Result<WebdavPluginDataRestoreResult, String> {
    let mut result = apply_webdav_plugin_data_payload_with_mode(
        db,
        &plan.plugin_data,
        confirmed,
        mode,
        selected_conflict_documents,
    )?;
    result.remote_path = plan.remote_path;
    result.manifest_kind = plan.manifest_kind;
    result.exported_at = plan.exported_at;
    result.duration_ms = plan.duration_ms;
    Ok(result)
}

fn webdav_plugin_data_restore_mode(
    mode: Option<&str>,
) -> Result<WebdavPluginDataRestoreMode, String> {
    match mode
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("append_missing")
    {
        "append_missing" => Ok(WebdavPluginDataRestoreMode::AppendMissing),
        "overwrite_conflicts" => Ok(WebdavPluginDataRestoreMode::OverwriteConflicts),
        "overwrite_selected_conflicts" => {
            Ok(WebdavPluginDataRestoreMode::OverwriteSelectedConflicts)
        }
        other => Err(format!(
            "Unsupported WebDAV plugin data restore mode: {other}"
        )),
    }
}

fn webdav_plugin_data_selected_conflict_set(
    selected_conflict_documents: &[WebdavPluginDataConflictSelection],
) -> std::collections::HashSet<(String, String)> {
    selected_conflict_documents
        .iter()
        .filter_map(|selection| {
            let plugin_id = selection.plugin_id.trim();
            let doc_id = selection.doc_id.trim();
            if plugin_id.is_empty() || doc_id.is_empty() {
                None
            } else {
                Some((plugin_id.to_string(), doc_id.to_string()))
            }
        })
        .collect()
}

fn webdav_plugin_data_should_overwrite_conflict(
    mode: WebdavPluginDataRestoreMode,
    selected_conflicts: &std::collections::HashSet<(String, String)>,
    plugin_id: &str,
    doc_id: &str,
) -> bool {
    match mode {
        WebdavPluginDataRestoreMode::AppendMissing => false,
        WebdavPluginDataRestoreMode::OverwriteConflicts => true,
        WebdavPluginDataRestoreMode::OverwriteSelectedConflicts => {
            selected_conflicts.contains(&(plugin_id.to_string(), doc_id.to_string()))
        }
    }
}

fn settings_string(settings: &serde_json::Value, key: &str) -> String {
    settings
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

// --- Data types for IPC ---

#[derive(serde::Serialize)]
pub struct RuntimeDiagnostics {
    pub runtime: String,
    pub platform: String,
    pub arch: String,
    pub debug: bool,
    pub base_dir: String,
    pub db_path: String,
    pub plugins_dir: String,
    pub plugin_count: usize,
    pub feature_count: usize,
    pub agent_tool_count: usize,
    pub enabled_agent_tool_count: usize,
    pub mcp_enabled: bool,
    pub mcp_bind: Option<String>,
    pub active_plugin: Option<String>,
    pub recent_events: Vec<RuntimeEvent>,
}

#[derive(serde::Serialize)]
pub struct SearchResult {
    pub code: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub label: String,
    pub icon: Option<String>,
    pub explain: String,
    pub score: i32,
    pub match_type: &'static str,
}

#[derive(serde::Serialize)]
pub struct FeatureAction {
    pub plugin_id: String,
    pub plugin_name: String,
    pub feature_code: String,
    pub main_url: String,
    pub plugin_path: String,
    pub preload_path: Option<String>,
    pub expand_height: u32,
    pub plugin_permissions: Vec<String>,
    pub payload: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_plugin_mutation_lock, activate_feature_inner, authorize_plugin_permissions_inner,
        cancel_plugin_market_operation_inner, default_local_app_roots,
        download_plugin_market_archive_with_progress, extract_plugin_market_zip,
        install_plugin_from_directory_inner, install_plugin_from_market_checked_url_inner,
        install_plugin_from_market_trusted_url_inner, install_plugin_from_market_url_inner,
        plugin_uninstall_path_allowed, plugin_update_from_path_inner,
        plugin_update_from_path_with_policy_inner, plugin_window_height,
        runtime_diagnostics_snapshot, search_local_apps_in_roots, search_local_apps_with_cache,
        shell_open_target, uninstall_plugin_files_transactionally,
        update_plugin_from_market_checked_url_inner, update_plugin_from_market_trusted_url_inner,
        update_plugin_from_market_url_inner, validate_plugin_market_trust, LocalAppSearchCache,
        PluginMarketProgressContext, PluginPersistencePolicy, RuntimeEvent, ShellOpenTarget,
        LOCAL_APP_SEARCH_CACHE_TTL,
    };
    use crate::window::{
        floating_ball_enabled_from_settings, floating_ball_initial_url,
        floating_ball_position_for_monitor, super_panel_enabled_from_settings,
        super_panel_initial_url, super_panel_position_for_monitor, FLOATING_BALL_HEIGHT,
        FLOATING_BALL_LABEL, FLOATING_BALL_MARGIN, FLOATING_BALL_WIDTH, SUPER_PANEL_LABEL,
        SUPER_PANEL_TOP_OFFSET, SUPER_PANEL_WIDTH,
    };
    use atools_core::config::AppConfig;
    use atools_core::db::Database;
    use atools_core::models::{Document, Plugin, PluginManifest};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri::{PhysicalPosition, PhysicalSize};
    use tempfile::TempDir;

    #[test]
    fn plugin_window_height_defaults_to_ztools_window_height() {
        assert_eq!(plugin_window_height(None), 541);
    }

    #[test]
    fn plugin_window_height_caps_large_manifest_values() {
        assert_eq!(plugin_window_height(Some(760)), 541);
        assert_eq!(plugin_window_height(Some(620)), 541);
    }

    #[test]
    fn plugin_window_height_preserves_smaller_manifest_values() {
        assert_eq!(plugin_window_height(Some(400)), 400);
    }

    #[test]
    fn activate_feature_includes_manifest_permissions_for_runtime_allowlist() {
        let db = Database::in_memory().unwrap();
        let manifest: PluginManifest = serde_json::from_str(
            r#"{"name":"permission-plugin","version":"1.0.0","main":"index.html","permissions":["clipboard","shell.openExternal"],"features":[{"code":"perm","explain":"Permission feature","cmds":["perm"]}]}"#,
        )
        .unwrap();
        db.save_plugin(&Plugin {
            id: "permission-plugin".to_string(),
            name: "permission-plugin".to_string(),
            version: "1.0.0".to_string(),
            path: "/tmp/permission-plugin".to_string(),
            enabled: true,
            manifest: manifest.clone(),
            created_at: "2026-06-05T00:00:00Z".to_string(),
            updated_at: "2026-06-05T00:00:00Z".to_string(),
        })
        .unwrap();
        db.index_features("permission-plugin", &manifest.features)
            .unwrap();

        let action = activate_feature_inner(&db, "perm", None).unwrap();

        assert_eq!(
            action.plugin_permissions,
            vec!["clipboard".to_string(), "shell.openExternal".to_string()]
        );
    }

    #[test]
    fn floating_ball_settings_and_geometry_are_parsed() {
        assert_eq!(FLOATING_BALL_LABEL, "floating-ball");
        assert_eq!(floating_ball_initial_url(), "/#/floating-ball");
        assert!(floating_ball_enabled_from_settings(Some(
            r#"{"floatingBallEnabled":true}"#
        )));
        assert!(!floating_ball_enabled_from_settings(Some(
            r#"{"floatingBallEnabled":false}"#
        )));
        assert!(!floating_ball_enabled_from_settings(Some(
            r#"{"floatingBallEnabled":"true"}"#
        )));
        assert!(!floating_ball_enabled_from_settings(None));
        assert_eq!(
            floating_ball_position_for_monitor(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1440, 900),
            ),
            PhysicalPosition::new(
                1440 - FLOATING_BALL_WIDTH as i32 - FLOATING_BALL_MARGIN as i32,
                900 - FLOATING_BALL_HEIGHT as i32 - FLOATING_BALL_MARGIN as i32,
            )
        );
    }

    #[test]
    fn super_panel_settings_and_geometry_are_parsed() {
        assert_eq!(SUPER_PANEL_LABEL, "super-panel");
        assert_eq!(super_panel_initial_url(), "/#/super-panel");
        assert!(super_panel_enabled_from_settings(Some(
            r#"{"superPanelEnabled":true}"#
        )));
        assert!(!super_panel_enabled_from_settings(Some(
            r#"{"superPanelEnabled":false}"#
        )));
        assert!(!super_panel_enabled_from_settings(Some(
            r#"{"superPanelEnabled":"true"}"#
        )));
        assert!(!super_panel_enabled_from_settings(None));
        assert_eq!(
            super_panel_position_for_monitor(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1440, 900),
            ),
            PhysicalPosition::new(
                (1440 - SUPER_PANEL_WIDTH as i32) / 2,
                SUPER_PANEL_TOP_OFFSET as i32,
            )
        );
    }

    #[test]
    fn plugin_uninstall_path_allows_only_user_plugin_directories() {
        let temp = TempDir::new().unwrap();
        let plugins_dir = temp.path().join("app-data").join("plugins");
        let imported_plugin = plugins_dir.join("plugin-user");
        let builtin_plugin = temp
            .path()
            .join("ATools.app")
            .join("Contents")
            .join("Resources")
            .join("plugins")
            .join("json");
        std::fs::create_dir_all(&imported_plugin).unwrap();
        std::fs::create_dir_all(&builtin_plugin).unwrap();

        assert!(plugin_uninstall_path_allowed(
            &imported_plugin,
            &plugins_dir
        ));
        assert!(!plugin_uninstall_path_allowed(
            &builtin_plugin,
            &plugins_dir
        ));
        assert!(!plugin_uninstall_path_allowed(&plugins_dir, &plugins_dir));
    }

    #[test]
    fn plugin_uninstall_restores_files_when_database_delete_fails() {
        let temp = TempDir::new().unwrap();
        let plugin_dir = temp.path().join("plugins").join("recoverable-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("plugin.json"), "original").unwrap();

        let error = uninstall_plugin_files_transactionally(&plugin_dir, || {
            Err::<(), _>("injected database delete failure".to_string())
        })
        .unwrap_err();

        assert!(error.contains("injected database delete failure"));
        assert_eq!(
            std::fs::read_to_string(plugin_dir.join("plugin.json")).unwrap(),
            "original",
            "failed uninstall must restore the live plugin directory"
        );
        assert_eq!(
            std::fs::read_dir(plugin_dir.parent().unwrap())
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn plugin_uninstall_removes_quarantine_after_database_delete_succeeds() {
        let temp = TempDir::new().unwrap();
        let plugin_dir = temp.path().join("plugins").join("removed-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("plugin.json"), "remove me").unwrap();

        uninstall_plugin_files_transactionally(&plugin_dir, || Ok::<(), String>(())).unwrap();

        assert!(!plugin_dir.exists());
        assert_eq!(
            std::fs::read_dir(plugin_dir.parent().unwrap())
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn plugin_mutation_lock_serializes_concurrent_operations() {
        let first_guard = acquire_plugin_mutation_lock().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (acquired_tx, acquired_rx) = std::sync::mpsc::channel();

        let waiter = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let _second_guard = acquire_plugin_mutation_lock().unwrap();
            acquired_tx.send(()).unwrap();
        });

        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            acquired_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "a second plugin mutation must wait while the first mutation owns the lock"
        );
        drop(first_guard);
        acquired_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn plugin_update_from_path_replaces_same_plugin_and_rejects_installed_source() {
        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        config.ensure_dirs().unwrap();
        let db = Database::in_memory().unwrap();
        let install_dir = config.plugin_dir("plugin-user");
        std::fs::create_dir_all(&install_dir).unwrap();
        std::fs::write(install_dir.join("stale.txt"), "old").unwrap();

        let old_manifest = serde_json::from_value::<PluginManifest>(serde_json::json!({
            "name": "plugin-user",
            "version": "1.0.0",
            "features": [
                { "code": "old", "explain": "Old feature", "cmds": ["old"] }
            ]
        }))
        .unwrap();
        db.save_plugin(&Plugin {
            id: "plugin-user".to_string(),
            name: "plugin-user".to_string(),
            version: "1.0.0".to_string(),
            path: install_dir.to_string_lossy().to_string(),
            enabled: false,
            manifest: old_manifest.clone(),
            created_at: "2026-06-01T08:00:00Z".to_string(),
            updated_at: "2026-06-01T08:00:00Z".to_string(),
        })
        .unwrap();
        db.index_features("plugin-user", &old_manifest.features)
            .unwrap();
        db.plugin_data_put(
            "plugin-user",
            &Document {
                id: "settings".to_string(),
                rev: None,
                data: serde_json::json!({ "preserved": true }),
            },
        )
        .unwrap();
        db.put_attachment(
            "plugin-user",
            "settings",
            "payload.bin",
            b"local-update-attachment",
            "application/octet-stream",
        )
        .unwrap();

        let source_dir = temp.path().join("source-plugin-user");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::write(
            source_dir.join("plugin.json"),
            r#"{"name":"plugin-user","version":"2.0.0","main":"index.html","features":[{"code":"new","explain":"New feature","cmds":["new"]}]}"#,
        )
        .unwrap();
        std::fs::write(source_dir.join("index.html"), "<main>v2</main>").unwrap();

        let updated =
            plugin_update_from_path_inner(&db, &config, "plugin-user", &source_dir).unwrap();

        assert_eq!(updated.id, "plugin-user");
        assert_eq!(updated.version, "2.0.0");
        assert!(
            !updated.enabled,
            "updates should preserve the existing enabled state"
        );
        assert!(
            source_dir.join("plugin.json").is_file(),
            "update must not remove the source"
        );
        assert!(install_dir.join("index.html").is_file());
        assert!(!install_dir.join("stale.txt").exists());
        let saved = db.get_plugin("plugin-user").unwrap();
        assert_eq!(saved.version, "2.0.0");
        assert!(!saved.enabled);
        assert_eq!(saved.created_at, "2026-06-01T08:00:00Z");
        assert_eq!(
            db.plugin_data_get("plugin-user", "settings")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "preserved": true })
        );
        assert_eq!(
            db.get_attachment("plugin-user", "settings", "payload.bin")
                .unwrap()
                .unwrap()
                .0,
            b"local-update-attachment"
        );

        let installed_source_error =
            plugin_update_from_path_inner(&db, &config, "plugin-user", &install_dir).unwrap_err();
        assert!(installed_source_error.contains("installed plugin directory"));

        let mismatch_dir = temp.path().join("source-other");
        std::fs::create_dir_all(&mismatch_dir).unwrap();
        std::fs::write(
            mismatch_dir.join("plugin.json"),
            r#"{"name":"other-plugin","version":"1.0.0","features":[]}"#,
        )
        .unwrap();
        let mismatch_error =
            plugin_update_from_path_inner(&db, &config, "plugin-user", &mismatch_dir).unwrap_err();
        assert!(mismatch_error.contains("does not match"));
    }

    #[cfg(unix)]
    #[test]
    fn market_update_copy_failure_keeps_existing_bytes_disabled_and_unsearchable() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        config.ensure_dirs().unwrap();
        let db = Database::in_memory().unwrap();
        let install_dir = config.plugin_dir("market-plugin");
        std::fs::create_dir_all(&install_dir).unwrap();
        std::fs::write(install_dir.join("index.html"), "<main>old</main>").unwrap();

        let old_manifest: PluginManifest = serde_json::from_str(
            r#"{"name":"market-plugin","version":"0.1.0","main":"index.html","features":[{"code":"old","explain":"Old feature","cmds":["old"]}]}"#,
        )
        .unwrap();
        let created_at = "2026-06-01T00:00:00Z";
        db.save_plugin_with_features(
            &Plugin {
                id: "market-plugin".to_string(),
                name: "market-plugin".to_string(),
                version: "0.1.0".to_string(),
                path: install_dir.to_string_lossy().to_string(),
                enabled: true,
                manifest: old_manifest.clone(),
                created_at: created_at.to_string(),
                updated_at: created_at.to_string(),
            },
            &old_manifest.features,
        )
        .unwrap();
        db.plugin_data_put(
            "market-plugin",
            &Document {
                id: "doc".to_string(),
                rev: None,
                data: serde_json::json!({ "value": "old" }),
            },
        )
        .unwrap();
        db.put_attachment(
            "market-plugin",
            "doc",
            "payload.bin",
            b"old attachment",
            "application/octet-stream",
        )
        .unwrap();

        let source_dir = temp.path().join("market-update-source");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::write(
            source_dir.join("plugin.json"),
            r#"{"name":"market-plugin","version":"2.0.0","main":"index.html","features":[{"code":"new","explain":"New feature","cmds":["new"]}]}"#,
        )
        .unwrap();
        std::fs::write(source_dir.join("index.html"), "<main>new</main>").unwrap();
        symlink(
            source_dir.join("missing-target"),
            source_dir.join("broken-link"),
        )
        .unwrap();

        let error = plugin_update_from_path_with_policy_inner(
            &db,
            &config,
            "market-plugin",
            &source_dir,
            PluginPersistencePolicy::Market,
        )
        .unwrap_err();

        assert!(error.contains("Failed to copy plugin"), "{error}");
        assert_eq!(
            std::fs::read_to_string(install_dir.join("index.html")).unwrap(),
            "<main>old</main>",
            "a failed update must leave the previously installed bytes intact"
        );
        assert!(
            !install_dir.join("plugin.json").exists(),
            "staged update files must not leak into the live plugin directory"
        );
        let saved = db.get_plugin("market-plugin").unwrap();
        assert_eq!(saved.version, "0.1.0");
        assert_eq!(saved.created_at, created_at);
        assert!(!saved.enabled);
        assert!(db.all_features().unwrap().is_empty());
        assert_eq!(db.get_feature("old").unwrap().plugin_id, "market-plugin");
        assert!(db.get_feature("new").is_err());
        assert_eq!(
            db.plugin_data_get("market-plugin", "doc")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "value": "old" })
        );
        assert_eq!(
            db.get_attachment("market-plugin", "doc", "payload.bin")
                .unwrap()
                .unwrap(),
            (
                b"old attachment".to_vec(),
                "application/octet-stream".to_string()
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn plugin_directory_install_rejects_source_and_destination_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        config.ensure_dirs().unwrap();
        let db = Database::in_memory().unwrap();

        let source_dir = temp.path().join("source-plugin");
        let outside_dir = temp.path().join("outside");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(
            source_dir.join("plugin.json"),
            r#"{"name":"symlink-plugin","version":"1.0.0","features":[]}"#,
        )
        .unwrap();
        std::fs::write(outside_dir.join("secret.txt"), "outside").unwrap();
        symlink(&outside_dir, source_dir.join("linked-assets")).unwrap();

        let source_error =
            install_plugin_from_directory_inner(&db, &config, &source_dir).unwrap_err();
        assert!(
            source_error.to_ascii_lowercase().contains("symlink"),
            "source symlinks must fail closed: {source_error}"
        );
        assert!(!config.plugin_dir("symlink-plugin").exists());

        std::fs::remove_file(source_dir.join("linked-assets")).unwrap();
        let destination = config.plugin_dir("symlink-plugin");
        symlink(&outside_dir, &destination).unwrap();

        let destination_error =
            install_plugin_from_directory_inner(&db, &config, &source_dir).unwrap_err();
        assert!(
            destination_error.to_ascii_lowercase().contains("symlink"),
            "destination symlinks must fail closed: {destination_error}"
        );
        assert_eq!(
            std::fs::read_to_string(outside_dir.join("secret.txt")).unwrap(),
            "outside"
        );
    }

    #[test]
    fn plugin_market_zip_rejects_entry_count_and_uncompressed_size_bombs() {
        use std::io::Write;

        let temp = TempDir::new().unwrap();
        let staging = temp.path().join("staging");
        std::fs::create_dir_all(&staging).unwrap();

        let mut entry_count_cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut entry_count_cursor);
            let options = zip::write::SimpleFileOptions::default();
            for index in 0..=4096 {
                writer
                    .start_file(format!("plugin/file-{index}.txt"), options)
                    .unwrap();
            }
            writer.finish().unwrap();
        }
        let entry_error = extract_plugin_market_zip(
            entry_count_cursor.get_ref(),
            &staging,
            "https://plugins.example.test/entry-bomb.zip",
        )
        .unwrap_err();
        assert!(
            entry_error.contains("too many entries"),
            "ZIP entry-count bombs must be rejected: {entry_error}"
        );

        let mut size_cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut size_cursor);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("plugin/huge.bin", options).unwrap();
            let chunk = vec![0_u8; 1024 * 1024];
            for _ in 0..=64 {
                writer.write_all(&chunk).unwrap();
            }
            writer.finish().unwrap();
        }
        let size_error = extract_plugin_market_zip(
            size_cursor.get_ref(),
            &staging,
            "https://plugins.example.test/size-bomb.zip",
        )
        .unwrap_err();
        assert!(
            size_error.contains("uncompressed size"),
            "ZIP uncompressed-size bombs must be rejected before extraction: {size_error}"
        );
    }

    #[tokio::test]
    async fn plugin_market_zip_download_installs_plugin_and_rejects_zip_slip() {
        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        config.ensure_dirs().unwrap();
        let db = Database::in_memory().unwrap();

        let plugin_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKYKxVyd6c83aAAAAIoAAAAZAAAAbWFya2V0LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUspNLMpOLdEtyClNz8xT0lEqSy0qzszPA8oY6hnpGQNFchMzQdzMvJTUCr2MktwcoFhaamJJaVFqsZJVdLVScn4KwiSgZGpFQQ5Ejy9YSAGqGiiVnJsC0gNTG1sbWwsAUEsDBBQAAAAIAKYKxVyOTM9TGQAAABoAAAAYAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1ss8lNzMyz800syk4tUQjIKU3PzLPRB4sBAFBLAwQUAAAACACmCsVcjyikHwYAAAAEAAAAHQAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0K05MSwUAUEsBAhQDFAAAAAgApgrFXJ3pzzdoAAAAigAAABkAAAAAAAAAAAAAAIABAAAAAG1hcmtldC1wbHVnaW4vcGx1Z2luLmpzb25QSwECFAMUAAAACACmCsVcjkzPUxkAAAAaAAAAGAAAAAAAAAAAAAAAgAGfAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1sUEsBAhQDFAAAAAgApgrFXI8opB8GAAAABAAAAB0AAAAAAAAAAAAAAIAB7gAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0UEsFBgAAAAADAAMA2AAAAC8BAAAAAA==",
        ).unwrap();
        let plugin_url = one_shot_http_url(plugin_zip, "application/zip").await;
        let installed = install_plugin_from_market_url_inner(&db, &config, &plugin_url)
            .await
            .unwrap();

        assert_eq!(installed.id, "market-plugin");
        assert_eq!(installed.version, "1.2.3");
        assert!(
            !installed.enabled,
            "remote market installs should stay disabled until the user authorizes plugin permissions"
        );
        assert!(config
            .plugin_dir("market-plugin")
            .join("plugin.json")
            .is_file());
        assert!(config
            .plugin_dir("market-plugin")
            .join("index.html")
            .is_file());
        assert!(config
            .plugin_dir("market-plugin")
            .join("assets")
            .join("info.txt")
            .is_file());
        assert_eq!(db.get_plugin("market-plugin").unwrap().version, "1.2.3");
        assert!(
            db.all_features().unwrap().is_empty(),
            "disabled remote installs must not enter the searchable feature list before authorization"
        );
        let authorized = authorize_plugin_permissions_inner(&db, "market-plugin").unwrap();
        assert!(authorized.enabled);
        assert_eq!(db.all_features().unwrap()[0].plugin_id, "market-plugin");
        assert_eq!(db.get_feature("market").unwrap().plugin_id, "market-plugin");

        let malicious_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKkKxVz31tOUNwAAADsAAAAXAAAAZXZpbC1wbHVnaW4vcGx1Z2luLmpzb26rVspLzE1VslJQSi3LzNEtyClNz8xT0lFQKkstKs7MzwPJGOoZ6BmAxNJSE0tKi1KLgYLRsbUAUEsDBBQAAAAIAKkKxVz7OSuCBQAAAAMAAAANAAAALi4vZXNjYXBlLnR4dEtKTAEAUEsBAhQDFAAAAAgAqQrFXPfW05Q3AAAAOwAAABcAAAAAAAAAAAAAAIABAAAAAGV2aWwtcGx1Z2luL3BsdWdpbi5qc29uUEsBAhQDFAAAAAgAqQrFXPs5K4IFAAAAAwAAAA0AAAAAAAAAAAAAAIABbAAAAC4uL2VzY2FwZS50eHRQSwUGAAAAAAIAAgCAAAAAnAAAAAAA",
        ).unwrap();
        let malicious_url = one_shot_http_url(malicious_zip, "application/zip").await;
        let error = install_plugin_from_market_url_inner(&db, &config, &malicious_url)
            .await
            .unwrap_err();
        assert!(
            error.contains("unsafe path"),
            "zip-slip paths should be rejected before installation: {error}"
        );
        assert!(!temp.path().join("escape.txt").exists());
    }

    #[tokio::test]
    async fn plugin_market_zip_update_requires_reauthorization_before_searchable() {
        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        config.ensure_dirs().unwrap();
        let db = Database::in_memory().unwrap();

        let install_dir = config.plugin_dir("market-plugin");
        std::fs::create_dir_all(&install_dir).unwrap();
        let old_manifest: PluginManifest = serde_json::from_str(
            r#"{"name":"market-plugin","version":"0.1.0","main":"index.html","features":[{"code":"old","explain":"Old feature","cmds":["old"]}]}"#,
        )
        .unwrap();
        db.save_plugin(&Plugin {
            id: "market-plugin".to_string(),
            name: "market-plugin".to_string(),
            version: "0.1.0".to_string(),
            path: install_dir.to_string_lossy().to_string(),
            enabled: true,
            manifest: old_manifest.clone(),
            created_at: "2026-06-01T00:00:00Z".to_string(),
            updated_at: "2026-06-01T00:00:00Z".to_string(),
        })
        .unwrap();
        db.index_features("market-plugin", &old_manifest.features)
            .unwrap();
        db.plugin_data_put(
            "market-plugin",
            &Document {
                id: "doc".to_string(),
                rev: None,
                data: serde_json::json!({ "value": "preserved" }),
            },
        )
        .unwrap();
        db.put_attachment(
            "market-plugin",
            "doc",
            "payload.bin",
            b"preserved attachment",
            "application/octet-stream",
        )
        .unwrap();
        assert_eq!(db.all_features().unwrap().len(), 1);

        let plugin_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKYKxVyd6c83aAAAAIoAAAAZAAAAbWFya2V0LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUspNLMpOLdEtyClNz8xT0lEqSy0qzszPA8oY6hnpGQNFchMzQdzMvJTUCr2MktwcoFhaamJJaVFqsZJVdLVScn4KwiSgZGpFQQ5Ejy9YSAGqGiiVnJsC0gNTG1sbWwsAUEsDBBQAAAAIAKYKxVyOTM9TGQAAABoAAAAYAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1ss8lNzMyz800syk4tUQjIKU3PzLPRB4sBAFBLAwQUAAAACACmCsVcjyikHwYAAAAEAAAAHQAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0K05MSwUAUEsBAhQDFAAAAAgApgrFXJ3pzzdoAAAAigAAABkAAAAAAAAAAAAAAIABAAAAAG1hcmtldC1wbHVnaW4vcGx1Z2luLmpzb25QSwECFAMUAAAACACmCsVcjkzPUxkAAAAaAAAAGAAAAAAAAAAAAAAAgAGfAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1sUEsBAhQDFAAAAAgApgrFXI8opB8GAAAABAAAAB0AAAAAAAAAAAAAAIAB7gAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0UEsFBgAAAAADAAMA2AAAAC8BAAAAAA==",
        )
        .unwrap();
        let plugin_url = one_shot_http_url(plugin_zip, "application/zip").await;
        let updated =
            update_plugin_from_market_url_inner(&db, &config, "market-plugin", &plugin_url)
                .await
                .unwrap();

        assert_eq!(updated.version, "1.2.3");
        assert!(
            !updated.enabled,
            "remote market updates should disable the plugin until the user reauthorizes the new manifest"
        );
        assert!(
            db.all_features().unwrap().is_empty(),
            "updated remote plugin features must stay out of search until reauthorized"
        );
        let saved = db.get_plugin("market-plugin").unwrap();
        assert_eq!(saved.created_at, "2026-06-01T00:00:00Z");
        assert_eq!(
            db.plugin_data_get("market-plugin", "doc")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "value": "preserved" })
        );
        assert_eq!(
            db.get_attachment("market-plugin", "doc", "payload.bin")
                .unwrap()
                .unwrap(),
            (
                b"preserved attachment".to_vec(),
                "application/octet-stream".to_string()
            )
        );

        let authorized = authorize_plugin_permissions_inner(&db, "market-plugin").unwrap();
        assert!(authorized.enabled);
        assert_eq!(db.all_features().unwrap()[0].code, "market");
        assert_eq!(
            db.plugin_data_get("market-plugin", "doc")
                .unwrap()
                .unwrap()
                .data,
            serde_json::json!({ "value": "preserved" })
        );
        assert_eq!(
            db.get_attachment("market-plugin", "doc", "payload.bin")
                .unwrap()
                .unwrap()
                .0,
            b"preserved attachment"
        );
    }

    #[tokio::test]
    async fn plugin_market_zip_download_verifies_sha256_checksum_before_install() {
        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        config.ensure_dirs().unwrap();
        let db = Database::in_memory().unwrap();

        let plugin_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKYKxVyd6c83aAAAAIoAAAAZAAAAbWFya2V0LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUspNLMpOLdEtyClNz8xT0lEqSy0qzszPA8oY6hnpGQNFchMzQdzMvJTUCr2MktwcoFhaamJJaVFqsZJVdLVScn4KwiSgZGpFQQ5Ejy9YSAGqGiiVnJsC0gNTG1sbWwsAUEsDBBQAAAAIAKYKxVyOTM9TGQAAABoAAAAYAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1ss8lNzMyz800syk4tUQjIKU3PzLPRB4sBAFBLAwQUAAAACACmCsVcjyikHwYAAAAEAAAAHQAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0K05MSwUAUEsBAhQDFAAAAAgApgrFXJ3pzzdoAAAAigAAABkAAAAAAAAAAAAAAIABAAAAAG1hcmtldC1wbHVnaW4vcGx1Z2luLmpzb25QSwECFAMUAAAACACmCsVcjkzPUxkAAAAaAAAAGAAAAAAAAAAAAAAAgAGfAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1sUEsBAhQDFAAAAAgApgrFXI8opB8GAAAABAAAAB0AAAAAAAAAAAAAAIAB7gAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0UEsFBgAAAAADAAMA2AAAAC8BAAAAAA==",
        ).unwrap();
        let good_checksum =
            "sha256:9a1048629d74b6e3ecf2c886447c2ba773b31edeea98c3c40bbaac8fd99efacd";
        let plugin_url = one_shot_http_url(plugin_zip.clone(), "application/zip").await;
        let installed = install_plugin_from_market_checked_url_inner(
            &db,
            &config,
            Some("market-plugin"),
            &plugin_url,
            Some(good_checksum),
        )
        .await
        .unwrap();

        assert_eq!(installed.id, "market-plugin");
        assert_eq!(installed.version, "1.2.3");

        let bad_zip_url = one_shot_http_url(plugin_zip, "application/zip").await;
        let bad_checksum =
            "sha256:0000000000000000000000000000000000000000000000000000000000000000";
        let error = update_plugin_from_market_checked_url_inner(
            &db,
            &config,
            "market-plugin",
            &bad_zip_url,
            Some(bad_checksum),
        )
        .await
        .unwrap_err();

        assert!(
            error.contains("checksum"),
            "wrong checksum should reject the archive before update: {error}"
        );
        assert_eq!(db.get_plugin("market-plugin").unwrap().version, "1.2.3");
    }

    #[tokio::test]
    async fn plugin_market_zip_download_verifies_ed25519_signature_before_install_or_update() {
        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        config.ensure_dirs().unwrap();
        let db = Database::in_memory().unwrap();

        let plugin_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKYKxVyd6c83aAAAAIoAAAAZAAAAbWFya2V0LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUspNLMpOLdEtyClNz8xT0lEqSy0qzszPA8oY6hnpGQNFchMzQdzMvJTUCr2MktwcoFhaamJJaVFqsZJVdLVScn4KwiSgZGpFQQ5Ejy9YSAGqGiiVnJsC0gNTG1sbWwsAUEsDBBQAAAAIAKYKxVyOTM9TGQAAABoAAAAYAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1ss8lNzMyz800syk4tUQjIKU3PzLPRB4sBAFBLAwQUAAAACACmCsVcjyikHwYAAAAEAAAAHQAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0K05MSwUAUEsBAhQDFAAAAAgApgrFXJ3pzzdoAAAAigAAABkAAAAAAAAAAAAAAIABAAAAAG1hcmtldC1wbHVnaW4vcGx1Z2luLmpzb25QSwECFAMUAAAACACmCsVcjkzPUxkAAAAaAAAAGAAAAAAAAAAAAAAAgAGfAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1sUEsBAhQDFAAAAAgApgrFXI8opB8GAAAABAAAAB0AAAAAAAAAAAAAAIAB7gAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0UEsFBgAAAAADAAMA2AAAAC8BAAAAAA==",
        ).unwrap();
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let public_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
        let good_signature = STANDARD.encode(signing_key.sign(&plugin_zip).to_bytes());
        let bad_signature = STANDARD.encode(signing_key.sign(b"different archive").to_bytes());

        let plugin_url = one_shot_http_url(plugin_zip.clone(), "application/zip").await;
        let installed = install_plugin_from_market_trusted_url_inner(
            &db,
            &config,
            Some("market-plugin"),
            &plugin_url,
            Some("sha256:9a1048629d74b6e3ecf2c886447c2ba773b31edeea98c3c40bbaac8fd99efacd"),
            Some(&good_signature),
            Some(&public_key),
        )
        .await
        .unwrap();

        assert_eq!(installed.id, "market-plugin");
        assert_eq!(installed.version, "1.2.3");

        let bad_zip_url = one_shot_http_url(plugin_zip, "application/zip").await;
        let error = update_plugin_from_market_trusted_url_inner(
            &db,
            &config,
            "market-plugin",
            &bad_zip_url,
            Some("sha256:9a1048629d74b6e3ecf2c886447c2ba773b31edeea98c3c40bbaac8fd99efacd"),
            Some(&bad_signature),
            Some(&public_key),
        )
        .await
        .unwrap_err();

        assert!(
            error.contains("signature"),
            "wrong Ed25519 signature should reject the archive before update: {error}"
        );
        assert_eq!(db.get_plugin("market-plugin").unwrap().version, "1.2.3");
    }

    #[test]
    fn plugin_market_requires_signature_and_locally_pinned_public_key() {
        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        config.ensure_dirs().unwrap();
        let trusted_key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
        let substituted_key = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=";
        let signature = STANDARD.encode([1_u8; 64]);
        config
            .save_settings(&serde_json::json!({
                "pluginMarketTrustedPublicKeys": [trusted_key]
            }))
            .unwrap();

        let missing_signature =
            validate_plugin_market_trust(&config, None, Some(trusted_key)).unwrap_err();
        assert!(missing_signature.contains("signature"));
        let missing_key =
            validate_plugin_market_trust(&config, Some(&signature), None).unwrap_err();
        assert!(missing_key.contains("public key"));
        let short_signature = STANDARD.encode([1_u8; 8]);
        let malformed =
            validate_plugin_market_trust(&config, Some(&short_signature), Some(trusted_key))
                .unwrap_err();
        assert!(malformed.contains("64 bytes"));
        let substituted =
            validate_plugin_market_trust(&config, Some(&signature), Some(substituted_key))
                .unwrap_err();
        assert!(
            substituted.contains("not trusted"),
            "a catalog-supplied replacement key must not become its own trust anchor: {substituted}"
        );

        validate_plugin_market_trust(&config, Some(&signature), Some(trusted_key)).unwrap();

        config
            .save_settings(&serde_json::json!({
                "pluginMarketTrustedPublicKeys": []
            }))
            .unwrap();
        let no_pins =
            validate_plugin_market_trust(&config, Some(&signature), Some(trusted_key)).unwrap_err();
        assert!(no_pins.contains("No trusted plugin market public keys"));
    }

    #[tokio::test]
    async fn plugin_market_zip_download_reports_progress_events() {
        let plugin_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKYKxVyd6c83aAAAAIoAAAAZAAAAbWFya2V0LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUspNLMpOLdEtyClNz8xT0lEqSy0qzszPA8oY6hnpGQNFchMzQdzMvJTUCr2MktwcoFhaamJJaVFqsZJVdLVScn4KwiSgZGpFQQ5Ejy9YSAGqGiiVnJsC0gNTG1sbWwsAUEsDBBQAAAAIAKYKxVyOTM9TGQAAABoAAAAYAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1ss8lNzMyz800syk4tUQjIKU3PzLPRB4sBAFBLAwQUAAAACACmCsVcjyikHwYAAAAEAAAAHQAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0K05MSwUAUEsBAhQDFAAAAAgApgrFXJ3pzzdoAAAAigAAABkAAAAAAAAAAAAAAIABAAAAAG1hcmtldC1wbHVnaW4vcGx1Z2luLmpzb25QSwECFAMUAAAACACmCsVcjkzPUxkAAAAaAAAAGAAAAAAAAAAAAAAAgAGfAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1sUEsBAhQDFAAAAAgApgrFXI8opB8GAAAABAAAAB0AAAAAAAAAAAAAAIAB7gAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0UEsFBgAAAAADAAMA2AAAAC8BAAAAAA==",
        ).unwrap();
        let plugin_url = one_shot_http_url(plugin_zip.clone(), "application/zip").await;
        let mut events = Vec::new();

        let (bytes, source_url) = download_plugin_market_archive_with_progress(
            &plugin_url,
            Some("sha256:9a1048629d74b6e3ecf2c886447c2ba773b31edeea98c3c40bbaac8fd99efacd"),
            PluginMarketProgressContext {
                plugin_id: Some("market-plugin".to_string()),
                operation: "install".to_string(),
                operation_id: None,
            },
            |event| events.push(event),
        )
        .await
        .unwrap();

        assert_eq!(bytes, plugin_zip);
        assert_eq!(source_url, plugin_url);
        assert!(
            events.iter().any(|event| event.stage == "downloading"
                && event.plugin_id.as_deref() == Some("market-plugin")
                && event.operation == "install"
                && event.downloaded_bytes > 0
                && event.total_bytes == Some(plugin_zip.len() as u64)
                && event.percent.unwrap_or_default() > 0.0),
            "download should report byte progress events: {events:?}"
        );
        assert!(
            events.iter().any(|event| event.stage == "verified"),
            "download should report checksum verification completion: {events:?}"
        );
    }

    #[tokio::test]
    async fn plugin_market_zip_download_retries_transient_request_failure_and_reports_attempts() {
        let plugin_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKYKxVyd6c83aAAAAIoAAAAZAAAAbWFya2V0LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUspNLMpOLdEtyClNz8xT0lEqSy0qzszPA8oY6hnpGQNFchMzQdzMvJTUCr2MktwcoFhaamJJaVFqsZJVdLVScn4KwiSgZGpFQQ5Ejy9YSAGqGiiVnJsC0gNTG1sbWwsAUEsDBBQAAAAIAKYKxVyOTM9TGQAAABoAAAAYAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1ss8lNzMyz800syk4tUQjIKU3PzLPRB4sBAFBLAwQUAAAACACmCsVcjyikHwYAAAAEAAAAHQAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0K05MSwUAUEsBAhQDFAAAAAgApgrFXJ3pzzdoAAAAigAAABkAAAAAAAAAAAAAAIABAAAAAG1hcmtldC1wbHVnaW4vcGx1Z2luLmpzb25QSwECFAMUAAAACACmCsVcjkzPUxkAAAAaAAAAGAAAAAAAAAAAAAAAgAGfAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1sUEsBAhQDFAAAAAgApgrFXI8opB8GAAAABAAAAB0AAAAAAAAAAAAAAIAB7gAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0UEsFBgAAAAADAAMA2AAAAC8BAAAAAA==",
        ).unwrap();
        let plugin_url = sequenced_http_url(vec![
            HttpTestResponse {
                status: 503,
                body: b"busy".to_vec(),
                content_type: "text/plain",
            },
            HttpTestResponse {
                status: 200,
                body: plugin_zip.clone(),
                content_type: "application/zip",
            },
        ])
        .await;
        let mut events = Vec::new();

        let (bytes, _) = download_plugin_market_archive_with_progress(
            &plugin_url,
            Some("sha256:9a1048629d74b6e3ecf2c886447c2ba773b31edeea98c3c40bbaac8fd99efacd"),
            PluginMarketProgressContext {
                plugin_id: Some("market-plugin".to_string()),
                operation: "install".to_string(),
                operation_id: Some("retry-op".to_string()),
            },
            |event| events.push(event),
        )
        .await
        .unwrap();

        assert_eq!(bytes, plugin_zip);
        assert!(
            events.iter().any(|event| event.stage == "retrying"
                && event.operation_id.as_deref() == Some("retry-op")
                && event.attempt == 1
                && event.max_attempts == 3),
            "transient HTTP failures should emit retrying with attempt metadata: {events:?}"
        );
        assert!(
            events
                .iter()
                .any(|event| event.stage == "downloading" && event.attempt == 2),
            "second attempt should complete the download: {events:?}"
        );
    }

    #[tokio::test]
    async fn plugin_market_zip_download_can_be_cancelled_before_local_write() {
        let plugin_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKYKxVyd6c83aAAAAIoAAAAZAAAAbWFya2V0LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUspNLMpOLdEtyClNz8xT0lEqSy0qzszPA8oY6hnpGQNFchMzQdzMvJTUCr2MktwcoFhaamJJaVFqsZJVdLVScn4KwiSgZGpFQQ5Ejy9YSAGqGiiVnJsC0gNTG1sbWwsAUEsDBBQAAAAIAKYKxVyOTM9TGQAAABoAAAAYAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1ss8lNzMyz800syk4tUQjIKU3PzLPRB4sBAFBLAwQUAAAACACmCsVcjyikHwYAAAAEAAAAHQAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0K05MSwUAUEsBAhQDFAAAAAgApgrFXJ3pzzdoAAAAigAAABkAAAAAAAAAAAAAAIABAAAAAG1hcmtldC1wbHVnaW4vcGx1Z2luLmpzb25QSwECFAMUAAAACACmCsVcjkzPUxkAAAAaAAAAGAAAAAAAAAAAAAAAgAGfAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1sUEsBAhQDFAAAAAgApgrFXI8opB8GAAAABAAAAB0AAAAAAAAAAAAAAIAB7gAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0UEsFBgAAAAADAAMA2AAAAC8BAAAAAA==",
        ).unwrap();
        let plugin_url = one_shot_http_url(plugin_zip, "application/zip").await;
        let mut events = Vec::new();

        let error = download_plugin_market_archive_with_progress(
            &plugin_url,
            Some("sha256:9a1048629d74b6e3ecf2c886447c2ba773b31edeea98c3c40bbaac8fd99efacd"),
            PluginMarketProgressContext {
                plugin_id: Some("market-plugin".to_string()),
                operation: "install".to_string(),
                operation_id: Some("cancel-op".to_string()),
            },
            |event| {
                if event.stage == "downloading" {
                    cancel_plugin_market_operation_inner("cancel-op").unwrap();
                }
                events.push(event);
            },
        )
        .await
        .unwrap_err();

        assert!(
            error.contains("cancelled"),
            "cancel should stop the active download: {error}"
        );
        assert!(
            events.iter().any(|event| event.stage == "cancelled"
                && event.operation_id.as_deref() == Some("cancel-op")),
            "cancelled operations should emit a terminal cancelled event: {events:?}"
        );
    }

    #[tokio::test]
    async fn plugin_market_zip_update_preserves_enabled_state_and_rejects_id_mismatch() {
        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        config.ensure_dirs().unwrap();
        let db = Database::in_memory().unwrap();

        let install_dir = config.plugin_dir("market-plugin");
        std::fs::create_dir_all(&install_dir).unwrap();
        std::fs::write(install_dir.join("stale.txt"), "old").unwrap();
        let old_manifest: PluginManifest = serde_json::from_str(
            r#"{"name":"market-plugin","version":"0.1.0","main":"index.html","features":[{"code":"old","explain":"Old feature","cmds":["old"]}]}"#,
        )
        .unwrap();
        let created_at = "2026-06-01T00:00:00Z".to_string();
        db.save_plugin(&Plugin {
            id: "market-plugin".to_string(),
            name: "market-plugin".to_string(),
            version: "0.1.0".to_string(),
            path: install_dir.to_string_lossy().to_string(),
            enabled: false,
            manifest: old_manifest.clone(),
            created_at: created_at.clone(),
            updated_at: created_at.clone(),
        })
        .unwrap();
        db.index_features("market-plugin", &old_manifest.features)
            .unwrap();

        let plugin_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKYKxVyd6c83aAAAAIoAAAAZAAAAbWFya2V0LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUspNLMpOLdEtyClNz8xT0lEqSy0qzszPA8oY6hnpGQNFchMzQdzMvJTUCr2MktwcoFhaamJJaVFqsZJVdLVScn4KwiSgZGpFQQ5Ejy9YSAGqGiiVnJsC0gNTG1sbWwsAUEsDBBQAAAAIAKYKxVyOTM9TGQAAABoAAAAYAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1ss8lNzMyz800syk4tUQjIKU3PzLPRB4sBAFBLAwQUAAAACACmCsVcjyikHwYAAAAEAAAAHQAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0K05MSwUAUEsBAhQDFAAAAAgApgrFXJ3pzzdoAAAAigAAABkAAAAAAAAAAAAAAIABAAAAAG1hcmtldC1wbHVnaW4vcGx1Z2luLmpzb25QSwECFAMUAAAACACmCsVcjkzPUxkAAAAaAAAAGAAAAAAAAAAAAAAAgAGfAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1sUEsBAhQDFAAAAAgApgrFXI8opB8GAAAABAAAAB0AAAAAAAAAAAAAAIAB7gAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0UEsFBgAAAAADAAMA2AAAAC8BAAAAAA==",
        ).unwrap();
        let plugin_url = one_shot_http_url(plugin_zip, "application/zip").await;
        let updated =
            update_plugin_from_market_url_inner(&db, &config, "market-plugin", &plugin_url)
                .await
                .unwrap();

        assert_eq!(updated.id, "market-plugin");
        assert_eq!(updated.version, "1.2.3");
        assert!(
            !updated.enabled,
            "market updates should preserve the existing enabled state"
        );
        assert_eq!(updated.created_at, created_at);
        assert!(install_dir.join("index.html").is_file());
        assert!(!install_dir.join("stale.txt").exists());
        assert_eq!(db.get_plugin("market-plugin").unwrap().version, "1.2.3");
        assert!(!db.get_plugin("market-plugin").unwrap().enabled);
        assert_eq!(db.get_feature("market").unwrap().plugin_id, "market-plugin");

        let mismatch_zip = STANDARD.decode(
            "UEsDBBQAAAAIAKYKxVyd6c83aAAAAIoAAAAZAAAAbWFya2V0LXBsdWdpbi9wbHVnaW4uanNvbqtWykvMTVWyUspNLMpOLdEtyClNz8xT0lEqSy0qzszPA8oY6hnpGQNFchMzQdzMvJTUCr2MktwcoFhaamJJaVFqsZJVdLVScn4KwiSgZGpFQQ5Ejy9YSAGqGiiVnJsC0gNTG1sbWwsAUEsDBBQAAAAIAKYKxVyOTM9TGQAAABoAAAAYAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1ss8lNzMyz800syk4tUQjIKU3PzLPRB4sBAFBLAwQUAAAACACmCsVcjyikHwYAAAAEAAAAHQAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0K05MSwUAUEsBAhQDFAAAAAgApgrFXJ3pzzdoAAAAigAAABkAAAAAAAAAAAAAAIABAAAAAG1hcmtldC1wbHVnaW4vcGx1Z2luLmpzb25QSwECFAMUAAAACACmCsVcjkzPUxkAAAAaAAAAGAAAAAAAAAAAAAAAgAGfAAAAbWFya2V0LXBsdWdpbi9pbmRleC5odG1sUEsBAhQDFAAAAAgApgrFXI8opB8GAAAABAAAAB0AAAAAAAAAAAAAAIAB7gAAAG1hcmtldC1wbHVnaW4vYXNzZXRzL2luZm8udHh0UEsFBgAAAAADAAMA2AAAAC8BAAAAAA==",
        ).unwrap();
        let mismatch_install_dir = config.plugin_dir("different-plugin");
        std::fs::create_dir_all(&mismatch_install_dir).unwrap();
        let mismatch_existing_manifest: PluginManifest =
            serde_json::from_str(r#"{"name":"different-plugin","version":"0.1.0","features":[]}"#)
                .unwrap();
        db.save_plugin(&Plugin {
            id: "different-plugin".to_string(),
            name: "different-plugin".to_string(),
            version: "0.1.0".to_string(),
            path: mismatch_install_dir.to_string_lossy().to_string(),
            enabled: true,
            manifest: mismatch_existing_manifest,
            created_at: created_at.clone(),
            updated_at: created_at,
        })
        .unwrap();
        let mismatch_url = one_shot_http_url(mismatch_zip, "application/zip").await;
        let mismatch_error =
            update_plugin_from_market_url_inner(&db, &config, "different-plugin", &mismatch_url)
                .await
                .unwrap_err();
        assert!(mismatch_error.contains("does not match"));
        assert_eq!(db.get_plugin("market-plugin").unwrap().version, "1.2.3");
    }

    struct HttpTestResponse {
        status: u16,
        body: Vec<u8>,
        content_type: &'static str,
    }

    async fn sequenced_http_url(responses: Vec<HttpTestResponse>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/plugin.zip", listener.local_addr().unwrap());
        tokio::spawn(async move {
            for response in responses {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buffer = vec![0; 16 * 1024];
                let _ = socket.read(&mut buffer).await;
                let status_text = if response.status == 200 {
                    "OK"
                } else {
                    "Service Unavailable"
                };
                let header = format!(
                    "HTTP/1.1 {} {status_text}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.status,
                    response.content_type,
                    response.body.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(&response.body).await;
            }
        });
        url
    }

    async fn one_shot_http_url(body: Vec<u8>, content_type: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/plugin.zip", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = vec![0; 16 * 1024];
            let _ = socket.read(&mut buffer).await;
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        });
        url
    }

    #[test]
    fn local_app_search_finds_app_bundles_by_name_and_limit() {
        let temp = TempDir::new().unwrap();
        std::fs::create_dir(temp.path().join("Safari.app")).unwrap();
        std::fs::create_dir(temp.path().join("Visual Studio Code.app")).unwrap();
        std::fs::write(temp.path().join("Notes.txt"), "not app").unwrap();

        let results = search_local_apps_in_roots(&[temp.path().to_path_buf()], "code", 10);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].label, "打开 Visual Studio Code");
        assert_eq!(results[0].plugin_id, "local-apps");
        assert_eq!(results[0].plugin_name, "本地应用");
        assert!(results[0].code.starts_with("local-app:"));
        assert!(results[0].explain.ends_with("Visual Studio Code.app"));
    }

    #[test]
    fn local_app_default_roots_include_system_applications() {
        let roots = default_local_app_roots()
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert!(roots.contains(&"/Applications".to_string()));
        assert!(roots.contains(&"/System/Applications".to_string()));
        assert!(roots.contains(&"/System/Applications/Utilities".to_string()));
    }

    #[test]
    fn local_app_search_recurses_and_respects_limit() {
        let temp = TempDir::new().unwrap();
        let utilities = temp.path().join("Utilities");
        std::fs::create_dir(&utilities).unwrap();
        std::fs::create_dir(utilities.join("Terminal.app")).unwrap();
        std::fs::create_dir(temp.path().join("Terminal Helper.app")).unwrap();

        let results = search_local_apps_in_roots(&[temp.path().to_path_buf()], "terminal", 1);

        assert_eq!(results.len(), 1);
        assert!(results[0].label.contains("Terminal"));
    }

    #[test]
    fn local_app_search_cache_reuses_index_until_ttl_expires() {
        let temp = TempDir::new().unwrap();
        std::fs::create_dir(temp.path().join("Alpha.app")).unwrap();

        let mut cache = LocalAppSearchCache::default();
        let first =
            search_local_apps_with_cache(&mut cache, &[temp.path().to_path_buf()], "alpha", 10);

        assert_eq!(first.len(), 1);
        assert_eq!(first[0].label, "打开 Alpha");

        std::fs::create_dir(temp.path().join("Beta.app")).unwrap();
        let cached =
            search_local_apps_with_cache(&mut cache, &[temp.path().to_path_buf()], "beta", 10);
        assert!(
            cached.is_empty(),
            "fresh cache should avoid rescanning during rapid typing"
        );

        cache.scanned_at =
            Some(Instant::now() - LOCAL_APP_SEARCH_CACHE_TTL - Duration::from_secs(1));
        let refreshed =
            search_local_apps_with_cache(&mut cache, &[temp.path().to_path_buf()], "beta", 10);

        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].label, "打开 Beta");
    }

    #[test]
    fn local_app_search_sorts_same_score_and_label_by_path() {
        let temp = TempDir::new().unwrap();
        let z_root = temp.path().join("z-root");
        let a_root = temp.path().join("a-root");
        std::fs::create_dir_all(&z_root).unwrap();
        std::fs::create_dir_all(&a_root).unwrap();
        std::fs::create_dir(z_root.join("Code.app")).unwrap();
        std::fs::create_dir(a_root.join("Code.app")).unwrap();

        let results = search_local_apps_in_roots(&[z_root, a_root], "code", 10);

        assert_eq!(results.len(), 2);
        assert!(results[0].explain.contains("a-root/Code.app"));
        assert!(results[1].explain.contains("z-root/Code.app"));
    }

    #[test]
    fn local_app_search_uses_info_plist_display_name_and_metadata_aliases() {
        let temp = TempDir::new().unwrap();
        let app = temp.path().join("HiddenBundleName.app");
        let contents = app.join("Contents");
        std::fs::create_dir_all(&contents).unwrap();
        std::fs::write(
            contents.join("Info.plist"),
            r#"<plist><dict>
  <key>CFBundleDisplayName</key><string>Actual Tool</string>
  <key>CFBundleIdentifier</key><string>com.example.actual-tool</string>
  <key>CFBundleExecutable</key><string>actuald</string>
</dict></plist>"#,
        )
        .unwrap();

        let display_name_results =
            search_local_apps_in_roots(&[temp.path().to_path_buf()], "actual", 10);
        assert_eq!(display_name_results.len(), 1);
        assert_eq!(display_name_results[0].label, "打开 Actual Tool");

        let bundle_results =
            search_local_apps_in_roots(&[temp.path().to_path_buf()], "com example actual", 10);
        assert_eq!(bundle_results.len(), 1);
        assert_eq!(bundle_results[0].label, "打开 Actual Tool");
        assert_eq!(bundle_results[0].match_type, "alias");

        let executable_results =
            search_local_apps_in_roots(&[temp.path().to_path_buf()], "actuald", 10);
        assert_eq!(executable_results.len(), 1);
        assert_eq!(executable_results[0].label, "打开 Actual Tool");
        assert_eq!(executable_results[0].match_type, "alias");
    }

    #[test]
    fn local_app_search_reads_icon_from_info_plist_without_extension() {
        let temp = TempDir::new().unwrap();
        let app = temp.path().join("Iconic.app");
        let contents = app.join("Contents");
        let resources = contents.join("Resources");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(
            contents.join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
</dict>
</plist>"#,
        )
        .unwrap();
        std::fs::write(resources.join("AppIcon.icns"), "icon").unwrap();

        let results = search_local_apps_in_roots(&[temp.path().to_path_buf()], "iconic", 10);

        assert_eq!(results.len(), 1);
        assert!(results[0]
            .icon
            .as_deref()
            .is_some_and(|icon| icon.ends_with("Iconic.app/Contents/Resources/AppIcon.icns")));
    }

    #[test]
    fn local_app_search_leaves_icon_empty_when_declared_resource_is_missing() {
        let temp = TempDir::new().unwrap();
        let app = temp.path().join("NoIcon.app");
        let contents = app.join("Contents");
        std::fs::create_dir_all(&contents).unwrap();
        std::fs::write(
            contents.join("Info.plist"),
            r#"<plist><dict><key>CFBundleIconFile</key><string>MissingIcon.icns</string></dict></plist>"#,
        )
        .unwrap();

        let results = search_local_apps_in_roots(&[temp.path().to_path_buf()], "noicon", 10);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].icon, None);
    }

    #[test]
    fn shell_open_target_detects_urls() {
        assert_eq!(
            shell_open_target("https://example.com"),
            ShellOpenTarget::Url("https://example.com")
        );
        assert_eq!(
            shell_open_target("mailto:hello@example.com"),
            ShellOpenTarget::Url("mailto:hello@example.com")
        );
    }

    #[test]
    fn shell_open_target_detects_local_paths() {
        assert_eq!(
            shell_open_target("/Applications/Terminal.app"),
            ShellOpenTarget::Path("/Applications/Terminal.app")
        );
        assert_eq!(
            shell_open_target("relative/file.txt"),
            ShellOpenTarget::Path("relative/file.txt")
        );
    }

    #[test]
    fn shell_open_target_trims_input() {
        assert_eq!(
            shell_open_target("  file:///tmp/example.txt  "),
            ShellOpenTarget::Url("file:///tmp/example.txt")
        );
        assert_eq!(
            shell_open_target("  /tmp/example.txt  "),
            ShellOpenTarget::Path("/tmp/example.txt")
        );
    }

    #[test]
    fn runtime_diagnostics_snapshot_reports_paths_counts_mcp_and_events() {
        let temp = TempDir::new().unwrap();
        let config = AppConfig::with_base_dir(temp.path().join("atools-data"));
        let db = Arc::new(Database::in_memory().unwrap());
        crate::agent_tools::sync_builtin_tools(&db).unwrap();
        let events = vec![
            RuntimeEvent::new("info", "ATools started"),
            RuntimeEvent::new("error", "Failed to load builtin plugin json-viewer"),
        ];
        let mcp = crate::mcp_server::McpServerStatus {
            enabled: true,
            bind: "127.0.0.1:17321".to_string(),
            token: "secret-token".to_string(),
        };

        let snapshot = runtime_diagnostics_snapshot(
            &config,
            &db,
            Some(mcp),
            Some("json-viewer".to_string()),
            &events,
        )
        .unwrap();

        assert_eq!(snapshot.base_dir, config.base_dir().to_string_lossy());
        assert_eq!(snapshot.db_path, config.db_path().to_string_lossy());
        assert_eq!(snapshot.plugins_dir, config.plugins_dir().to_string_lossy());
        assert_eq!(snapshot.plugin_count, 0);
        assert_eq!(snapshot.feature_count, 0);
        assert_eq!(snapshot.agent_tool_count, 8);
        assert_eq!(snapshot.enabled_agent_tool_count, 8);
        assert!(db.get_agent_tool("ask_ai_model").unwrap().is_some());
        assert_eq!(snapshot.mcp_bind.as_deref(), Some("127.0.0.1:17321"));
        assert_eq!(snapshot.active_plugin.as_deref(), Some("json-viewer"));
        assert_eq!(snapshot.recent_events.len(), 2);
        assert_eq!(snapshot.recent_events[1].level, "error");
    }
}

// --- Helpers ---

pub(crate) fn acquire_plugin_mutation_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    PLUGIN_MUTATION_LOCK
        .lock()
        .map_err(|_| "Plugin mutation lock poisoned".to_string())
}

pub(crate) fn stage_plugin_directory(
    source_dir: &std::path::Path,
    install_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    reject_symlink_path(source_dir, "Plugin source")?;
    if !source_dir.is_dir() {
        return Err(format!(
            "Plugin source is not a directory: {}",
            source_dir.display()
        ));
    }
    if std::fs::symlink_metadata(install_dir).is_ok() {
        reject_symlink_path(install_dir, "Plugin destination")?;
        if !install_dir.is_dir() {
            return Err(format!(
                "Plugin destination is not a directory: {}",
                install_dir.display()
            ));
        }
    }
    let parent = install_dir.parent().ok_or_else(|| {
        format!(
            "Plugin destination has no parent: {}",
            install_dir.display()
        )
    })?;
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create plugin destination parent {}: {error}",
            parent.display()
        )
    })?;
    reject_symlink_path(parent, "Plugin destination parent")?;

    let staged_dir = unique_plugin_sibling_path(install_dir, "stage")?;
    std::fs::create_dir(&staged_dir).map_err(|error| {
        format!(
            "Failed to create staged plugin directory {}: {error}",
            staged_dir.display()
        )
    })?;
    if let Err(error) = copy_dir_recursive(source_dir, &staged_dir) {
        let _ = std::fs::remove_dir_all(&staged_dir);
        return Err(error.to_string());
    }
    Ok(staged_dir)
}

pub(crate) fn replace_plugin_directory_transactionally<T>(
    staged_dir: &std::path::Path,
    install_dir: &std::path::Path,
    persist: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let backup_dir = if std::fs::symlink_metadata(install_dir).is_ok() {
        reject_symlink_path(install_dir, "Plugin destination")?;
        let backup_dir = unique_plugin_sibling_path(install_dir, "backup")?;
        std::fs::rename(install_dir, &backup_dir).map_err(|error| {
            let _ = std::fs::remove_dir_all(staged_dir);
            format!(
                "Failed to move existing plugin {} to rollback directory: {error}",
                install_dir.display()
            )
        })?;
        Some(backup_dir)
    } else {
        None
    };

    if let Err(error) = std::fs::rename(staged_dir, install_dir) {
        if let Some(backup_dir) = backup_dir.as_deref() {
            let _ = std::fs::rename(backup_dir, install_dir);
        }
        let _ = std::fs::remove_dir_all(staged_dir);
        return Err(format!(
            "Failed to activate staged plugin {}: {error}",
            install_dir.display()
        ));
    }

    match persist() {
        Ok(value) => {
            if let Some(backup_dir) = backup_dir {
                if let Err(error) = std::fs::remove_dir_all(&backup_dir) {
                    tracing::warn!(
                        "Failed to remove plugin rollback directory {}: {}",
                        backup_dir.display(),
                        error
                    );
                }
            }
            Ok(value)
        }
        Err(error) => {
            let failed_dir = unique_plugin_sibling_path(install_dir, "failed").ok();
            let live_removed = match failed_dir.as_deref() {
                Some(failed_dir) => std::fs::rename(install_dir, failed_dir),
                None => std::fs::remove_dir_all(install_dir),
            };
            if let Err(rollback_error) = live_removed {
                return Err(format!(
                    "{error}; failed to move rejected plugin bytes out of service: {rollback_error}"
                ));
            }
            if let Some(backup_dir) = backup_dir.as_deref() {
                if let Err(rollback_error) = std::fs::rename(backup_dir, install_dir) {
                    return Err(format!(
                        "{error}; failed to restore previous plugin bytes: {rollback_error}"
                    ));
                }
            }
            if let Some(failed_dir) = failed_dir {
                let _ = std::fs::remove_dir_all(failed_dir);
            }
            Err(error)
        }
    }
}

fn uninstall_plugin_files_transactionally<T>(
    plugin_dir: &std::path::Path,
    persist_delete: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    match std::fs::symlink_metadata(plugin_dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Plugin uninstall path must not be a symlink: {}",
                    plugin_dir.display()
                ));
            }
            if !metadata.is_dir() {
                return Err(format!(
                    "Plugin uninstall path is not a directory: {}",
                    plugin_dir.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return persist_delete(),
        Err(error) => {
            return Err(format!(
                "Failed to inspect plugin uninstall path {}: {error}",
                plugin_dir.display()
            ));
        }
    }

    let quarantine_dir = unique_plugin_sibling_path(plugin_dir, "uninstall")?;
    std::fs::rename(plugin_dir, &quarantine_dir).map_err(|error| {
        format!(
            "Failed to move plugin {} into uninstall quarantine: {error}",
            plugin_dir.display()
        )
    })?;

    match persist_delete() {
        Ok(value) => {
            if let Err(error) = std::fs::remove_dir_all(&quarantine_dir) {
                tracing::warn!(
                    "Plugin database record was removed but uninstall quarantine {} could not be deleted: {}",
                    quarantine_dir.display(),
                    error
                );
            }
            Ok(value)
        }
        Err(error) => {
            if let Err(rollback_error) = std::fs::rename(&quarantine_dir, plugin_dir) {
                return Err(format!(
                    "{error}; failed to restore plugin directory after uninstall rollback: {rollback_error}"
                ));
            }
            Err(error)
        }
    }
}

fn unique_plugin_sibling_path(
    install_dir: &std::path::Path,
    kind: &str,
) -> Result<std::path::PathBuf, String> {
    let parent = install_dir
        .parent()
        .ok_or_else(|| format!("Plugin path has no parent: {}", install_dir.display()))?;
    let name = install_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Plugin path has an invalid name: {}", install_dir.display()))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    for attempt in 0..100_u8 {
        let candidate = parent.join(format!(
            ".{name}.{kind}-{}-{nonce}-{attempt}",
            std::process::id()
        ));
        if std::fs::symlink_metadata(&candidate).is_err() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Could not allocate a unique plugin {kind} path for {}",
        install_dir.display()
    ))
}

fn reject_symlink_path(path: &std::path::Path, label: &str) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{label} must not be a symlink: {}", path.display()));
    }
    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let metadata = std::fs::symlink_metadata(&src_path)?;
        if metadata.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("Plugin source contains symlink: {}", src_path.display()),
            ));
        }
        if metadata.is_dir() {
            std::fs::create_dir(&dst_path)?;
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if metadata.is_file() {
            std::fs::copy(&src_path, &dst_path)?;
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "Plugin source contains unsupported filesystem entry: {}",
                    src_path.display()
                ),
            ));
        }
    }
    Ok(())
}

fn macos_open_reveal_args(path: &str) -> Vec<String> {
    vec!["-R".to_string(), path.to_string()]
}

fn macos_screencapture_args(output_path: Option<&str>) -> Vec<String> {
    let mut args = vec!["-i".to_string()];
    if let Some(path) = output_path {
        args.push(path.to_string());
    } else {
        args.push("-c".to_string());
    }
    args
}

fn macos_current_browser_url_script() -> &'static str {
    r#"
set frontApp to ""
tell application "System Events" to set frontApp to name of first application process whose frontmost is true
if frontApp is "Google Chrome" or frontApp is "Chromium" or frontApp is "Microsoft Edge" then
  tell application frontApp to return URL of active tab of front window
else if frontApp is "Safari" then
  tell application "Safari" to return URL of front document
else
  return ""
end if
"#
}

fn macos_current_folder_path_script() -> &'static str {
    r#"
tell application "Finder"
  if (count of Finder windows) is 0 then
    return POSIX path of (path to desktop)
  end if
  return POSIX path of (target of front Finder window as alias)
end tell
"#
}

fn macos_frontmost_app_name_script() -> &'static str {
    r#"tell application "System Events" to get name of first application process whose frontmost is true"#
}

fn run_native_command(program: &str, args: &[String]) -> Result<String, String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| native_command_error(program, &e.to_string()))?;

    if output.status.success() {
        String::from_utf8(output.stdout).map_err(|e| native_command_error(program, &e.to_string()))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(native_command_error(program, stderr.trim()))
    }
}

fn native_command_error(operation: &str, detail: &str) -> String {
    if detail.trim().is_empty() {
        format!("{} failed", operation)
    } else {
        format!("{} failed: {}", operation, detail.trim())
    }
}

fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !clean.len().is_multiple_of(4) {
        return None;
    }

    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    for chunk in clean.chunks(4) {
        let a = base64_value(chunk[0])?;
        let b = base64_value(chunk[1])?;
        let c = if chunk[2] == b'=' {
            64
        } else {
            base64_value(chunk[2])?
        };
        let d = if chunk[3] == b'=' {
            64
        } else {
            base64_value(chunk[3])?
        };

        out.push((a << 2) | (b >> 4));
        if c != 64 {
            out.push(((b & 0b0000_1111) << 4) | (c >> 2));
        }
        if d != 64 {
            out.push(((c & 0b0000_0011) << 6) | d);
        }
    }
    Some(out)
}

fn encode_base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);

        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(b2 & 0b0011_1111) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}
