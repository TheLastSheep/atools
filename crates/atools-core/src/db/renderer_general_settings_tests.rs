use super::*;
use serde_json::json;
use std::sync::{Arc, Barrier};

fn patch(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

#[test]
fn general_settings_patch_survives_reopen_and_preserves_unknown_fields() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-settings.sqlite");
    let initial = json!({
        "theme": "dark",
        "customColor": "#123456",
        "unknownField": {"retained": [1, true, "value"]}
    })
    .to_string();

    let updated = {
        let db = Database::open(&path).unwrap();
        db.set_setting(SETTINGS_KEY, &initial).unwrap();
        let expected = db.read_renderer_general_settings().unwrap().unwrap();
        db.mutate_renderer_general_settings(
            Some(&expected),
            &patch(&[
                ("theme", json!("light")),
                ("placeholder", json!("Search apps")),
            ]),
        )
        .unwrap()
    };

    let decoded: Value = serde_json::from_str(&updated).unwrap();
    assert_eq!(decoded["theme"], "light");
    assert_eq!(decoded["placeholder"], "Search apps");
    assert_eq!(decoded["customColor"], "#123456");
    assert_eq!(
        decoded["unknownField"]["retained"],
        json!([1, true, "value"])
    );

    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        reopened
            .read_renderer_general_settings()
            .unwrap()
            .as_deref(),
        Some(updated.as_str())
    );
}

#[test]
fn empty_settings_accept_the_original_general_page_values() {
    let db = Database::in_memory().unwrap();
    assert_eq!(db.read_renderer_general_settings().unwrap(), None);

    let raw = db
        .mutate_renderer_general_settings(
            None,
            &patch(&[
                ("placeholder", json!("界".repeat(170))),
                ("theme", json!("system")),
                ("primaryColor", json!("pink")),
                ("customColor", json!("#a1B2c3")),
                ("autoClear", json!("10m")),
            ]),
        )
        .unwrap();

    let settings: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(settings["placeholder"].as_str().unwrap().len(), 510);
    assert_eq!(settings["theme"], "system");
    assert_eq!(settings["primaryColor"], "pink");
    assert_eq!(settings["customColor"], "#a1B2c3");
    assert_eq!(settings["autoClear"], "10m");
}

#[test]
fn renderer_patch_accepts_all_typed_fields_in_contract_order() {
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

    let db = Database::in_memory().unwrap();
    let initial = json!({
        "aiApiKey": "secret-retained-only-in-storage",
        "unknownNativeField": {"retained": true}
    })
    .to_string();
    db.set_setting(SETTINGS_KEY, &initial).unwrap();
    let expected = db.read_renderer_general_settings().unwrap().unwrap();
    let placeholder = "p".repeat(MAX_PLACEHOLDER_BYTES);
    let target_command = "t".repeat(2049);
    let updated = db
        .mutate_renderer_general_settings(
            Some(&expected),
            &patch(&[
                ("placeholder", json!(placeholder)),
                ("theme", json!("dark")),
                ("primaryColor", json!("green")),
                ("customColor", json!("#a1B2c3")),
                ("autoClear", json!("10m")),
                ("showRecentInSearch", json!(true)),
                ("recentRows", json!(0)),
                ("pinnedRows", json!(20)),
                ("searchMode", json!("list")),
                ("showMatchRecommendation", json!(false)),
                ("tabKeyFunction", json!("navigate")),
                ("tabTargetCommand", json!(target_command)),
                ("spaceOpenCommand", json!(true)),
                ("localAppSearch", json!(false)),
                ("opacity", json!(1.0)),
                ("showTrayIcon", json!(true)),
                ("hotkey", json!("Command+Shift+F10")),
                ("windowPositionStrategy", json!("lastActive")),
                ("clipboardRetentionDays", json!(30)),
                ("autoBackToSearch", json!("30s")),
                ("autoPaste", json!("10s")),
                (
                    "builtinAppShortcutsEnabled",
                    json!({"search":false,"esc":true}),
                ),
            ]),
        )
        .unwrap();

    let stored: Value = serde_json::from_str(&updated).unwrap();
    assert_eq!(stored["placeholder"].as_str().unwrap().len(), 512);
    assert_eq!(stored["showRecentInSearch"], true);
    assert_eq!(stored["recentRows"], 0);
    assert_eq!(stored["pinnedRows"], 20);
    assert_eq!(stored["searchMode"], "list");
    assert_eq!(stored["showMatchRecommendation"], false);
    assert_eq!(stored["tabKeyFunction"], "navigate");
    assert_eq!(stored["tabTargetCommand"].as_str().unwrap().len(), 2049);
    assert_eq!(stored["spaceOpenCommand"], true);
    assert_eq!(stored["localAppSearch"], false);
    assert_eq!(stored["showTrayIcon"], true);
    assert_eq!(stored["hotkey"], "Command+Shift+F10");
    assert_eq!(stored["windowPositionStrategy"], "lastActive");
    assert_eq!(stored["clipboardRetentionDays"].as_u64(), Some(30));
    assert_eq!(stored["autoBackToSearch"], "30s");
    assert_eq!(stored["autoPaste"], "10s");
    assert_eq!(
        stored["builtinAppShortcutsEnabled"],
        json!({"search":false,"esc":true})
    );
    assert_eq!(stored["aiApiKey"], "secret-retained-only-in-storage");
    assert_eq!(stored["unknownNativeField"]["retained"], true);
}

#[test]
fn local_app_search_toggles_with_cas_and_preserves_unrelated_settings() {
    let db = Database::in_memory().unwrap();
    let initial = json!({
        "localAppSearch": true,
        "theme": "dark",
        "unknownSetting": {"retained": ["value", 7]}
    })
    .to_string();
    db.set_setting(SETTINGS_KEY, &initial).unwrap();

    let expected = db.read_renderer_general_settings().unwrap().unwrap();
    let disabled = db
        .mutate_renderer_general_settings(
            Some(&expected),
            &patch(&[("localAppSearch", json!(false))]),
        )
        .unwrap();
    let disabled_value: Value = serde_json::from_str(&disabled).unwrap();
    assert_eq!(disabled_value["localAppSearch"], false);
    assert_eq!(disabled_value["theme"], "dark");
    assert_eq!(
        disabled_value["unknownSetting"]["retained"],
        json!(["value", 7])
    );

    let conflict = db
        .mutate_renderer_general_settings(
            Some(&initial),
            &patch(&[("localAppSearch", json!(true))]),
        )
        .unwrap_err();
    assert!(conflict.to_string().contains("General settings changed"));
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(disabled.as_str())
    );

    let enabled = db
        .mutate_renderer_general_settings(
            Some(&disabled),
            &patch(&[("localAppSearch", json!(true))]),
        )
        .unwrap();
    let enabled_value: Value = serde_json::from_str(&enabled).unwrap();
    assert_eq!(enabled_value["localAppSearch"], true);
    assert_eq!(enabled_value["theme"], "dark");
    assert_eq!(
        enabled_value["unknownSetting"]["retained"],
        json!(["value", 7])
    );
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(enabled.as_str())
    );
}

#[test]
fn local_app_search_rejects_non_boolean_values_without_mutation() {
    let db = Database::in_memory().unwrap();
    let initial = r#"{"theme":"system","unknownSetting":true}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();

    for value in [Value::Null, json!("false"), json!(0), json!([]), json!({})] {
        assert!(db
            .mutate_renderer_general_settings(Some(initial), &patch(&[("localAppSearch", value)]),)
            .is_err());
        assert_eq!(
            db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
            Some(initial)
        );
    }
}

#[test]
fn compare_and_swap_rejects_stale_writes_and_allows_only_one_racing_writer() {
    let db = Database::in_memory().unwrap();
    let initial = r#"{"theme":"dark","unknown":7}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();

    assert!(db
        .mutate_renderer_general_settings(
            Some(r#"{"theme":"light"}"#),
            &patch(&[("theme", json!("light"))]),
        )
        .is_err());
    assert_eq!(
        db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(initial)
    );

    let barrier = Arc::new(Barrier::new(3));
    let mut writers = Vec::new();
    for theme in ["light", "system"] {
        let db = db.clone();
        let expected = initial.to_owned();
        let barrier = Arc::clone(&barrier);
        writers.push(std::thread::spawn(move || {
            barrier.wait();
            db.mutate_renderer_general_settings(Some(&expected), &patch(&[("theme", json!(theme))]))
        }));
    }
    barrier.wait();
    let outcomes = writers
        .into_iter()
        .map(|writer| writer.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);

    let final_settings: Value = serde_json::from_str(
        db.read_renderer_general_settings()
            .unwrap()
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        final_settings["theme"].as_str(),
        Some("light" | "system")
    ));
    assert_eq!(final_settings["unknown"], 7);
}

#[test]
fn independent_sqlite_connections_cas_without_overwriting_the_winner() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("independent-general-settings.sqlite");
    let first = Database::open(&path).unwrap();
    let initial = r#"{"theme":"dark","unknown":{"kept":true}}"#;
    first.set_setting(SETTINGS_KEY, initial).unwrap();
    let second = Database::open(&path).unwrap();

    let first_expected = first.read_renderer_general_settings().unwrap().unwrap();
    let second_expected = second.read_renderer_general_settings().unwrap().unwrap();
    assert_eq!(first_expected, second_expected);

    let barrier = Arc::new(Barrier::new(3));
    let first_barrier = Arc::clone(&barrier);
    let first_writer = std::thread::spawn(move || {
        first_barrier.wait();
        first.mutate_renderer_general_settings(
            Some(&first_expected),
            &patch(&[("theme", json!("light"))]),
        )
    });
    let second_barrier = Arc::clone(&barrier);
    let second_writer = std::thread::spawn(move || {
        second_barrier.wait();
        second.mutate_renderer_general_settings(
            Some(&second_expected),
            &patch(&[("theme", json!("system"))]),
        )
    });

    barrier.wait();
    let outcomes = [first_writer.join().unwrap(), second_writer.join().unwrap()];
    let winners = outcomes
        .iter()
        .filter_map(|outcome| outcome.as_ref().ok())
        .collect::<Vec<_>>();
    let conflicts = outcomes
        .iter()
        .filter_map(|outcome| outcome.as_ref().err())
        .collect::<Vec<_>>();
    assert_eq!(winners.len(), 1);
    assert_eq!(conflicts.len(), 1);
    assert!(conflicts[0]
        .to_string()
        .contains("General settings changed"));

    let winner: Value = serde_json::from_str(winners[0]).unwrap();
    let reopened = Database::open(&path).unwrap();
    let final_raw = reopened.read_renderer_general_settings().unwrap().unwrap();
    let final_settings: Value = serde_json::from_str(&final_raw).unwrap();
    assert_eq!(final_settings["theme"], winner["theme"]);
    assert_eq!(final_settings["unknown"]["kept"], true);
}

#[test]
fn invalid_fields_values_and_oversized_requests_leave_storage_unchanged() {
    let db = Database::in_memory().unwrap();
    let initial = r#"{"theme":"dark","unknown":true}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();

    let mut too_many_fields = BTreeMap::new();
    for index in 0..21 {
        too_many_fields.insert(format!("unsupported{index}"), json!("value"));
    }
    let more_than_twenty = {
        let mut changes = patch(&[
            ("placeholder", json!("Search")),
            ("theme", json!("dark")),
            ("primaryColor", json!("green")),
            ("customColor", json!("#a1B2c3")),
            ("autoClear", json!("10m")),
            ("showRecentInSearch", json!(true)),
            ("recentRows", json!(2)),
            ("pinnedRows", json!(2)),
            ("searchMode", json!("aggregate")),
            ("showMatchRecommendation", json!(true)),
            ("tabKeyFunction", json!("navigate")),
            ("tabTargetCommand", json!("")),
            ("spaceOpenCommand", json!(false)),
            ("localAppSearch", json!(true)),
            ("opacity", json!(1.0)),
            ("showTrayIcon", json!(true)),
            ("hotkey", json!("Command+Shift+F10")),
            ("windowPositionStrategy", json!("lastActive")),
            ("clipboardRetentionDays", json!(30)),
            ("autoBackToSearch", json!("30s")),
        ]);
        changes.insert("readonlyField".into(), json!("value"));
        changes
    };
    let invalid_patches = [
        patch(&[("unapproved", json!("value"))]),
        patch(&[("theme", json!("system-dark"))]),
        patch(&[("primaryColor", json!("cyan"))]),
        patch(&[("customColor", json!("#12345g"))]),
        patch(&[("autoClear", json!("off"))]),
        patch(&[("placeholder", json!("line\nbreak"))]),
        patch(&[("placeholder", json!("x".repeat(MAX_PLACEHOLDER_BYTES + 1)))]),
        patch(&[("autoClear", json!(false))]),
        patch(&[("showRecentInSearch", json!(1))]),
        patch(&[("recentRows", json!(2.5))]),
        patch(&[("recentRows", json!(-1))]),
        patch(&[("recentRows", json!(21))]),
        patch(&[("recentRows", json!("2"))]),
        patch(&[("recentRows", json!(true))]),
        patch(&[("pinnedRows", json!(2.5))]),
        patch(&[("searchMode", json!("grid"))]),
        patch(&[("showMatchRecommendation", json!("true"))]),
        patch(&[("tabKeyFunction", json!("spaces"))]),
        patch(&[("tabTargetCommand", json!("open\ncommand"))]),
        patch(&[("spaceOpenCommand", json!(0))]),
        BTreeMap::new(),
        too_many_fields,
        more_than_twenty,
    ];
    for changes in invalid_patches {
        assert!(db
            .mutate_renderer_general_settings(Some(initial), &changes)
            .is_err());
        assert_eq!(
            db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
            Some(initial)
        );
    }

    let oversized_expected = "x".repeat(MAX_GENERAL_BYTES + 1);
    assert!(db
        .mutate_renderer_general_settings(
            Some(&oversized_expected),
            &patch(&[("theme", json!("light"))]),
        )
        .is_err());
    assert_eq!(
        db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(initial)
    );
}

#[test]
fn invalid_or_oversized_stored_values_are_rejected_without_mutation() {
    let db = Database::in_memory().unwrap();

    for invalid_raw in ["not-json", "[]"] {
        db.set_setting(SETTINGS_KEY, invalid_raw).unwrap();
        assert!(db.read_renderer_general_settings().is_err());
        assert!(db
            .mutate_renderer_general_settings(
                Some(invalid_raw),
                &patch(&[("theme", json!("light"))]),
            )
            .is_err());
        assert_eq!(
            db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
            Some(invalid_raw)
        );
    }

    let oversized = format!("{{\"unknown\":\"{}\"}}", "x".repeat(MAX_GENERAL_BYTES));
    db.set_setting(SETTINGS_KEY, &oversized).unwrap();
    assert!(db.read_renderer_general_settings().is_err());
    assert!(db
        .mutate_renderer_general_settings(Some(&oversized), &patch(&[("theme", json!("light"))]),)
        .is_err());
    assert_eq!(
        db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(oversized.as_str())
    );
}

#[test]
fn response_budget_counts_json_string_escaping() {
    let db = Database::in_memory().unwrap();
    let raw = json!({"unknown": "\"".repeat(17_000)}).to_string();
    assert!(raw.len() < MAX_GENERAL_BYTES);
    db.set_setting(SETTINGS_KEY, &raw).unwrap();

    let error = db.read_renderer_general_settings().unwrap_err();
    assert!(error.to_string().contains("response exceeds"));
    let request_error = db
        .mutate_renderer_general_settings(Some(&raw), &patch(&[("theme", json!("light"))]))
        .unwrap_err();
    assert!(request_error.to_string().contains("request exceeds"));
    assert_eq!(
        db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(raw.as_str())
    );
}
