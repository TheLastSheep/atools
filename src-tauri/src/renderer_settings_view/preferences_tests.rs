use std::{
    collections::BTreeMap,
    sync::{Arc, Barrier},
    thread,
};

use atools_core::{
    db::{DEFAULT_SHOW_TRAY_ICON, RENDERER_GENERAL_SETTINGS_FIELDS},
    Database,
};
use serde_json::{json, Value};

use crate::hotkey::OwnedMainHotkeyStateSnapshot;

use super::projection::{displayed_hotkey, project_general_settings, validate_projected_size};
use super::{map_patch_error, new_revision, revision_matches, validate_patch};

#[test]
fn empty_projection_matches_original_general_form_defaults() {
    let value = project_general_settings(None, "Option+Z").unwrap();
    let form = value.as_object().unwrap();

    assert_eq!(form.len(), 44);
    assert_eq!(form["opacity"], 1.0);
    assert_eq!(form["windowDefaultHeight"], 541);
    assert_eq!(form["hotkey"], "Option+Z");
    assert_eq!(form["placeholder"], "搜索应用和指令 / 粘贴文件或图片");
    assert_eq!(form["avatar"], Value::Null);
    assert_eq!(form["autoPaste"], "3s");
    assert_eq!(form["autoClear"], "immediately");
    assert_eq!(form["autoBackToSearch"], "never");
    assert_eq!(form["windowPositionStrategy"], "remember");
    assert_eq!(form["theme"], "system");
    assert_eq!(form["primaryColor"], "green");
    assert_eq!(form["customColor"], "#db2777");
    assert_eq!(form["windowMaterial"], "none");
    assert_eq!(form["showTrayIcon"], DEFAULT_SHOW_TRAY_ICON);
    assert_eq!(form["clipboardRetentionDays"], 180);
    assert_eq!(form["terminalCustomCommand"], "");
    assert_eq!(form["proxyUrl"], "");
}

#[test]
fn projection_uses_true_tray_default_and_preserves_explicit_false() {
    let default = project_general_settings(None, "Option+Z").unwrap();
    assert_eq!(default["showTrayIcon"], true);

    let stored = project_general_settings(Some(r#"{"showTrayIcon":false}"#), "Option+Z").unwrap();
    assert_eq!(stored["showTrayIcon"], false);
    assert!(project_general_settings(Some(r#"{"showTrayIcon":"false"}"#), "Option+Z").is_err());
}

#[test]
fn projection_uses_the_owned_hotkey_state_instead_of_the_stored_value() {
    let stored = project_general_settings(
        Some(r#"{"hotkey":"Command+Shift+F11"}"#),
        "Command+Shift+F12",
    )
    .unwrap();
    assert_eq!(stored["hotkey"], "Command+Shift+F12");

    let missing = project_general_settings(None, "Option+Z").unwrap();
    assert_eq!(missing["hotkey"], "Option+Z");
    let unregistered =
        project_general_settings(Some(r#"{"hotkey":"Command+Shift+F11"}"#), "").unwrap();
    assert_eq!(unregistered["hotkey"], "");
}

#[test]
fn hotkey_display_distinguishes_registered_from_confirmed_unregistered_state() {
    let registered = OwnedMainHotkeyStateSnapshot::for_test_registered("Command+Shift+F11");
    assert_eq!(
        displayed_hotkey(&registered, "Option+Z").unwrap(),
        "Command+Shift+F11"
    );

    let attempted_unregistered =
        OwnedMainHotkeyStateSnapshot::for_test_unregistered_with_startup(true);
    assert_eq!(
        displayed_hotkey(&attempted_unregistered, "Option+Z").unwrap(),
        ""
    );

    let legacy_unregistered =
        OwnedMainHotkeyStateSnapshot::for_test_unregistered_with_startup(false);
    #[cfg(feature = "legacy-node-smoke")]
    assert_eq!(
        displayed_hotkey(&legacy_unregistered, "Option+Z").unwrap(),
        "Option+Z"
    );
    #[cfg(not(feature = "legacy-node-smoke"))]
    assert!(displayed_hotkey(&legacy_unregistered, "Option+Z").is_err());
}

#[test]
fn projection_keeps_an_invalid_persisted_hotkey_private_when_no_shortcut_is_registered() {
    for raw in [
        r#"{"hotkey":null}"#,
        r#"{"hotkey":false}"#,
        r#"{"hotkey":""}"#,
        r#"{"hotkey":" Command+K"}"#,
        r#"{"hotkey":"Command+K "}"#,
        r#"{"hotkey":"line\nfeed"}"#,
    ] {
        let projected = project_general_settings(Some(raw), "").unwrap();
        assert_eq!(projected["hotkey"], "");
    }
    let oversized = json!({"hotkey": "é".repeat(129)}).to_string();
    let projected = project_general_settings(Some(&oversized), "").unwrap();
    assert_eq!(projected["hotkey"], "");
}

#[test]
fn projection_redacts_sensitive_and_unknown_values() {
    let raw = json!({
        "aiApiKey": "secret-ai-sentinel",
        "webdavUsername": "secret-user-sentinel",
        "webdavPassword": "secret-webdav-sentinel",
        "proxyUrl": "https://secret-proxy-sentinel@example.test",
        "terminalCustomCommand": "shell-secret-sentinel",
        "unknownRendererField": "unknown-secret-sentinel",
        "theme": "dark",
        "clipboardRetentionDays": 90
    })
    .to_string();
    let projected = project_general_settings(Some(&raw), "Option+Z").unwrap();
    let serialized = serde_json::to_string(&projected).unwrap();

    for sentinel in [
        "secret-ai-sentinel",
        "secret-user-sentinel",
        "secret-webdav-sentinel",
        "secret-proxy-sentinel",
        "shell-secret-sentinel",
        "unknown-secret-sentinel",
    ] {
        assert!(!serialized.contains(sentinel));
    }
    assert!(projected.get("aiApiKey").is_none());
    assert!(projected.get("webdavUsername").is_none());
    assert!(projected.get("webdavPassword").is_none());
    assert!(projected.get("unknownRendererField").is_none());
    assert_eq!(projected["proxyUrl"], "");
    assert_eq!(projected["terminalCustomCommand"], "");
    assert_eq!(projected["theme"], "dark");
    assert_eq!(projected["clipboardRetentionDays"], 90);
}

#[test]
fn projection_rejects_invalid_known_field_shapes() {
    for raw in [
        r#"{"theme":true}"#,
        r#"{"autoClear":"2h"}"#,
        r#"{"opacity":2}"#,
        r#"{"superPanelBlockedApps":[{"app":"safe","unknown":"not-safe"}]}"#,
    ] {
        assert!(project_general_settings(Some(raw), "Option+Z").is_err());
    }
}

#[test]
fn projection_normalizes_legacy_integral_float_row_counts_to_integers() {
    let raw = json!({"recentRows": 2.0, "pinnedRows": -0.0}).to_string();
    let projected = project_general_settings(Some(&raw), "Option+Z").unwrap();

    assert_eq!(projected["recentRows"].as_u64(), Some(2));
    assert_eq!(projected["pinnedRows"].as_u64(), Some(0));

    for invalid in [
        r#"{"recentRows":2.5}"#,
        r#"{"pinnedRows":-1}"#,
        r#"{"recentRows":21}"#,
        r#"{"recentRows":"2"}"#,
        r#"{"pinnedRows":true}"#,
    ] {
        assert!(project_general_settings(Some(invalid), "Option+Z").is_err());
    }
}

#[test]
fn projection_matches_general_load_time_fallbacks() {
    let raw = json!({ "tabTargetCommand": "open-target", "floatingBallLetter": "" }).to_string();
    let projected = project_general_settings(Some(&raw), "Option+Z").unwrap();
    assert_eq!(projected["tabKeyFunction"], "target-command");
    assert_eq!(projected["floatingBallLetter"], "Z");
}

#[test]
fn projection_accepts_originally_storable_readonly_values_and_redacts_commands() {
    let long_command = format!("terminal-secret-{}", "x".repeat(5 * 1024));
    let raw = json!({
        "tabTargetCommand": "t".repeat(2049),
        "windowDefaultHeight": 2001,
        "terminalCustomCommand": long_command,
        "theme": "dark"
    })
    .to_string();

    let projected = project_general_settings(Some(&raw), "Option+Z").unwrap();
    let serialized = serde_json::to_string(&projected).unwrap();
    assert_eq!(projected["tabTargetCommand"].as_str().unwrap().len(), 2049);
    assert_eq!(projected["windowDefaultHeight"], 2001);
    assert_eq!(projected["terminalCustomCommand"], "");
    assert_eq!(projected["theme"], "dark");
    assert!(!serialized.contains("terminal-secret"));
}

#[test]
fn projection_reads_513_byte_placeholder_while_write_budget_stays_512() {
    let placeholder = "p".repeat(513);
    let raw = json!({"placeholder": placeholder}).to_string();
    let projected = project_general_settings(Some(&raw), "Option+Z").unwrap();
    assert_eq!(projected["placeholder"].as_str().unwrap().len(), 513);

    let patch = BTreeMap::from([("placeholder".into(), json!("p".repeat(513)))]);
    assert!(validate_patch(&patch).is_err());
}

#[test]
fn projection_preserves_bounded_custom_avatar_values() {
    let avatar = format!("data:image/png;base64,{}", "a".repeat(61 * 1024));
    let raw = json!({"avatar": avatar}).to_string();
    assert!(raw.len() < 64 * 1024);

    let projected = project_general_settings(Some(&raw), "Option+Z").unwrap();
    assert_eq!(projected["avatar"].as_str().unwrap().len(), 61 * 1024 + 22);
}

#[test]
fn projection_accepts_more_than_128_apps_within_the_raw_record_budget() {
    let apps = (0..129)
        .map(|index| json!({"app": format!("app-{index}")}))
        .collect::<Vec<_>>();
    let raw = json!({"wakeupBlacklist": apps}).to_string();
    assert!(raw.len() < 64 * 1024);

    let projected = project_general_settings(Some(&raw), "Option+Z").unwrap();
    assert_eq!(projected["wakeupBlacklist"].as_array().unwrap().len(), 129);
}

#[test]
fn final_projection_budget_rejects_values_over_80_kib() {
    let oversized = json!({"value": "x".repeat(80 * 1024 + 1)});
    assert!(validate_projected_size(&oversized).is_err());
}

#[test]
fn projection_enforces_raw_record_budget_and_sensitive_types() {
    let oversized_raw = json!({"placeholder": "x".repeat(64 * 1024)}).to_string();
    assert!(project_general_settings(Some(&oversized_raw), "Option+Z").is_err());

    for raw in [r#"{"proxyUrl":false}"#, r#"{"terminalCustomCommand":{}}"#] {
        assert!(project_general_settings(Some(raw), "Option+Z").is_err());
    }
}

#[test]
fn renderer_patch_accepts_shared_typed_fields_and_rejects_invalid_or_readonly_fields() {
    let accepted = BTreeMap::from([
        ("placeholder".into(), json!("Search")),
        ("theme".into(), json!("dark")),
        ("primaryColor".into(), json!("green")),
        ("customColor".into(), json!("#a1B2c3")),
        ("autoClear".into(), json!("10m")),
        ("showRecentInSearch".into(), json!(true)),
        ("recentRows".into(), json!(2.0)),
        ("pinnedRows".into(), json!(-0.0)),
        ("searchMode".into(), json!("list")),
        ("showMatchRecommendation".into(), json!(false)),
        ("tabKeyFunction".into(), json!("target-command")),
        ("tabTargetCommand".into(), json!("")),
        ("spaceOpenCommand".into(), json!(false)),
        ("localAppSearch".into(), json!(true)),
        ("opacity".into(), json!(0.65)),
        ("showTrayIcon".into(), json!(true)),
        ("hotkey".into(), json!("Command+Shift+F10")),
        ("windowPositionStrategy".into(), json!("lastActive")),
        ("clipboardRetentionDays".into(), json!(180.0)),
        ("autoBackToSearch".into(), json!("never")),
        ("autoPaste".into(), json!("3s")),
    ]);
    assert!(validate_patch(&accepted).is_ok());

    for rejected in [
        BTreeMap::from([("autoPaste".into(), json!("11s"))]),
        BTreeMap::from([("theme".into(), json!("blue"))]),
        BTreeMap::from([("customColor".into(), json!("red"))]),
        BTreeMap::from([("placeholder".into(), json!("\n"))]),
        BTreeMap::from([("showRecentInSearch".into(), json!(1))]),
        BTreeMap::from([("recentRows".into(), json!(2.5))]),
        BTreeMap::from([("recentRows".into(), json!(-1))]),
        BTreeMap::from([("recentRows".into(), json!(21))]),
        BTreeMap::from([("recentRows".into(), json!("2"))]),
        BTreeMap::from([("recentRows".into(), json!(true))]),
        BTreeMap::from([("pinnedRows".into(), json!(21))]),
        BTreeMap::from([("searchMode".into(), json!("grid"))]),
        BTreeMap::from([("tabKeyFunction".into(), json!("space"))]),
        BTreeMap::from([("tabTargetCommand".into(), json!("open\ncommand"))]),
        BTreeMap::from([("spaceOpenCommand".into(), json!(0))]),
        BTreeMap::from([("opacity".into(), json!(0.29))]),
        BTreeMap::from([("opacity".into(), json!(1.01))]),
        BTreeMap::from([("opacity".into(), json!("0.65"))]),
        BTreeMap::from([("opacity".into(), Value::Null)]),
        BTreeMap::from([("opacity".into(), json!(true))]),
        BTreeMap::from([("hotkey".into(), Value::Null)]),
        BTreeMap::from([("hotkey".into(), json!(" Command+K"))]),
        BTreeMap::from([("hotkey".into(), json!("x".repeat(257)))]),
        BTreeMap::from([("windowPositionStrategy".into(), json!("lastUsed"))]),
        BTreeMap::from([("clipboardRetentionDays".into(), json!(0))]),
        BTreeMap::from([("clipboardRetentionDays".into(), json!(3651))]),
        BTreeMap::from([("clipboardRetentionDays".into(), json!(1.5))]),
        BTreeMap::from([("localAppSearch".into(), Value::Null)]),
        BTreeMap::from([("localAppSearch".into(), json!("false"))]),
        BTreeMap::from([("localAppSearch".into(), json!(0))]),
        BTreeMap::from([("localAppSearch".into(), json!([]))]),
        BTreeMap::from([("localAppSearch".into(), json!({}))]),
        BTreeMap::new(),
    ] {
        assert!(validate_patch(&rejected).is_err());
    }
    let mut too_many = accepted;
    too_many.insert("unsupportedField".into(), json!("3s"));
    assert!(validate_patch(&too_many).is_err());
}

#[test]
fn child_changes_gate_reuses_the_core_general_patch_contract() {
    use super::super::validation::changes_field;

    let valid = json!({
        "placeholder": "Search",
        "theme": "dark",
        "primaryColor": "green",
        "customColor": "#a1B2c3",
        "autoClear": "10m",
        "showRecentInSearch": true,
        "recentRows": 0,
        "pinnedRows": 20,
        "searchMode": "list",
        "showMatchRecommendation": false,
        "tabKeyFunction": "target-command",
        "tabTargetCommand": "",
        "spaceOpenCommand": false,
        "localAppSearch": true,
        "opacity": 0.65,
        "showTrayIcon": true,
        "hotkey": "Command+Shift+F10",
        "windowPositionStrategy": "primary",
        "clipboardRetentionDays": 30,
        "autoBackToSearch": "never",
        "autoPaste": "off"
    });
    assert_eq!(changes_field(Some(&valid)).unwrap().len(), 21);

    for invalid in [
        json!({"recentRows": true}),
        json!({"tabTargetCommand": "open\ncommand"}),
        json!({"opacity": 0.29}),
        json!({"opacity": 1.01}),
        json!({"opacity": "0.65"}),
        json!({"opacity": null}),
        json!({"hotkey": ""}),
        json!({"hotkey": {}}),
        json!({"windowPositionStrategy": "lastUsed"}),
        json!({"clipboardRetentionDays": "30"}),
        json!({"autoPaste": true}),
        json!({"localAppSearch": "true"}),
        json!({"unknownField": true}),
        json!([]),
    ] {
        assert!(changes_field(Some(&invalid)).is_err());
    }
}

#[test]
fn ready_capabilities_advertise_the_shared_general_field_order() {
    assert_eq!(
        RENDERER_GENERAL_SETTINGS_FIELDS,
        [
            "placeholder",
            "theme",
            "primaryColor",
            "customColor",
            "autoClear",
            "showRecentInSearch",
            "recentRows",
            "pinnedRows",
            "searchMode",
            "showMatchRecommendation",
            "tabKeyFunction",
            "tabTargetCommand",
            "spaceOpenCommand",
            "localAppSearch",
            "opacity",
            "showTrayIcon",
            "hotkey",
            "windowPositionStrategy",
            "clipboardRetentionDays",
            "autoBackToSearch",
            "autoPaste",
            "builtinAppShortcutsEnabled",
            "windowDefaultHeight",
            "autoCheckUpdate",
        ]
    );
    assert_eq!(
        super::super::lifecycle::ready_capabilities()["editableGeneralFields"],
        json!(RENDERER_GENERAL_SETTINGS_FIELDS)
    );
}

#[test]
fn opaque_revisions_are_random_32_character_hex_tokens() {
    let first = new_revision();
    let second = new_revision();
    assert_eq!(first.len(), 32);
    assert_eq!(second.len(), 32);
    assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(second.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(first, second);
    assert!(revision_matches(&first, &first));
    assert!(!revision_matches("not-a-revision", &first));
    assert!(!revision_matches(&second, &first));
}

#[test]
fn patch_errors_expose_only_stable_conflict_recovery_or_generic_codes() {
    assert_eq!(
        map_patch_error(
            "Config error: General settings changed; reload before applying the patch".into()
        ),
        "SETTINGS_REVISION_CONFLICT"
    );
    assert_eq!(
        map_patch_error("Database error: private details".into()),
        "GENERAL_SETTINGS_PATCH_FAILED"
    );
    assert_eq!(
        map_patch_error("SETTINGS_OPACITY_RECOVERY_FAILED".into()),
        "SETTINGS_OPACITY_RECOVERY_FAILED"
    );
    assert_eq!(
        map_patch_error("SETTINGS_NATIVE_RECOVERY_FAILED".into()),
        "SETTINGS_NATIVE_RECOVERY_FAILED"
    );
    assert_eq!(
        map_patch_error("SETTINGS_HOTKEY_REJECTED".into()),
        "SETTINGS_HOTKEY_REJECTED"
    );
    assert_eq!(
        map_patch_error(
            "Wrapped: Config error: General settings changed; reload before applying the patch"
                .into()
        ),
        "GENERAL_SETTINGS_PATCH_FAILED"
    );
}

#[test]
fn file_database_cas_rejects_concurrent_patch_and_preserves_unknown_raw_fields() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings-preferences.sqlite");
    let database = Database::open(&path).unwrap();
    let raw = json!({
        "theme": "system",
        "hotkey": "unsupported legacy shortcut",
        "aiApiKey": "secret-retained-in-db-only",
        "unknownNativeField": {"retained": true}
    })
    .to_string();
    database.set_setting("settings-general", &raw).unwrap();
    let opening_raw = database.read_renderer_general_settings().unwrap().unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let writers = ["dark", "light"].map(|theme| {
        let database = database.clone();
        let expected = opening_raw.clone();
        let barrier = Arc::clone(&barrier);
        thread::spawn(move || {
            barrier.wait();
            let patch = BTreeMap::from([("theme".into(), json!(theme))]);
            database.mutate_renderer_general_settings(Some(&expected), &patch)
        })
    });
    barrier.wait();
    let results = writers.map(|writer| writer.join().unwrap());
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
    let committed = database.read_renderer_general_settings().unwrap().unwrap();
    let stored: Value = serde_json::from_str(&committed).unwrap();
    assert!(matches!(stored["theme"].as_str(), Some("dark" | "light")));
    assert_eq!(stored["hotkey"], "unsupported legacy shortcut");
    assert_eq!(stored["aiApiKey"], "secret-retained-in-db-only");
    assert_eq!(stored["unknownNativeField"]["retained"], true);

    let projected = project_general_settings(Some(&committed), "").unwrap();
    assert_eq!(projected["hotkey"], "");
    assert!(!serde_json::to_string(&projected)
        .unwrap()
        .contains("secret-retained-in-db-only"));
}
