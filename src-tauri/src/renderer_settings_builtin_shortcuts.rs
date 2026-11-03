//! Read-only projection for the supported original Main shortcut switches.
use serde_json::{json, Value};

pub(crate) fn project_builtin_shortcuts(value: Option<&Value>) -> Value {
    let fields = value.and_then(Value::as_object);
    let enabled = |key: &str| {
        fields
            .and_then(|map| map.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    };
    json!({"search":enabled("search"),"esc":enabled("esc"),"closePlugin":enabled("closePlugin")})
}
