use super::*;
pub(super) fn tool(
    name: &str,
    description: &str,
    input_schema: Value,
    output_schema: Value,
    scopes: Vec<PermissionScope>,
) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        input_schema,
        output_schema: Some(output_schema),
        scopes,
        enabled_by_default: true,
        enabled: true,
        source: "builtin".to_string(),
        plugin_id: None,
    }
}

pub(super) fn search_clipboard_tool() -> ToolDefinition {
    tool(
        "search_clipboard",
        "Search local clipboard history without uploading it. The current clipboard text is captured locally before searching.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
            }
        }),
        json!({ "type": "object", "properties": { "items": { "type": "array" }, "total": { "type": "integer" } } }),
        vec![PermissionScope::ClipboardRead],
    )
}

pub(super) fn ask_ai_model_tool() -> ToolDefinition {
    tool(
        "ask_ai_model",
        "Send a prompt to the AI model configured in ATools settings. Requires the AI provider to be enabled for Agent use.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "prompt": { "type": "string" },
                "system": { "type": "string" },
                "max_tokens": { "type": "integer", "minimum": 1, "maximum": 32768 }
            },
            "required": ["prompt"]
        }),
        json!({
            "type": "object",
            "properties": {
                "status": { "type": "string" },
                "provider": { "type": "string" },
                "model": { "type": "string" },
                "text": { "type": "string" },
                "finish_reason": { "type": ["string", "null"] },
                "usage": { "type": ["object", "null"] },
                "duration_ms": { "type": "integer" }
            }
        }),
        vec![PermissionScope::Network],
    )
}

pub(super) fn find_local_files_tool() -> ToolDefinition {
    tool(
        "find_local_files",
        "Find local files by filename under a root directory.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "root": { "type": "string" },
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 },
                "max_depth": { "type": "integer", "minimum": 0, "maximum": 100 },
                "ignore_dirs": { "type": "array", "items": { "type": "string" } },
                "ignore_patterns": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional filename or relative-path wildcard patterns to skip, such as *.tmp or generated/**."
                }
            }
        }),
        json!({
            "type": "object",
            "properties": {
                "items": { "type": "array" },
                "skipped_permission_errors": { "type": "integer" }
            }
        }),
        vec![PermissionScope::FileRead],
    )
}

pub(super) fn ocr_image_tool() -> ToolDefinition {
    tool(
        "ocr_image",
        "Run OCR on a local image through the local OCR endpoint.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "path": { "type": "string" },
                "endpoint": { "type": "string" }
            },
            "required": ["path"]
        }),
        json!({ "type": "object", "properties": { "text": { "type": "string" } } }),
        vec![PermissionScope::FileRead],
    )
}

pub(super) fn compress_images_tool() -> ToolDefinition {
    tool(
        "compress_images",
        "Create compressed local image copies.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "paths": { "type": "array", "items": { "type": "string" } },
                "output_dir": { "type": "string" },
                "max_width": { "type": "integer" },
                "max_bytes": { "type": "integer", "minimum": 1 },
                "format": { "type": "string", "enum": ["original", "webp"], "default": "original" }
            },
            "required": ["paths"]
        }),
        json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "input": { "type": "string" },
                            "output": { "type": "string" },
                            "format": { "type": "string" },
                            "status": { "type": "string" },
                            "original_size": { "type": "integer" },
                            "output_size": { "type": "integer" },
                            "target_size": { "type": ["integer", "null"] },
                            "target_met": { "type": ["boolean", "null"] },
                            "target_reason": { "type": ["string", "null"] },
                            "compression_ratio": { "type": "number" }
                        }
                    }
                }
            }
        }),
        vec![PermissionScope::FileRead, PermissionScope::FileWrite],
    )
}

pub(super) fn rename_files_tool() -> ToolDefinition {
    tool(
        "rename_files",
        "Plan or execute local file renames.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "dry_run": { "type": "boolean", "default": true },
                "operations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "from": { "type": "string" },
                            "to": { "type": "string" }
                        },
                        "required": ["from", "to"]
                    }
                }
            },
            "required": ["operations"]
        }),
        json!({
            "type": "object",
            "properties": {
                "operations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "from": { "type": "string" },
                            "to": { "type": "string" },
                            "status": { "type": "string" },
                            "dry_run": { "type": "boolean" },
                            "from_exists": { "type": "boolean" },
                            "to_exists": { "type": "boolean" },
                            "parent_exists": { "type": "boolean" }
                        }
                    }
                }
            }
        }),
        vec![PermissionScope::FileWrite],
    )
}

pub(super) fn open_or_reveal_path_tool() -> ToolDefinition {
    tool(
        "open_or_reveal_path",
        "Open or reveal a local path.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "path": { "type": "string" },
                "reveal": { "type": "boolean", "default": false }
            },
            "required": ["path"]
        }),
        json!({ "type": "object", "properties": { "ok": { "type": "boolean" } } }),
        vec![PermissionScope::Shell],
    )
}

pub(super) fn open_url_tool() -> ToolDefinition {
    tool(
        "open_url",
        "Open an explicit HTTP or HTTPS URL in the default browser.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "url": { "type": "string", "format": "uri" }
            },
            "required": ["url"]
        }),
        json!({
            "type": "object",
            "properties": {
                "ok": { "type": "boolean" },
                "url": { "type": "string", "format": "uri" }
            }
        }),
        vec![PermissionScope::Shell],
    )
}

pub(super) fn get_current_context_tool() -> ToolDefinition {
    tool(
        "get_current_context",
        "Return local platform and common directory context.",
        json!({ "type": "object", "additionalProperties": false, "properties": {} }),
        json!({ "type": "object" }),
        vec![PermissionScope::BrowserContext],
    )
}

#[cfg(test)]
mod artifact_tests {
    use super::{
        structured_failed_items, structured_result_artifacts, structured_result_task_status,
        validated_open_url,
    };
    use atools_core::task_run::{ArtifactKind, TaskRun, TaskRunInitiator, TaskRunStatus};
    use serde_json::json;

    #[test]
    fn compressed_images_produce_bounded_image_artifacts() {
        let mut run = TaskRun::new(
            "compress_images",
            TaskRunInitiator::agent("test"),
            json!({}),
        );
        run.output = json!({
            "items": (0..55).map(|index| json!({
                "input": format!("/tmp/source-{index}.png"),
                "output": format!("/tmp/compressed-{index}.webp"),
                "output_size": 128,
                "status": "compressed",
                "target_met": true,
                "compression_ratio": 0.5
            })).collect::<Vec<_>>()
        });

        let artifacts = structured_result_artifacts(&run);
        assert_eq!(artifacts.len(), 51);
        assert_eq!(artifacts[0].kind, ArtifactKind::Json);
        assert!(artifacts[1..]
            .iter()
            .all(|artifact| artifact.kind == ArtifactKind::Image));
        assert_eq!(artifacts[1].size_bytes, Some(128));
    }

    #[test]
    fn structured_item_failures_select_partial_and_failed_task_statuses() {
        let output = json!({
            "items": [
                { "input": "ok.png", "status": "compressed" },
                { "input": "bad.png", "status": "failed", "error": "invalid image" }
            ]
        });
        assert_eq!(structured_failed_items(&output).len(), 1);
        assert_eq!(structured_result_task_status(2, 1), TaskRunStatus::Partial);
        assert_eq!(structured_result_task_status(2, 2), TaskRunStatus::Failed);
        assert_eq!(
            structured_result_task_status(2, 0),
            TaskRunStatus::Succeeded
        );
    }

    #[test]
    fn text_outputs_use_field_references_instead_of_copying_content() {
        let mut run = TaskRun::new("ocr_image", TaskRunInitiator::agent("test"), json!({}));
        run.output = json!({ "text": "recognized" });

        let artifacts = structured_result_artifacts(&run);
        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[1].kind, ArtifactKind::RichText);
        assert_eq!(artifacts[1].metadata["outputField"], "text");
        assert_eq!(artifacts[1].size_bytes, Some(10));
        assert!(artifacts[1].metadata.get("content").is_none());
    }

    #[test]
    fn open_url_only_accepts_explicit_http_targets() {
        assert_eq!(
            validated_open_url(&json!({ "url": " https://example.com/docs " })).unwrap(),
            "https://example.com/docs"
        );
        assert!(validated_open_url(&json!({ "url": "file:///tmp/secret" })).is_err());
        assert!(validated_open_url(&json!({ "url": "javascript:alert(1)" })).is_err());
        assert!(validated_open_url(&json!({ "url": "https://" })).is_err());
    }
}
