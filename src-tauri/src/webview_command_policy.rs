//! Policy for the production application's custom Tauri command dispatcher.
//!
//! This distinguishes a top-level Tauri Webview from a Tauri child Webview by
//! comparing native labels. It does not distinguish iframes inside one
//! Webview, and it does not authorize Tauri core or plugin commands; those
//! routes remain governed by capabilities.

const MAX_LABEL_BYTES: usize = 256;

/// Child Webviews currently receive no application-command access.
///
/// The two labels must come from the actual Invoke's Webview and its native
/// parent Window. Never populate these values from command arguments.
pub(crate) fn application_commands_allowed(
    caller_webview_label: &str,
    parent_window_label: &str,
) -> bool {
    !caller_webview_label.is_empty()
        && !parent_window_label.is_empty()
        && caller_webview_label.len() <= MAX_LABEL_BYTES
        && parent_window_label.len() <= MAX_LABEL_BYTES
        && caller_webview_label == parent_window_label
}

/// Fixed structured IPC rejection. It intentionally contains no caller data.
pub(crate) fn child_app_command_rejection() -> serde_json::Value {
    serde_json::json!({
        "code": "CHILD_WEBVIEW_APP_COMMAND_DENIED",
        "message": "Child WebViews cannot invoke application commands"
    })
}

#[cfg(test)]
mod tests {
    use super::{application_commands_allowed, child_app_command_rejection, MAX_LABEL_BYTES};

    #[test]
    fn matching_top_level_webviews_keep_existing_command_dispatch() {
        for label in [
            "main",
            "settings",
            "atools-native-browser-0123456789abcdef0123456789abcdef",
        ] {
            assert!(application_commands_allowed(label, label), "{label}");
        }
    }

    #[test]
    fn child_and_mismatched_parent_labels_are_rejected() {
        assert!(!application_commands_allowed("renderer-settings", "main"));
        assert!(!application_commands_allowed(
            "renderer-settings",
            "settings"
        ));
        assert!(!application_commands_allowed("main", "renderer-settings"));
    }

    #[test]
    fn empty_or_oversized_labels_are_rejected_even_when_equal() {
        assert!(!application_commands_allowed("", ""));
        assert!(!application_commands_allowed("", "main"));
        assert!(!application_commands_allowed("main", ""));

        let boundary = "x".repeat(MAX_LABEL_BYTES);
        assert!(application_commands_allowed(&boundary, &boundary));
        let oversized = "x".repeat(MAX_LABEL_BYTES + 1);
        assert!(!application_commands_allowed(&oversized, &oversized));
    }

    #[test]
    fn rejection_is_fixed_structured_and_does_not_echo_labels() {
        assert_eq!(
            child_app_command_rejection(),
            serde_json::json!({
                "code": "CHILD_WEBVIEW_APP_COMMAND_DENIED",
                "message": "Child WebViews cannot invoke application commands"
            })
        );
    }
}
