use serde_json::{json, Value};

const EVENT_PHASES: [&str; 5] = [
    "placeholder",
    "opened",
    "loaded",
    "closed",
    "back-to-search",
];

pub(super) fn build_open_receipt(session_id: &str) -> Value {
    json!({"version":1,"sessionId":session_id})
}

pub(super) fn build_event_payload(
    session_id: &str,
    phase: &str,
    plugin: Option<Value>,
) -> Result<Value, String> {
    if !EVENT_PHASES.contains(&phase) || (phase == "opened") != plugin.is_some() {
        return Err("Settings view lifecycle payload is invalid".into());
    }
    let mut payload = json!({"version":1,"sessionId":session_id,"phase":phase});
    if let Some(plugin) = plugin {
        payload["plugin"] = plugin;
    }
    Ok(payload)
}

#[cfg(test)]
#[path = "event_payload_tests.rs"]
mod tests;
