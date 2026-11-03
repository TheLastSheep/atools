//! Exact-ID lookup of published releases from the fixed official ZTools source.

use crate::commands::{PluginMarketCatalogPlugin, PluginMarketCatalogSourceKind};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const OFFICIAL_SOURCE: &str = "https://z-tools.top/api/market";
const LATEST_ENDPOINT: &str = "https://z-tools.top/api/market/plugins/latest";
const DOWNLOAD_ENDPOINT: &str = "https://z-tools.top/api/market/plugins/download";
const MAX_PLUGIN_ID_BYTES: usize = 256;
const MAX_VERSION_BYTES: usize = 128;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OfficialPluginTargetStatus {
    Available,
    NotFound,
    UnsupportedPlatform,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OfficialPluginTargetLookup {
    pub plugin_id: String,
    pub source_url: String,
    pub source_kind: PluginMarketCatalogSourceKind,
    pub status: OfficialPluginTargetStatus,
    pub plugin: Option<PluginMarketCatalogPlugin>,
}

// This endpoint has a top-level envelope, not the catalog or a data wrapper.
// Additive metadata is allowed; explicit failure signals are checked separately.
#[derive(Deserialize)]
struct RawTargetLookup {
    available: bool,
    reason: Option<String>,
    plugin: Option<RawTargetPlugin>,
}

#[derive(Deserialize)]
struct RawTargetPlugin {
    name: String,
    version: String,
    title: Option<String>,
    description: Option<String>,
    logo: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<Value>,
}

/// Read release metadata only. Package resolution and installation remain separate operations.
#[tauri::command]
pub async fn fetch_official_plugin_target(
    plugin_id: String,
) -> Result<OfficialPluginTargetLookup, String> {
    let plugin_id = validate_plugin_id(&plugin_id)?;
    let request_url = latest_url(&plugin_id, current_platform())?;
    let raw = crate::plugin_market_http::fetch_json_metadata(&request_url)
        .await
        .map_err(|error| format!("Official plugin target lookup failed: {error}"))?;
    normalize_target_lookup(&plugin_id, raw)
}

fn validate_plugin_id(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Plugin ID must not contain control characters".to_string());
    }
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_PLUGIN_ID_BYTES {
        return Err(format!(
            "Plugin ID must contain 1 to {MAX_PLUGIN_ID_BYTES} UTF-8 bytes"
        ));
    }
    Ok(value.to_string())
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

fn latest_url(plugin_id: &str, platform: &str) -> Result<Url, String> {
    let mut url = fixed_url(LATEST_ENDPOINT)?;
    url.query_pairs_mut()
        .append_pair("name", plugin_id)
        .append_pair("platform", platform);
    Ok(url)
}

#[cfg(feature = "market-metadata-probe")]
pub(crate) fn official_target_probe_url(plugin_id: &str) -> Result<Url, String> {
    let plugin_id = validate_plugin_id(plugin_id)?;
    latest_url(&plugin_id, current_platform())
}

fn download_resolver_url(plugin_id: &str) -> Result<String, String> {
    let mut url = fixed_url(DOWNLOAD_ENDPOINT)?;
    url.query_pairs_mut().append_pair("name", plugin_id);
    Ok(url.to_string())
}

fn fixed_url(endpoint: &str) -> Result<Url, String> {
    Url::parse(endpoint).map_err(|error| format!("Invalid official market endpoint: {error}"))
}

fn normalize_target_lookup(
    plugin_id: &str,
    raw: Value,
) -> Result<OfficialPluginTargetLookup, String> {
    reject_error_envelope(&raw)?;
    let raw: RawTargetLookup = serde_json::from_value(raw)
        .map_err(|error| format!("Invalid official plugin target response: {error}"))?;
    let (status, plugin) = if raw.available {
        if raw.reason.is_some() {
            return Err("Available official plugin response must not include a reason".to_string());
        }
        let plugin = raw
            .plugin
            .ok_or_else(|| "Available official plugin response has no plugin".to_string())?;
        (
            OfficialPluginTargetStatus::Available,
            Some(normalize_target_plugin(plugin_id, plugin)?),
        )
    } else {
        if raw.plugin.is_some() {
            return Err(
                "Unavailable official plugin response must not include a plugin".to_string(),
            );
        }
        let status = match raw.reason.as_deref() {
            Some("not_found") => OfficialPluginTargetStatus::NotFound,
            Some("unsupported_platform") => OfficialPluginTargetStatus::UnsupportedPlatform,
            _ => {
                return Err("Official plugin response has an unknown unavailable reason".to_string())
            }
        };
        (status, None)
    };
    Ok(OfficialPluginTargetLookup {
        plugin_id: plugin_id.to_string(),
        source_url: OFFICIAL_SOURCE.to_string(),
        source_kind: PluginMarketCatalogSourceKind::Ztools,
        status,
        plugin,
    })
}

fn reject_error_envelope(raw: &Value) -> Result<(), String> {
    if raw
        .get("success")
        .is_some_and(|value| value != &Value::Bool(true))
    {
        return Err("Official plugin response reports an unsuccessful request".to_string());
    }
    for field in ["errorCode", "error_code", "resultCode", "result_code"] {
        if let Some(value) = raw.get(field) {
            let zero_or_absent = match value {
                Value::Null => true,
                Value::Number(number) => number.as_i64() == Some(0),
                Value::String(text) => text.trim() == "0",
                _ => false,
            };
            if !zero_or_absent {
                return Err(format!(
                    "Official plugin response reports a nonzero {field}"
                ));
            }
        }
    }
    for field in ["error", "errors"] {
        if raw.get(field).is_some_and(|value| match value {
            Value::Null | Value::Bool(false) => false,
            Value::String(text) => !text.trim().is_empty(),
            Value::Array(items) => !items.is_empty(),
            _ => true,
        }) {
            return Err("Official plugin response contains an error".to_string());
        }
    }
    if raw.get("code").is_some_and(|value| {
        let text = match value {
            Value::Number(number) => number.to_string(),
            Value::String(text) => text.trim().to_ascii_lowercase(),
            _ => return false,
        };
        text.parse::<i64>()
            .is_ok_and(|code| code < 0 || code >= 400)
            || matches!(
                text.as_str(),
                "error"
                    | "failed"
                    | "failure"
                    | "unauthorized"
                    | "forbidden"
                    | "not_found"
                    | "internal_server_error"
            )
    }) {
        return Err("Official plugin response reports an error code".to_string());
    }
    Ok(())
}

fn normalize_target_plugin(
    plugin_id: &str,
    raw: RawTargetPlugin,
) -> Result<PluginMarketCatalogPlugin, String> {
    // Never accept a title, differently-cased ID, or trimmed returned ID as identity.
    if raw.name != plugin_id {
        return Err(
            "Official plugin response ID does not exactly match the requested ID".to_string(),
        );
    }
    if raw.version.chars().any(char::is_control) {
        return Err("Official plugin version contains control characters".to_string());
    }
    let version = raw.version.trim();
    if version.is_empty() || version.len() > MAX_VERSION_BYTES {
        return Err(format!(
            "Official plugin version must contain 1 to {MAX_VERSION_BYTES} UTF-8 bytes"
        ));
    }
    let updated_at = match raw.updated_at {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => optional_text(value),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(_) => return Err("Official plugin updatedAt must be text or a number".to_string()),
    };
    Ok(PluginMarketCatalogPlugin {
        id: plugin_id.to_string(),
        name: raw
            .title
            .and_then(optional_text)
            .unwrap_or_else(|| plugin_id.to_string()),
        version: version.to_string(),
        description: raw.description.and_then(optional_text).unwrap_or_default(),
        author: None,
        download_url: None,
        download_resolver_url: Some(download_resolver_url(plugin_id)?),
        trust_policy: "official_ztools_confirm".to_string(),
        checksum: None,
        rating: None,
        rating_count: None,
        downloads: None,
        updated_at,
        publisher: None,
        publisher_url: None,
        signature: None,
        public_key: None,
        homepage: None,
        logo: raw.logo.and_then(optional_http_url),
        category: None,
        package_size: None,
    })
}

fn optional_text(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn optional_http_url(value: String) -> Option<String> {
    let value = optional_text(value)?;
    let parsed = Url::parse(&value).ok()?;
    (matches!(parsed.scheme(), "http" | "https")
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none())
    .then_some(value)
}

#[cfg(test)]
#[path = "plugin_market_target_tests.rs"]
mod tests;
