use super::*;
use crate::renderer_settings_view::{bundle::SettingsBundle, preferences::SettingsPreferences};
use serde_json::json;
use std::sync::Arc;

fn begin(runtime: &SettingsViewRuntime, id: &str, bundle: &str) -> SessionView {
    runtime
        .begin_session(
            id.into(),
            Arc::new(SettingsBundle::height_test_bundle(bundle)),
            Arc::new(SettingsPreferences::height_test_preferences(None)),
            json!({}),
            json!("darwin"),
        )
        .unwrap()
}
fn ready(runtime: &SettingsViewRuntime, session: &SessionView) {
    runtime.mark_opened_with(&session.id, |_| Ok(())).unwrap();
    runtime
        .note_index_request(&session.label, &session.origin)
        .unwrap();
    runtime.record_page_started(&session.id).unwrap();
    runtime
        .record_ready(&session.id, &session.bundle_revision)
        .unwrap();
    runtime.mark_open_with(&session.id, |_| Ok(())).unwrap();
}
fn close(runtime: &SettingsViewRuntime, session: &SessionView) {
    runtime.mark_closing(&session.id, "child-out").unwrap();
    assert!(runtime.take_if(&session.id).is_some());
}

#[test]
fn production_open_ready_close_preserves_requested_height_and_rejects_late_generation() {
    let runtime = SettingsViewRuntime::default();
    let first = begin(&runtime, "first", "bundle");
    assert_eq!(runtime.stage_height(&first, 2001.0).unwrap(), 2001.0);
    assert!(runtime.mark_open_with(&first.id, |_| Ok(())).is_err());
    close(&runtime, &first); // No Ready: do not cache.
    let second = begin(&runtime, "second", "bundle");
    assert_eq!(runtime.stage_height(&second, 200.5).unwrap(), 200.5);
    assert!(runtime.stage_height(&first, 542.0).is_err());
    ready(&runtime, &second);
    close(&runtime, &second);
    assert!(runtime.mark_open_with(&second.id, |_| Ok(())).is_err());
    let third = begin(&runtime, "third", "bundle");
    assert_eq!(runtime.stage_height(&third, 541.0).unwrap(), 200.5);
    runtime.mark_closing(&third.id, "child-out").unwrap();
    assert!(runtime.stage_height(&third, 2001.0).is_err());
    runtime.take_if(&third.id).unwrap();
    let changed = begin(&runtime, "changed", "new-bundle");
    assert_eq!(runtime.stage_height(&changed, 2001.0).unwrap(), 2001.0);
    let fresh = SettingsViewRuntime::default();
    let session = begin(&fresh, "fresh", "bundle");
    assert_eq!(fresh.stage_height(&session, 541.0).unwrap(), 541.0);
}

#[test]
fn loaded_delivery_failure_does_not_confirm_a_candidate() {
    let runtime = SettingsViewRuntime::default();
    let session = begin(&runtime, "first", "bundle");
    runtime.stage_height(&session, 2001.0).unwrap();
    runtime.mark_opened_with(&session.id, |_| Ok(())).unwrap();
    runtime
        .note_index_request(&session.label, &session.origin)
        .unwrap();
    runtime.record_page_started(&session.id).unwrap();
    runtime
        .record_ready(&session.id, &session.bundle_revision)
        .unwrap();
    assert!(runtime
        .mark_open_with(&session.id, |_| Err("delivery failed".into()))
        .is_err());
    close(&runtime, &session);
    let next = begin(&runtime, "second", "bundle");
    assert_eq!(runtime.stage_height(&next, 541.0).unwrap(), 541.0);
}

#[test]
fn dpi_change_rejects_before_native_creation_without_registering_or_confirming_cache() {
    let runtime = SettingsViewRuntime::default();
    let session = begin(&runtime, "before-dpi-change", "bundle");
    let desired = runtime.stage_height(&session, 1_100_000_000.0).unwrap();
    // Parent admission at A=1 was legal, but creation samples B=2.
    assert!(crate::window::create_settings_child(
        tauri::PhysicalSize::new(1000, 800),
        1.0,
        58,
        desired,
        |_, _| Ok(())
    )
    .is_ok());
    let mut creates = 0;
    let mut registrations = 0;
    let result = crate::window::create_settings_child(
        tauri::PhysicalSize::new(1000, 800),
        2.0,
        58,
        desired,
        |_, _| {
            creates += 1;
            registrations += 1;
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!((creates, registrations), (0, 0));
    close(&runtime, &session);
    let next = begin(&runtime, "after-failed-creation", "bundle");
    assert_eq!(runtime.stage_height(&next, 541.0).unwrap(), 541.0);
}
