use std::{path::PathBuf, sync::Arc};

use serde_json::json;

use super::{handles, is_local_root_url, validation, Harness};
use crate::renderer_desktop_smoke::observations::{NativeObservation, Stage};
use crate::renderer_desktop_smoke::profile::{PaintPresentation, Profile};

fn profile() -> Arc<Profile> {
    Arc::new(Profile {
        root: PathBuf::from("/private/tmp/renderer-smoke-test"),
        dist: PathBuf::from("/private/tmp/renderer-smoke-dist"),
        output: PathBuf::from("/private/tmp/renderer-smoke-report.json"),
        auto_clear: "never".into(),
        identifier: "dev.atools.renderer-smoke.0123456789abcdef0123456789abcdef".into(),
        run_id: "0123456789abcdef0123456789abcdef".into(),
        settings_journey: false,
        settings_height_case: None,
        manual_ui: false,
        settings_input_journey: false,
        builtin_state_seed: false,
        builtin_state_journey: false,
        resume_seed_pid: None,
        main_hotkey_recovery_first: false,
        main_hotkey_recovery_second: false,
        resume_hotkey_owner_pid: None,
        paint_presentation: PaintPresentation::Hidden,
        launcher_journey: false,
        launch_return_journey: false,
        launch_target_kind: crate::renderer_desktop_smoke::profile::LaunchTargetKind::App,
        registration_source: crate::renderer_desktop_smoke::profile::RegistrationSource::CoreSeed,
        catalog_journey: false,
        updater_journey: false,
        updater_about: false,
        window_drag: false,
        main_panel_journey: false,
        clipboard_context_journey: false,
    })
}

fn ready_evidence() -> serde_json::Value {
    json!({
        "ready": true,
        "schemaVersion": 1,
        "inputFound": true,
        "adapterPresent": true,
        "nativeListenersListening": true,
        "eventSourceSubscribers": [1, 1, 1, 2],
        "appStateSubscriberCounts": [1, 1],
        "contextMenuSubscriberCount": 1,
        "settingsCacheCount": 14,
        "nativeInvocationCount": 4,
        "appCatalogReadCount": 1,
        "outstandingNativeCalls": 0
    })
}

#[test]
fn command_dispatch_claims_only_the_two_test_commands() {
    assert!(handles("renderer_probe_ready"));
    assert!(handles("renderer_probe_observe"));
    assert!(!handles("hide_main_window"));
    assert!(!handles("renderer_probe_arbitrary_path"));
}

#[test]
fn local_root_allowlist_rejects_remote_routes_and_other_paths() {
    assert!(is_local_root_url(
        &tauri::Url::parse("tauri://localhost/").unwrap()
    ));
    assert!(is_local_root_url(
        &tauri::Url::parse("http://tauri.localhost/").unwrap()
    ));
    assert!(is_local_root_url(
        &tauri::Url::parse("https://tauri.localhost/").unwrap()
    ));
    assert!(!is_local_root_url(
        &tauri::Url::parse("https://example.com/").unwrap()
    ));
    assert!(!is_local_root_url(
        &tauri::Url::parse("tauri://localhost/settings").unwrap()
    ));
    assert!(!is_local_root_url(
        &tauri::Url::parse("tauri://localhost/?next=/").unwrap()
    ));
}

#[test]
fn readiness_requires_installed_probe_and_private_token() {
    let harness = Harness::new(profile());
    assert_eq!(
        harness.accept_readiness("wrong-token", ready_evidence()),
        Err("renderer-probe-token-rejected")
    );
    let token = harness.0.token.clone();
    assert!(harness.token_matches(&token));
    assert!(!harness.token_matches(&format!("{token}too-long")));
    assert_eq!(
        harness.accept_readiness(&token, ready_evidence()),
        Err("renderer-probe-not-installed")
    );
    assert!(harness.mark_probe_injected());
    assert_eq!(harness.accept_readiness(&token, ready_evidence()), Ok(()));
    assert_eq!(
        harness.accept_readiness(&token, ready_evidence()),
        Err("duplicate-renderer-readiness-message")
    );
}

#[test]
fn readiness_evidence_has_a_small_serialized_size_limit() {
    let mut evidence = ready_evidence();
    evidence["extra"] = serde_json::Value::String("x".repeat(4097));
    assert!(validation::readiness_errors(&evidence)
        .contains(&"renderer-readiness-evidence-exceeds-limit"));
}

#[test]
fn stages_are_single_pending_and_strictly_ordered() {
    let harness = Harness::new(profile());
    let _receiver = harness.begin_capture(Stage::Shown).unwrap();
    assert_eq!(
        harness.begin_capture(Stage::Hidden).err(),
        Some("renderer-stage-capture-already-pending")
    );
    harness.cancel_capture(Stage::Shown);
    assert_eq!(
        harness.begin_capture(Stage::Prepared).err(),
        Some("renderer-stage-order-rejected")
    );
}

#[test]
fn dom_observation_is_rejected_without_the_expected_pending_stage() {
    let harness = Harness::new(profile());
    assert_eq!(
        harness.accept_observation(
            Stage::Shown,
            json!({
                "schemaVersion": 1,
                "stage":"shown",
                "stageReady": true,
                "inputFound": true,
                "documentVisibility": "visible",
                "documentHasFocus": true,
                "inputFocused": false,
                "inputValue": "",
                "selectionStart": 0,
                "selectionEnd": 0,
                "adapter": null,
                "disposeError": null
            }),
            NativeObservation::default(),
        ),
        Err("unsolicited-renderer-stage-observation")
    );
    assert_eq!(harness.0.state.lock().stage_observations.len(), 0);
}

#[test]
fn readiness_schema_requires_bounded_production_listener_and_cache_evidence() {
    assert!(validation::readiness_errors(&ready_evidence()).is_empty());

    let mut missing_app_state_listener = ready_evidence();
    missing_app_state_listener["appStateSubscriberCounts"] = json!([1, 0]);
    assert!(validation::readiness_errors(&missing_app_state_listener)
        .contains(&"production-app-state-subscribers-not-ready"));

    let mut no_native_invocations = ready_evidence();
    no_native_invocations["nativeInvocationCount"] = json!(0);
    assert!(validation::readiness_errors(&no_native_invocations)
        .contains(&"production-native-ipc-not-observed-or-out-of-bounds"));
}

#[test]
fn readiness_requires_an_observed_app_catalog_read_even_when_other_ipc_completed() {
    for count in [
        json!(null),
        json!(0),
        json!(-1),
        json!(1.5),
        json!(5),
        json!(129),
    ] {
        let mut evidence = ready_evidence();
        evidence["appCatalogReadCount"] = count;
        assert!(validation::readiness_errors(&evidence)
            .contains(&"production-app-catalog-read-not-observed-or-out-of-bounds"));
    }
    let mut missing = ready_evidence();
    missing
        .as_object_mut()
        .unwrap()
        .remove("appCatalogReadCount");
    assert!(validation::readiness_errors(&missing)
        .contains(&"production-app-catalog-read-not-observed-or-out-of-bounds"));
}

#[test]
fn observation_schema_rejects_versions_and_unbounded_input_before_stage_acceptance() {
    let valid = json!({
        "schemaVersion": 1,
        "stage": "shown",
        "stageReady": true,
        "inputFound": true,
        "documentVisibility": "visible",
        "documentHasFocus": true,
        "inputFocused": true,
        "inputValue": "query",
        "selectionStart": 0,
        "selectionEnd": 5,
        "adapter": {},
        "disposeError": null
    });
    assert!(validation::observation_errors(Stage::Shown, &valid).is_empty());

    let mut wrong_version = valid.clone();
    wrong_version["schemaVersion"] = json!(2);
    assert!(validation::observation_errors(Stage::Shown, &wrong_version)
        .contains(&"renderer-observation-schema-version-mismatch"));

    let mut too_long = valid.clone();
    too_long["inputValue"] = json!("x".repeat(65));
    assert!(validation::observation_errors(Stage::Shown, &too_long)
        .contains(&"renderer-input-value-schema-invalid"));

    let mut invalid_visibility = valid;
    invalid_visibility["documentVisibility"] = json!("unknown");
    assert!(
        validation::observation_errors(Stage::Shown, &invalid_visibility)
            .contains(&"renderer-document-visibility-schema-invalid")
    );
}

#[test]
fn disposed_stage_schema_requires_bounded_pre_dispose_counters() {
    let mut disposed = json!({
        "schemaVersion": 1,
        "stage": "disposed",
        "stageReady": true,
        "inputFound": true,
        "documentVisibility": "visible",
        "documentHasFocus": true,
        "inputFocused": true,
        "inputValue": "query",
        "selectionStart": 0,
        "selectionEnd": 5,
        "adapter": {},
        "disposeError": null,
        "preDisposeCounters": {
            "nativeCalls": { "get_ztools_renderer_settings": 1 },
            "eventSourceDeliveredEvents": {
                "focusEvents": 1,
                "appState": 0,
                "contextMenu": 0,
                "appCatalog": 0
            }
        }
    });
    assert!(validation::observation_errors(Stage::Disposed, &disposed).is_empty());

    disposed["preDisposeCounters"] = json!(null);
    assert!(validation::observation_errors(Stage::Disposed, &disposed)
        .contains(&"pre-dispose-counter-baseline-schema-invalid"));
}
