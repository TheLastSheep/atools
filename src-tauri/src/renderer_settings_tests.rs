use super::*;

fn empty_settings() -> BTreeMap<String, Option<String>> {
    NATIVE_SETTING_KEYS
        .into_iter()
        .map(|key| (key.to_owned(), None))
        .collect()
}

#[test]
fn snapshot_has_the_fixed_native_keyset_and_preserves_missing_values() {
    let snapshot = build_snapshot(empty_settings()).unwrap();

    assert_eq!(snapshot.version, 1);
    assert_eq!(snapshot.settings.len(), 14);
    assert_eq!(snapshot.settings.get("settings-general"), Some(&None));
    assert_eq!(
        NATIVE_SETTING_KEYS,
        [
            "settings-general",
            "ztools-renderer:command-aliases",
            "ztools-renderer:disable-commands",
            "ztools-renderer:enabled-main-push-plugin",
            "ztools-renderer:search-preference",
            "ztools-renderer:recommendation-pinned",
            "ztools-renderer:command-history",
            "ztools-renderer:pinned-commands",
            "ztools-renderer:out-kill-plugin",
            "ztools-renderer:auto-detach-plugin",
            "ztools-renderer:auto-start-plugin",
            "ztools-renderer:super-panel-pinned",
            "ztools-renderer:local-shortcuts",
            "ztools-renderer:command-usage-stats",
        ]
    );

    let encoded = serde_json::to_value(snapshot).unwrap();
    assert_eq!(encoded["version"], 1);
    assert_eq!(encoded["settings"]["settings-general"], Value::Null);
}

#[test]
fn snapshot_rejects_unknown_or_missing_native_keys() {
    let mut missing = empty_settings();
    missing.remove("settings-general");
    assert_eq!(
        build_snapshot(missing).unwrap_err(),
        "Renderer settings snapshot has an invalid key set"
    );

    let mut unknown = empty_settings();
    unknown.insert("user-secret".into(), None);
    assert_eq!(
        build_snapshot(unknown).unwrap_err(),
        "Renderer settings snapshot has an invalid key set"
    );
}

#[test]
fn general_settings_are_projected_to_the_frontend_safe_keys() {
    let mut settings = empty_settings();
    settings.insert(
        "settings-general".into(),
        Some(
            serde_json::json!({
                "hotkey": "Alt+Space",
                "theme": "dark",
                "authToken": "must-not-cross-ipc",
                "password": "also-secret",
                "unknownExtensionSetting": true
            })
            .to_string(),
        ),
    );

    let snapshot = build_snapshot(settings).unwrap();
    let filtered = snapshot.settings["settings-general"].as_ref().unwrap();
    let projected: Value = serde_json::from_str(filtered).unwrap();

    assert_eq!(
        projected,
        serde_json::json!({"hotkey":"Alt+Space", "theme":"dark", "builtinAppShortcutsEnabled":{"search":true,"esc":true,"closePlugin":true}})
    );
    assert!(!filtered.contains("must-not-cross-ipc"));
    assert!(!filtered.contains("password"));
}

#[test]
fn cold_start_snapshot_preserves_tab_target_command_and_legacy_alias_safely() {
    use atools_core::db::Database;

    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("renderer-general-settings.db");
    let target_command = "t".repeat(2049);
    let raw = serde_json::json!({
        "tabTargetCommand": target_command,
        "tabTarget": "legacy-target",
        "authToken": "must-not-cross-ipc",
        "unknownExtensionSetting": "unknown-secret"
    })
    .to_string();
    {
        let db = Database::open(&path).unwrap();
        db.set_setting("settings-general", &raw).unwrap();
    }

    let db = Database::open(&path).unwrap();
    let native_rows = read_settings_snapshot(&db).unwrap();
    let snapshot = build_snapshot(native_rows).unwrap();
    let projected_raw = snapshot.settings["settings-general"].as_ref().unwrap();
    let projected: Value = serde_json::from_str(projected_raw).unwrap();
    let serialized = serde_json::to_string(&snapshot).unwrap();

    assert_eq!(projected["tabTargetCommand"].as_str().unwrap().len(), 2049);
    assert_eq!(projected["tabTarget"], "legacy-target");
    assert!(projected.get("authToken").is_none());
    assert!(projected.get("unknownExtensionSetting").is_none());
    assert!(!serialized.contains("must-not-cross-ipc"));
    assert!(!serialized.contains("unknown-secret"));
}

#[test]
fn general_settings_must_be_a_json_object_and_within_its_byte_budget() {
    let mut malformed = empty_settings();
    malformed.insert("settings-general".into(), Some("[]".into()));
    assert_eq!(
        build_snapshot(malformed).unwrap_err(),
        "General renderer settings must be a JSON object"
    );

    let mut oversized = empty_settings();
    oversized.insert(
        "settings-general".into(),
        Some("x".repeat(MAX_GENERAL_BYTES + 1)),
    );
    assert_eq!(
        build_snapshot(oversized).unwrap_err(),
        "Renderer setting exceeds the configured byte limit"
    );
}

#[test]
fn namespaced_values_and_total_snapshot_bytes_are_bounded() {
    let mut oversized_value = empty_settings();
    oversized_value.insert(
        NATIVE_SETTING_KEYS[1].into(),
        Some("x".repeat(MAX_VALUE_BYTES + 1)),
    );
    assert_eq!(
        build_snapshot(oversized_value).unwrap_err(),
        "Renderer setting exceeds the configured byte limit"
    );

    let mut over_total = empty_settings();
    // Alias values have their own normalized JSON contract; isolate the aggregate
    // budget here from that parser with nine of the other bounded namespaces.
    for key in &NATIVE_SETTING_KEYS[2..11] {
        over_total.insert((*key).into(), Some("x".repeat(128 * 1024)));
    }
    assert_eq!(
        build_snapshot(over_total).unwrap_err(),
        "Renderer settings response exceeds its byte budget"
    );
}

#[test]
fn alias_settings_are_normalized_from_the_captured_legacy_value() {
    let mut settings = empty_settings();
    settings.insert(
        COMMAND_ALIASES_KEY.to_owned(),
        Some(r#"{"direct:app:/fixture":[" old ",{"alias":"new","icon":" icon "}]}"#.into()),
    );

    let snapshot = build_snapshot(settings).unwrap();
    let aliases: Value =
        serde_json::from_str(snapshot.settings[COMMAND_ALIASES_KEY].as_deref().unwrap()).unwrap();
    assert_eq!(
        aliases,
        serde_json::json!({
            "direct:app:/fixture": [
                {"alias":"old"},
                {"alias":"new","icon":" icon "}
            ]
        })
    );

    let missing = build_snapshot(empty_settings()).unwrap();
    assert_eq!(missing.settings[COMMAND_ALIASES_KEY], None);
}

#[test]
fn alias_snapshot_rejects_invalid_roots_without_substituting_an_empty_map() {
    let mut settings = empty_settings();
    settings.insert(COMMAND_ALIASES_KEY.to_owned(), Some("[]".into()));

    assert_eq!(
        build_snapshot(settings).unwrap_err(),
        "Renderer command aliases are invalid"
    );
}

#[test]
fn actual_json_escaping_is_checked_after_the_sum_budget_fast_path() {
    let mut settings = empty_settings();
    for key in &NATIVE_SETTING_KEYS[2..8] {
        settings.insert((*key).to_owned(), Some("\"".repeat(90_000)));
    }

    assert_eq!(
        build_snapshot(settings).unwrap_err(),
        "Renderer settings response exceeds its byte budget"
    );
}

#[test]
fn only_the_main_webview_can_read_the_snapshot() {
    assert!(ensure_main_webview("main").is_ok());
    assert_eq!(
        ensure_main_webview("plugin-123").unwrap_err(),
        "Renderer settings are available only to the main window"
    );
}

#[test]
fn search_preference_survives_database_reopen_and_snapshot_mapping() {
    use atools_core::db::Database;

    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("renderer-settings.db");
    let preference = r#"{"recent":[{"path":"/tmp/item","name":"Item"}]}"#;
    {
        let db = Database::open(&path).unwrap();
        db.set_setting("ztools-renderer:search-preference", preference)
            .unwrap();
    }

    let db = Database::open(&path).unwrap();
    let rows = read_settings_snapshot(&db).unwrap();
    let snapshot = build_snapshot(rows).unwrap();

    assert_eq!(
        snapshot.settings.get("ztools-renderer:search-preference"),
        Some(&Some(preference.to_owned()))
    );
}

#[test]
fn auto_check_preference_is_in_the_existing_safe_general_event_projection() {
    for enabled in [false, true] {
        let raw=serde_json::json!({"autoCheckUpdate":enabled,"secret":"not-for-Main","unknownExtensionSetting":true}).to_string();
        let safe = project_general_settings(&raw).unwrap();
        let value: Value = serde_json::from_str(&safe).unwrap();
        assert_eq!(value["autoCheckUpdate"], enabled);
        assert!(!safe.contains("not-for-Main"));
        assert!(value.get("unknownExtensionSetting").is_none());
    }
}
