use super::{
    audit_metadata_only, contains_private_payload_bytes, database_facts, task_payload_absent,
    task_summary_only,
};
use crate::renderer_desktop_smoke::profile::{PaintPresentation, Profile};
use atools_core::{
    agent::{AuditLogEntry, AuditStatus},
    task_run::{TaskRun, TaskRunInitiator, TaskRunStatus, TaskValidationStatus},
    Database, PasteboardItem, PasteboardItemKind,
};
use serde_json::json;
use std::path::PathBuf;

fn profile() -> Profile {
    Profile {
        root: PathBuf::from(
            "/private/tmp/atools-renderer-clipboard-0123456789abcdef0123456789abcdef",
        ),
        dist: PathBuf::from("/private/tmp/renderer-dist"),
        output: PathBuf::from("/private/tmp/renderer-output"),
        auto_clear: "never".to_owned(),
        identifier: "dev.atools.renderer-clipboard.0123456789abcdef0123456789abcdef".to_owned(),
        run_id: "0123456789abcdef0123456789abcdef".to_owned(),
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
        clipboard_context_journey: true,
    }
}

fn metadata_run() -> TaskRun {
    let mut run = TaskRun::new(
        "atools.clipboard.read_current",
        TaskRunInitiator::human(None),
        json!({"timeLimit": null}),
    );
    run.status = TaskRunStatus::Succeeded;
    run.output = json!({
        "available": true,
        "contentRedacted": true,
        "summary": {
            "type": "text",
            "payloadBytes": 12,
            "fileCount": 0,
            "timestamp": 1
        }
    });
    run
}

#[test]
fn summary_only_metadata_is_accepted_but_extra_or_raw_fields_are_rejected() {
    let mut run = metadata_run();
    assert!(task_summary_only(&run));

    run.output["raw"] = json!("unrecognized content field");
    assert!(!task_summary_only(&run));

    let mut run = metadata_run();
    run.output["summary"]["raw"] = json!("unrecognized summary field");
    assert!(!task_summary_only(&run));
}

#[test]
fn full_task_run_scan_rejects_fixture_text_in_summary_and_validation() {
    let profile = profile();
    let mut run = metadata_run();
    run.summary = Some("prefix ATools R62 private clipboard text suffix".to_owned());
    assert!(!task_payload_absent(&run, &profile));

    let mut run = metadata_run();
    run.validation.status = TaskValidationStatus::Passed;
    run.validation.summary = Some("ATools R62 private clipboard text".to_owned());
    assert!(!task_payload_absent(&run, &profile));
}

#[test]
fn full_task_run_scan_rejects_private_markers_in_json_keys() {
    let profile = profile();
    for key in [
        "ATools R62 private clipboard text",
        "atools-r62-private-clipboard.txt",
    ] {
        let mut run = metadata_run();
        let mut metrics = serde_json::Map::new();
        metrics.insert(key.to_owned(), json!("metadata"));
        run.metrics = serde_json::Value::Object(metrics);
        assert!(!task_payload_absent(&run, &profile));
    }
}

#[test]
fn nested_json_encoded_task_strings_are_decoded_before_scanning() {
    let profile = profile();
    let encoded = serde_json::to_string(&json!({
        "outer": serde_json::to_string(&json!({
            "inner": "ATools R62 private clipboard text"
        }))
        .unwrap()
    }))
    .unwrap();
    let mut run = metadata_run();
    run.validation.summary = Some(encoded);
    assert!(!task_payload_absent(&run, &profile));

    let fixture = crate::pasteboard_native::clipboard_fixture::FIXTURE_TEXT;
    let escaped = serde_json::to_string(fixture).unwrap();
    let escaped = &escaped[1..escaped.len() - 1];
    let mut run = metadata_run();
    run.summary = Some(format!("encoded-field={escaped}"));
    assert!(!task_payload_absent(&run, &profile));
}

#[test]
fn task_scan_rejects_private_fixture_name_root_and_path() {
    let profile = profile();
    let fixture_dir = profile.root.join("clipboard-fixture");
    let private_values = [
        "atools-r62-private-clipboard.txt".to_owned(),
        profile.root.to_string_lossy().into_owned(),
        fixture_dir.to_string_lossy().into_owned(),
        fixture_dir
            .join("atools-r62-private-clipboard.txt")
            .to_string_lossy()
            .into_owned(),
    ];
    for value in private_values {
        let mut run = metadata_run();
        run.summary = Some(value);
        assert!(!task_payload_absent(&run, &profile));
    }
}

#[test]
fn audit_scans_the_complete_entry_and_accepts_metadata_only_entries() {
    let profile = profile();
    let clean = AuditLogEntry::new(
        "main",
        "atools.clipboard.read_current",
        json!({"timeLimit": null}),
        AuditStatus::Allowed,
    )
    .with_output(json!({"available": true, "contentRedacted": true}));
    assert!(audit_metadata_only(&clean, &profile));

    for time_limit in [json!(1), json!(1.0)] {
        let entry = AuditLogEntry::new(
            "main",
            "atools.clipboard.read_current",
            json!({"timeLimit": time_limit}),
            AuditStatus::Allowed,
        )
        .with_output(json!({"available": true, "contentRedacted": true}));
        assert!(audit_metadata_only(&entry, &profile));
    }

    let extra_input = AuditLogEntry::new(
        "main",
        "atools.clipboard.read_current",
        json!({"timeLimit": null, "raw": "unrecognized"}),
        AuditStatus::Allowed,
    );
    assert!(!audit_metadata_only(&extra_input, &profile));

    let leaked = AuditLogEntry::new(
        "main",
        "atools.clipboard.read_current",
        json!({"timeLimit": null}),
        AuditStatus::Allowed,
    )
    .with_output(json!({
        "nested": serde_json::to_string(&json!({
            "output": "ATools R62 private clipboard text"
        }))
        .unwrap()
    }));
    assert!(!audit_metadata_only(&leaked, &profile));
}

#[test]
fn byte_scanner_catches_trimmed_fixture_core_and_png_prefix() {
    let profile = profile();
    assert!(contains_private_payload_bytes(
        b"payload: ATools R62 private clipboard text",
        &profile
    ));
    assert!(contains_private_payload_bytes(
        br#"{"body":"data:image/png;base64,AAAA"}"#,
        &profile
    ));
}

#[test]
fn database_facts_reads_native_pasteboard_table_with_a_bounded_search() {
    let db = Database::in_memory().unwrap();
    let profile = profile();
    assert!(database_facts(&db, &profile).unwrap().native_items_empty);

    db.upsert_pasteboard_item(&PasteboardItem {
        id: "native-item-1".to_owned(),
        kind: PasteboardItemKind::Text,
        title: Some("persisted metadata".to_owned()),
        source_app: None,
        source_device_id: "fixture-device".to_owned(),
        copied_at: "2026-10-29T00:00:00Z".to_owned(),
        updated_at: "2026-10-29T00:00:00Z".to_owned(),
        content_fingerprint: "fixture-fingerprint".to_owned(),
        payload: json!({"text": "stored item"}),
        ocr_text: None,
        pinboard_id: None,
        pinboard_order_key: None,
        pinned: false,
        field_clocks: json!({}),
    })
    .unwrap();
    assert!(!database_facts(&db, &profile).unwrap().native_items_empty);
}
