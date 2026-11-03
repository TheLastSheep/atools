use super::*;
pub(super) fn memory_scope_for_call(tool_name: &str, arguments: &Value) -> MemoryScope {
    fn string_argument(arguments: &Value, names: &[&str]) -> Option<String> {
        let object = arguments.as_object()?;
        names
            .iter()
            .find_map(|name| object.get(*name).and_then(Value::as_str))
            .map(str::to_string)
    }

    MemoryScope {
        workspace: string_argument(arguments, &["workspace", "workspacePath", "cwd"]),
        skill: string_argument(arguments, &["skill", "skillId"]),
        tool: Some(tool_name.to_string()),
        application: string_argument(arguments, &["application", "app", "appName"]),
        domain: string_argument(arguments, &["domain", "host"]),
    }
}

/// Initialize a background run before storing or dispatching its Created input.
pub(crate) fn initialize_new_task_run(db: &Database, run: &mut TaskRun) -> Result<(), String> {
    crate::launcher_media_clipboard::validate_request(&run.capability_id, &run.input)?;
    crate::launcher_clipboard_context::validate_request(&run.capability_id, &run.input)?;
    task_run_pipeline::apply_new_run_memory(db, run);
    crate::launcher_media_clipboard::validate_request(&run.capability_id, &run.input)?;
    crate::launcher_clipboard_context::validate_request(&run.capability_id, &run.input)?;
    plugin_execution_snapshot::bind_created(db, run)
}

pub(super) fn new_task_run(client_id: &str, tool_name: &str, arguments: Value) -> TaskRun {
    let initiator = if client_id == "atools-ui" {
        TaskRunInitiator::human(Some(client_id.to_string()))
    } else {
        TaskRunInitiator::agent(client_id)
    };
    TaskRun::new(tool_name, initiator, arguments)
}

pub(super) fn structured_result_summary(tool_name: &str, output: &Value) -> String {
    let count = output
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| output.get("operations").and_then(Value::as_array))
        .map(Vec::len);
    let failed = structured_failed_items(output).len();
    match count {
        Some(count) if failed > 0 => {
            format!("{tool_name} completed with {count} result item(s); {failed} failed")
        }
        Some(count) => format!("{tool_name} completed with {count} result item(s)"),
        None => format!("{tool_name} completed"),
    }
}

pub(super) fn structured_failed_items(output: &Value) -> Vec<&serde_json::Map<String, Value>> {
    output_items(output)
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("failed"))
        .collect()
}

pub(super) fn structured_result_task_status(
    item_count: usize,
    failed_count: usize,
) -> TaskRunStatus {
    if failed_count == 0 {
        TaskRunStatus::Succeeded
    } else if failed_count < item_count {
        TaskRunStatus::Partial
    } else {
        TaskRunStatus::Failed
    }
}

pub(super) fn structured_result_artifacts(run: &TaskRun) -> Vec<Artifact> {
    let mut artifacts = vec![Artifact {
        id: format!("artifact-{}", atools_core::utils::generate_rev()),
        kind: ArtifactKind::Json,
        label: format!("{} structured result", run.capability_id),
        media_type: Some("application/json".to_string()),
        uri: Some(format!("atools://task-runs/{}/output", run.id)),
        path: None,
        size_bytes: None,
        metadata: json!({ "runId": run.id }),
    }];

    match run.capability_id.as_str() {
        "compress_images" => {
            for item in output_items(&run.output).take(50) {
                let Some(path) = item.get("output").and_then(Value::as_str) else {
                    continue;
                };
                artifacts.push(path_artifact(
                    item.get("input")
                        .and_then(Value::as_str)
                        .map(|input| {
                            format!(
                                "Compressed {}",
                                Path::new(input)
                                    .file_name()
                                    .and_then(|name| name.to_str())
                                    .unwrap_or(input)
                            )
                        })
                        .unwrap_or_else(|| "Compressed image".to_string()),
                    path,
                    item.get("output_size").and_then(Value::as_u64),
                    json!({
                        "status": item.get("status"),
                        "targetMet": item.get("target_met"),
                        "compressionRatio": item.get("compression_ratio"),
                    }),
                ));
            }
        }
        "find_local_files" => {
            for item in output_items(&run.output).take(50) {
                if let Some(path) = item.get("path").and_then(Value::as_str) {
                    artifacts.push(path_artifact(
                        Path::new(path)
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or(path)
                            .to_string(),
                        path,
                        item.get("size").and_then(Value::as_u64),
                        json!({ "relativePath": item.get("relative_path") }),
                    ));
                }
            }
        }
        "open_or_reveal_path" => {
            if let Some(path) = run.output.get("path").and_then(Value::as_str) {
                artifacts.push(path_artifact(
                    "Opened path".to_string(),
                    path,
                    None,
                    json!({ "reveal": run.output.get("reveal") }),
                ));
            }
        }
        "open_url" => {
            if let Some(url) = run.output.get("url").and_then(Value::as_str) {
                artifacts.push(Artifact {
                    id: format!("artifact-{}", atools_core::utils::generate_rev()),
                    kind: ArtifactKind::Url,
                    label: "Opened URL".to_string(),
                    media_type: Some("text/uri-list".to_string()),
                    uri: Some(url.to_string()),
                    path: None,
                    size_bytes: None,
                    metadata: json!({}),
                });
            }
        }
        "ocr_image" => artifacts.push(output_field_artifact(
            run,
            ArtifactKind::RichText,
            "Recognized text",
            "text/plain",
            "text",
        )),
        "ask_ai_model" => artifacts.push(output_field_artifact(
            run,
            ArtifactKind::Markdown,
            "Model response",
            "text/markdown",
            "text",
        )),
        _ => {}
    }
    artifacts
}

pub(super) fn output_items(
    output: &Value,
) -> impl Iterator<Item = &serde_json::Map<String, Value>> {
    output
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
}

pub(super) fn output_field_artifact(
    run: &TaskRun,
    kind: ArtifactKind,
    label: &str,
    media_type: &str,
    field: &str,
) -> Artifact {
    Artifact {
        id: format!("artifact-{}", atools_core::utils::generate_rev()),
        kind,
        label: label.to_string(),
        media_type: Some(media_type.to_string()),
        uri: Some(format!("atools://task-runs/{}/output", run.id)),
        path: None,
        size_bytes: run
            .output
            .get(field)
            .and_then(Value::as_str)
            .map(|text| text.len() as u64),
        metadata: json!({ "outputField": field }),
    }
}

pub(super) fn path_artifact(
    label: String,
    path: &str,
    size_bytes: Option<u64>,
    metadata: Value,
) -> Artifact {
    let path_ref = Path::new(path);
    let extension = path_ref
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (kind, media_type) = if path_ref.is_dir() {
        (ArtifactKind::Directory, None)
    } else {
        match extension.as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "svg" => (
                ArtifactKind::Image,
                Some(image_mime_for_path(path_ref).to_string()),
            ),
            "md" | "markdown" => (ArtifactKind::Markdown, Some("text/markdown".to_string())),
            "csv" => (ArtifactKind::Csv, Some("text/csv".to_string())),
            "json" => (ArtifactKind::Json, Some("application/json".to_string())),
            "diff" | "patch" => (ArtifactKind::Diff, Some("text/x-diff".to_string())),
            "log" => (ArtifactKind::Log, Some("text/plain".to_string())),
            _ => (ArtifactKind::File, None),
        }
    };
    Artifact {
        id: format!("artifact-{}", atools_core::utils::generate_rev()),
        kind,
        label,
        media_type,
        uri: None,
        path: Some(path.to_string()),
        size_bytes,
        metadata,
    }
}

pub(super) fn task_run_success(run: &TaskRun, output: Value) -> McpToolCallResult {
    McpToolCallResult::success(task_run_envelope(run, output))
}

pub(super) fn task_run_error(run: &TaskRun, output: Value) -> McpToolCallResult {
    McpToolCallResult {
        structured_content: task_run_envelope(run, output),
        is_error: true,
    }
}

pub(crate) fn task_run_result(run: &TaskRun) -> McpToolCallResult {
    let output = run.output.clone();
    if matches!(
        run.status,
        TaskRunStatus::Succeeded | TaskRunStatus::Partial
    ) {
        task_run_success(run, output)
    } else {
        task_run_error(run, output)
    }
}

pub(super) fn task_run_envelope(run: &TaskRun, output: Value) -> Value {
    let mut fields = match output {
        Value::Object(fields) => fields,
        other => {
            let mut fields = serde_json::Map::new();
            fields.insert("result".to_string(), other);
            fields
        }
    };
    fields.insert("runId".to_string(), Value::String(run.id.clone()));
    fields.insert(
        "status".to_string(),
        Value::String(run.status.as_str().to_string()),
    );
    fields.insert(
        "summary".to_string(),
        run.summary
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    fields.insert("metrics".to_string(), run.metrics.clone());
    fields.insert(
        "artifacts".to_string(),
        serde_json::to_value(&run.artifacts).unwrap_or_else(|_| json!([])),
    );
    fields.insert(
        "validation".to_string(),
        serde_json::to_value(&run.validation).unwrap_or(Value::Null),
    );
    fields.insert(
        "resultUrl".to_string(),
        Value::String(format!("atools://task-runs/{}", run.id)),
    );
    Value::Object(fields)
}
