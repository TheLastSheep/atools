use super::{
    native::{
        child_incognito_data_store_persistent, child_url, fixture_is_valid,
        inspect_native_child_bounds, native_main_window_state, option_count, parse_general,
        raw_general, record_probe_error, trusted_child_source, unknown_fields_preserved,
        wait_for_active_child, wait_for_closed_session, wait_for_saved_raw,
    },
    probe::{child, child_escape_witness, main},
    state::{owned_child_count, Harness},
};
use serde_json::Value;
use tauri::{AppHandle, Manager, Wry};

const INITIAL_PLACEHOLDER: &str = "atools-native-settings-initial";
const FIXED_PLACEHOLDER: &str = "atools-native-settings-fixed";

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let baseline = raw_general(app)?;
    let baseline_value = parse_general(&baseline).ok_or("settings-fixture-general-invalid")?;
    let auto_clear = app
        .state::<super::super::controller::Harness>()
        .auto_clear()
        .to_owned();
    let fixture_ok = fixture_is_valid(&baseline, &baseline_value, &auto_clear);
    harness.set(
        &["fixture", "readonlyDataAccepted"],
        Value::Bool(fixture_ok),
    );
    if !fixture_ok {
        harness.record_error("settings-fixture-readonly-data-invalid");
    }
    super::preferences::observe_cold_startup(app, harness, &baseline_value).await?;

    let button_entry = main(app, harness, "entryButton", 1).await?;
    let placeholder_notifications_before = button_entry["placeholderNotificationCount"].as_u64();
    let initial = wait_for_active_child(app).await?;
    let initial_id = initial.1.clone();
    let initial_url = child_url(&initial.0)?;
    record_child_bounds(harness, "initial", inspect_native_child_bounds(&initial.0));
    let initial_diagnostics = crate::renderer_settings_view::snapshot(app);
    let initial_report = child(
        app,
        harness,
        &initial.0,
        &initial_id,
        "childInitial",
        1,
        INITIAL_PLACEHOLDER,
        None,
    )
    .await?;
    let initial_incognito = child_incognito_data_store_persistent(&initial.0).await;
    let source_trusted = trusted_child_source(&initial_diagnostics, &initial.0, &initial_id);
    let dom_mounted = initial_report["domMounted"].as_bool() == Some(true)
        && initial_report["inputFound"].as_bool() == Some(true)
        && initial_report["placeholderMatches"].as_bool() == Some(true)
        && initial_report["notIframe"].as_bool() == Some(true);
    let native_ready = initial_diagnostics["ready"].as_bool() == Some(true)
        && dom_mounted
        && initial_report["nativeReady"].as_bool() == Some(true)
        && initial_report["themeApplied"].as_bool() == Some(true)
        && initial_report["platform"].as_str() == Some("darwin");
    let projection_count = initial_report["projectionFieldCount"].as_u64();
    let secrets_absent = initial_report["secretsAbsent"].as_bool() == Some(true)
        && initial_report["readGeneralSucceeded"].as_bool() == Some(true);

    harness.set(&["bootstrap", "domMounted"], Value::Bool(dom_mounted));
    harness.set(&["bootstrap", "nativeReady"], Value::Bool(native_ready));
    harness.set(
        &["bootstrap", "platform"],
        initial_report["platform"].clone(),
    );
    harness.set(
        &["bootstrap", "launchAtLoginAvailable"],
        initial_report["launchAtLoginAvailable"].clone(),
    );
    harness.set(
        &["bootstrap", "opacityApplied"],
        initial_report["opacityApplied"].clone(),
    );
    harness.set(&["bootstrap", "sourceTrusted"], Value::Bool(source_trusted));
    harness.set(
        &["bootstrap", "childIncognitoDataStorePersistent"],
        match initial_incognito {
            Ok(value) => Value::Bool(value),
            Err(_) => Value::Null,
        },
    );
    harness.set(
        &["fixture", "projectionFieldCount"],
        projection_count.map_or(Value::Null, Value::from),
    );
    harness.set(
        &["isolation", "genericAppDenied"],
        initial_report["genericAppDenied"].clone(),
    );
    harness.set(
        &["isolation", "coreDenied"],
        initial_report["coreDenied"].clone(),
    );
    harness.set(
        &["isolation", "coreDenialDiagnosticInitial"],
        initial_report["coreDenialDiagnostic"].clone(),
    );
    harness.set(
        &["isolation", "unlistedResourceDenied"],
        initial_report["unlistedResourceDenied"].clone(),
    );
    harness.set(&["isolation", "secretsAbsent"], Value::Bool(secrets_absent));
    harness.set(
        &["entryPoints", "button", "mainPluginMode"],
        button_entry["mainPluginMode"].clone(),
    );
    let button_child_views = owned_child_count(
        &crate::window::main_window(app)
            .map_err(|_| "settings-main-window-unavailable-after-button-entry")?,
    );
    harness.set(
        &["entryPoints", "button", "childViews"],
        Value::from(button_child_views),
    );
    record_probe_error(harness, &button_entry, "settings-button-entry-not-observed");
    record_probe_error(harness, &initial_report, "settings-initial-child-not-ready");
    if button_child_views != 1 {
        harness.record_error("settings-button-entry-child-count-invalid");
    }
    if !dom_mounted {
        harness.record_error("settings-general-dom-not-mounted");
    }
    if !native_ready {
        harness.record_error("settings-native-bootstrap-not-ready");
    }
    if !source_trusted {
        harness.record_error("settings-bundle-source-not-trusted");
    }
    if initial_incognito != Ok(false) {
        harness.record_error("settings-child-incognito-data-store-not-proven");
    }

    let save_report = child(
        app,
        harness,
        &initial.0,
        &initial_id,
        "childSave",
        1,
        FIXED_PLACEHOLDER,
        None,
    )
    .await?;
    let committed_raw = wait_for_saved_raw(app).await?;
    let committed_value = parse_general(&committed_raw).ok_or("settings-save-raw-invalid")?;
    let raw_updated =
        committed_value.get("placeholder").and_then(Value::as_str) == Some(FIXED_PLACEHOLDER);
    let unknown_preserved = unknown_fields_preserved(&baseline_value, &committed_value);
    let save_acknowledged = save_report["saveAcknowledged"].as_bool() == Some(true)
        && save_report["projectionPersisted"].as_bool() == Some(true);
    harness.set(
        &["save", "inputChanged"],
        save_report["inputChanged"].clone(),
    );
    harness.set(
        &["save", "rawUpdated"],
        Value::Bool(raw_updated && unknown_preserved),
    );
    harness.set(
        &["save", "committed"],
        Value::Bool(raw_updated && unknown_preserved && save_acknowledged),
    );
    harness.set(
        &["fixture", "unknownFieldsPreserved"],
        Value::Bool(unknown_preserved),
    );
    record_probe_error(
        harness,
        &save_report,
        "settings-general-save-not-acknowledged",
    );
    if !raw_updated {
        harness.record_error("settings-general-raw-placeholder-not-updated");
    }
    if !unknown_preserved {
        harness.record_error("settings-general-unknown-fields-not-preserved");
    }
    super::preferences::run(app, harness, &initial.0, &initial_id).await?;

    let button_exit = main(app, harness, "exitButton", 1).await?;
    let first_cleanup = wait_for_closed_session(app).await?;
    let button_layout = crate::window::main_child_layout_active_count(app).ok();
    let button_native_window = native_main_window_state(app);
    let button_exit_ok = button_exit["buttonLocated"].as_bool() == Some(true)
        && button_exit["buttonClicked"].as_bool() == Some(true)
        && button_exit["closedPhaseObserved"].as_bool() == Some(true);
    harness.set(
        &["exit", "button", "childAbsent"],
        Value::Bool(first_cleanup),
    );
    harness.set(
        &["exit", "button", "layoutRegistrations"],
        option_count(button_layout),
    );
    harness.set(
        &["exit", "button", "searchQueryEmpty"],
        button_exit["searchQueryEmpty"].clone(),
    );
    harness.set(
        &["exit", "button", "searchFocused"],
        button_exit["searchFocused"].clone(),
    );
    harness.set(
        &["exit", "button", "nativeWindowVisible"],
        Value::Bool(button_native_window.0),
    );
    harness.set(
        &["exit", "button", "nativeWindowFocused"],
        Value::Bool(button_native_window.1),
    );
    harness.set(
        &["save", "mainNotified"],
        Value::Bool(
            button_exit["visiblePlaceholderMatches"].as_bool() == Some(true)
                && button_exit["placeholderNotificationCount"]
                    .as_u64()
                    .zip(placeholder_notifications_before)
                    .is_some_and(|(after, before)| after > before),
        ),
    );
    if !button_exit_ok {
        harness.record_error("settings-plugin-exit-button-not-observed");
    }
    if !first_cleanup || button_layout != Some(0) {
        harness.record_error("settings-button-exit-native-cleanup-failed");
    }
    record_probe_error(
        harness,
        &button_exit,
        "settings-main-search-state-after-button-exit-invalid",
    );
    if button_exit["visiblePlaceholderMatches"].as_bool() != Some(true)
        || button_exit["placeholderNotificationCount"]
            .as_u64()
            .zip(placeholder_notifications_before)
            .is_none_or(|(after, before)| after <= before)
    {
        harness.record_error("settings-main-placeholder-notification-not-observed");
    }
    super::preferences::observe_main_after_exit(app, harness).await?;

    let keyboard_entry = main(app, harness, "entryKeyboard", 2).await?;
    let reopened = wait_for_active_child(app).await?;
    let reopened_id = reopened.1.clone();
    let reopened_url = child_url(&reopened.0)?;
    record_child_bounds(harness, "reopen", inspect_native_child_bounds(&reopened.0));
    let reopened_report = child(
        app,
        harness,
        &reopened.0,
        &reopened_id,
        "childReopen",
        2,
        FIXED_PLACEHOLDER,
        Some(&initial_id),
    )
    .await?;
    let reopened_incognito = child_incognito_data_store_persistent(&reopened.0).await;
    super::preferences::inspect_reopened(app, harness, &reopened.0, &reopened_id).await?;
    let fresh_document = initial_id != reopened_id
        && initial_url != reopened_url
        && initial_report["documentIdentity"].as_str().is_some()
        && initial_report["documentIdentity"] != reopened_report["documentIdentity"]
        && initial_report["sessionIdentity"].as_str().is_some()
        && initial_report["sessionIdentity"] != reopened_report["sessionIdentity"];
    let persisted_dom = reopened_report["domMounted"].as_bool() == Some(true)
        && reopened_report["inputFound"].as_bool() == Some(true)
        && reopened_report["placeholderMatches"].as_bool() == Some(true)
        && reopened_report["notIframe"].as_bool() == Some(true);
    let reopen_secrets_absent = reopened_report["secretsAbsent"].as_bool() == Some(true);
    harness.set(
        &["entryPoints", "keyboard", "mainPluginMode"],
        keyboard_entry["mainPluginMode"].clone(),
    );
    let keyboard_child_views = owned_child_count(
        &crate::window::main_window(app)
            .map_err(|_| "settings-main-window-unavailable-after-keyboard-entry")?,
    );
    harness.set(
        &["entryPoints", "keyboard", "childViews"],
        Value::from(keyboard_child_views),
    );
    harness.set(&["reopen", "freshDocument"], Value::Bool(fresh_document));
    harness.set(&["reopen", "persistedDOM"], Value::Bool(persisted_dom));
    if reopened_incognito != Ok(false) {
        harness.set(
            &["bootstrap", "childIncognitoDataStorePersistent"],
            Value::Null,
        );
    }
    harness.set(
        &["isolation", "staleSessionRejected"],
        reopened_report["staleSessionRejected"].clone(),
    );
    harness.set(
        &["isolation", "genericAppDenied"],
        Value::Bool(
            harness.snapshot()["isolation"]["genericAppDenied"].as_bool() == Some(true)
                && reopened_report["genericAppDenied"].as_bool() == Some(true),
        ),
    );
    harness.set(
        &["isolation", "coreDenied"],
        Value::Bool(
            harness.snapshot()["isolation"]["coreDenied"].as_bool() == Some(true)
                && reopened_report["coreDenied"].as_bool() == Some(true),
        ),
    );
    harness.set(
        &["isolation", "coreDenialDiagnosticReopen"],
        reopened_report["coreDenialDiagnostic"].clone(),
    );
    harness.set(
        &["isolation", "unlistedResourceDenied"],
        Value::Bool(
            harness.snapshot()["isolation"]["unlistedResourceDenied"].as_bool() == Some(true)
                && reopened_report["unlistedResourceDenied"].as_bool() == Some(true),
        ),
    );
    harness.set(
        &["isolation", "secretsAbsent"],
        Value::Bool(secrets_absent && reopen_secrets_absent),
    );
    record_probe_error(
        harness,
        &keyboard_entry,
        "settings-keyboard-entry-not-observed",
    );
    record_probe_error(
        harness,
        &reopened_report,
        "settings-reopened-child-not-ready",
    );
    if keyboard_child_views != 1 {
        harness.record_error("settings-keyboard-entry-child-count-invalid");
    }
    if !fresh_document {
        harness.record_error("settings-reopen-document-identity-not-fresh");
    }
    if !persisted_dom {
        harness.record_error("settings-persisted-general-dom-not-observed");
    }
    if reopened_incognito != Ok(false) {
        harness.record_error("settings-reopened-child-incognito-data-store-not-proven");
    }

    let escape_witness = child_escape_witness(app, harness, &reopened.0, &reopened_id).await?;
    let second_cleanup = wait_for_closed_session(app).await?;
    let escape_layout = crate::window::main_child_layout_active_count(app).ok();
    let escape_main = main(app, harness, "afterEscapeExit", 2).await?;
    let escape_native_window = native_main_window_state(app);
    let escape_event_ok = escape_witness["escapeEventDispatched"].as_bool() == Some(true)
        && escape_witness["captureListenerObserved"].as_bool() == Some(true)
        && escape_witness["bubbles"].as_bool() == Some(true)
        && escape_witness["cancelable"].as_bool() == Some(true);
    harness.set(
        &["exit", "childEscape", "childAbsent"],
        Value::Bool(second_cleanup),
    );
    harness.set(
        &["exit", "childEscape", "layoutRegistrations"],
        option_count(escape_layout),
    );
    harness.set(
        &["exit", "childEscape", "searchQueryEmpty"],
        escape_main["searchQueryEmpty"].clone(),
    );
    harness.set(
        &["exit", "childEscape", "searchFocused"],
        escape_main["searchFocused"].clone(),
    );
    harness.set(
        &["exit", "childEscape", "nativeWindowVisible"],
        Value::Bool(escape_native_window.0),
    );
    harness.set(
        &["exit", "childEscape", "nativeWindowFocused"],
        Value::Bool(escape_native_window.1),
    );
    if !escape_event_ok {
        harness.record_error("settings-child-escape-dom-event-not-observed");
    }
    if !second_cleanup || escape_layout != Some(0) {
        harness.record_error("settings-child-escape-native-cleanup-failed");
    }
    record_probe_error(
        harness,
        &escape_main,
        "settings-main-search-state-after-escape-invalid",
    );
    Ok(())
}

fn record_child_bounds(
    harness: &Harness,
    phase: &'static str,
    bounds: Result<Value, &'static str>,
) {
    match bounds {
        Ok(bounds) => {
            if bounds["boundsVerified"].as_bool() != Some(true) {
                harness.record_error(if phase == "initial" {
                    "settings-initial-child-bounds-invalid"
                } else {
                    "settings-reopened-child-bounds-invalid"
                });
            }
            harness.set(&["bootstrap", "nativeBounds", phase], bounds);
        }
        Err(error) => {
            harness.record_error(error);
            harness.set(&["bootstrap", "nativeBounds", phase], Value::Null);
        }
    }
}
