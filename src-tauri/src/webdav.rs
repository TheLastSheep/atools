use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct WebdavSyncConfig {
    pub url: String,
    pub username: String,
    pub password: String,
    pub remote_path: String,
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavScopeSelection {
    pub settings: bool,
    pub plugins: bool,
    pub clipboard: bool,
}

#[derive(Debug, Clone)]
pub struct WebdavSyncSnapshot {
    pub settings: Value,
    pub plugin_data: Value,
    pub clipboard_history: Value,
    pub scopes: WebdavScopeSelection,
}

#[derive(Debug, Clone)]
pub struct WebdavFile {
    pub name: String,
    pub bytes: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavUploadedFile {
    pub name: String,
    pub url: String,
    pub bytes: usize,
    pub status: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavSyncSummary {
    pub status: String,
    pub remote_path: String,
    pub files_uploaded: Vec<WebdavUploadedFile>,
    pub uploaded_bytes: usize,
    pub remote_manifest_verified: bool,
    pub remote_manifest_bytes: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavPreviewFile {
    pub name: String,
    pub url: String,
    pub declared_bytes: Option<usize>,
    pub downloaded_bytes: usize,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavBackupPreview {
    pub status: String,
    pub remote_path: String,
    pub manifest_kind: Option<String>,
    pub exported_at: Option<String>,
    pub files: Vec<WebdavPreviewFile>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct WebdavRestoreLocalSnapshot {
    pub settings: Value,
    pub plugin_data: Value,
    pub clipboard_history: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavPluginDataConflictDocument {
    pub plugin_id: String,
    pub plugin_name: String,
    pub doc_id: String,
    pub local_summary: String,
    pub remote_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavRestorePlanItem {
    pub scope: String,
    pub file_name: String,
    pub action: String,
    pub local_summary: String,
    pub remote_summary: String,
    pub changed_keys: Vec<String>,
    pub skipped_keys: Vec<String>,
    pub plugin_conflicts: Vec<WebdavPluginDataConflictDocument>,
    pub high_risk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavRestorePlan {
    pub status: String,
    pub remote_path: String,
    pub manifest_kind: Option<String>,
    pub exported_at: Option<String>,
    pub items: Vec<WebdavRestorePlanItem>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebdavSettingsRestoreResult {
    pub status: String,
    pub remote_path: String,
    pub manifest_kind: Option<String>,
    pub exported_at: Option<String>,
    pub applied_keys: Vec<String>,
    pub skipped_keys: Vec<String>,
    pub merged_settings: Value,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavClipboardRestoreEntry {
    pub text: String,
    pub copied_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebdavClipboardRestorePlan {
    pub status: String,
    pub remote_path: String,
    pub manifest_kind: Option<String>,
    pub exported_at: Option<String>,
    pub remote_entries: usize,
    pub skipped_entries: usize,
    pub entries: Vec<WebdavClipboardRestoreEntry>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebdavPluginDataRestorePlan {
    pub status: String,
    pub remote_path: String,
    pub manifest_kind: Option<String>,
    pub exported_at: Option<String>,
    pub plugin_data: Value,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
struct WebdavDownloadedFile {
    name: String,
    url: String,
    declared_bytes: Option<usize>,
    downloaded_bytes: usize,
    payload: Value,
}

#[derive(Debug, Clone)]
struct WebdavDownloadedBackup {
    manifest: Value,
    files: Vec<WebdavDownloadedFile>,
}

pub async fn sync_webdav_snapshot(
    config: WebdavSyncConfig,
    snapshot: WebdavSyncSnapshot,
) -> Result<WebdavSyncSummary, String> {
    validate_webdav_config(&config)?;
    let files = build_webdav_files(snapshot)?;
    let started = Instant::now();
    let client = webdav_client(&config)?;

    for dir_url in webdav_directory_urls(&config.url, &config.remote_path)? {
        let status = send_webdav_request(&client, &config, mkcol_method()?, &dir_url, None).await?;
        if !(status.is_success()
            || status == StatusCode::METHOD_NOT_ALLOWED
            || status == StatusCode::CONFLICT)
        {
            return Err(format!(
                "WebDAV MKCOL failed for {dir_url}: HTTP {}",
                status.as_u16()
            ));
        }
    }

    let mut uploaded = Vec::new();
    for file in &files {
        let file_url = webdav_file_url(&config.url, &config.remote_path, &file.name)?;
        let status = send_webdav_request(
            &client,
            &config,
            Method::PUT,
            &file_url,
            Some((file.bytes.clone(), file.content_type.as_str())),
        )
        .await?;
        if !status.is_success() {
            return Err(format!(
                "WebDAV upload failed for {}: HTTP {}",
                file.name,
                status.as_u16()
            ));
        }
        uploaded.push(WebdavUploadedFile {
            name: file.name.clone(),
            url: file_url,
            bytes: file.bytes.len(),
            status: status.as_u16(),
        });
    }

    let manifest_url = webdav_file_url(&config.url, &config.remote_path, "manifest.json")?;
    let manifest_response = client
        .get(&manifest_url)
        .basic_auth(&config.username, Some(&config.password))
        .send()
        .await
        .map_err(|error| format!("WebDAV manifest verification failed: {error}"))?;
    let manifest_status = manifest_response.status();
    if !manifest_status.is_success() {
        return Err(format!(
            "WebDAV manifest verification failed: HTTP {}",
            manifest_status.as_u16()
        ));
    }
    let manifest_bytes = manifest_response
        .bytes()
        .await
        .map_err(|error| format!("WebDAV manifest verification body failed: {error}"))?
        .len();

    Ok(WebdavSyncSummary {
        status: "ok".to_string(),
        remote_path: normalize_remote_path(&config.remote_path),
        uploaded_bytes: uploaded.iter().map(|file| file.bytes).sum(),
        files_uploaded: uploaded,
        remote_manifest_verified: manifest_bytes > 0,
        remote_manifest_bytes: manifest_bytes,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub async fn preview_webdav_backup(
    config: WebdavSyncConfig,
) -> Result<WebdavBackupPreview, String> {
    let started = Instant::now();
    let backup = download_webdav_backup(&config).await?;

    Ok(WebdavBackupPreview {
        status: "ok".to_string(),
        remote_path: normalize_remote_path(&config.remote_path),
        manifest_kind: backup
            .manifest
            .get("kind")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        exported_at: backup
            .manifest
            .get("exportedAt")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        files: backup
            .files
            .into_iter()
            .map(|file| WebdavPreviewFile {
                name: file.name.clone(),
                url: file.url,
                declared_bytes: file.declared_bytes,
                downloaded_bytes: file.downloaded_bytes,
                summary: preview_file_summary(&file.name, &file.payload),
            })
            .collect(),
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub async fn plan_webdav_restore(
    config: WebdavSyncConfig,
    local: WebdavRestoreLocalSnapshot,
) -> Result<WebdavRestorePlan, String> {
    let started = Instant::now();
    let backup = download_webdav_backup(&config).await?;
    let mut items = Vec::new();
    for file in &backup.files {
        items.push(restore_plan_item(file, &local));
    }

    Ok(WebdavRestorePlan {
        status: "ready".to_string(),
        remote_path: normalize_remote_path(&config.remote_path),
        manifest_kind: backup
            .manifest
            .get("kind")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        exported_at: backup
            .manifest
            .get("exportedAt")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        items,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub async fn restore_webdav_settings(
    config: WebdavSyncConfig,
    local_settings: Value,
    confirmed: bool,
) -> Result<WebdavSettingsRestoreResult, String> {
    if !confirmed {
        return Err("WebDAV settings restore requires explicit confirmation".to_string());
    }

    let started = Instant::now();
    let (manifest, remote_settings) = download_webdav_settings_backup(&config).await?;
    let (merged_settings, applied_keys, skipped_keys) =
        merge_webdav_settings(local_settings, remote_settings.payload)?;

    Ok(WebdavSettingsRestoreResult {
        status: if applied_keys.is_empty() {
            "unchanged".to_string()
        } else {
            "applied".to_string()
        },
        remote_path: normalize_remote_path(&config.remote_path),
        manifest_kind: manifest
            .get("kind")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        exported_at: manifest
            .get("exportedAt")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        applied_keys,
        skipped_keys,
        merged_settings,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub async fn restore_webdav_clipboard_history(
    config: WebdavSyncConfig,
    confirmed: bool,
) -> Result<WebdavClipboardRestorePlan, String> {
    if !confirmed {
        return Err("WebDAV clipboard restore requires explicit confirmation".to_string());
    }

    let started = Instant::now();
    let (manifest, remote_clipboard) = download_webdav_clipboard_backup(&config).await?;
    let (remote_entries, skipped_entries, entries) =
        clipboard_restore_entries(&remote_clipboard.payload);

    Ok(WebdavClipboardRestorePlan {
        status: "ready".to_string(),
        remote_path: normalize_remote_path(&config.remote_path),
        manifest_kind: manifest
            .get("kind")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        exported_at: manifest
            .get("exportedAt")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        remote_entries,
        skipped_entries,
        entries,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub async fn restore_webdav_plugin_data(
    config: WebdavSyncConfig,
    confirmed: bool,
) -> Result<WebdavPluginDataRestorePlan, String> {
    if !confirmed {
        return Err("WebDAV plugin data restore requires explicit confirmation".to_string());
    }

    let started = Instant::now();
    let (manifest, remote_plugin_data) = download_webdav_plugin_data_backup(&config).await?;

    Ok(WebdavPluginDataRestorePlan {
        status: "ready".to_string(),
        remote_path: normalize_remote_path(&config.remote_path),
        manifest_kind: manifest
            .get("kind")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        exported_at: manifest
            .get("exportedAt")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        plugin_data: remote_plugin_data.payload,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub fn build_webdav_files(snapshot: WebdavSyncSnapshot) -> Result<Vec<WebdavFile>, String> {
    if !snapshot.scopes.settings && !snapshot.scopes.plugins && !snapshot.scopes.clipboard {
        return Err("WebDAV sync scope is empty".to_string());
    }

    let mut payloads: Vec<(String, Value)> = Vec::new();
    if snapshot.scopes.settings {
        payloads.push((
            "settings.json".to_string(),
            redact_secrets(snapshot.settings),
        ));
    }
    if snapshot.scopes.plugins {
        payloads.push(("plugin-data.json".to_string(), snapshot.plugin_data));
    }
    if snapshot.scopes.clipboard {
        payloads.push((
            "clipboard-history.json".to_string(),
            snapshot.clipboard_history,
        ));
    }

    let manifest = serde_json::json!({
        "version": 1,
        "kind": "atools-webdav-sync",
        "app": "ATools",
        "exportedAt": atools_core::utils::now_iso(),
        "scopes": snapshot.scopes,
        "files": payloads.iter().map(|(name, payload)| serde_json::json!({
            "name": name,
            "bytes": serde_json::to_vec_pretty(payload).map(|bytes| bytes.len()).unwrap_or(0),
        })).collect::<Vec<_>>(),
    });

    let mut files = vec![json_file("manifest.json", manifest)?];
    for (name, payload) in payloads {
        files.push(json_file(&name, payload)?);
    }
    Ok(files)
}

pub fn webdav_directory_urls(base_url: &str, remote_path: &str) -> Result<Vec<String>, String> {
    let segments = remote_segments(remote_path);
    let mut urls = Vec::new();
    for index in 0..segments.len() {
        urls.push(webdav_url(base_url, &segments[..=index], None)?);
    }
    Ok(urls)
}

pub fn webdav_file_url(
    base_url: &str,
    remote_path: &str,
    file_name: &str,
) -> Result<String, String> {
    webdav_url(base_url, &remote_segments(remote_path), Some(file_name))
}

pub fn validate_webdav_config(config: &WebdavSyncConfig) -> Result<(), String> {
    let url =
        Url::parse(config.url.trim()).map_err(|error| format!("Invalid WebDAV URL: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("WebDAV URL must use http or https".to_string());
    }
    if config.username.trim().is_empty() {
        return Err("WebDAV username is required".to_string());
    }
    if remote_segments(&config.remote_path).is_empty() {
        return Err("WebDAV remote path is required".to_string());
    }
    validate_webdav_proxy_url(config.proxy_url.as_deref())?;
    Ok(())
}

fn validate_webdav_proxy_url(proxy_url: Option<&str>) -> Result<(), String> {
    let Some(proxy_url) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let url =
        Url::parse(proxy_url).map_err(|error| format!("Invalid network proxy URL: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Network proxy URL must use http or https".to_string());
    }
    Ok(())
}

fn webdav_client(config: &WebdavSyncConfig) -> Result<Client, String> {
    let mut builder = Client::builder().timeout(Duration::from_secs(30));
    if let Some(proxy_url) = config
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy_url)
                .map_err(|error| format!("Invalid network proxy URL: {error}"))?,
        );
    }
    builder
        .build()
        .map_err(|error| format!("Failed to create WebDAV client: {error}"))
}

async fn send_webdav_request(
    client: &Client,
    config: &WebdavSyncConfig,
    method: Method,
    url: &str,
    body: Option<(Vec<u8>, &str)>,
) -> Result<StatusCode, String> {
    let mut request = client
        .request(method.clone(), url)
        .basic_auth(&config.username, Some(&config.password));
    if let Some((bytes, content_type)) = body {
        request = request.header("Content-Type", content_type).body(bytes);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("WebDAV {} failed for {url}: {error}", method.as_str()))?;
    Ok(response.status())
}

async fn get_webdav_json(
    client: &Client,
    config: &WebdavSyncConfig,
    url: &str,
    label: &str,
) -> Result<Value, String> {
    let response = client
        .get(url)
        .basic_auth(&config.username, Some(&config.password))
        .send()
        .await
        .map_err(|error| format!("WebDAV preview failed for {label}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "WebDAV preview failed for {label}: HTTP {}",
            status.as_u16()
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("WebDAV preview JSON failed for {label}: {error}"))
}

async fn download_webdav_backup(
    config: &WebdavSyncConfig,
) -> Result<WebdavDownloadedBackup, String> {
    validate_webdav_config(config)?;
    let client = webdav_client(config)?;

    let manifest_url = webdav_file_url(&config.url, &config.remote_path, "manifest.json")?;
    let manifest = get_webdav_json(&client, config, &manifest_url, "manifest.json").await?;
    let mut files = Vec::new();
    for file in manifest_file_entries(&manifest) {
        let file_url = webdav_file_url(&config.url, &config.remote_path, &file.name)?;
        let payload = get_webdav_json(&client, config, &file_url, &file.name).await?;
        let downloaded_bytes = serde_json::to_vec(&payload)
            .map_err(|error| format!("Failed to measure {}: {error}", file.name))?
            .len();
        files.push(WebdavDownloadedFile {
            name: file.name,
            url: file_url,
            declared_bytes: file.bytes,
            downloaded_bytes,
            payload,
        });
    }
    Ok(WebdavDownloadedBackup { manifest, files })
}

async fn download_webdav_settings_backup(
    config: &WebdavSyncConfig,
) -> Result<(Value, WebdavDownloadedFile), String> {
    validate_webdav_config(config)?;
    let client = webdav_client(config)?;

    let manifest_url = webdav_file_url(&config.url, &config.remote_path, "manifest.json")?;
    let manifest = get_webdav_json(&client, config, &manifest_url, "manifest.json").await?;
    let settings_entry = manifest_file_entries(&manifest)
        .into_iter()
        .find(|file| file.name == "settings.json")
        .ok_or_else(|| "Remote WebDAV backup does not contain settings.json".to_string())?;
    let settings_url = webdav_file_url(&config.url, &config.remote_path, "settings.json")?;
    let payload = get_webdav_json(&client, config, &settings_url, "settings.json").await?;
    let downloaded_bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("Failed to measure settings.json: {error}"))?
        .len();

    Ok((
        manifest,
        WebdavDownloadedFile {
            name: settings_entry.name,
            url: settings_url,
            declared_bytes: settings_entry.bytes,
            downloaded_bytes,
            payload,
        },
    ))
}

async fn download_webdav_clipboard_backup(
    config: &WebdavSyncConfig,
) -> Result<(Value, WebdavDownloadedFile), String> {
    validate_webdav_config(config)?;
    let client = webdav_client(config)?;

    let manifest_url = webdav_file_url(&config.url, &config.remote_path, "manifest.json")?;
    let manifest = get_webdav_json(&client, config, &manifest_url, "manifest.json").await?;
    let clipboard_entry = manifest_file_entries(&manifest)
        .into_iter()
        .find(|file| file.name == "clipboard-history.json")
        .ok_or_else(|| {
            "Remote WebDAV backup does not contain clipboard-history.json".to_string()
        })?;
    let clipboard_url =
        webdav_file_url(&config.url, &config.remote_path, "clipboard-history.json")?;
    let payload =
        get_webdav_json(&client, config, &clipboard_url, "clipboard-history.json").await?;
    let downloaded_bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("Failed to measure clipboard-history.json: {error}"))?
        .len();

    Ok((
        manifest,
        WebdavDownloadedFile {
            name: clipboard_entry.name,
            url: clipboard_url,
            declared_bytes: clipboard_entry.bytes,
            downloaded_bytes,
            payload,
        },
    ))
}

async fn download_webdav_plugin_data_backup(
    config: &WebdavSyncConfig,
) -> Result<(Value, WebdavDownloadedFile), String> {
    validate_webdav_config(config)?;
    let client = webdav_client(config)?;

    let manifest_url = webdav_file_url(&config.url, &config.remote_path, "manifest.json")?;
    let manifest = get_webdav_json(&client, config, &manifest_url, "manifest.json").await?;
    let plugin_entry = manifest_file_entries(&manifest)
        .into_iter()
        .find(|file| file.name == "plugin-data.json")
        .ok_or_else(|| "Remote WebDAV backup does not contain plugin-data.json".to_string())?;
    let plugin_url = webdav_file_url(&config.url, &config.remote_path, "plugin-data.json")?;
    let payload = get_webdav_json(&client, config, &plugin_url, "plugin-data.json").await?;
    let downloaded_bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("Failed to measure plugin-data.json: {error}"))?
        .len();

    Ok((
        manifest,
        WebdavDownloadedFile {
            name: plugin_entry.name,
            url: plugin_url,
            declared_bytes: plugin_entry.bytes,
            downloaded_bytes,
            payload,
        },
    ))
}

fn merge_webdav_settings(
    local_settings: Value,
    remote_settings: Value,
) -> Result<(Value, Vec<String>, Vec<String>), String> {
    let mut merged = local_settings
        .as_object()
        .cloned()
        .ok_or_else(|| "Local settings must be a JSON object".to_string())?;
    let remote = remote_settings
        .as_object()
        .ok_or_else(|| "Remote settings backup must be a JSON object".to_string())?;
    let mut applied_keys = Vec::new();
    let mut skipped_keys = Vec::new();

    for (key, value) in remote {
        if is_local_only_setting_key(key) || is_redacted_secret_value(value) {
            skipped_keys.push(key.clone());
            continue;
        }
        if merged.get(key) != Some(value) {
            applied_keys.push(key.clone());
        }
        merged.insert(key.clone(), value.clone());
    }

    Ok((Value::Object(merged), applied_keys, skipped_keys))
}

fn clipboard_restore_entries(payload: &Value) -> (usize, usize, Vec<WebdavClipboardRestoreEntry>) {
    let Some(items) = payload.get("entries").and_then(Value::as_array) else {
        return (0, 0, Vec::new());
    };

    let mut entries = Vec::new();
    let mut skipped_entries = 0;
    for item in items {
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if text.is_empty() {
            skipped_entries += 1;
            continue;
        }
        let copied_at = item
            .get("last_copied_at")
            .or_else(|| item.get("first_copied_at"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(atools_core::utils::now_iso);
        entries.push(WebdavClipboardRestoreEntry { text, copied_at });
    }

    (items.len(), skipped_entries, entries)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestFileEntry {
    name: String,
    bytes: Option<usize>,
}

fn manifest_file_entries(manifest: &Value) -> Vec<ManifestFileEntry> {
    manifest
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.trim();
            if name.is_empty() || name.contains('/') {
                return None;
            }
            Some(ManifestFileEntry {
                name: name.to_string(),
                bytes: item
                    .get("bytes")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok()),
            })
        })
        .collect()
}

fn preview_file_summary(name: &str, payload: &Value) -> String {
    match name {
        "settings.json" => {
            let count = payload.as_object().map(|object| object.len()).unwrap_or(0);
            format!("设置备份 · {count} 项")
        }
        "plugin-data.json" => {
            let count = payload
                .get("plugins")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            format!("插件数据 · {count} 个插件")
        }
        "clipboard-history.json" => {
            let count = payload
                .get("entries")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            format!("剪贴板历史 · {count} 条")
        }
        _ => "远端备份文件".to_string(),
    }
}

fn restore_plan_item(
    file: &WebdavDownloadedFile,
    local: &WebdavRestoreLocalSnapshot,
) -> WebdavRestorePlanItem {
    match file.name.as_str() {
        "settings.json" => settings_restore_plan_item(file, &local.settings),
        "plugin-data.json" => plugin_data_restore_plan_item(file, &local.plugin_data),
        "clipboard-history.json" => replace_restore_plan_item(
            "clipboard",
            file,
            &local.clipboard_history,
            "clipboard-history.json",
            true,
        ),
        _ => WebdavRestorePlanItem {
            scope: "unknown".to_string(),
            file_name: file.name.clone(),
            action: "inspect".to_string(),
            local_summary: "未知本地数据".to_string(),
            remote_summary: preview_file_summary(&file.name, &file.payload),
            changed_keys: Vec::new(),
            skipped_keys: Vec::new(),
            plugin_conflicts: Vec::new(),
            high_risk: true,
        },
    }
}

fn settings_restore_plan_item(
    file: &WebdavDownloadedFile,
    local_settings: &Value,
) -> WebdavRestorePlanItem {
    let mut changed_keys = Vec::new();
    let mut skipped_keys = Vec::new();
    let remote_object = file.payload.as_object();
    let local_object = local_settings.as_object();
    let keys = remote_object
        .map(|object| object.keys().cloned().collect::<BTreeSet<_>>())
        .unwrap_or_default();
    for key in keys {
        let remote_value = remote_object.and_then(|object| object.get(&key));
        if is_local_only_setting_key(&key) || remote_value.is_some_and(is_redacted_secret_value) {
            skipped_keys.push(key);
            continue;
        }
        let local_value = local_object.and_then(|object| object.get(&key));
        if remote_value != local_value {
            changed_keys.push(key);
        }
    }

    WebdavRestorePlanItem {
        scope: "settings".to_string(),
        file_name: file.name.clone(),
        action: if changed_keys.is_empty() {
            "unchanged".to_string()
        } else {
            "would_update".to_string()
        },
        local_summary: preview_file_summary("settings.json", local_settings),
        remote_summary: preview_file_summary("settings.json", &file.payload),
        changed_keys,
        skipped_keys,
        plugin_conflicts: Vec::new(),
        high_risk: false,
    }
}

fn plugin_data_restore_plan_item(
    file: &WebdavDownloadedFile,
    local_payload: &Value,
) -> WebdavRestorePlanItem {
    let mut item =
        replace_restore_plan_item("plugins", file, local_payload, "plugin-data.json", true);
    item.plugin_conflicts = plugin_data_conflict_documents(local_payload, &file.payload);
    item
}

fn replace_restore_plan_item(
    scope: &str,
    file: &WebdavDownloadedFile,
    local_payload: &Value,
    summary_name: &str,
    high_risk: bool,
) -> WebdavRestorePlanItem {
    WebdavRestorePlanItem {
        scope: scope.to_string(),
        file_name: file.name.clone(),
        action: if &file.payload == local_payload {
            "unchanged".to_string()
        } else {
            "would_replace".to_string()
        },
        local_summary: preview_file_summary(summary_name, local_payload),
        remote_summary: preview_file_summary(summary_name, &file.payload),
        changed_keys: Vec::new(),
        skipped_keys: Vec::new(),
        plugin_conflicts: Vec::new(),
        high_risk: high_risk && &file.payload != local_payload,
    }
}

fn plugin_data_conflict_documents(
    local_payload: &Value,
    remote_payload: &Value,
) -> Vec<WebdavPluginDataConflictDocument> {
    let mut conflicts = Vec::new();
    let remote_plugins = remote_payload
        .get("plugins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();

    for remote_plugin in remote_plugins {
        let Some(plugin_id) = plugin_data_plugin_id(remote_plugin) else {
            continue;
        };
        let Some(local_plugin) = find_plugin_data_plugin(local_payload, plugin_id) else {
            continue;
        };
        let plugin_name = remote_plugin
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| local_plugin.get("name").and_then(Value::as_str))
            .unwrap_or(plugin_id)
            .to_string();
        let remote_docs = remote_plugin
            .get("documents")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();

        for remote_doc in remote_docs {
            let Some(doc_id) = plugin_data_doc_id(remote_doc) else {
                continue;
            };
            let Some(local_doc) = find_plugin_data_document(local_plugin, doc_id) else {
                continue;
            };
            if local_doc == remote_doc {
                continue;
            }
            conflicts.push(WebdavPluginDataConflictDocument {
                plugin_id: plugin_id.to_string(),
                plugin_name: plugin_name.clone(),
                doc_id: doc_id.to_string(),
                local_summary: plugin_data_doc_summary(local_doc),
                remote_summary: plugin_data_doc_summary(remote_doc),
            });
        }
    }

    conflicts.sort_by(|left, right| {
        left.plugin_id
            .cmp(&right.plugin_id)
            .then(left.doc_id.cmp(&right.doc_id))
    });
    conflicts
}

fn plugin_data_plugin_id(plugin: &Value) -> Option<&str> {
    plugin
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn plugin_data_doc_id(doc: &Value) -> Option<&str> {
    doc.get("_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn find_plugin_data_plugin<'a>(payload: &'a Value, plugin_id: &str) -> Option<&'a Value> {
    payload
        .get("plugins")
        .and_then(Value::as_array)?
        .iter()
        .find(|plugin| plugin_data_plugin_id(plugin).is_some_and(|id| id == plugin_id))
}

fn find_plugin_data_document<'a>(plugin: &'a Value, doc_id: &str) -> Option<&'a Value> {
    plugin
        .get("documents")
        .and_then(Value::as_array)?
        .iter()
        .find(|doc| plugin_data_doc_id(doc).is_some_and(|id| id == doc_id))
}

fn plugin_data_doc_summary(doc: &Value) -> String {
    let Some(object) = doc.as_object() else {
        return "非对象文档".to_string();
    };
    let keys = object
        .keys()
        .filter(|key| key.as_str() != "_id" && key.as_str() != "_rev")
        .take(4)
        .cloned()
        .collect::<Vec<_>>();
    if keys.is_empty() {
        "无业务字段".to_string()
    } else {
        format!("字段 {}", keys.join("、"))
    }
}

fn is_redacted_secret_value(value: &Value) -> bool {
    value.as_str().is_some_and(|text| text == "<redacted>")
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)] // Helpers below remain shared by production code and tests.
mod tests {
    use super::*;

    #[test]
    fn plugin_market_trust_pins_remain_local_during_webdav_backup_and_restore() {
        let local_key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
        let remote_key = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=";
        let backup = redact_secrets(serde_json::json!({
            "theme": "dark",
            "pluginMarketTrustedPublicKeys": [local_key]
        }));
        assert!(
            backup.get("pluginMarketTrustedPublicKeys").is_none(),
            "trust anchors must not leave the local machine in WebDAV settings backups"
        );

        let (merged, applied, skipped) = merge_webdav_settings(
            serde_json::json!({
                "theme": "system",
                "pluginMarketTrustedPublicKeys": [local_key]
            }),
            serde_json::json!({
                "theme": "light",
                "pluginMarketTrustedPublicKeys": [remote_key]
            }),
        )
        .unwrap();
        assert_eq!(merged["theme"], "light");
        assert_eq!(
            merged["pluginMarketTrustedPublicKeys"],
            serde_json::json!([local_key])
        );
        assert!(applied.contains(&"theme".to_string()));
        assert!(skipped.contains(&"pluginMarketTrustedPublicKeys".to_string()));
    }

    #[test]
    fn plugin_data_restore_plan_lists_same_id_conflict_documents() {
        let local_plugin_data = serde_json::json!({
            "version": 1,
            "plugins": [
                {
                    "id": "plugin-json",
                    "name": "JSON",
                    "documents": [
                        { "_id": "same-doc", "value": "same" },
                        { "_id": "conflict-doc", "value": "local" }
                    ]
                }
            ]
        });
        let remote_plugin_data = serde_json::json!({
            "version": 1,
            "plugins": [
                {
                    "id": "plugin-json",
                    "name": "JSON",
                    "documents": [
                        { "_id": "same-doc", "value": "same" },
                        { "_id": "conflict-doc", "value": "remote" },
                        { "_id": "new-doc", "value": "remote-new" }
                    ]
                },
                {
                    "id": "missing-plugin",
                    "name": "Missing",
                    "documents": [
                        { "_id": "missing-doc", "value": "remote" }
                    ]
                }
            ]
        });
        let item = restore_plan_item(
            &WebdavDownloadedFile {
                name: "plugin-data.json".to_string(),
                url: "https://dav.example.com/ATools/plugin-data.json".to_string(),
                declared_bytes: None,
                downloaded_bytes: 128,
                payload: remote_plugin_data,
            },
            &WebdavRestoreLocalSnapshot {
                settings: serde_json::json!({}),
                plugin_data: local_plugin_data,
                clipboard_history: serde_json::json!({ "entries": [] }),
            },
        );

        assert_eq!(item.scope, "plugins");
        assert_eq!(item.action, "would_replace");
        assert_eq!(item.plugin_conflicts.len(), 1);
        assert_eq!(item.plugin_conflicts[0].plugin_id, "plugin-json");
        assert_eq!(item.plugin_conflicts[0].plugin_name, "JSON");
        assert_eq!(item.plugin_conflicts[0].doc_id, "conflict-doc");
        assert!(item.plugin_conflicts[0].local_summary.contains("value"));
        assert!(item.plugin_conflicts[0].remote_summary.contains("value"));
    }
}

fn mkcol_method() -> Result<Method, String> {
    Method::from_bytes(b"MKCOL").map_err(|error| format!("Invalid MKCOL method: {error}"))
}

fn json_file(name: &str, payload: Value) -> Result<WebdavFile, String> {
    Ok(WebdavFile {
        name: name.to_string(),
        bytes: serde_json::to_vec_pretty(&payload)
            .map_err(|error| format!("Failed to serialize {name}: {error}"))?,
        content_type: "application/json".to_string(),
    })
}

fn webdav_url(
    base_url: &str,
    remote_segments: &[String],
    file_name: Option<&str>,
) -> Result<String, String> {
    let mut url =
        Url::parse(base_url.trim()).map_err(|error| format!("Invalid WebDAV URL: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("WebDAV URL must use http or https".to_string());
    }
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "WebDAV URL cannot be used as a base path".to_string())?;
        segments.pop_if_empty();
        for segment in remote_segments {
            segments.push(segment);
        }
        if let Some(file_name) = file_name {
            segments.push(file_name.trim_matches('/'));
        }
    }
    Ok(trim_url_trailing_slash(url.as_str()).to_string())
}

fn remote_segments(remote_path: &str) -> Vec<String> {
    remote_path
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn normalize_remote_path(remote_path: &str) -> String {
    let segments = remote_segments(remote_path);
    if segments.is_empty() {
        "/ATools".to_string()
    } else {
        format!("/{}", segments.join("/"))
    }
}

fn trim_url_trailing_slash(value: &str) -> &str {
    value.strip_suffix('/').unwrap_or(value)
}

fn redact_secrets(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter_map(|(key, value)| {
                    if is_local_only_setting_key(&key) {
                        return None;
                    }
                    if is_secret_key(&key) {
                        Some((key, Value::String("<redacted>".to_string())))
                    } else {
                        Some((key, redact_secrets(value)))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_secrets).collect()),
        other => other,
    }
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    normalized.contains("password")
        || normalized.contains("apikey")
        || normalized.contains("token")
        || normalized.contains("secret")
}

fn is_local_only_setting_key(key: &str) -> bool {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .eq_ignore_ascii_case("pluginmarkettrustedpublickeys")
}
