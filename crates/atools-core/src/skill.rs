use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AToolsError, Result};
use crate::utils::now_iso;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStep {
    pub id: String,
    pub capability_id: String,
    pub description: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFailureMode {
    pub code: String,
    pub description: String,
    #[serde(default)]
    pub recovery: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_capability_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillValidationRule {
    pub id: String,
    pub label: String,
    pub description: String,
    pub kind: String,
    #[serde(default)]
    pub config: Value,
    #[serde(default = "default_true")]
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResultSuggestion {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub config: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDefinition {
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
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_skill_source")]
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

impl SkillDefinition {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: String,
        name: String,
        description: String,
        version: String,
        triggers: Vec<String>,
        capability_ids: Vec<String>,
        steps: Vec<SkillStep>,
        permission_scopes: Vec<String>,
        failure_modes: Vec<SkillFailureMode>,
        validation: Vec<SkillValidationRule>,
        result_suggestions: Vec<SkillResultSuggestion>,
        source: String,
    ) -> Result<Self> {
        let now = now_iso();
        let skill = Self {
            id,
            name,
            description,
            version,
            triggers,
            capability_ids,
            steps,
            permission_scopes,
            failure_modes,
            validation,
            result_suggestions,
            enabled: true,
            source,
            created_at: now.clone(),
            updated_at: now,
        };
        skill.validate()?;
        Ok(skill)
    }

    pub fn validate(&self) -> Result<()> {
        validate_identifier("Skill id", &self.id)?;
        nonempty("Skill name", &self.name)?;
        nonempty("Skill description", &self.description)?;
        nonempty("Skill version", &self.version)?;
        if self.triggers.is_empty() {
            return config_error("Skill must declare at least one trigger");
        }
        if self.capability_ids.is_empty() {
            return config_error("Skill must declare at least one capability dependency");
        }
        if self.steps.is_empty() {
            return config_error("Skill must declare at least one execution step");
        }
        if self.validation.is_empty() {
            return config_error("Skill must declare at least one validation rule");
        }
        if self.result_suggestions.is_empty() {
            return config_error("Skill must declare at least one result suggestion");
        }

        let capabilities = self
            .capability_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if capabilities.len() != self.capability_ids.len() {
            return config_error("Skill capability dependencies must be unique");
        }
        for capability in &self.capability_ids {
            validate_identifier("Capability id", capability)?;
        }

        let mut step_ids = BTreeSet::new();
        for step in &self.steps {
            validate_identifier("Skill step id", &step.id)?;
            nonempty("Skill step description", &step.description)?;
            if !step_ids.insert(step.id.as_str()) {
                return config_error("Skill step ids must be unique");
            }
            if !capabilities.contains(step.capability_id.as_str()) {
                return config_error(format!(
                    "Skill step {} references undeclared capability {}",
                    step.id, step.capability_id
                ));
            }
        }

        validate_unique_nonempty("Permission scopes", &self.permission_scopes)?;
        validate_unique_codes(
            "Failure mode",
            self.failure_modes.iter().map(|item| item.code.as_str()),
        )?;
        for failure in &self.failure_modes {
            nonempty("Failure mode description", &failure.description)?;
            if failure.recovery.is_empty() && failure.recovery_capability_id.is_none() {
                return config_error(format!(
                    "Failure mode {} must declare recovery guidance or a recovery capability",
                    failure.code
                ));
            }
            if let Some(capability) = &failure.recovery_capability_id {
                if !capabilities.contains(capability.as_str()) {
                    return config_error(format!(
                        "Failure mode {} references undeclared recovery capability {}",
                        failure.code, capability
                    ));
                }
            }
        }

        validate_unique_codes(
            "Validation rule",
            self.validation.iter().map(|item| item.id.as_str()),
        )?;
        for rule in &self.validation {
            nonempty("Validation label", &rule.label)?;
            nonempty("Validation description", &rule.description)?;
            nonempty("Validation kind", &rule.kind)?;
        }

        validate_unique_codes(
            "Result suggestion",
            self.result_suggestions.iter().map(|item| item.id.as_str()),
        )?;
        for suggestion in &self.result_suggestions {
            nonempty("Result suggestion label", &suggestion.label)?;
            nonempty("Result suggestion kind", &suggestion.kind)?;
        }
        Ok(())
    }
}

fn default_true() -> bool {
    true
}

fn default_skill_source() -> String {
    "local".to_string()
}

fn validate_identifier(label: &str, value: &str) -> Result<()> {
    nonempty(label, value)?;
    if value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return config_error(format!(
            "{label} must use 1-128 ASCII letters, numbers, dots, underscores, or hyphens"
        ));
    }
    Ok(())
}

fn nonempty(label: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return config_error(format!("{label} must not be empty"));
    }
    Ok(())
}

fn validate_unique_nonempty(label: &str, values: &[String]) -> Result<()> {
    let mut unique = BTreeSet::new();
    for value in values {
        nonempty(label, value)?;
        if !unique.insert(value.as_str()) {
            return config_error(format!("{label} must be unique"));
        }
    }
    Ok(())
}

fn validate_unique_codes<'a>(label: &str, values: impl Iterator<Item = &'a str>) -> Result<()> {
    let mut unique = BTreeSet::new();
    for value in values {
        validate_identifier(label, value)?;
        if !unique.insert(value) {
            return config_error(format!("{label} ids must be unique"));
        }
    }
    Ok(())
}

fn config_error<T>(message: impl Into<String>) -> Result<T> {
    Err(AToolsError::Config(message.into()))
}
