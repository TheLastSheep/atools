use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

#[tokio::test]
async fn successful_open_records_once_and_returns_the_record_result() {
    let open_calls = Arc::new(AtomicUsize::new(0));
    let record_calls = Arc::new(AtomicUsize::new(0));
    let events = Arc::new(Mutex::new(Vec::new()));
    let open_counter = Arc::clone(&open_calls);
    let record_counter = Arc::clone(&record_calls);
    let open_events = Arc::clone(&events);
    let record_events = Arc::clone(&events);
    let state_events = Arc::clone(&events);
    let notification_events = Arc::clone(&events);
    let hide_events = Arc::clone(&events);

    let result: Result<&str, LaunchStageError> = coordinate_launch(
        move || async move {
            open_counter.fetch_add(1, Ordering::SeqCst);
            open_events.lock().unwrap().push("open");
            Ok(())
        },
        move || async move {
            record_counter.fetch_add(1, Ordering::SeqCst);
            record_events.lock().unwrap().push("record");
            Ok("fresh snapshot")
        },
        move |snapshot| {
            assert_eq!(*snapshot, "fresh snapshot");
            complete_launch_success(
                snapshot,
                move |_| state_events.lock().unwrap().push("state"),
                move || {
                    notification_events.lock().unwrap().push("app-launched");
                    Ok::<(), &'static str>(())
                },
                move || {
                    hide_events.lock().unwrap().push("hide");
                    Ok::<(), &'static str>(())
                },
            );
        },
    )
    .await;

    assert_eq!(result, Ok("fresh snapshot"));
    assert_eq!(open_calls.load(Ordering::SeqCst), 1);
    assert_eq!(record_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        *events.lock().unwrap(),
        ["open", "record", "state", "app-launched", "hide"]
    );
}

#[tokio::test]
async fn notification_or_hide_failure_does_not_turn_a_committed_launch_into_an_error() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let state_events = Arc::clone(&events);
    let notification_events = Arc::clone(&events);
    let hide_events = Arc::clone(&events);

    let result: Result<&str, LaunchStageError> = coordinate_launch(
        || async { Ok(()) },
        || async { Ok("committed snapshot") },
        move |snapshot| {
            complete_launch_success(
                snapshot,
                move |_| state_events.lock().unwrap().push("state"),
                move || {
                    notification_events.lock().unwrap().push("app-launched");
                    Err("notification unavailable")
                },
                move || {
                    hide_events.lock().unwrap().push("hide");
                    Err("hide unavailable")
                },
            );
        },
    )
    .await;

    assert_eq!(result, Ok("committed snapshot"));
    assert_eq!(*events.lock().unwrap(), ["state", "app-launched", "hide"]);
}

#[tokio::test]
async fn failed_open_never_records_history() {
    let record_calls = Arc::new(AtomicUsize::new(0));
    let success_calls = Arc::new(AtomicUsize::new(0));
    let record_counter = Arc::clone(&record_calls);
    let success_counter = Arc::clone(&success_calls);

    let result = coordinate_launch(
        || async { Err(OpenFailure::Failed) },
        move || async move {
            record_counter.fetch_add(1, Ordering::SeqCst);
            Ok("unexpected snapshot")
        },
        move |_| {
            success_counter.fetch_add(1, Ordering::SeqCst);
        },
    )
    .await;

    assert_eq!(result, Err(LaunchStageError::Open));
    assert_eq!(LaunchStageError::Open.message(), OPEN_FAILED);
    assert_eq!(record_calls.load(Ordering::SeqCst), 0);
    assert_eq!(success_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn permission_denial_is_typed_and_never_records_history() {
    let open_calls = Arc::new(AtomicUsize::new(0));
    let record_calls = Arc::new(AtomicUsize::new(0));
    let success_calls = Arc::new(AtomicUsize::new(0));
    let open_counter = Arc::clone(&open_calls);
    let record_counter = Arc::clone(&record_calls);
    let success_counter = Arc::clone(&success_calls);

    let result = coordinate_launch(
        move || async move {
            open_counter.fetch_add(1, Ordering::SeqCst);
            classify_open_result(true, Some("cancelled"), Some("Permission denied"))
        },
        move || async move {
            record_counter.fetch_add(1, Ordering::SeqCst);
            Ok("unexpected snapshot")
        },
        move |_| {
            success_counter.fetch_add(1, Ordering::SeqCst);
        },
    )
    .await;

    assert_eq!(result, Err(LaunchStageError::Permission));
    assert_eq!(open_calls.load(Ordering::SeqCst), 1);
    assert_eq!(record_calls.load(Ordering::SeqCst), 0);
    assert_eq!(success_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        LaunchStageError::Permission.message(),
        "应用启动被权限策略拒绝，最近使用未记录"
    );
}

#[test]
fn only_the_fixed_denied_task_run_shape_is_classified_as_permission_denial() {
    assert_eq!(
        classify_open_result(true, Some("cancelled"), Some("Permission denied")),
        Err(OpenFailure::PermissionDenied)
    );
    assert_eq!(
        classify_open_result(false, Some("cancelled"), Some("Permission denied")),
        Ok(())
    );
    assert_eq!(
        classify_open_result(true, None, Some("Permission denied")),
        Err(OpenFailure::Failed)
    );
    assert_eq!(
        classify_open_result(
            true,
            Some("cancelled"),
            Some("Permission denied: /private/example")
        ),
        Err(OpenFailure::Failed)
    );
}

#[tokio::test]
async fn record_failure_is_partial_success_and_is_not_retried() {
    let open_calls = Arc::new(AtomicUsize::new(0));
    let record_calls = Arc::new(AtomicUsize::new(0));
    let success_calls = Arc::new(AtomicUsize::new(0));
    let open_counter = Arc::clone(&open_calls);
    let record_counter = Arc::clone(&record_calls);
    let success_counter = Arc::clone(&success_calls);

    let result: Result<(), LaunchStageError> = coordinate_launch(
        move || async move {
            open_counter.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        move || async move {
            record_counter.fetch_add(1, Ordering::SeqCst);
            Err(())
        },
        move |_| {
            success_counter.fetch_add(1, Ordering::SeqCst);
        },
    )
    .await;

    assert_eq!(result, Err(LaunchStageError::Record));
    assert_eq!(open_calls.load(Ordering::SeqCst), 1);
    assert_eq!(record_calls.load(Ordering::SeqCst), 1);
    assert_eq!(success_calls.load(Ordering::SeqCst), 0);
    assert_eq!(LaunchStageError::Record.message(), RECORD_FAILED);
    assert_eq!(RECORD_FAILED, "应用已启动，但最近使用未保存");
}

#[test]
fn only_the_main_webview_can_mutate_renderer_app_state() {
    assert!(ensure_main_webview("main").is_ok());
    assert!(ensure_main_webview("plugin-panel").is_err());
}

#[test]
fn change_event_targets_the_main_webview_listener() {
    assert_eq!(
        renderer_app_state_event_target(),
        tauri::EventTarget::Webview {
            label: "main".into()
        }
    );
}

#[test]
fn launch_success_event_is_a_null_payload_for_only_the_main_webview() {
    assert_eq!(APP_LAUNCHED_EVENT_NAME, "atools://renderer-app-launched");
    assert_eq!(
        app_launched_event_target(),
        tauri::EventTarget::Webview {
            label: "main".into()
        }
    );
    assert_eq!(serde_json::to_value(()).unwrap(), serde_json::Value::Null);
}

#[test]
fn payload_is_typed_and_rejects_extra_fields_and_frontend_launch_writes() {
    let valid = serde_json::json!({
        "operation": "pin",
        "app": {"path": "/Applications/Editor.app", "name": "Editor alias"}
    });
    assert!(serde_json::from_value::<RendererAppMutationRequest>(valid).is_ok());
    for valid in [
        serde_json::json!({"operation": "clear_pins"}),
        serde_json::json!({"operation": "clear_history"}),
        serde_json::json!({"operation": "remove_history", "path": "/Applications/Old.app"}),
        serde_json::json!({"operation": "unpin", "path": "/Applications/Old.app", "name": null}),
    ] {
        assert!(serde_json::from_value::<RendererAppMutationRequest>(valid).is_ok());
    }

    for invalid in [
        serde_json::json!({"operation": "record_launch", "app": {}}),
        serde_json::json!({"operation": "clear_history", "extra": true}),
        serde_json::json!({"operation": "clear_pins", "extra": true}),
        serde_json::json!({
            "operation": "pin",
            "app": {"path": "/Applications/Editor.app", "name": "Editor", "extra": true}
        }),
        serde_json::json!({"operation": "unknown"}),
    ] {
        assert!(serde_json::from_value::<RendererAppMutationRequest>(invalid).is_err());
    }
}

#[test]
fn app_identity_alias_is_bounded_and_catalog_membership_is_exact() {
    let app = RendererAppIdentity {
        path: "/Applications/Editor.app".into(),
        name: "Favorite alias".into(),
        sub_type: RendererDirectSubtype::App,
    };
    assert!(validate_identity(&app).is_ok());
    assert!(catalog_contains_path(
        [
            "/Applications/Editor.app",
            "/System/Applications/Calculator.app"
        ],
        &app.path
    ));
    assert!(!catalog_contains_path(
        ["/Applications/Editor.app"],
        "/Applications/Editor Pro.app"
    ));

    let alias_at_limit = RendererAppIdentity {
        path: app.path.clone(),
        name: "x".repeat(MAX_NAME_BYTES),
        sub_type: RendererDirectSubtype::App,
    };
    assert!(validate_identity(&alias_at_limit).is_ok());
    let oversized_alias = RendererAppIdentity {
        path: app.path,
        name: "x".repeat(MAX_NAME_BYTES + 1),
        sub_type: RendererDirectSubtype::App,
    };
    assert!(validate_identity(&oversized_alias).is_err());

    let path_at_limit = "/".repeat(MAX_PATH_BYTES);
    assert!(validate_filter(&path_at_limit, None).is_ok());
    assert!(validate_filter(&format!("{path_at_limit}/"), None).is_err());
}

#[test]
fn direct_identity_defaults_to_app_and_serializes_local_shortcuts_explicitly() {
    let legacy: RendererAppIdentity = serde_json::from_value(serde_json::json!({
        "path":"/Applications/Editor.app",
        "name":"Editor"
    }))
    .unwrap();
    assert_eq!(legacy.sub_type, RendererDirectSubtype::App);
    let local = RendererAppIdentity {
        path: "/tmp/fixture.txt".into(),
        name: "Fixture".into(),
        sub_type: RendererDirectSubtype::LocalShortcut,
    };
    assert_eq!(
        serde_json::to_value(local).unwrap()["subType"],
        "local-shortcut"
    );
}

#[test]
fn local_shortcut_launch_and_reveal_require_current_path_and_display_name() {
    let record = RendererLocalShortcut {
        id: "shortcut-1".into(),
        name: "fixture.txt".into(),
        path: "/tmp/fixture.txt".into(),
        kind: atools_core::db::RendererLocalShortcutType::File,
        added_at: 1,
        alias: Some("Fixture".into()),
        icon: None,
        keywords: None,
        pinyin: None,
        pinyin_abbr: None,
    };
    let valid = RendererAppIdentity {
        path: "/tmp/fixture.txt".into(),
        name: "Fixture".into(),
        sub_type: RendererDirectSubtype::LocalShortcut,
    };
    assert!(local_shortcut_matches_identity(&record, &valid));
    assert!(!local_shortcut_matches_identity(
        &record,
        &RendererAppIdentity {
            name: "fixture.txt".into(),
            ..valid.clone()
        }
    ));
    assert!(!local_shortcut_matches_identity(
        &record,
        &RendererAppIdentity {
            path: "/tmp/replaced.txt".into(),
            ..valid
        }
    ));
}

#[tokio::test]
async fn main_target_authority_uses_the_current_core_shortcut_registry() {
    let database = Arc::new(atools_core::db::Database::in_memory().unwrap());
    database
        .apply_renderer_local_shortcut_guarded(
            atools_core::db::RendererLocalShortcutMutation::Add {
                record: RendererLocalShortcut {
                    id: "registered".into(),
                    name: "fixture.txt".into(),
                    path: "/tmp/fixture.txt".into(),
                    kind: atools_core::db::RendererLocalShortcutType::File,
                    added_at: 1,
                    alias: Some("Display".into()),
                    icon: None,
                    keywords: None,
                    pinyin: None,
                    pinyin_abbr: None,
                },
            },
            || true,
        )
        .unwrap();
    let registered = RendererAppIdentity {
        path: "/tmp/fixture.txt".into(),
        name: "Display".into(),
        sub_type: RendererDirectSubtype::LocalShortcut,
    };
    assert!(
        local_shortcut_contains_identity(Arc::clone(&database), &registered)
            .await
            .unwrap()
    );
    assert!(!local_shortcut_contains_identity(
        Arc::clone(&database),
        &RendererAppIdentity {
            name: "fixture.txt".into(),
            ..registered.clone()
        }
    )
    .await
    .unwrap());
    assert!(!local_shortcut_contains_identity(
        database,
        &RendererAppIdentity {
            path: "/tmp/stale.txt".into(),
            ..registered
        }
    )
    .await
    .unwrap());
}

#[test]
fn reveal_requires_the_actual_main_webview_and_parent_window_labels() {
    assert!(main_context_labels_match("main", "main", "main"));
    assert!(!main_context_labels_match("plugin", "main", "main"));
    assert!(!main_context_labels_match("main", "plugin-window", "main"));
    assert!(!main_context_labels_match("main", "main", "plugin-window"));
}

#[test]
fn orphan_filters_remain_deletable_without_catalog_lookup() {
    assert!(validate_filter("/Applications/Removed.app", Some("Old alias")).is_ok());
    assert!(validate_filter("/Applications/Removed.app", None).is_ok());
    assert!(validate_filter("/Applications/Removed.app", Some("")).is_err());
}

#[test]
fn local_open_identity_requires_a_current_platform_absolute_path() {
    let identity = RendererAppIdentity {
        path: std::env::temp_dir()
            .join("atools-direct-identity.txt")
            .to_string_lossy()
            .into_owned(),
        name: "fixture.txt".into(),
        sub_type: RendererDirectSubtype::LocalShortcut,
    };
    assert!(validate_identity(&identity).is_ok());
    for path in [
        "relative.txt",
        "https://example.test/file",
        "file:///tmp/fixture.txt",
    ] {
        assert!(validate_identity(&RendererAppIdentity {
            path: path.into(),
            ..identity.clone()
        })
        .is_err());
    }
}
