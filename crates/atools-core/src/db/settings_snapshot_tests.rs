use super::*;

#[test]
fn bounded_batch_preserves_missing_values_and_counts_utf8_bytes() {
    let db = Database::in_memory().unwrap();
    db.set_setting("present", "é").unwrap();

    let values = db
        .read_settings_bounded(&["missing", "present"], 4, 16)
        .unwrap();

    assert_eq!(values.get("missing"), Some(&None));
    assert_eq!(values.get("present"), Some(&Some("é".to_owned())));
    assert!(db
        .read_settings_bounded(&["present"], 1, 8)
        .unwrap_err()
        .to_string()
        .contains("configured byte limit"));
}

#[test]
fn bounded_batch_rejects_total_budget_overflow_without_returning_values() {
    let db = Database::in_memory().unwrap();
    db.set_setting("a", "123").unwrap();
    db.set_setting("b", "456").unwrap();

    let error = db.read_settings_bounded(&["a", "b"], 3, 7).unwrap_err();

    assert_eq!(
        error.to_string(),
        "Config error: Settings response budget exceeded"
    );
}

#[test]
fn settings_general_has_its_lower_sql_side_value_limit() {
    let db = Database::in_memory().unwrap();
    let oversized = "x".repeat(GENERAL_SETTINGS_MAX_BYTES + 1);
    db.set_setting("settings-general", &oversized).unwrap();

    let error = db
        .read_settings_bounded(&["settings-general"], 128 * 1024, 128 * 1024)
        .unwrap_err();

    assert_eq!(
        error.to_string(),
        "Config error: Setting value exceeds the configured byte limit"
    );
    assert!(!error.to_string().contains(&oversized));
}

#[test]
fn bounded_batch_validates_key_count_and_limits() {
    let db = Database::in_memory().unwrap();
    let keys = (0..33).map(|_| "x").collect::<Vec<_>>();

    assert!(db.read_settings_bounded(&keys, 1, 4096).is_err());
    assert!(db.read_settings_bounded(&[""], 1, 8).is_err());
    assert!(db.read_settings_bounded(&["x"], 0, 8).is_err());
    assert!(db.read_settings_bounded(&["x"], 9, 8).is_err());
}

#[test]
fn search_preference_survives_reopen_and_is_returned_by_the_bounded_snapshot_read() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("settings.db");
    let preference = r#"{"recent":{"path":"/Applications/Fixture.app","name":"Fixture"}}"#;
    {
        let db = Database::open(&path).unwrap();
        db.set_setting("ztools-renderer:search-preference", preference)
            .unwrap();
    }

    let db = Database::open(&path).unwrap();
    let snapshot = db
        .read_settings_bounded(
            &["settings-general", "ztools-renderer:search-preference"],
            128 * 1024,
            1024 * 1024,
        )
        .unwrap();

    assert_eq!(
        snapshot.get("ztools-renderer:search-preference"),
        Some(&Some(preference.to_owned()))
    );
    assert_eq!(snapshot.get("settings-general"), Some(&None));
}
