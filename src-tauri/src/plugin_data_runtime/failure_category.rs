//! Bounded, host-owned diagnostics for failed plugin data TaskRuns.
#[cfg(any(test, feature = "legacy-node-smoke"))]
use serde_json::json;
use serde_json::Value;

#[cfg(any(test, feature = "legacy-node-smoke"))]
const FAILURE_MARKER: &str = " [failureCode=";
#[cfg(any(test, feature = "legacy-node-smoke"))]
const CODES: &[&str] = &[
    "DATA_NOT_FOUND",
    "DATA_CONFLICT",
    "DATA_LOGICAL_FAILURE",
    "DATA_OPERATION_ERROR",
];

pub(super) fn for_operation(method: &str, result: &Result<Value, String>) -> &'static str {
    let Ok(value) = result else {
        return "DATA_OPERATION_ERROR";
    };
    if !super::operations::logical_failure(method, value) {
        return "DATA_OPERATION_ERROR";
    }

    let name = match method {
        "db.put" | "db.remove" | "db.bulkDocs" | "db.postAttachment" | "dbStorage.removeItem" => {
            write_result_name(value)
        }
        _ => None,
    };
    match (method, name) {
        ("db.remove" | "dbStorage.removeItem", Some("not_found")) => "DATA_NOT_FOUND",
        (
            "db.put" | "db.remove" | "db.bulkDocs" | "db.postAttachment" | "dbStorage.removeItem",
            Some("conflict"),
        ) => "DATA_CONFLICT",
        _ => "DATA_LOGICAL_FAILURE",
    }
}

fn write_result_name(value: &Value) -> Option<&str> {
    if let Some(items) = value.as_array() {
        let mut conflict = false;
        for item in items {
            if item.get("error") != Some(&Value::Bool(true)) {
                continue;
            }
            match item.get("name").and_then(Value::as_str) {
                Some("conflict") => conflict = true,
                _ => return None,
            }
        }
        return conflict.then_some("conflict");
    }
    if value.get("error") != Some(&Value::Bool(true)) {
        return None;
    }
    value.get("name").and_then(Value::as_str)
}

/// Project only finite method and failure codes into the native smoke receipt.
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) fn task_run_audit_fields(
    capability_id: &str,
    status: &str,
    input: &Value,
    summary: Option<&str>,
) -> Value {
    if !capability_id.starts_with("atools.host.data.") || input["operation"] != "request" {
        return json!({});
    }
    let mut fields = serde_json::Map::new();
    if let Some(method) = input
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| super::operations::METHODS.contains(method))
    {
        fields.insert("method".into(), json!(method));
    }
    if status == "failed" {
        if let Some(code) = summary.and_then(failure_code_from_summary) {
            fields.insert("failureCode".into(), json!(code));
        }
    }
    Value::Object(fields)
}

#[cfg(any(test, feature = "legacy-node-smoke"))]
fn failure_code_from_summary(summary: &str) -> Option<&'static str> {
    let code = summary.rsplit_once(FAILURE_MARKER)?.1.strip_suffix(']')?;
    CODES.iter().copied().find(|candidate| *candidate == code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorizes_only_host_write_outcomes_and_never_echoes_unknown_names() {
        assert_eq!(
            for_operation("db.put", &Ok(json!({"error":true,"name":"conflict"}))),
            "DATA_CONFLICT"
        );
        assert_eq!(
            for_operation("db.remove", &Ok(json!({"error":true,"name":"not_found"}))),
            "DATA_NOT_FOUND"
        );
        assert_eq!(
            for_operation(
                "db.bulkDocs",
                &Ok(json!([
                    {"error":true,"name":"conflict","id":"private-id"}
                ]))
            ),
            "DATA_CONFLICT"
        );
        assert_eq!(
            for_operation(
                "db.bulkDocs",
                &Ok(json!([
                    {"error":true,"name":"conflict"},
                    {"error":true,"name":"private-text"}
                ]))
            ),
            "DATA_LOGICAL_FAILURE"
        );
        assert_eq!(
            for_operation("db.get", &Ok(json!({"error":true,"name":"conflict"}))),
            "DATA_OPERATION_ERROR"
        );
        assert_eq!(
            for_operation(
                "dbStorage.setItem",
                &Ok(json!({"error":true,"name":"conflict"}))
            ),
            "DATA_LOGICAL_FAILURE"
        );
        assert_eq!(
            for_operation("db.put", &Err("private key/value/path".into())),
            "DATA_OPERATION_ERROR"
        );
    }

    #[test]
    fn native_audit_projection_keeps_only_whitelisted_method_and_category() {
        let projected = task_run_audit_fields(
            "atools.host.data.0123456789abcdef01234567",
            "failed",
            &json!({"operation":"request","method":"db.put","invocationId":"private-ticket","key":"private-key"}),
            Some("capability failed: private raw details [failureCode=DATA_CONFLICT]"),
        );
        assert_eq!(
            projected,
            json!({"method":"db.put","failureCode":"DATA_CONFLICT"})
        );
        assert_eq!(
            task_run_audit_fields(
                "plugin.todo.add",
                "failed",
                &json!({"operation":"request","method":"db.put"}),
                None
            ),
            json!({})
        );
        assert_eq!(
            task_run_audit_fields(
                "atools.host.data.0123456789abcdef01234567",
                "failed",
                &json!({"operation":"request","method":"unknown"}),
                Some("failed [failureCode=PRIVATE_MESSAGE]"),
            ),
            json!({})
        );
    }
}
