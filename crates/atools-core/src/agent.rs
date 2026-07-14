use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::utils::{generate_rev, now_iso};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionScope {
    ClipboardRead,
    ClipboardWrite,
    FileRead,
    FileWrite,
    Network,
    Shell,
    Screenshot,
    BrowserContext,
    PluginData,
    SystemSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    Conservative,
    PerTool,
    Developer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    Confirm,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub client_id: String,
    pub tool_name: String,
    pub scopes: Vec<PermissionScope>,
    pub mutates: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionPolicy {
    pub mode: PermissionMode,
    pub granted_tools: BTreeSet<String>,
    pub denied_scopes: BTreeSet<PermissionScope>,
}

impl PermissionPolicy {
    pub fn new(mode: PermissionMode) -> Self {
        Self {
            mode,
            granted_tools: BTreeSet::new(),
            denied_scopes: BTreeSet::new(),
        }
    }

    pub fn grant_tool(&mut self, client_id: &str, tool_name: &str) {
        self.granted_tools
            .insert(format!("{}:{}", client_id, tool_name));
    }

    pub fn evaluate(&self, request: &PermissionRequest) -> PermissionDecision {
        if request
            .scopes
            .iter()
            .any(|scope| self.denied_scopes.contains(scope))
        {
            return PermissionDecision::Deny;
        }

        match self.mode {
            PermissionMode::Developer => PermissionDecision::Allow,
            PermissionMode::PerTool => {
                let key = format!("{}:{}", request.client_id, request.tool_name);
                if self.granted_tools.contains(&key) {
                    PermissionDecision::Allow
                } else {
                    PermissionDecision::Confirm
                }
            }
            PermissionMode::Conservative => PermissionDecision::Confirm,
        }
    }
}

impl Default for PermissionPolicy {
    fn default() -> Self {
        Self::new(PermissionMode::Conservative)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditStatus {
    Allowed,
    Confirmed,
    Denied,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub id: String,
    pub timestamp: String,
    pub client_id: String,
    pub tool_name: String,
    pub input: Value,
    pub output: Value,
    pub status: AuditStatus,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogQuery {
    #[serde(default = "default_audit_query_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

impl Default for AuditLogQuery {
    fn default() -> Self {
        Self {
            limit: default_audit_query_limit(),
            offset: 0,
            query: None,
            status: None,
            tool_name: None,
            client_id: None,
        }
    }
}

fn default_audit_query_limit() -> usize {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogPage {
    pub entries: Vec<AuditLogEntry>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
}

impl AuditLogEntry {
    pub fn new(client_id: &str, tool_name: &str, input: Value, status: AuditStatus) -> Self {
        Self {
            id: generate_rev(),
            timestamp: now_iso(),
            client_id: client_id.to_string(),
            tool_name: tool_name.to_string(),
            input,
            output: Value::Null,
            status,
            duration_ms: 0,
            error: None,
        }
    }

    pub fn with_output(mut self, output: Value) -> Self {
        self.output = output;
        self
    }

    pub fn with_duration_ms(mut self, duration_ms: u64) -> Self {
        self.duration_ms = duration_ms;
        self
    }

    pub fn with_error(mut self, error: impl Into<String>) -> Self {
        self.error = Some(error.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    pub scopes: Vec<PermissionScope>,
    pub enabled_by_default: bool,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolGrant {
    pub client_id: String,
    pub tool_name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAgentToolRequest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub client_id: String,
    pub tool_name: String,
    pub arguments: Value,
    pub scopes: Vec<PermissionScope>,
    pub created_at: String,
}

#[derive(Debug, Default, Clone)]
pub struct ToolRegistry {
    tools: BTreeMap<String, ToolDefinition>,
}

impl ToolRegistry {
    pub fn register(&mut self, tool: ToolDefinition) {
        self.tools.insert(tool.name.clone(), tool);
    }

    pub fn get(&self, name: &str) -> Option<&ToolDefinition> {
        self.tools.get(name)
    }

    pub fn list_all(&self) -> Vec<ToolDefinition> {
        self.tools.values().cloned().collect()
    }

    pub fn list_enabled(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .filter(|tool| tool.enabled)
            .cloned()
            .collect()
    }
}
