use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum VisibilityState {
    Visible,
    Hidden,
    Prerender,
    Unloaded,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FocusObservation {
    pub(super) has_focus: bool,
    pub(super) visibility_state: VisibilityState,
    pub(super) events_observed: bool,
    pub(super) focus_events: Option<u8>,
    pub(super) blur_events: Option<u8>,
}

impl FocusObservation {
    pub(super) fn from_renderer_report(report: &Value) -> Option<Self> {
        let has_focus = report.get("hasFocus")?.as_bool()?;
        let visibility_state = match report.get("visibilityState").and_then(Value::as_str) {
            Some("visible") => VisibilityState::Visible,
            Some("hidden") => VisibilityState::Hidden,
            Some("prerender") => VisibilityState::Prerender,
            Some("unloaded") => VisibilityState::Unloaded,
            _ => VisibilityState::Other,
        };
        Some(Self {
            has_focus,
            visibility_state,
            events_observed: false,
            focus_events: None,
            blur_events: None,
        })
    }

    pub(super) fn from_normalized_report(report: &Value) -> Option<Self> {
        serde_json::from_value(report.clone()).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{FocusObservation, VisibilityState};
    use serde_json::json;

    #[test]
    fn normalizes_safe_document_focus_and_visibility_fields() {
        let observation = FocusObservation::from_renderer_report(&json!({
            "hasFocus": true,
            "visibilityState": "visible",
            "secret": "ignored"
        }))
        .unwrap();

        assert_eq!(observation.has_focus, true);
        assert_eq!(observation.visibility_state, VisibilityState::Visible);
        assert_eq!(observation.events_observed, false);
        assert_eq!(observation.focus_events, None);
        assert_eq!(observation.blur_events, None);
    }

    #[test]
    fn maps_unknown_visibility_to_fixed_other_value() {
        let observation = FocusObservation::from_renderer_report(&json!({
            "hasFocus": false,
            "visibilityState": "private-runtime-value"
        }))
        .unwrap();
        assert_eq!(observation.visibility_state, VisibilityState::Other);
    }

    #[test]
    fn rejects_missing_or_wrong_typed_required_fields() {
        assert!(FocusObservation::from_renderer_report(&json!({
            "visibilityState": "hidden"
        }))
        .is_none());
        assert!(FocusObservation::from_renderer_report(&json!({
            "hasFocus": "true",
            "visibilityState": "hidden"
        }))
        .is_none());
    }

    #[test]
    fn normalized_values_reject_unknown_fields_and_unbounded_counts() {
        assert!(FocusObservation::from_normalized_report(&json!({
            "hasFocus": true,
            "visibilityState": "visible",
            "eventsObserved": false,
            "focusEvents": null,
            "blurEvents": null,
            "private": "not-allowed"
        }))
        .is_none());
        assert!(FocusObservation::from_normalized_report(&json!({
            "hasFocus": true,
            "visibilityState": "visible",
            "eventsObserved": true,
            "focusEvents": 256,
            "blurEvents": 0
        }))
        .is_none());
    }
}
