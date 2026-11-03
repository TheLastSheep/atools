use super::*;
pub(super) fn find_local_files_tool_call(arguments: Value) -> Result<Value, String> {
    let root = arguments
        .get("root")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Cannot determine home directory".to_string())?;
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .min(500) as usize;
    let max_depth = arguments
        .get("max_depth")
        .and_then(Value::as_u64)
        .map(|depth| depth.min(100) as usize);
    let ignore_dirs = arguments
        .get("ignore_dirs")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(default_ignored_dirs);
    let ignore_patterns = arguments
        .get("ignore_patterns")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let report = find_local_files_with_options(
        &root,
        query,
        &FindLocalFilesOptions {
            limit,
            max_depth,
            ignore_dirs,
            ignore_patterns,
        },
    )?;
    Ok(json!({
        "items": report.items,
        "skipped_permission_errors": report.skipped_permission_errors
    }))
}

pub(super) fn rename_files_tool_call(arguments: Value) -> Result<Value, String> {
    let dry_run = arguments
        .get("dry_run")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let operations: Vec<RenameOperation> = serde_json::from_value(
        arguments
            .get("operations")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({ "operations": plan_renames(&operations, dry_run)? }))
}
