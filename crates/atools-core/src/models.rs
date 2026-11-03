//! Data models for atools-core.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Plugin manifest (parsed from `plugin.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    /// Supported host platforms (`darwin`, `win32`, `linux`); empty is unrestricted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platform: Vec<String>,
    /// Plugin name (e.g. "utools-demo").
    pub name: String,
    /// Human-readable ZTools title; never used as a stable identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Semantic version string.
    #[serde(default)]
    pub version: String,
    /// Relative path to the main HTML entry point (optional for headless plugins).
    #[serde(default)]
    pub main: Option<String>,
    /// Relative path to the plugin logo image.
    #[serde(default)]
    pub logo: Option<String>,
    /// Optional preload JavaScript file.
    #[serde(default)]
    pub preload: Option<String>,
    /// Human-readable description.
    #[serde(default)]
    pub description: Option<String>,
    /// Author name or email.
    #[serde(default)]
    pub author: Option<String>,
    /// Homepage URL.
    #[serde(default)]
    pub homepage: Option<String>,
    /// Optional plugin-level settings.
    #[serde(default, rename = "pluginSetting")]
    pub plugin_setting: Option<PluginSetting>,
    /// Feature declarations.
    #[serde(default)]
    pub features: Vec<Feature>,
    /// Development-time overrides.
    #[serde(default)]
    pub development: Option<Development>,
    /// Agent/MCP tool declarations from `plugin.json`.
    #[serde(default)]
    pub tools: HashMap<String, ToolManifest>,
    /// ZTools 3.x translation/OCR provider declarations keyed by plugin-local id.
    #[serde(default)]
    pub providers: HashMap<String, ProviderManifest>,
    /// Runtime bridge permissions declared by the plugin manifest.
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Optional ATools runtime declaration. Legacy manifests without this field
    /// are treated as ZTools-compatible Web plugins.
    #[serde(default)]
    pub runtime: Option<PluginRuntimeManifest>,
}

impl PluginManifest {
    pub fn effective_runtime_kind(&self) -> PluginRuntimeKind {
        self.runtime
            .as_ref()
            .map(|runtime| runtime.kind)
            .unwrap_or(PluginRuntimeKind::Web)
    }

    pub fn effective_compatibility(&self) -> PluginCompatibilityKind {
        self.runtime
            .as_ref()
            .map(|runtime| runtime.compatibility)
            .unwrap_or(PluginCompatibilityKind::Ztools)
    }

    pub fn effective_runtime_transport(&self) -> PluginRuntimeTransport {
        self.runtime
            .as_ref()
            .map(|runtime| runtime.transport)
            .unwrap_or(PluginRuntimeTransport::HostBridge)
    }

    pub fn effective_runtime_entry(&self) -> Option<&str> {
        self.runtime
            .as_ref()
            .and_then(|runtime| runtime.entry.as_deref())
            .or(self.main.as_deref())
            .or(self.preload.as_deref())
    }

    pub fn validate_runtime_contract(&self) -> Result<(), String> {
        let Some(runtime) = &self.runtime else {
            return Ok(());
        };
        let entry = self
            .effective_runtime_entry()
            .map(str::trim)
            .filter(|entry| !entry.is_empty());
        if entry.is_none() {
            return Err("Plugin runtime requires a non-empty entry".to_string());
        }
        match runtime.kind {
            PluginRuntimeKind::Web => {
                if runtime.transport != PluginRuntimeTransport::HostBridge {
                    return Err("Web plugins must use host_bridge transport".to_string());
                }
            }
            PluginRuntimeKind::Rust | PluginRuntimeKind::Node | PluginRuntimeKind::Wasm => {
                if runtime.transport == PluginRuntimeTransport::HostBridge {
                    return Err(
                        "Rust, Node, and Wasm plugins must use json_rpc_stdio or mcp_stdio transport"
                            .to_string(),
                    );
                }
            }
        }
        if runtime.compatibility == PluginCompatibilityKind::Ztools
            && (runtime.kind != PluginRuntimeKind::Web
                || runtime.transport != PluginRuntimeTransport::HostBridge)
        {
            return Err(
                "ZTools compatibility requires a Web plugin using host_bridge transport"
                    .to_string(),
            );
        }
        Ok(())
    }
}

/// Execution technology used by a plugin.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginRuntimeKind {
    Rust,
    Node,
    Web,
    #[serde(alias = "wasm_component")]
    Wasm,
}

/// Compatibility contract implemented by a plugin.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginCompatibilityKind {
    Native,
    Ztools,
}

/// Process/host transport used to invoke a plugin runtime.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginRuntimeTransport {
    HostBridge,
    JsonRpcStdio,
    McpStdio,
}

/// Explicit runtime declaration for new ATools plugins.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginRuntimeManifest {
    pub kind: PluginRuntimeKind,
    #[serde(default = "default_plugin_compatibility")]
    pub compatibility: PluginCompatibilityKind,
    #[serde(default = "default_plugin_runtime_transport")]
    pub transport: PluginRuntimeTransport,
    #[serde(default)]
    pub entry: Option<String>,
}

fn default_plugin_compatibility() -> PluginCompatibilityKind {
    PluginCompatibilityKind::Native
}

fn default_plugin_runtime_transport() -> PluginRuntimeTransport {
    PluginRuntimeTransport::HostBridge
}

/// ZTools 3.x provider declaration exposed by a plugin.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderManifest {
    /// Provider capability type (`translation` or `ocr`).
    #[serde(rename = "type")]
    pub type_: String,
    /// Human-readable provider name.
    #[serde(default)]
    pub label: Option<String>,
    /// Optional provider description shown by host settings UIs.
    #[serde(default)]
    pub description: Option<String>,
}

/// Tool declaration exposed by a plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolManifest {
    /// Human-readable description for agent clients.
    #[serde(default)]
    pub description: String,
    /// JSON Schema for tool input.
    #[serde(default, rename = "inputSchema")]
    pub input_schema: serde_json::Value,
    /// Optional JSON Schema for structured output.
    #[serde(default, rename = "outputSchema")]
    pub output_schema: Option<serde_json::Value>,
}

/// Plugin-level settings (from the `pluginSetting` field).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSetting {
    /// If true, the plugin runs as a singleton.
    #[serde(default, deserialize_with = "deserialize_lenient_bool")]
    pub single: bool,
    /// Initial window height in pixels.
    #[serde(default = "default_height")]
    pub height: u32,
}

fn default_height() -> u32 {
    544
}

/// Development-time configuration overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Development {
    /// Optional dev-time main entry override.
    #[serde(default)]
    pub main: Option<String>,
    /// Optional dev-time preload override.
    #[serde(default)]
    pub preload: Option<String>,
}

/// A feature declaration inside a plugin manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Feature {
    /// Additional host-platform restriction for this feature; empty is unrestricted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platform: Vec<String>,
    /// Unique code identifying this feature within the plugin.
    pub code: String,
    /// Human-readable display label (shown as the command title in the UI).
    #[serde(default)]
    pub label: Option<String>,
    /// Human-readable explanation shown in the UI.
    #[serde(default)]
    pub explain: String,
    /// Optional icon path (relative to plugin directory).
    #[serde(default)]
    pub icon: Option<String>,
    /// Whether this feature is pushed to the main search list.
    #[serde(
        default,
        rename = "mainPush",
        deserialize_with = "deserialize_lenient_bool"
    )]
    pub main_push: bool,
    /// Whether this feature is hidden from the main list by default.
    #[serde(
        default,
        rename = "mainHide",
        deserialize_with = "deserialize_lenient_bool"
    )]
    pub main_hide: bool,
    /// Command match rules that activate this feature.
    #[serde(default)]
    pub cmds: Vec<Cmd>,
}

fn deserialize_lenient_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let val = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match val {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(b)) => b,
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim().to_ascii_lowercase();
            !trimmed.is_empty() && trimmed != "false" && trimmed != "0" && trimmed != "no"
        }
        Some(_) => true,
    })
}

/// A command match rule.
///
/// Can be a plain text string (keyword match) or a typed rule (regex, length-based, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Cmd {
    /// Simple keyword/command text.
    Text(String),
    /// Typed command with a specific matcher.
    Typed(CmdTyped),
}

/// A typed command rule with a specific match strategy.
mod typed_command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "typed_command::Wire")]
pub struct CmdTyped {
    /// The type of match to perform.
    #[serde(rename = "type")]
    pub type_: CmdType,
    /// Optional label shown in the UI.
    pub label: Option<String>,
    /// Regex pattern for `Regex` type, or serialized match object for `Window`/`Files`.
    #[serde(
        default,
        rename = "match",
        alias = "regex",
        deserialize_with = "deserialize_match_field"
    )]
    pub match_: Option<String>,
    /// Ordinary-text exclusion for `Over`; fixed-text matching ignores this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude: Option<String>,
    /// Minimum input length for `Over` type (`length` or `minLength` in ZTools/uTools).
    #[serde(
        default,
        alias = "minLength",
        deserialize_with = "deserialize_length_field"
    )]
    pub length: Option<u32>,
    /// Upper text UTF-16 length or inclusive files selection count.
    #[serde(
        default,
        rename = "maxLength",
        deserialize_with = "deserialize_length_field"
    )]
    pub max_length: Option<u32>,
    /// Optional files-only kind restriction, retained across static/dynamic persistence.
    #[serde(default, rename = "fileType", skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    /// Case-insensitive filename suffixes, without implicit leading-dot removal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
}

fn deserialize_match_field<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let val = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match val {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s),
        Some(other) => Some(other.to_string()),
    })
}

fn deserialize_length_field<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let val = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match val {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .map(|v| u32::try_from(v).unwrap_or(u32::MAX))
            .or_else(|| n.as_i64().map(|v| v.max(0) as u32)),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u32>().ok(),
        _ => None,
    })
}

/// The type of a typed command rule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CmdType {
    /// Match input against a regular expression.
    Regex,
    /// Match when input length exceeds a threshold.
    Over,
    /// Match when input is an image path/URL.
    Img,
    /// Match when input refers to files.
    Files,
    /// Match when input refers to a window identifier.
    Window,
}

/// An installed plugin record (stored in the database).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plugin {
    /// Unique plugin identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Installed version.
    pub version: String,
    /// Absolute filesystem path to the plugin directory.
    pub path: String,
    /// Whether the plugin is currently enabled.
    pub enabled: bool,
    /// The full parsed manifest.
    pub manifest: PluginManifest,
    /// ISO 8601 creation timestamp.
    pub created_at: String,
    /// ISO 8601 last-updated timestamp.
    pub updated_at: String,
}

/// A feature entry joined with its parent plugin context.
///
/// Used for matching and display in the command palette.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureEntry {
    /// Feature code (unique within the plugin).
    pub code: String,
    /// ID of the owning plugin.
    pub plugin_id: String,
    /// Display name of the owning plugin.
    pub plugin_name: String,
    /// Label to show in the UI.
    pub label: String,
    /// Optional icon path.
    pub icon: Option<String>,
    /// Explanation text.
    pub explain: String,
    /// Command match rules.
    pub cmds: Vec<Cmd>,
    /// Whether this feature is pushed to the main list.
    pub main_push: bool,
    /// Display/activation priority (higher = shown first).
    pub priority: i32,
}

/// A locally stored clipboard history item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClipboardHistoryEntry {
    /// Stable ID derived from clipboard content.
    pub id: String,
    /// Text content stored locally.
    pub text: String,
    /// ISO 8601 timestamp for the first time this text was observed.
    pub first_copied_at: String,
    /// ISO 8601 timestamp for the most recent time this text was observed.
    pub last_copied_at: String,
    /// Number of times this same text was observed.
    pub used_count: u32,
}

/// A document in the plugin data store (PouchDB-compatible).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    /// Document ID (unique within the plugin's data store).
    #[serde(rename = "_id")]
    pub id: String,
    /// Revision ID for conflict detection.
    #[serde(rename = "_rev", default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    /// All other fields are stored as opaque JSON.
    #[serde(flatten)]
    pub data: serde_json::Value,
}
