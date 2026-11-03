//! Declarative Schema UI (`SchemaView`) — Plan D Convergence (Raycast-style Dual Human/Agent UI).
//!
//! Instead of coupling plugin output exclusively to opaque HTML DOM trees, tools and plugins
//! can emit structured `SchemaView` specifications (`List`, `Detail`, `Form`, `ActionPanel`)
//! that the desktop frontend renders as native UI components AND AI Agents consume directly
//! as structured JSON or compact Markdown observations.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A declarative UI view consumable by both Human UI renderers and AI Agents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaView {
    pub id: String,
    pub title: String,
    pub kind: SchemaViewKind,
    #[serde(default)]
    pub actions: Vec<SchemaAction>,
}

/// Supported declarative view archetypes (inspired by Raycast's `List`, `Detail`, `Form`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SchemaViewKind {
    List { items: Vec<SchemaDataItem> },
    Detail { markdown: String, metadata: Value },
    Form { fields: Vec<SchemaField> },
}

/// A single structured row in a `SchemaViewKind::List`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDataItem {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

/// A single input field in a `SchemaViewKind::Form`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaField {
    pub name: String,
    pub label: String,
    pub kind: SchemaFieldKind,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<Value>,
}

/// Supported field input types in a declarative form.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SchemaFieldKind {
    Text,
    Textarea,
    Password,
    Number,
    Checkbox,
    Select,
    FilePath,
}

/// An executable capability action attached to a `SchemaView` (`ActionPanel`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaAction {
    pub id: String,
    pub title: String,
    pub capability_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
}

impl SchemaView {
    /// Validates structural invariants of the declarative view.
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("SchemaView.id must not be empty".to_string());
        }
        if self.title.trim().is_empty() {
            return Err("SchemaView.title must not be empty".to_string());
        }
        match &self.kind {
            SchemaViewKind::List { items } => {
                for item in items {
                    if item.id.trim().is_empty() || item.title.trim().is_empty() {
                        return Err("SchemaDataItem requires non-empty id and title".to_string());
                    }
                }
            }
            SchemaViewKind::Detail { markdown, .. } => {
                if markdown.trim().is_empty() {
                    return Err("SchemaViewKind::Detail requires non-empty markdown".to_string());
                }
            }
            SchemaViewKind::Form { fields } => {
                if fields.is_empty() {
                    return Err("SchemaViewKind::Form requires at least one field".to_string());
                }
                for field in fields {
                    if field.name.trim().is_empty() || field.label.trim().is_empty() {
                        return Err("SchemaField requires non-empty name and label".to_string());
                    }
                }
            }
        }
        for action in &self.actions {
            if action.id.trim().is_empty() || action.capability_id.trim().is_empty() {
                return Err("SchemaAction requires non-empty id and capability_id".to_string());
            }
        }
        Ok(())
    }

    /// Renders a compact, high-signal Markdown representation for AI Agent observations.
    pub fn to_agent_markdown(&self) -> String {
        let mut out = format!("# {} (`{}`)\n\n", self.title, self.id);
        match &self.kind {
            SchemaViewKind::List { items } => {
                for item in items {
                    out.push_str(&format!("- **{}** (`{}`)", item.title, item.id));
                    if let Some(ref badge) = item.badge {
                        out.push_str(&format!(" [{}]", badge));
                    }
                    if let Some(ref sub) = item.subtitle {
                        out.push_str(&format!(" — {}", sub));
                    }
                    out.push('\n');
                }
            }
            SchemaViewKind::Detail { markdown, .. } => {
                out.push_str(markdown);
                out.push('\n');
            }
            SchemaViewKind::Form { fields } => {
                out.push_str("## Form Fields\n");
                for field in fields {
                    out.push_str(&format!(
                        "- `{}` ({}{}): {:?}\n",
                        field.name,
                        field.label,
                        if field.required { ", required" } else { "" },
                        field.kind
                    ));
                }
            }
        }
        if !self.actions.is_empty() {
            out.push_str("\n## Available Actions\n");
            for action in &self.actions {
                out.push_str(&format!(
                    "- **{}** -> `{}`\n",
                    action.title, action.capability_id
                ));
            }
        }
        out
    }
}
