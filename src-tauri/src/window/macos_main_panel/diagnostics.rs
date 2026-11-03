use objc2::{
    runtime::{AnyClass, NSObjectProtocol},
    sel, ClassType,
};
use objc2_app_kit::{NSPanel, NSWindow};
use serde_json::{json, Value};
use tauri::{WebviewWindow, Wry};

use super::super::layout::{self, cstr, required_instance_getters_owned};
use super::super::{
    RawAToolsMainPanel, MAIN_PANEL_ALREADY_ACTIVE, MAIN_PANEL_CONVERSION_FAILED,
    MAIN_PANEL_DIAGNOSTIC_ERROR_REJECTED, MAIN_PANEL_LAYOUT_REJECTED,
    MAIN_PANEL_MAIN_THREAD_REQUIRED, MAIN_PANEL_RECOVERY_FAILED, MAIN_PANEL_SCOPE_REJECTED,
    MAIN_PANEL_STATE_UNAVAILABLE, MAIN_PANEL_WINDOW_UNAVAILABLE,
};
use super::ns_window;

const MAX_METADATA_TEXT_BYTES: usize = 128;
const MAX_OWN_METHOD_NAMES: usize = 32;

fn error_code_allowed(error_code: &str) -> bool {
    matches!(
        error_code,
        MAIN_PANEL_ALREADY_ACTIVE
            | MAIN_PANEL_CONVERSION_FAILED
            | MAIN_PANEL_LAYOUT_REJECTED
            | MAIN_PANEL_MAIN_THREAD_REQUIRED
            | MAIN_PANEL_RECOVERY_FAILED
            | MAIN_PANEL_SCOPE_REJECTED
            | MAIN_PANEL_STATE_UNAVAILABLE
            | MAIN_PANEL_WINDOW_UNAVAILABLE
    )
}

fn bounded_text(value: &str) -> String {
    let mut end = value.len().min(MAX_METADATA_TEXT_BYTES);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn class_name(class: Option<&AnyClass>) -> Option<String> {
    class.map(|class| bounded_text(&class.name().to_string_lossy()))
}

fn summarize_method_names(mut names: Vec<String>) -> (usize, Vec<String>, bool) {
    names.sort_unstable();
    let actual_count = names.len();
    let names_truncated = actual_count > MAX_OWN_METHOD_NAMES
        || names
            .iter()
            .take(MAX_OWN_METHOD_NAMES)
            .any(|name| name.len() > MAX_METADATA_TEXT_BYTES);
    let bounded_names = names
        .into_iter()
        .take(MAX_OWN_METHOD_NAMES)
        .map(|name| bounded_text(&name))
        .collect();
    (actual_count, bounded_names, names_truncated)
}

pub(in crate::window::macos_main_panel) fn collect(
    window: &WebviewWindow<Wry>,
    run_id: &str,
    error_code: &str,
) -> Result<Value, &'static str> {
    if !error_code_allowed(error_code) {
        return Err(MAIN_PANEL_DIAGNOSTIC_ERROR_REJECTED);
    }
    if window.label() != "main"
        || window
            .is_visible()
            .map_err(|_| MAIN_PANEL_WINDOW_UNAVAILABLE)?
    {
        return Err(MAIN_PANEL_WINDOW_UNAVAILABLE);
    }
    let native = ns_window(window)?;
    if native.isVisible() {
        return Err(MAIN_PANEL_WINDOW_UNAVAILABLE);
    }

    let original = native.class();
    // SAFETY: `-class` returns an immortal Objective-C Class object for the receiver.
    let reported_class = layout::reported_class(native);
    let target = RawAToolsMainPanel::class();
    let ns_window = NSWindow::class();
    let ns_panel = NSPanel::class();
    let [can_become_key_getter, can_become_main_getter] = required_instance_getters_owned(target);
    let focusable = original.instance_variable(cstr(b"focusable\0"));
    let focusable_offset = focusable.and_then(|ivar| usize::try_from(ivar.offset()).ok());
    let focusable_encoding = focusable
        .and_then(|ivar| ivar.type_encoding().to_str().ok())
        .map(bounded_text);
    let layout_safe =
        layout::layout_facts(original, reported_class, target).map(|facts| facts.is_safe);
    let method_names: Vec<String> = original
        .instance_methods()
        .iter()
        .map(|method| method.name().name().to_string_lossy().into_owned())
        .collect();
    let (original_method_count, original_method_names, original_method_names_truncated) =
        summarize_method_names(method_names);

    Ok(json!({
        "schemaVersion": 1,
        "kind": "main-panel-installation-diagnostic",
        "pid": std::process::id(),
        "runId": run_id,
        "errorCode": error_code,
        "originalClass": class_name(Some(original)),
        "reportedClass": class_name(Some(reported_class)),
        "panelClass": class_name(Some(target)),
        "superclasses": {
            "original": class_name(original.superclass()),
            "panel": class_name(target.superclass()),
            "nsWindow": class_name(ns_window.superclass()),
            "nsPanel": class_name(ns_panel.superclass()),
        },
        "nsWindowInstanceSize": ns_window.instance_size(),
        "nsPanelInstanceSize": ns_panel.instance_size(),
        "targetInstanceSize": target.instance_size(),
        "originalInstanceSize": original.instance_size(),
        "nsPanelOwnIvarCount": ns_panel.instance_variables().len(),
        "rawPanelOwnIvarCount": target.instance_variables().len(),
        "originalOwnIvarCount": original.instance_variables().len(),
        "originalOwnMethodCount": original_method_count,
        "originalOwnMethodNames": original_method_names,
        "originalOwnMethodNamesTruncated": original_method_names_truncated,
        "focusableOffset": focusable_offset,
        "focusableEncoding": focusable_encoding,
        "requiredInstanceGetters": {
            "canBecomeKeyWindow": can_become_key_getter,
            "canBecomeMainWindow": can_become_main_getter,
        },
        "privateSelectorAvailable": native.respondsToSelector(sel!(_setPreventsActivation:)),
        "layoutFactsSafe": layout_safe,
    }))
}

#[cfg(test)]
mod tests {
    use super::super::super::{MAIN_PANEL_CONVERSION_FAILED, MAIN_PANEL_DIAGNOSTIC_ERROR_REJECTED};
    use super::{bounded_text, error_code_allowed, summarize_method_names, MAX_OWN_METHOD_NAMES};

    #[test]
    fn diagnostic_error_code_is_a_fixed_allowlist() {
        assert!(error_code_allowed(MAIN_PANEL_CONVERSION_FAILED));
        assert!(!error_code_allowed(MAIN_PANEL_DIAGNOSTIC_ERROR_REJECTED));
        assert!(!error_code_allowed("MAIN_PANEL_CONVERSION_FAILED-extra"));
    }

    #[test]
    fn metadata_text_limit_preserves_utf8_boundaries() {
        let value = format!("{}界", "a".repeat(127));
        assert_eq!(bounded_text(&value).len(), 127);
    }

    #[test]
    fn method_name_truncation_uses_actual_count_and_sorts_names() {
        let names = (0..MAX_OWN_METHOD_NAMES + 1)
            .rev()
            .map(|index| format!("method-{index:02}"))
            .collect();
        let (actual_count, bounded_names, truncated) = summarize_method_names(names);
        assert_eq!(actual_count, MAX_OWN_METHOD_NAMES + 1);
        assert_eq!(bounded_names.len(), MAX_OWN_METHOD_NAMES);
        assert!(bounded_names.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(truncated);
    }
}
