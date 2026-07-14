use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AToolsError, Result};
use crate::utils::{generate_rev, now_iso};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryType {
    Preference,
    WorkspaceFact,
    TaskRecipe,
    Correction,
    FailureRecovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryApproval {
    Explicit,
    ConfirmedCandidate,
    Temporary,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
}

impl MemoryScope {
    pub fn specificity(&self) -> usize {
        [
            self.workspace.as_ref(),
            self.skill.as_ref(),
            self.tool.as_ref(),
            self.application.as_ref(),
            self.domain.as_ref(),
        ]
        .into_iter()
        .flatten()
        .count()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: MemoryType,
    pub scope: MemoryScope,
    pub content: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_run_id: Option<String>,
    pub confidence: f64,
    pub approval: MemoryApproval,
    pub enabled: bool,
    pub use_count: u64,
    pub success_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl MemoryItem {
    pub fn new(
        kind: MemoryType,
        scope: MemoryScope,
        content: Value,
        source_run_id: Option<String>,
        confidence: f64,
        approval: MemoryApproval,
        expires_at: Option<String>,
    ) -> Result<Self> {
        validate_memory_content(&content)?;
        if !(0.0..=1.0).contains(&confidence) {
            return Err(AToolsError::Config(
                "Memory confidence must be between 0 and 1".to_string(),
            ));
        }
        if approval == MemoryApproval::Temporary && expires_at.is_none() {
            return Err(AToolsError::Config(
                "Temporary memory requires an expiry".to_string(),
            ));
        }
        let now = now_iso();
        Ok(Self {
            id: format!("memory-{}", generate_rev()),
            kind,
            scope,
            content,
            source_run_id,
            confidence,
            approval,
            enabled: true,
            use_count: 0,
            success_count: 0,
            last_used_at: None,
            expires_at,
            created_at: now.clone(),
            updated_at: now,
        })
    }
}

pub fn validate_memory_content(content: &Value) -> Result<()> {
    fn visit(value: &Value, path: &str) -> std::result::Result<(), String> {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    let normalized = key.to_ascii_lowercase().replace(['-', ' '], "_");
                    let sensitive_key = [
                        "password",
                        "passwd",
                        "secret",
                        "api_key",
                        "apikey",
                        "access_token",
                        "refresh_token",
                        "authorization",
                        "cookie",
                        "credential",
                        "private_key",
                        "access_key",
                    ]
                    .iter()
                    .any(|candidate| normalized.contains(candidate));
                    if sensitive_key {
                        return Err(format!("sensitive field `{path}{key}` is not allowed"));
                    }
                    visit(value, &format!("{path}{key}."))?;
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, path)?;
                }
            }
            Value::String(text) => {
                let trimmed = text.trim();
                let looks_like_secret = trimmed.starts_with("sk-")
                    || trimmed.starts_with("ghp_")
                    || trimmed.starts_with("github_pat_")
                    || trimmed.starts_with("Bearer ")
                    || (trimmed.contains("BEGIN ") && trimmed.contains("PRIVATE KEY"));
                if looks_like_secret {
                    return Err(format!(
                        "credential-like content at `{path}` is not allowed"
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }

    visit(content, "memory.").map_err(AToolsError::Config)
}

pub fn apply_memory_defaults(arguments: &mut Value, memories: &[MemoryItem]) {
    let Some(target) = arguments.as_object_mut() else {
        return;
    };
    for memory in memories {
        let Some(defaults) = memory.content.get("arguments").and_then(Value::as_object) else {
            continue;
        };
        for (key, value) in defaults {
            target.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
}
