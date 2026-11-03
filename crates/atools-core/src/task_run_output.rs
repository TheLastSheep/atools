//! Safe MCP projections for bounded TaskRun output fields.
use crate::harness::{prune_tool_output, PromptSanitizer};
use crate::task_run::{ArtifactKind, TaskRun};
use serde_json::{json, Value};

pub const SOURCE_BUILD_LOG_FIELD: &str = "capturedRunnerLog";
pub const SOURCE_BUILD_LOG_MAX_BYTES: usize = 64 * 1024;
pub const MCP_LOG_PREVIEW_MAX_BYTES: usize = 16 * 1024;
const MCP_LOG_PREVIEW_MAX_CHARS: usize = 16 * 1024;
const SOURCE_BUILD_CAPABILITY: &str = "convert_ztools_plugin";
const LOG_ARTIFACT_PREFIX: &str = "artifact-source-build-log-";
const RESOURCE_PREFIX: &str = "atools://task-runs/";
const RESOURCE_SUFFIX: &str = "/output";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskRunOutputError {
    InvalidUri,
    NotFound,
    InvalidArtifact,
    MissingOutput,
    OutputTooLarge,
}

impl TaskRunOutputError {
    pub fn safe_message(self) -> &'static str {
        match self {
            Self::InvalidUri => "Invalid task-run output resource URI",
            Self::NotFound => "Task-run output resource not found",
            Self::InvalidArtifact => "Task-run output artifact is unavailable",
            Self::MissingOutput => "Task-run output field is unavailable",
            Self::OutputTooLarge => "Task-run output exceeds the supported resource limit",
        }
    }
}

pub fn is_task_run_output_uri(uri: &str) -> bool {
    uri.starts_with(RESOURCE_PREFIX)
}

pub fn parse_task_run_output_uri(uri: &str) -> Result<&str, TaskRunOutputError> {
    let rest = uri
        .strip_prefix(RESOURCE_PREFIX)
        .ok_or(TaskRunOutputError::InvalidUri)?;
    let run_id = rest
        .strip_suffix(RESOURCE_SUFFIX)
        .ok_or(TaskRunOutputError::InvalidUri)?;
    if run_id.is_empty()
        || run_id.len() > 128
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(TaskRunOutputError::InvalidUri);
    }
    Ok(run_id)
}

/// Projects model-facing source-build results without mutating the stored TaskRun.
/// `source_build_run` must come from the actual tool/run capability, never result JSON.
pub fn project_source_build_result(mut value: Value, source_build_run: bool) -> Value {
    if !source_build_run {
        return value;
    }
    let run_id = value
        .get("runId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let has_top_field = value.get(SOURCE_BUILD_LOG_FIELD).is_some();
    let artifact_signal = has_log_artifact_signal(&value);
    let raw_log = value
        .get(SOURCE_BUILD_LOG_FIELD)
        .and_then(Value::as_str)
        .map(str::to_owned);
    let exact_artifact = match (run_id.as_deref(), raw_log.as_deref()) {
        (Some(run_id), Some(raw_log)) if raw_log.len() <= SOURCE_BUILD_LOG_MAX_BYTES => {
            has_exact_log_artifact(&value, run_id, raw_log.len())
        }
        _ => false,
    };

    if has_top_field || artifact_signal {
        let (preview, available, truncated, uri) = if exact_artifact {
            let raw_log = raw_log.as_deref().unwrap_or_default();
            let (preview, truncated) = render_log(raw_log, true);
            (
                preview,
                true,
                truncated,
                run_id.as_deref().map(resource_uri),
            )
        } else {
            ("[captured log unavailable]".to_owned(), false, true, None)
        };
        if let Some(fields) = value.as_object_mut() {
            fields.insert(SOURCE_BUILD_LOG_FIELD.to_owned(), Value::String(preview));
            fields.insert("capturedRunnerLogAvailable".to_owned(), json!(available));
            fields.insert("capturedRunnerLogTruncated".to_owned(), json!(truncated));
            if let Some(uri) = uri {
                fields.insert("capturedRunnerLogResourceUri".to_owned(), json!(uri));
            } else {
                fields.remove("capturedRunnerLogResourceUri");
            }
        }
    }
    redact_nested_log_fields(&mut value, true);
    value
}

fn has_log_artifact_signal(value: &Value) -> bool {
    value
        .get("artifacts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|artifact| {
            artifact
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with(LOG_ARTIFACT_PREFIX))
                || artifact
                    .get("metadata")
                    .and_then(|metadata| metadata.get("outputField"))
                    .and_then(Value::as_str)
                    == Some(SOURCE_BUILD_LOG_FIELD)
        })
}

fn redact_nested_log_fields(value: &mut Value, is_root: bool) {
    match value {
        Value::Object(fields) => {
            for (key, nested) in fields.iter_mut() {
                if !is_root && key == SOURCE_BUILD_LOG_FIELD {
                    *nested = Value::String("[nested captured log omitted]".to_owned());
                } else {
                    redact_nested_log_fields(nested, false);
                }
            }
        }
        Value::Array(items) => {
            for nested in items {
                redact_nested_log_fields(nested, false);
            }
        }
        _ => {}
    }
}

/// Returns the full safe resource body after validating the TaskRun and its exact artifact.
pub fn read_source_build_log_resource(
    run: &TaskRun,
    requested_uri: &str,
) -> Result<String, TaskRunOutputError> {
    let uri_run_id = parse_task_run_output_uri(requested_uri)?;
    if uri_run_id != run.id {
        return Err(TaskRunOutputError::NotFound);
    }
    if run.initiator.client_id.as_deref() != Some("mcp-http")
        || run.capability_id != SOURCE_BUILD_CAPABILITY
    {
        return Err(TaskRunOutputError::NotFound);
    }
    let raw_log = run
        .output
        .get(SOURCE_BUILD_LOG_FIELD)
        .and_then(Value::as_str)
        .ok_or(TaskRunOutputError::MissingOutput)?;
    if raw_log.len() > SOURCE_BUILD_LOG_MAX_BYTES {
        return Err(TaskRunOutputError::OutputTooLarge);
    }
    if !run.artifacts.iter().any(|artifact| {
        artifact.id == format!("{LOG_ARTIFACT_PREFIX}{}", run.id)
            && artifact.kind == ArtifactKind::Log
            && artifact.uri.as_deref() == Some(requested_uri)
            && artifact.metadata.get("outputField").and_then(Value::as_str)
                == Some(SOURCE_BUILD_LOG_FIELD)
            && artifact.metadata.get("encoding").and_then(Value::as_str) == Some("utf-8-lossy")
            && artifact.metadata.get("source").and_then(Value::as_str)
                == Some("merged_stdout_stderr")
            && artifact.metadata.get("untrusted").and_then(Value::as_bool) == Some(true)
            && artifact.size_bytes == Some(raw_log.len() as u64)
    }) {
        return Err(TaskRunOutputError::InvalidArtifact);
    }
    Ok(render_log(raw_log, false).0)
}

pub fn resource_uri(run_id: &str) -> String {
    format!("{RESOURCE_PREFIX}{run_id}{RESOURCE_SUFFIX}")
}

fn has_exact_log_artifact(value: &Value, run_id: &str, raw_log_bytes: usize) -> bool {
    let expected_uri = resource_uri(run_id);
    let expected_id = format!("{LOG_ARTIFACT_PREFIX}{run_id}");
    value
        .get("artifacts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|artifact| {
            artifact.get("id").and_then(Value::as_str) == Some(expected_id.as_str())
                && artifact.get("kind").and_then(Value::as_str) == Some("log")
                && artifact.get("uri").and_then(Value::as_str) == Some(expected_uri.as_str())
                && artifact
                    .get("metadata")
                    .and_then(|metadata| metadata.get("outputField"))
                    .and_then(Value::as_str)
                    == Some(SOURCE_BUILD_LOG_FIELD)
                && artifact
                    .get("metadata")
                    .and_then(|metadata| metadata.get("encoding"))
                    .and_then(Value::as_str)
                    == Some("utf-8-lossy")
                && artifact
                    .get("metadata")
                    .and_then(|metadata| metadata.get("source"))
                    .and_then(Value::as_str)
                    == Some("merged_stdout_stderr")
                && artifact
                    .get("metadata")
                    .and_then(|metadata| metadata.get("untrusted"))
                    .and_then(Value::as_bool)
                    == Some(true)
                && artifact.get("sizeBytes").and_then(Value::as_u64) == Some(raw_log_bytes as u64)
        })
}

fn render_log(raw_log: &str, preview: bool) -> (String, bool) {
    let (sanitized, _) = PromptSanitizer::sanitize_observation(raw_log);
    if !preview {
        return (wrap_untrusted(&sanitized), false);
    }

    let initial = prune_tool_output(&sanitized, MCP_LOG_PREVIEW_MAX_CHARS);
    let initial_wrapped = wrap_untrusted(&initial);
    if initial_wrapped.len() <= MCP_LOG_PREVIEW_MAX_BYTES {
        let truncated = initial != sanitized;
        return (initial_wrapped, truncated);
    }

    // Bound the serialized resource preview, not merely Unicode scalar count.
    // Binary search keeps the existing head+tail pruning behavior while ensuring
    // XML escaping and the wrapper still fit the 16 KiB MCP preview budget.
    let mut low = 64usize;
    let mut high = MCP_LOG_PREVIEW_MAX_CHARS.saturating_sub(1);
    let mut best = wrap_untrusted(&prune_tool_output(&sanitized, low));
    while low <= high {
        let middle = low + (high - low) / 2;
        let candidate = wrap_untrusted(&prune_tool_output(&sanitized, middle));
        if candidate.len() <= MCP_LOG_PREVIEW_MAX_BYTES {
            best = candidate;
            low = middle.saturating_add(1);
        } else {
            high = middle.saturating_sub(1);
        }
    }
    (best, true)
}

fn wrap_untrusted(content: &str) -> String {
    let escaped = xml_escape(content);
    format!("<untrusted_data source=\"source-build-runner-log\">{escaped}</untrusted_data>")
}

fn xml_escape(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for character in input.chars() {
        if !is_xml10_character(character) {
            escaped.push('�');
            continue;
        }
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn is_xml10_character(character: char) -> bool {
    matches!(character, '\u{9}' | '\u{A}' | '\u{D}')
        || matches!(character, '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')
}

#[cfg(test)]
#[path = "task_run_output_tests.rs"]
mod tests;
