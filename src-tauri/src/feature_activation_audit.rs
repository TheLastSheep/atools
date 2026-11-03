//! Activation content belongs to the live plugin, never a durable diagnostic body.
use crate::commands::FeatureAction;
use serde_json::{json, Value};
use std::io::{self, Write};

#[derive(Default)]
struct ByteCount(usize);
impl Write for ByteCount {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn payload_summary(payload: Option<&Value>) -> Value {
    let kind = match payload {
        None | Some(Value::Null) => "null",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
    };
    if let Some(Value::String(text)) = payload {
        return json!({"type":kind,"utf8Bytes":text.len(),"contentRedacted":true});
    }
    let mut bytes = ByteCount::default();
    if let Some(value) = payload {
        let _ = serde_json::to_writer(&mut bytes, value);
    }
    json!({"type":kind,"jsonBytes":bytes.0,"contentRedacted":true})
}

pub(crate) fn output(action: &FeatureAction) -> Value {
    json!({
        "plugin_id":action.plugin_id, "feature_code":action.feature_code,
        "plugin_name":action.plugin_name, "entry_type":action.entry_type,
        "payload_summary":payload_summary(Some(&action.payload)), "resolved":true,
    })
}
