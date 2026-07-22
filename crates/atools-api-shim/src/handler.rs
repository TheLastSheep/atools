//! API handler implementation for IPC calls from plugin JavaScript.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Weak};

use anyhow::{Context, Result};
use atools_core::db::Database;
use atools_core::models::{Document, Feature, Plugin};
use atools_plugin::runtime::JsRuntime;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{debug, warn};

/// Handles IPC calls from plugin JavaScript contexts.
///
/// This struct owns a reference to the application database and implements
/// all IPC methods that plugins can invoke, including:
/// - Database operations (CRUD, attachments, bulk operations)
/// - Key-value storage
/// - Feature indexing and retrieval
/// - System path resolution
/// - Plugin metadata queries
pub struct ApiHandler {
    db: Arc<Database>,
    plugins_dir: PathBuf,
    runtime: RwLock<Option<Weak<JsRuntime>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub id: String,
    pub plugin_id: String,
    pub key: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub label: String,
    pub description: Option<String>,
    pub source: String,
    pub plugin_name: String,
    pub plugin_path: String,
    pub plugin_logo: Option<String>,
    pub enabled: bool,
    pub is_default: bool,
}

const PROVIDER_TYPES: [&str; 2] = ["translation", "ocr"];
const PROVIDER_INPUT_MAX_BYTES: usize = 16 * 1024 * 1024;
const PROVIDER_FETCH_MAX_BYTES: usize = 8 * 1024 * 1024;

impl ApiHandler {
    /// Creates a new API handler.
    ///
    /// # Arguments
    ///
    /// * `db` - Shared reference to the application database.
    /// * `plugins_dir` - Root directory where plugins are installed.
    pub fn new(db: Arc<Database>, plugins_dir: PathBuf) -> Self {
        Self {
            db,
            plugins_dir,
            runtime: RwLock::new(None),
        }
    }

    pub fn attach_runtime(&self, runtime: &Arc<JsRuntime>) {
        *self.runtime.write() = Some(Arc::downgrade(runtime));
    }

    /// Dispatches an IPC call from a plugin's JavaScript context.
    ///
    /// # Arguments
    ///
    /// * `plugin_id` - The ID of the plugin making the call.
    /// * `method` - The IPC method name (e.g., "db.put", "storage.get").
    /// * `args` - JSON arguments passed to the method.
    ///
    /// # Returns
    ///
    /// A JSON value representing the result, or an error if the operation failed.
    pub async fn handle(&self, plugin_id: &str, method: &str, args: Vec<Value>) -> Result<Value> {
        debug!(
            "IPC call: plugin={}, method={}, args_len={}",
            plugin_id,
            method,
            args.len()
        );

        match method {
            // Database operations
            "db.put" => self.db_put(plugin_id, args).await,
            "db.get" => self.db_get(plugin_id, args).await,
            "db.remove" => self.db_remove(plugin_id, args).await,
            "db.allDocs" => self.db_all_docs(plugin_id, args).await,
            "db.bulkDocs" => self.db_bulk_docs(plugin_id, args).await,
            "db.putAttachment" => self.db_put_attachment(plugin_id, args).await,
            "db.getAttachment" => self.db_get_attachment(plugin_id, args).await,

            // Storage (key-value)
            "storage.set" => self.storage_set(plugin_id, args).await,
            "storage.get" => self.storage_get(plugin_id, args).await,
            "storage.remove" => self.storage_remove(plugin_id, args).await,

            // Features
            "features.set" => self.feature_set(plugin_id, args).await,
            "features.remove" => self.feature_remove(plugin_id, args).await,
            "features.get" => self.feature_get(plugin_id).await,
            "settings.redirectHotKey" => unsupported_native(method),
            "settings.redirectAiModels" => unsupported_native(method),

            // ZTools 3.x provider compatibility.
            "providers.getProviders" => self.provider_get_providers(args).await,
            "providers.getDefault" => self.provider_get_default(args).await,
            "providers.setDefault" => self.provider_set_default(args).await,
            "providers.invoke" => self.provider_invoke(args).await,
            "network.fetch" => self.network_fetch(args).await,

            // Plugin info
            "plugin.getPath" => self.plugin_get_path(plugin_id).await,

            // System info
            "system.isMacOS" => Ok(json!(true)),
            "system.isWindows" => Ok(json!(false)),
            "system.isLinux" => Ok(json!(false)),
            "system.getPath" => self.system_get_path(args).await,
            "system.getFileIcon" => self.system_get_file_icon(args).await,
            "system.notify" => Ok(json!(null)), // Handled by Tauri layer
            "system.nativeId" => Ok(json!(plugin_id)),

            // User - local-only shim has no uTools account session.
            "user.get" => Ok(json!(null)),
            "user.fetchServerTemporaryToken" => unsupported_native(method),

            // Shell - delegated to Tauri
            "shell.openPath" => Ok(json!(null)), // Handled by Tauri layer
            "shell.openExternal" => Ok(json!(null)),
            "shell.trashItem" => unsupported_native(method),
            "shell.beep" => unsupported_native(method),

            // Window control - delegated to Tauri
            "window.show" => Ok(json!(null)),
            "window.hide" => Ok(json!(null)),
            "window.setExpendHeight" => Ok(json!(null)),
            "window.startDrag" => unsupported_native(method),
            "window.isDarkColors" => Ok(json!(false)),
            "window.createBrowserWindow" => unsupported_native(method),
            "window.sendToParent" => unsupported_native(method),
            "plugin.out" => Ok(json!(null)),

            // Input control - delegated to Tauri
            "input.setSubInput" => Ok(json!(null)),
            "input.removeSubInput" => Ok(json!(null)),
            "input.setSubInputValue" => Ok(json!(null)),
            "input.pasteText" => unsupported_native(method),
            "input.pasteImage" => unsupported_native(method),
            "input.pasteFile" => unsupported_native(method),
            "input.typeString" => unsupported_native(method),

            // Clipboard - native-only operations must be handled by the Tauri bridge.
            "clipboard.copyText" => Ok(json!(null)),
            "clipboard.copyImage" => unsupported_native(method),
            "clipboard.copyFile" => unsupported_native(method),
            "clipboard.getCopyedFiles" => unsupported_native(method),

            // Dialog - native-only operations must be handled by the Tauri bridge.
            "dialog.open" => unsupported_native(method),
            "dialog.save" => unsupported_native(method),

            // Screen - native-only operations must be handled by the Tauri bridge.
            "screen.capture" => unsupported_native(method),
            "screen.colorPick" => unsupported_native(method),
            "screen.desktopCaptureSources" => unsupported_native(method),

            // Redirect requires a host that can search and activate plugin features.
            "app.redirect" => unsupported_native(method),

            _ => {
                warn!("Unknown IPC method: {}", method);
                Err(anyhow::anyhow!("Unsupported IPC method: {}", method))
            }
        }
    }

    pub fn list_providers(&self, provider_type: Option<&str>) -> Result<Vec<ProviderDescriptor>> {
        let provider_type = provider_type.map(normalize_provider_type).transpose()?;
        let plugins = self
            .db
            .list_plugins()
            .context("Failed to list provider plugins")?;
        let mut providers = Vec::new();
        for plugin in plugins {
            for (key, declaration) in &plugin.manifest.providers {
                if key.trim().is_empty() {
                    continue;
                }
                let declared_type = match normalize_provider_type(&declaration.type_) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if provider_type.is_some_and(|filter| filter != declared_type) {
                    continue;
                }
                providers.push(ProviderDescriptor {
                    id: provider_id(&plugin.manifest.name, key),
                    plugin_id: plugin.id.clone(),
                    key: key.clone(),
                    provider_type: declared_type.to_string(),
                    label: declaration
                        .label
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(&plugin.name)
                        .to_string(),
                    description: declaration.description.clone(),
                    source: "plugin".to_string(),
                    plugin_name: plugin.name.clone(),
                    plugin_path: plugin.path.clone(),
                    plugin_logo: plugin.manifest.logo.clone(),
                    enabled: plugin.enabled,
                    is_default: false,
                });
            }
        }
        providers.sort_by(|left, right| {
            left.provider_type
                .cmp(&right.provider_type)
                .then_with(|| left.label.cmp(&right.label))
                .then_with(|| left.id.cmp(&right.id))
        });
        for provider_type in PROVIDER_TYPES {
            let configured = self
                .db
                .get_setting(&provider_default_setting_key(provider_type))
                .context("Failed to read default provider")?;
            let fallback = providers
                .iter()
                .find(|provider| provider.provider_type == provider_type && provider.enabled)
                .map(|provider| provider.id.clone());
            let selected = configured
                .filter(|configured| {
                    providers.iter().any(|provider| {
                        provider.provider_type == provider_type
                            && provider.enabled
                            && provider.id == *configured
                    })
                })
                .or(fallback);
            if let Some(selected) = selected {
                if let Some(provider) = providers
                    .iter_mut()
                    .find(|provider| provider.id == selected)
                {
                    provider.is_default = true;
                }
            }
        }
        Ok(providers)
    }

    pub fn default_provider(&self, provider_type: &str) -> Result<Option<ProviderDescriptor>> {
        let provider_type = normalize_provider_type(provider_type)?;
        Ok(self
            .list_providers(Some(provider_type))?
            .into_iter()
            .find(|provider| provider.enabled && provider.is_default))
    }

    pub fn set_default_provider(
        &self,
        provider_type: &str,
        provider_id: &str,
    ) -> Result<ProviderDescriptor> {
        let provider_type = normalize_provider_type(provider_type)?;
        let provider = self
            .list_providers(Some(provider_type))?
            .into_iter()
            .find(|provider| provider.enabled && provider.id == provider_id)
            .context("Provider is not installed or enabled")?;
        self.db
            .set_setting(&provider_default_setting_key(provider_type), &provider.id)
            .context("Failed to save default provider")?;
        Ok(ProviderDescriptor {
            is_default: true,
            ..provider
        })
    }

    pub async fn invoke_provider(
        &self,
        provider_type: &str,
        input: Value,
        requested_provider_id: Option<&str>,
    ) -> Result<Value> {
        let provider_type = normalize_provider_type(provider_type)?;
        validate_provider_input(provider_type, &input)?;
        let provider = match requested_provider_id.filter(|value| !value.trim().is_empty()) {
            Some(provider_id) => self
                .list_providers(Some(provider_type))?
                .into_iter()
                .find(|provider| provider.enabled && provider.id == provider_id)
                .context("Requested provider is not installed or enabled")?,
            None => self
                .default_provider(provider_type)?
                .context("No enabled provider is available")?,
        };
        let plugin = self
            .db
            .get_plugin(&provider.plugin_id)
            .context("Provider plugin no longer exists")?;
        let runtime = self
            .runtime
            .read()
            .as_ref()
            .and_then(Weak::upgrade)
            .context("Plugin runtime is not available for provider invocation")?;
        let payload = vec![json!({ "key": provider.key, "input": input })];
        match runtime
            .call_function(&plugin.id, "____callProvider____", payload.clone())
            .await
        {
            Ok(output) => Ok(output),
            Err(error) if error.to_string().contains("Context not found") => {
                self.load_plugin_preload(&runtime, &plugin).await?;
                runtime
                    .call_function(&plugin.id, "____callProvider____", payload)
                    .await
                    .with_context(|| format!("Provider {} failed", provider.id))
            }
            Err(error) => Err(error).with_context(|| format!("Provider {} failed", provider.id)),
        }
    }

    async fn load_plugin_preload(&self, runtime: &JsRuntime, plugin: &Plugin) -> Result<()> {
        let preload = plugin
            .manifest
            .preload
            .as_deref()
            .context("Provider plugin does not declare a preload script")?;
        let relative = Path::new(preload);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            anyhow::bail!("Provider preload path is outside the plugin directory");
        }
        let path = PathBuf::from(&plugin.path).join(relative);
        let preload_code = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("Failed to read provider preload at {}", path.display()))?;
        let declared_provider_keys = serde_json::to_string(
            &plugin
                .manifest
                .providers
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        )
        .context("Failed to serialize provider declarations")?;
        let provider_preload = format!(
            "globalThis.__atools_declared_provider_keys__ = {declared_provider_keys};\n{preload_code}"
        );
        runtime
            .execute_preload(&plugin.id, &provider_preload)
            .await
            .with_context(|| format!("Failed to execute provider preload for {}", plugin.id))
    }

    async fn provider_get_providers(&self, args: Vec<Value>) -> Result<Value> {
        let provider_type = args.first().and_then(Value::as_str);
        Ok(serde_json::to_value(self.list_providers(provider_type)?)?)
    }

    async fn provider_get_default(&self, args: Vec<Value>) -> Result<Value> {
        let provider_type = args
            .first()
            .and_then(Value::as_str)
            .context("Provider type is required")?;
        Ok(serde_json::to_value(self.default_provider(provider_type)?)?)
    }

    async fn provider_set_default(&self, args: Vec<Value>) -> Result<Value> {
        let provider_type = args
            .first()
            .and_then(Value::as_str)
            .context("Provider type is required")?;
        let provider_id = args
            .get(1)
            .and_then(Value::as_str)
            .context("Provider id is required")?;
        Ok(serde_json::to_value(
            self.set_default_provider(provider_type, provider_id)?,
        )?)
    }

    async fn provider_invoke(&self, args: Vec<Value>) -> Result<Value> {
        let provider_type = args
            .first()
            .and_then(Value::as_str)
            .context("Provider type is required")?;
        let input = args.get(1).cloned().unwrap_or(Value::Null);
        let provider_id = args.get(2).and_then(Value::as_str);
        self.invoke_provider(provider_type, input, provider_id)
            .await
    }

    async fn network_fetch(&self, args: Vec<Value>) -> Result<Value> {
        let url = args
            .first()
            .and_then(Value::as_str)
            .context("fetch URL is required")?;
        let parsed = reqwest::Url::parse(url).context("Invalid fetch URL")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            anyhow::bail!("fetch only supports http and https URLs");
        }
        let options = args.get(1).and_then(Value::as_object);
        let method = options
            .and_then(|options| options.get("method"))
            .and_then(Value::as_str)
            .unwrap_or("GET")
            .parse::<reqwest::Method>()
            .context("Invalid fetch method")?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .context("Failed to initialize provider HTTP client")?;
        let mut request = client.request(method, parsed);
        if let Some(headers) = options
            .and_then(|options| options.get("headers"))
            .and_then(Value::as_object)
        {
            for (name, value) in headers {
                if let Some(value) = value.as_str() {
                    request = request.header(name.as_str(), value);
                }
            }
        }
        if let Some(body) = options
            .and_then(|options| options.get("body"))
            .and_then(Value::as_str)
        {
            request = request.body(body.to_string());
        }
        let mut response = request.send().await.context("Provider fetch failed")?;
        if response
            .content_length()
            .is_some_and(|length| length > PROVIDER_FETCH_MAX_BYTES as u64)
        {
            anyhow::bail!("Provider fetch response exceeds 8 MiB");
        }
        let status = response.status();
        let final_url = response.url().to_string();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_string()))
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .context("Provider fetch body failed")?
        {
            if body.len().saturating_add(chunk.len()) > PROVIDER_FETCH_MAX_BYTES {
                anyhow::bail!("Provider fetch response exceeds 8 MiB");
            }
            body.extend_from_slice(&chunk);
        }
        Ok(json!({
            "ok": status.is_success(),
            "status": status.as_u16(),
            "statusText": status.canonical_reason().unwrap_or(""),
            "url": final_url,
            "headers": headers,
            "body": String::from_utf8_lossy(&body),
        }))
    }

    // --- Database methods ---

    async fn db_put(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let doc: Document = serde_json::from_value(
            args.into_iter()
                .next()
                .context("Missing document argument")?,
        )
        .context("Failed to parse document")?;

        self.db
            .plugin_data_put(plugin_id, &doc)
            .context("Database put failed")?;

        Ok(json!({"ok": true, "id": doc.id, "rev": doc.rev.unwrap_or_default()}))
    }

    async fn db_get(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let doc_id = args
            .first()
            .and_then(|v| v.as_str())
            .context("Missing doc_id argument")?;

        match self
            .db
            .plugin_data_get(plugin_id, doc_id)
            .context("Database get failed")?
        {
            Some(doc) => Ok(serde_json::to_value(doc)?),
            None => Ok(json!(null)),
        }
    }

    async fn db_remove(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let doc_id = args
            .first()
            .and_then(|v| v.as_str())
            .context("Missing doc_id argument")?;

        self.db
            .plugin_data_remove(plugin_id, doc_id)
            .context("Database remove failed")?;

        Ok(json!({"ok": true}))
    }

    async fn db_all_docs(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let docs = self
            .db
            .plugin_data_all(plugin_id)
            .context("Database allDocs failed")?;

        let filtered = match args.first() {
            Some(Value::String(prefix)) if !prefix.is_empty() => docs
                .into_iter()
                .filter(|doc| doc.id.starts_with(prefix))
                .collect::<Vec<_>>(),
            Some(Value::Array(ids)) => {
                let by_id = docs
                    .into_iter()
                    .map(|doc| (doc.id.clone(), doc))
                    .collect::<std::collections::HashMap<_, _>>();
                ids.iter()
                    .filter_map(|id| id.as_str())
                    .filter_map(|id| by_id.get(id).cloned())
                    .collect::<Vec<_>>()
            }
            _ => docs,
        };

        Ok(serde_json::to_value(filtered)?)
    }

    async fn db_bulk_docs(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let docs: Vec<Document> = serde_json::from_value(
            args.into_iter()
                .next()
                .context("Missing documents array argument")?,
        )
        .context("Failed to parse documents array")?;

        self.db
            .plugin_data_bulk(plugin_id, &docs)
            .context("Database bulkDocs failed")?;

        Ok(json!({"ok": true}))
    }

    async fn db_put_attachment(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let mut iter = args.into_iter();
        let doc_id = iter
            .next()
            .and_then(|v| v.as_str().map(String::from))
            .context("Missing doc_id")?;
        let second = iter.next().context("Missing attachment rev or name")?;
        let third = iter.next().context("Missing attachment name or data")?;
        let fourth = iter.next().context("Missing attachment data")?;
        let fifth = iter.next();

        let (name, data, content_type) = match (second.as_str(), third.as_str(), fourth.as_str()) {
            // uTools/PouchDB order: docId, rev, name, data, contentType
            (_, Some(name), Some(data)) if fifth.is_some() => (
                name.to_string(),
                data.to_string(),
                fifth
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
            ),
            // ATools legacy order: docId, name, rev, data, contentType
            (Some(name), _, Some(data)) => (
                name.to_string(),
                data.to_string(),
                fifth
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
            ),
            _ => anyhow::bail!("Invalid putAttachment arguments"),
        };

        let decoded = base64_decode(&data);

        self.db
            .put_attachment(plugin_id, &doc_id, &name, &decoded, &content_type)
            .context("Database putAttachment failed")?;

        Ok(json!({"ok": true}))
    }

    async fn db_get_attachment(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let mut iter = args.into_iter();
        let doc_id = iter
            .next()
            .and_then(|v| v.as_str().map(String::from))
            .context("Missing doc_id")?;
        let name = iter
            .next()
            .and_then(|v| v.as_str().map(String::from))
            .context("Missing attachment name")?;

        match self
            .db
            .get_attachment(plugin_id, &doc_id, &name)
            .context("Database getAttachment failed")?
        {
            Some((data, _content_type)) => Ok(json!(base64_encode(&data))),
            None => Ok(json!(null)),
        }
    }

    // --- Storage methods ---

    async fn storage_set(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let key = args
            .first()
            .and_then(|v| v.as_str())
            .context("Missing key argument")?;
        let value = args.get(1).cloned().unwrap_or(json!(null));

        let storage_key = format!("storage:{}:{}", plugin_id, key);
        self.db
            .set_setting(&storage_key, &value.to_string())
            .context("Storage set failed")?;

        Ok(json!(true))
    }

    async fn storage_get(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let key = args
            .first()
            .and_then(|v| v.as_str())
            .context("Missing key argument")?;

        let storage_key = format!("storage:{}:{}", plugin_id, key);
        match self
            .db
            .get_setting(&storage_key)
            .context("Storage get failed")?
        {
            Some(val) => Ok(serde_json::from_str(&val).unwrap_or(json!(null))),
            None => Ok(json!(null)),
        }
    }

    async fn storage_remove(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let key = args
            .first()
            .and_then(|v| v.as_str())
            .context("Missing key argument")?;

        let storage_key = format!("storage:{}:{}", plugin_id, key);
        self.db
            .set_setting(&storage_key, "null")
            .context("Storage remove failed")?;

        Ok(json!(true))
    }

    // --- Features methods ---

    async fn feature_set(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let features: Vec<Feature> = serde_json::from_value(
            args.into_iter()
                .next()
                .context("Missing features argument")?,
        )
        .context("Failed to parse features")?;

        self.db
            .index_features(plugin_id, &features)
            .context("Feature indexing failed")?;

        Ok(json!(true))
    }

    async fn feature_remove(&self, plugin_id: &str, args: Vec<Value>) -> Result<Value> {
        let code = args
            .first()
            .and_then(|v| v.as_str())
            .context("Missing feature code argument")?;

        // Fetch all current features, filter out the one to remove, and re-index.
        let all_features = self
            .db
            .all_features()
            .context("Failed to fetch features for removal")?;

        let remaining: Vec<_> = all_features
            .into_iter()
            .filter(|entry| entry.plugin_id == plugin_id && entry.code != code)
            .map(|entry| Feature {
                code: entry.code,
                label: Some(entry.label),
                explain: entry.explain,
                icon: entry.icon,
                main_push: entry.main_push,
                main_hide: false,
                cmds: entry.cmds,
            })
            .collect();

        self.db
            .index_features(plugin_id, &remaining)
            .context("Feature remove failed")?;

        Ok(json!(true))
    }

    async fn feature_get(&self, plugin_id: &str) -> Result<Value> {
        let all_features = self.db.all_features().context("Failed to fetch features")?;

        let plugin_features: Vec<_> = all_features
            .into_iter()
            .filter(|entry| entry.plugin_id == plugin_id)
            .collect();

        Ok(serde_json::to_value(plugin_features)?)
    }

    // --- Plugin path ---

    async fn plugin_get_path(&self, plugin_id: &str) -> Result<Value> {
        let path = self.plugins_dir.join(plugin_id);
        Ok(json!(path.to_string_lossy()))
    }

    // --- System paths ---

    async fn system_get_path(&self, args: Vec<Value>) -> Result<Value> {
        let name = args
            .first()
            .and_then(|v| v.as_str())
            .context("Missing path name argument")?;

        let path = match name {
            "home" => dirs::home_dir(),
            "desktop" => dirs::desktop_dir(),
            "documents" => dirs::document_dir(),
            "downloads" => dirs::download_dir(),
            "music" => dirs::audio_dir(),
            "pictures" => dirs::picture_dir(),
            "videos" => dirs::video_dir(),
            "temp" => Some(std::env::temp_dir()),
            "appData" | "userData" => dirs::data_dir().map(|p| p.join("atools")),
            _ => None,
        };

        Ok(json!(path
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()))
    }

    async fn system_get_file_icon(&self, args: Vec<Value>) -> Result<Value> {
        let raw = args.first().and_then(|v| v.as_str()).unwrap_or("FILE");
        let label = file_icon_label(raw);
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="12" y="6" width="40" height="52" rx="6" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/><path d="M40 6v14h12" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2"/><text x="32" y="42" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="#334155">{}</text></svg>"##,
            label
        );
        Ok(json!(format!(
            "data:image/svg+xml;base64,{}",
            base64_encode(svg.as_bytes())
        )))
    }
}

fn normalize_provider_type(value: &str) -> Result<&str> {
    let value = value.trim();
    if PROVIDER_TYPES.contains(&value) {
        Ok(value)
    } else {
        anyhow::bail!("Unsupported provider type: {value}")
    }
}

fn provider_id(plugin_name: &str, key: &str) -> String {
    format!("plugin:{plugin_name}:{key}")
}

fn provider_default_setting_key(provider_type: &str) -> String {
    format!("providers.default.{provider_type}")
}

fn validate_provider_input(provider_type: &str, input: &Value) -> Result<()> {
    let serialized = serde_json::to_vec(input).context("Failed to serialize provider input")?;
    if serialized.len() > PROVIDER_INPUT_MAX_BYTES {
        anyhow::bail!("Provider input exceeds 16 MiB");
    }
    let object = input
        .as_object()
        .context("Provider input must be an object")?;
    let required = if provider_type == "translation" {
        "text"
    } else {
        "image"
    };
    if !object
        .get(required)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        anyhow::bail!("Provider input requires a non-empty {required} string");
    }
    Ok(())
}

fn file_icon_label(raw: &str) -> String {
    let value = raw.trim();
    let candidate = if value.eq_ignore_ascii_case("folder") {
        "DIR".to_string()
    } else if value.starts_with('.') {
        value.to_string()
    } else {
        PathBuf::from(value)
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()))
            .unwrap_or_else(|| value.to_string())
    };
    let label = candidate
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '.')
        .take(6)
        .collect::<String>()
        .to_ascii_uppercase();
    if label.is_empty() {
        "FILE".to_string()
    } else {
        label
    }
}

/// Decodes a base64-encoded string into bytes.
///
/// Falls back to treating the string as raw UTF-8 bytes if decoding fails.
fn base64_decode(s: &str) -> Vec<u8> {
    decode_base64(s).unwrap_or_else(|| s.as_bytes().to_vec())
}

/// Encodes bytes into a base64 string.
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);

        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
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

fn unsupported_native(method: &str) -> Result<Value> {
    Err(anyhow::anyhow!(
        "{} requires native Tauri bridge support and cannot be completed in atools-api-shim",
        method
    ))
}
