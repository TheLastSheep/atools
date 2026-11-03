use serde_json::Value;

pub(super) fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// Reuse the ID normalization used by the importer. Refuse its random fallback
/// so the planner and a later install report can compare stable identities.
pub(super) fn stable_installation_id(name: &str) -> Option<String> {
    if !name.bytes().any(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let id = atools_core::sanitize_id(name);
    if id.is_empty() || id.len() > 256 {
        None
    } else {
        Some(id)
    }
}

pub(super) fn vite_declaration(package: &Value) -> Option<&str> {
    let runtime = package
        .get("dependencies")
        .and_then(|value| value.get("vite"))
        .and_then(Value::as_str);
    let development = package
        .get("devDependencies")
        .and_then(|value| value.get("vite"))
        .and_then(Value::as_str);
    match (runtime, development) {
        (Some(left), Some(right)) if left != right => None,
        (Some(value), _) | (_, Some(value)) => Some(value),
        _ => None,
    }
}
