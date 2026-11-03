use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;
use serde_json::{Map, Value};

const MAX_FILE_PATHS: usize = 20;
const MAX_FILE_PATH_BYTES: usize = 8 * 1024;

#[derive(Debug, Default, Deserialize)]
pub(super) struct ZToolsActivationStepPlan {
    #[serde(default)]
    pub(super) feature_code: String,
    #[serde(default)]
    pub(super) trigger_type: String,
    #[serde(default)]
    pub(super) query: String,
    #[serde(default)]
    pub(super) file_paths: Vec<String>,
}

impl ZToolsActivationStepPlan {
    pub(super) fn payload(&self, external: bool) -> Result<Value, String> {
        self.validate_file_paths()?;

        let mut payload = Map::new();
        payload.insert(
            "trigger_type".to_string(),
            Value::String(self.trigger_type.clone()),
        );
        payload.insert("query".to_string(), Value::String(self.query.clone()));

        if !self.file_paths.is_empty() {
            payload.insert(
                "__atools_desktop_smoke_file_paths".to_string(),
                serde_json::to_value(&self.file_paths)
                    .map_err(|error| format!("failed to encode activation file paths: {error}"))?,
            );
        }
        if external {
            payload.insert(
                "__atools_desktop_smoke_external_plan".to_string(),
                Value::Bool(true),
            );
        }

        Ok(Value::Object(payload))
    }

    fn validate_file_paths(&self) -> Result<(), String> {
        if self.file_paths.is_empty() {
            if self.trigger_type == "files" {
                return Err("trigger_type 'files' requires at least one file path".to_string());
            }
            return Ok(());
        }
        if self.trigger_type != "files" {
            return Err("file_paths require trigger_type 'files'".to_string());
        }
        if self.file_paths.len() > MAX_FILE_PATHS {
            return Err(format!("file_paths exceed the {MAX_FILE_PATHS}-path limit"));
        }

        let mut seen_paths = HashSet::with_capacity(self.file_paths.len());
        for (index, path) in self.file_paths.iter().enumerate() {
            if path.is_empty() {
                return Err(format!("file_paths[{index}] must not be empty"));
            }
            if path.len() > MAX_FILE_PATH_BYTES {
                return Err(format!(
                    "file_paths[{index}] exceeds the {MAX_FILE_PATH_BYTES}-byte limit"
                ));
            }
            if path.chars().any(char::is_control) {
                return Err(format!("file_paths[{index}] contains a control character"));
            }
            if !Path::new(path).is_absolute() {
                return Err(format!("file_paths[{index}] must be an absolute path"));
            }
            if !seen_paths.insert(path) {
                return Err(format!("file_paths[{index}] duplicates an earlier path"));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::ZToolsActivationStepPlan;
    use serde_json::json;

    fn absolute_test_path(file_name: &str) -> String {
        std::env::temp_dir()
            .join(file_name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn legacy_text_activation_plan_keeps_its_payload_shape() {
        let plan: ZToolsActivationStepPlan = serde_json::from_value(json!({
            "feature_code": "markdown-open",
            "trigger_type": "text",
            "query": "hello"
        }))
        .expect("legacy plan");

        assert!(plan.file_paths.is_empty());
        assert_eq!(
            plan.payload(false).expect("legacy payload"),
            json!({ "trigger_type": "text", "query": "hello" })
        );
    }

    #[test]
    fn file_activation_payload_keeps_trigger_data_and_adds_file_marker() {
        let alpha_path = absolute_test_path("alpha.md");
        let beta_path = absolute_test_path("beta.md");
        let plan: ZToolsActivationStepPlan = serde_json::from_value(json!({
            "feature_code": "markdown-open",
            "trigger_type": "files",
            "query": "ignored query",
            "file_paths": [alpha_path.clone(), beta_path.clone()]
        }))
        .expect("file plan");

        assert_eq!(
            plan.payload(false).expect("file payload"),
            json!({
                "trigger_type": "files",
                "query": "ignored query",
                "__atools_desktop_smoke_file_paths": [alpha_path.clone(), beta_path.clone()]
            })
        );
        assert_eq!(
            plan.payload(true).expect("external file payload"),
            json!({
                "trigger_type": "files",
                "query": "ignored query",
                "__atools_desktop_smoke_file_paths": [alpha_path, beta_path],
                "__atools_desktop_smoke_external_plan": true
            })
        );
    }

    #[test]
    fn file_activation_rejects_empty_relative_and_control_character_paths() {
        for file_path in ["", "relative.md"] {
            let plan = ZToolsActivationStepPlan {
                trigger_type: "files".to_string(),
                file_paths: vec![file_path.to_string()],
                ..ZToolsActivationStepPlan::default()
            };
            assert!(plan.payload(false).is_err(), "accepted path {file_path:?}");
        }

        let control_character_path = absolute_test_path("with\nnewline.md");
        let plan = ZToolsActivationStepPlan {
            trigger_type: "files".to_string(),
            file_paths: vec![control_character_path],
            ..ZToolsActivationStepPlan::default()
        };
        assert!(plan.payload(false).is_err());
    }

    #[test]
    fn file_activation_rejects_path_and_count_budget_overflow() {
        let long_path = format!("/{}", "a".repeat(8 * 1024));
        let long_path_plan = ZToolsActivationStepPlan {
            trigger_type: "files".to_string(),
            file_paths: vec![long_path],
            ..ZToolsActivationStepPlan::default()
        };
        assert!(long_path_plan.payload(false).is_err());

        let too_many_paths = ZToolsActivationStepPlan {
            trigger_type: "files".to_string(),
            file_paths: (0..21)
                .map(|index| format!("/tmp/file-{index}.md"))
                .collect(),
            ..ZToolsActivationStepPlan::default()
        };
        assert!(too_many_paths.payload(false).is_err());
    }

    #[test]
    fn file_activation_rejects_non_files_trigger() {
        let plan = ZToolsActivationStepPlan {
            trigger_type: "text".to_string(),
            query: "hello".to_string(),
            file_paths: vec!["/tmp/alpha.md".to_string()],
            ..ZToolsActivationStepPlan::default()
        };

        assert!(plan.payload(false).is_err());
    }

    #[test]
    fn files_trigger_rejects_an_empty_path_list() {
        let plan = ZToolsActivationStepPlan {
            trigger_type: "files".to_string(),
            ..ZToolsActivationStepPlan::default()
        };

        assert!(plan.payload(false).is_err());
    }

    #[test]
    fn file_activation_rejects_duplicate_paths() {
        let path = absolute_test_path("alpha.md");
        let plan = ZToolsActivationStepPlan {
            trigger_type: "files".to_string(),
            file_paths: vec![path.clone(), path],
            ..ZToolsActivationStepPlan::default()
        };

        assert!(plan.payload(false).is_err());
    }
}
