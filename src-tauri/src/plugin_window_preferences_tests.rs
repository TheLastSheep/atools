use super::*;
use atools_core::{Database, Plugin};
use serde_json::json;

fn plugin(id: &str) -> Plugin {
    Plugin {
        id: id.into(),
        name: id.into(),
        version: "1".into(),
        path: format!("/plugins/{id}"),
        enabled: true,
        manifest: serde_json::from_value(json!({
            "name": id,
            "version": "1",
            "main": "index.html",
            "features": []
        }))
        .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}

fn install(db: &Database, id: &str) {
    db.save_plugin(&plugin(id)).unwrap();
}

#[test]
fn preferences_are_isolated_and_survive_database_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin-preferences.sqlite");
    {
        let db = Database::open(&path).unwrap();
        install(&db, "harris.plugin-a");
        install(&db, "harris.plugin-b");
        assert!(!get_preferences(&db, "harris.plugin-a").unwrap().auto_detach);
        assert!(
            set_auto_detach(&db, "harris.plugin-a", true)
                .unwrap()
                .auto_detach
        );
        assert!(!get_preferences(&db, "harris.plugin-b").unwrap().auto_detach);
    }

    let db = Database::open(&path).unwrap();
    assert!(get_preferences(&db, "harris.plugin-a").unwrap().auto_detach);
    assert!(!get_preferences(&db, "harris.plugin-b").unwrap().auto_detach);
}

#[test]
fn corrupt_preference_is_a_recoverable_error_and_never_enables_detach() {
    let db = Database::in_memory().unwrap();
    install(&db, "plugin-a");
    db.set_setting(&setting_key("plugin-a"), "yes").unwrap();

    assert!(get_preferences(&db, "plugin-a").is_err());
    assert!(!activation_auto_detach(&db, "plugin-a"));
    assert!(!set_auto_detach(&db, "plugin-a", false).unwrap().auto_detach);
    assert!(!get_preferences(&db, "plugin-a").unwrap().auto_detach);
}

#[test]
fn preferences_reject_uninstalled_or_malformed_plugin_ids() {
    let db = Database::in_memory().unwrap();
    assert!(validate_installed_plugin(&db, "missing-plugin").is_err());
    for malformed in ["", " plugin-a", "plugin-a ", "plugin\n-a"] {
        assert!(validate_installed_plugin(&db, malformed).is_err());
    }
}

#[test]
fn activation_reads_corrupt_values_as_disabled() {
    let db = Database::in_memory().unwrap();
    install(&db, "plugin-a");
    db.set_setting(&setting_key("plugin-a"), "true-ish")
        .unwrap();
    assert!(!activation_auto_detach(&db, "plugin-a"));
}
