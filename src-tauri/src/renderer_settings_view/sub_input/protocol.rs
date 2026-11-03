use serde_json::{json, Map, Value};

use super::state::{SubInputSnapshot, Transition, MAX_SAFE_INTEGER};
use crate::renderer_settings_view::{
    identity::is_valid_session_id,
    session::SessionView,
    validation::{invalid_payload, BridgeError},
};

pub(crate) const MAX_OPERATION_PAYLOAD_BYTES: usize = 32 * 1024;
pub(crate) const MAX_TEXT_BYTES: usize = 16 * 1024;
pub(crate) const MAX_PLACEHOLDER_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum InputAction {
    Set,
    Remove,
    Value,
    Focus,
    Blur,
    Select,
}

impl InputAction {
    pub(crate) fn parse(value: &str) -> Result<Self, BridgeError> {
        match value {
            "set" => Ok(Self::Set),
            "remove" => Ok(Self::Remove),
            "value" => Ok(Self::Value),
            "focus" => Ok(Self::Focus),
            "blur" => Ok(Self::Blur),
            "select" => Ok(Self::Select),
            _ => Err(invalid_payload()),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Set => "set",
            Self::Remove => "remove",
            Self::Value => "value",
            Self::Focus => "focus",
            Self::Blur => "blur",
            Self::Select => "select",
        }
    }

    pub(crate) fn requests_focus(self, requested: bool) -> bool {
        match self {
            Self::Set => requested,
            Self::Value | Self::Focus | Self::Select => true,
            Self::Remove | Self::Blur => false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ControlRequest {
    pub(crate) action: InputAction,
    pub(crate) generation: u64,
    pub(crate) sequence: u64,
    pub(crate) placeholder: Option<String>,
    pub(crate) focus: bool,
    pub(crate) value: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MainInputRequest {
    pub(crate) session_id: String,
    pub(crate) bundle_revision: String,
    pub(crate) generation: u64,
    pub(crate) value_version: u64,
    pub(crate) sequence: u64,
    pub(crate) text: String,
}

pub(crate) fn parse_control(value: &Value) -> Result<ControlRequest, BridgeError> {
    check_payload_budget(value)?;
    let object = value.as_object().ok_or_else(invalid_payload)?;
    let action = string(object, "action")?;
    let action = InputAction::parse(action)?;
    let allowed = match action {
        InputAction::Set => &["action", "generation", "sequence", "placeholder", "focus"][..],
        InputAction::Remove | InputAction::Focus | InputAction::Blur | InputAction::Select => {
            &["action", "generation", "sequence"][..]
        }
        InputAction::Value => &["action", "generation", "sequence", "value"][..],
    };
    reject_unknown_keys(object, allowed)?;

    let generation = positive_safe_integer(object, "generation")?;
    let sequence = positive_safe_integer(object, "sequence")?;
    let (placeholder, focus, value) = match action {
        InputAction::Set => {
            let placeholder = bounded_string(object, "placeholder", MAX_PLACEHOLDER_BYTES)?;
            let focus = object
                .get("focus")
                .and_then(Value::as_bool)
                .ok_or_else(invalid_payload)?;
            (Some(placeholder), focus, None)
        }
        InputAction::Value => (
            None,
            false,
            Some(bounded_string(object, "value", MAX_TEXT_BYTES)?),
        ),
        _ => (None, false, None),
    };

    Ok(ControlRequest {
        action,
        generation,
        sequence,
        placeholder,
        focus,
        value,
    })
}

pub(crate) fn parse_main_input(value: &Value) -> Result<MainInputRequest, BridgeError> {
    check_payload_budget(value)?;
    let object = value.as_object().ok_or_else(invalid_payload)?;
    reject_unknown_keys(
        object,
        &[
            "sessionId",
            "bundleRevision",
            "generation",
            "valueVersion",
            "sequence",
            "text",
        ],
    )?;
    if object.len() != 6 {
        return Err(invalid_payload());
    }

    let session_id = bounded_string(object, "sessionId", 32)?;
    if !is_valid_session_id(&session_id) {
        return Err(invalid_payload());
    }
    let bundle_revision = string(object, "bundleRevision")?;
    if !is_lowercase_sha256(bundle_revision) {
        return Err(invalid_payload());
    }

    Ok(MainInputRequest {
        session_id,
        bundle_revision: bundle_revision.to_owned(),
        generation: positive_safe_integer(object, "generation")?,
        value_version: safe_integer(object, "valueVersion", true)?,
        sequence: positive_safe_integer(object, "sequence")?,
        text: bounded_string(object, "text", MAX_TEXT_BYTES)?,
    })
}

pub(crate) fn reply(snapshot: &SubInputSnapshot, applied: bool) -> Value {
    json!({
        "version": 1,
        "generation": snapshot.generation,
        "revision": snapshot.revision,
        "valueVersion": snapshot.value_version,
        "applied": applied,
    })
}

pub(crate) fn main_event(session: &SessionView, transition: &Transition) -> Value {
    main_event_from_ids(
        &session.id,
        &session.bundle_revision,
        &transition.snapshot,
        transition.action,
        transition.focus,
    )
}

fn main_event_from_ids(
    session_id: &str,
    bundle_revision: &str,
    snapshot: &SubInputSnapshot,
    action: InputAction,
    focus: bool,
) -> Value {
    json!({
        "version": 1,
        "kind": "subInput",
        "sessionId": session_id,
        "bundleRevision": bundle_revision,
        "generation": snapshot.generation,
        "revision": snapshot.revision,
        "valueVersion": snapshot.value_version,
        "action": action.as_str(),
        "visible": snapshot.visible,
        "placeholder": snapshot.placeholder,
        "value": snapshot.value,
        "focus": focus,
    })
}

pub(crate) fn child_delivery(session: &SessionView, snapshot: &SubInputSnapshot) -> Value {
    child_delivery_from_ids(&session.id, &session.bundle_revision, snapshot)
}

fn child_delivery_from_ids(
    session_id: &str,
    bundle_revision: &str,
    snapshot: &SubInputSnapshot,
) -> Value {
    json!({
        "version": 1,
        "sessionId": session_id,
        "bundleRevision": bundle_revision,
        "generation": snapshot.generation,
        "revision": snapshot.revision,
        "text": snapshot.value,
    })
}

pub(crate) fn require_main_role_labels(
    webview_label: &str,
    parent_window_label: &str,
    command_window_label: &str,
) -> Result<(), BridgeError> {
    if webview_label == "main" && parent_window_label == "main" && command_window_label == "main" {
        Ok(())
    } else {
        Err(BridgeError::new(
            "SETTINGS_CALLER_REJECTED",
            "Settings input is available only to the main renderer",
        ))
    }
}

fn check_payload_budget(value: &Value) -> Result<(), BridgeError> {
    let bytes = serde_json::to_vec(value).map_err(|_| invalid_payload())?;
    if bytes.len() > MAX_OPERATION_PAYLOAD_BYTES {
        return Err(BridgeError::new(
            "SETTINGS_CALL_TOO_LARGE",
            "SubInput request exceeds the 32 KiB limit",
        ));
    }
    Ok(())
}

fn reject_unknown_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), BridgeError> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid_payload());
    }
    Ok(())
}

fn string<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a str, BridgeError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(invalid_payload)
}

fn bounded_string(
    object: &Map<String, Value>,
    field: &str,
    max_bytes: usize,
) -> Result<String, BridgeError> {
    let value = string(object, field)?;
    if value.len() > max_bytes {
        let (code, message) = match field {
            "text" | "value" => (
                "SETTINGS_SUBINPUT_TOO_LARGE",
                "SubInput text exceeds the 16 KiB limit",
            ),
            "placeholder" => (
                "SETTINGS_SUBINPUT_PLACEHOLDER_TOO_LARGE",
                "SubInput placeholder exceeds the 512 byte limit",
            ),
            _ => ("SETTINGS_INVALID_ARGUMENT", "Settings input is invalid"),
        };
        return Err(BridgeError::new(code, message));
    }
    Ok(value.to_owned())
}

fn positive_safe_integer(object: &Map<String, Value>, field: &str) -> Result<u64, BridgeError> {
    safe_integer(object, field, false)
}

fn safe_integer(
    object: &Map<String, Value>,
    field: &str,
    allow_zero: bool,
) -> Result<u64, BridgeError> {
    let value = object
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER && (allow_zero || *value > 0))
        .ok_or_else(invalid_payload)?;
    Ok(value)
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::{child_delivery_from_ids, main_event_from_ids, reply, InputAction};
    use crate::renderer_settings_view::sub_input::state::{SubInputSnapshot, Transition};
    use serde_json::Value;
    use std::collections::BTreeSet;

    fn snapshot() -> SubInputSnapshot {
        SubInputSnapshot {
            generation: 2,
            revision: 5,
            value_version: 1,
            control_sequence: 3,
            user_sequence: 4,
            visible: true,
            placeholder: "搜索".to_owned(),
            value: "text".to_owned(),
        }
    }

    fn keys(value: &Value) -> BTreeSet<&str> {
        value
            .as_object()
            .expect("protocol message is an object")
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn replies_have_the_exact_five_field_contract() {
        let reply = reply(&snapshot(), true);
        assert_eq!(
            keys(&reply),
            [
                "applied",
                "generation",
                "revision",
                "valueVersion",
                "version"
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(reply["version"], 1);
        assert_eq!(reply["applied"], true);
    }

    #[test]
    fn main_event_is_a_twelve_field_subinput_packet_not_a_phase() {
        let event = main_event_from_ids(
            "00000000000040008000000000000001",
            "bundle-a",
            &snapshot(),
            InputAction::Set,
            true,
        );
        assert_eq!(
            keys(&event),
            [
                "action",
                "bundleRevision",
                "focus",
                "generation",
                "kind",
                "placeholder",
                "revision",
                "sessionId",
                "value",
                "valueVersion",
                "version",
                "visible",
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(event["kind"], "subInput");
        assert_eq!(event["action"], "set");
    }

    #[test]
    fn child_delivery_has_only_the_six_scoped_fields() {
        let packet =
            child_delivery_from_ids("00000000000040008000000000000001", "bundle-a", &snapshot());
        assert_eq!(
            keys(&packet),
            [
                "bundleRevision",
                "generation",
                "revision",
                "sessionId",
                "text",
                "version",
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(packet["text"], "text");
    }

    #[test]
    fn event_contains_no_user_or_control_sequence_fields() {
        let transition = Transition {
            snapshot: snapshot(),
            action: InputAction::Value,
            focus: true,
            applied: true,
            closed: false,
        };
        let event = main_event_from_ids(
            "00000000000040008000000000000001",
            "bundle-a",
            &transition.snapshot,
            transition.action,
            transition.focus,
        );
        assert!(!event.as_object().unwrap().contains_key("sequence"));
        assert!(!event.as_object().unwrap().contains_key("controlSequence"));
        assert!(!event.as_object().unwrap().contains_key("userSequence"));
    }
}
