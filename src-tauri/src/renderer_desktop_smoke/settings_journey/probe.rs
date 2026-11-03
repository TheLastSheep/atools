use super::state::Harness;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};
use tokio::sync::oneshot;

const PROBE_TIMEOUT: Duration = Duration::from_secs(18);

pub(super) async fn main(
    app: &AppHandle<Wry>,
    harness: &Harness,
    operation: &str,
    generation: u8,
) -> Result<Value, &'static str> {
    let receiver = harness.begin(operation, generation, "main")?;
    let token = serde_json::to_string(&harness.token())
        .map_err(|_| "settings-journey-token-serialize-failed")?;
    let action = match operation {
        "entryButton" => "openButton",
        "entryKeyboard" => "openKeyboard",
        "exitButton" => "exitButton",
        "afterEscapeExit" => "afterEscape",
        _ => {
            harness.cancel(operation);
            return Err("settings-main-probe-operation-rejected");
        }
    };
    let script = format!(
        "window.__ATOOLS_SETTINGS_JOURNEY_TOKEN__={token};\n{}\nwindow.__ATOOLS_SETTINGS_JOURNEY_MAIN__.{action}({generation});",
        include_str!("main-probe.js")
    );
    let main = match crate::window::main_webview(app) {
        Ok(main) => main,
        Err(_) => {
            harness.cancel(operation);
            return Err("settings-main-webview-unavailable-for-probe");
        }
    };
    if main.eval(script).is_err() {
        harness.cancel(operation);
        return Err("settings-main-probe-eval-failed");
    }
    await_probe(harness, operation, receiver).await
}

pub(super) async fn child(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    id: &str,
    operation: &str,
    generation: u8,
    expected_placeholder: &str,
    stale_session_id: Option<&str>,
) -> Result<Value, &'static str> {
    let method = child_probe_method(operation).ok_or("settings-child-probe-operation-rejected")?;
    let receiver = harness.begin(operation, generation, child.label())?;
    let token = serde_json::to_string(&harness.token())
        .map_err(|_| "settings-journey-token-serialize-failed")?;
    let expected = serde_json::to_string(expected_placeholder)
        .map_err(|_| "settings-placeholder-serialize-failed")?;
    let stale = serde_json::to_string(&stale_session_id)
        .map_err(|_| "settings-stale-session-serialize-failed")?;
    let script = match method {
        ChildProbeMethod::Save => format!(
            "{}\nwindow.__ATOOLS_SETTINGS_JOURNEY_CHILD__.save({token},{generation});",
            include_str!("child-probe.js")
        ),
        ChildProbeMethod::Inspect => format!(
            "{}\nwindow.__ATOOLS_SETTINGS_JOURNEY_CHILD__.inspect({operation:?},{generation},{token},{expected},{stale});",
            include_str!("child-probe.js")
        ),
    };
    if !super::native::child_identity_matches(app, child, id) {
        harness.cancel(operation);
        return Err("settings-child-identity-changed-before-probe");
    }
    if child.eval(script).is_err() {
        harness.cancel(operation);
        return Err("settings-child-probe-eval-failed");
    }
    await_probe(harness, operation, receiver).await
}

#[derive(Debug, PartialEq, Eq)]
enum ChildProbeMethod {
    Inspect,
    Save,
}

fn child_probe_method(operation: &str) -> Option<ChildProbeMethod> {
    match operation {
        "childSave" => Some(ChildProbeMethod::Save),
        "childInitial" | "childReopen" => Some(ChildProbeMethod::Inspect),
        _ => None,
    }
}

pub(super) async fn child_escape_witness(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    id: &str,
) -> Result<Value, &'static str> {
    let operation = "childEscapeWitness";
    let generation = 2;
    let receiver = harness.begin(operation, generation, child.label())?;
    let token = serde_json::to_string(&harness.token())
        .map_err(|_| "settings-journey-token-serialize-failed")?;
    let script = format!(
        "{}\nwindow.__ATOOLS_SETTINGS_JOURNEY_CHILD__.escapeAndWitness({token},{generation});",
        include_str!("child-probe.js")
    );
    if !super::native::child_identity_matches(app, child, id) {
        harness.cancel(operation);
        return Err("settings-child-identity-changed-before-escape");
    }
    if child.eval(script).is_err() {
        harness.cancel(operation);
        return Err("settings-child-escape-eval-failed");
    }
    await_probe(harness, operation, receiver).await
}

pub(super) async fn preference_edit(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    id: &str,
    field: &str,
    value: &Value,
) -> Result<Value, &'static str> {
    let token = serde_json::to_string(&harness.token())
        .map_err(|_| "settings-journey-token-serialize-failed")?;
    let field =
        serde_json::to_string(field).map_err(|_| "settings-preferences-field-serialize-failed")?;
    let value =
        serde_json::to_string(value).map_err(|_| "settings-preferences-value-serialize-failed")?;
    let script = format!(
        "{}\nwindow.__ATOOLS_SETTINGS_JOURNEY_PREFERENCES__.edit({token},1,{field},{value});",
        include_str!("preferences-probe.js")
    );
    child_preferences_call(app, harness, child, id, "childPreferenceEdit", 1, script).await
}

pub(super) async fn preference_rejection(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    id: &str,
    kind: &str,
) -> Result<Value, &'static str> {
    let (operation, method) = match kind {
        "readonly" => ("childPreferenceRejectReadonly", "rejectReadonly"),
        "invalidValue" => ("childPreferenceRejectInvalid", "rejectInvalid"),
        _ => return Err("settings-preferences-rejection-kind-rejected"),
    };
    let token = serde_json::to_string(&harness.token())
        .map_err(|_| "settings-journey-token-serialize-failed")?;
    let script = format!(
        "{}\nwindow.__ATOOLS_SETTINGS_JOURNEY_PREFERENCES__.{method}({token},1);",
        include_str!("preferences-probe.js")
    );
    child_preferences_call(app, harness, child, id, operation, 1, script).await
}

pub(super) async fn preferences_reopen(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    id: &str,
) -> Result<Value, &'static str> {
    let token = serde_json::to_string(&harness.token())
        .map_err(|_| "settings-journey-token-serialize-failed")?;
    let script = format!(
        "{}\nwindow.__ATOOLS_SETTINGS_JOURNEY_PREFERENCES__.inspectReopened({token},2);",
        include_str!("preferences-probe.js")
    );
    child_preferences_call(app, harness, child, id, "childPreferencesReopen", 2, script).await
}

pub(super) async fn observe_main_preferences(
    app: &AppHandle<Wry>,
    harness: &Harness,
    expected: &Value,
) -> Result<Value, &'static str> {
    let operation = "observePreferences";
    let generation = 1;
    let receiver = harness.begin(operation, generation, "main")?;
    let token = serde_json::to_string(&harness.token())
        .map_err(|_| "settings-journey-token-serialize-failed")?;
    let expected = serde_json::to_string(expected)
        .map_err(|_| "settings-preferences-main-values-serialize-failed")?;
    let script = format!(
        "window.__ATOOLS_SETTINGS_JOURNEY_TOKEN__={token};\n{}\nwindow.__ATOOLS_SETTINGS_JOURNEY_MAIN__.observePreferences({generation},{expected});",
        include_str!("main-probe.js")
    );
    let main = match crate::window::main_webview(app) {
        Ok(main) => main,
        Err(_) => {
            harness.cancel(operation);
            return Err("settings-main-webview-unavailable-for-preferences-probe");
        }
    };
    if main.eval(script).is_err() {
        harness.cancel(operation);
        return Err("settings-main-preferences-probe-eval-failed");
    }
    await_probe(harness, operation, receiver).await
}

pub(super) async fn observe_cold_startup(
    app: &AppHandle<Wry>,
    harness: &Harness,
    expected: &Value,
) -> Result<Value, &'static str> {
    let operation = "observeColdStartup";
    let generation = 1;
    let receiver = harness.begin(operation, generation, "main")?;
    let token = serde_json::to_string(&harness.token())
        .map_err(|_| "settings-journey-token-serialize-failed")?;
    let expected = serde_json::to_string(expected)
        .map_err(|_| "settings-preferences-cold-values-serialize-failed")?;
    let script = format!(
        "window.__ATOOLS_SETTINGS_JOURNEY_TOKEN__={token};\n{}\nwindow.__ATOOLS_SETTINGS_JOURNEY_MAIN__.observeColdStartup({generation},{expected});",
        include_str!("main-probe.js")
    );
    let main = match crate::window::main_webview(app) {
        Ok(main) => main,
        Err(_) => {
            harness.cancel(operation);
            return Err("settings-main-webview-unavailable-for-cold-preferences-probe");
        }
    };
    if main.eval(script).is_err() {
        harness.cancel(operation);
        return Err("settings-main-cold-preferences-probe-eval-failed");
    }
    await_probe(harness, operation, receiver).await
}

async fn child_preferences_call(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    id: &str,
    operation: &str,
    generation: u8,
    script: String,
) -> Result<Value, &'static str> {
    let receiver = harness.begin(operation, generation, child.label())?;
    if !super::native::child_identity_matches(app, child, id) {
        harness.cancel(operation);
        return Err("settings-child-identity-changed-before-preferences-probe");
    }
    if child.eval(script).is_err() {
        harness.cancel(operation);
        return Err("settings-child-preferences-probe-eval-failed");
    }
    await_probe(harness, operation, receiver).await
}

async fn await_probe(
    harness: &Harness,
    operation: &str,
    receiver: oneshot::Receiver<Value>,
) -> Result<Value, &'static str> {
    match tokio::time::timeout(PROBE_TIMEOUT, receiver).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => {
            harness.cancel(operation);
            Err("settings-journey-probe-channel-interrupted")
        }
        Err(_) => {
            harness.cancel(operation);
            Err("settings-journey-probe-timeout")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{child_probe_method, ChildProbeMethod};

    #[test]
    fn child_save_dispatches_to_save_and_inspection_stays_separate() {
        assert_eq!(
            child_probe_method("childSave"),
            Some(ChildProbeMethod::Save)
        );
        assert_eq!(
            child_probe_method("childInitial"),
            Some(ChildProbeMethod::Inspect)
        );
        assert_eq!(
            child_probe_method("childReopen"),
            Some(ChildProbeMethod::Inspect)
        );
        assert_eq!(child_probe_method("childEscapeWitness"), None);
    }
}
