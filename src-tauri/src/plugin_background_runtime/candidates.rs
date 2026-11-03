//! Stable, bounded description of plugins whose own preference requests startup.
use atools_core::{harness::canonicalize_json, models::Plugin, Database};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

const MAX_CANDIDATES: usize = 128;
const DEFAULT_HEIGHT: u32 = 541;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    pub(crate) plugin_id: String,
    pub(crate) plugin_name: String,
    pub(crate) code_revision: String,
    pub(crate) action: crate::commands::FeatureAction,
}

pub(super) fn list(db: &Database) -> Result<Vec<Candidate>, String> {
    let mut plugins = db
        .list_plugins()
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_UNAVAILABLE")?;
    plugins.sort_by(|left, right| {
        left.manifest
            .name
            .cmp(&right.manifest.name)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut candidates = Vec::new();
    for plugin in plugins {
        if !supported(&plugin) || !requested(db, &plugin)? {
            continue;
        }
        candidates.push(Candidate {
            plugin_id: plugin.id.clone(),
            plugin_name: plugin.display_name().to_string(),
            code_revision: code_revision(db, &plugin)?,
            action: boot_action(&plugin),
        });
        if candidates.len() == MAX_CANDIDATES {
            break;
        }
    }
    Ok(candidates)
}

pub(super) fn validate_current(
    db: &Database,
    plugin_id: &str,
    expected_revision: &str,
    require_requested: bool,
) -> Result<Plugin, String> {
    let plugin = db
        .get_plugin(plugin_id)
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_OWNER_CHANGED")?;
    if !supported(&plugin)
        || code_revision(db, &plugin)? != expected_revision
        || (require_requested && !requested(db, &plugin)?)
    {
        return Err("ERR_PLUGIN_BACKGROUND_OWNER_CHANGED".into());
    }
    Ok(plugin)
}

pub(super) fn requested(db: &Database, plugin: &Plugin) -> Result<bool, String> {
    let name = plugin.manifest.name.trim();
    if name.is_empty() {
        return Ok(false);
    }
    let value = db
        .plugin_storage_get(
            plugin.id.as_str(),
            crate::plugin_data_runtime::BACKGROUND_STARTUP_KEY,
        )
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_PREFERENCE_UNAVAILABLE")?;
    Ok(value.as_array().is_some_and(|names| {
        names.len() == 1 && names.first().and_then(Value::as_str) == Some(name)
    }))
}

pub(super) fn code_revision(db: &Database, plugin: &Plugin) -> Result<String, String> {
    let value = json!({
        "plugin": plugin,
        "codeRevision": crate::plugin_code_revision::current(db, &plugin.id)
            .map_err(|_| "ERR_PLUGIN_BACKGROUND_OWNER_CHANGED")?,
    });
    let canonical = canonicalize_json(&value);
    let bytes =
        serde_json::to_vec(&canonical).map_err(|_| "ERR_PLUGIN_BACKGROUND_OWNER_CHANGED")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn supported(plugin: &Plugin) -> bool {
    plugin.enabled
        && platform_matches(&plugin.manifest.platform)
        && (plugin
            .manifest
            .main
            .as_deref()
            .is_some_and(|main| !main.trim().is_empty())
            || plugin
                .manifest
                .preload
                .as_deref()
                .is_some_and(|preload| !preload.trim().is_empty()))
}

fn platform_matches(platforms: &[String]) -> bool {
    let current = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    platforms.is_empty() || platforms.iter().any(|platform| platform == current)
}

pub(super) fn boot_action(plugin: &Plugin) -> crate::commands::FeatureAction {
    crate::commands::FeatureAction {
        plugin_id: plugin.id.clone(),
        plugin_name: plugin.display_name().to_string(),
        feature_code: String::new(),
        feature_label: None,
        feature_label_source: None,
        main_url: plugin.manifest.main.clone().unwrap_or_default(),
        plugin_path: plugin.path.clone(),
        preload_path: plugin.manifest.preload.as_ref().map(|preload| {
            Path::new(&plugin.path)
                .join(preload)
                .to_string_lossy()
                .into_owned()
        }),
        expand_height: DEFAULT_HEIGHT,
        auto_detach: false,
        plugin_permissions: normalized_permissions(&plugin.manifest.permissions),
        plugin_providers: plugin.manifest.providers.clone(),
        payload: Value::Null,
        entry_type: None,
    }
}

fn normalized_permissions(permissions: &[String]) -> Vec<String> {
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
