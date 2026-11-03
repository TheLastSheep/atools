use super::*;
use crate::{Plugin, PluginManifest};
use rusqlite::params;
use serde_json::json;

fn plugin(id: &str, record_name: &str, manifest_name: &str, updated_at: &str) -> Plugin {
    let manifest: PluginManifest = serde_json::from_value(json!({
        "name": manifest_name,
        "title": format!("{record_name} display title"),
        "logo": "images/logo.png",
        "description": "retained manifest metadata",
        "features": [{
            "code": format!("static-{id}"),
            "label": "Static feature",
            "explain": "static explanation",
            "icon": "images/static.png",
            "cmds": ["static-command", {"type":"regex", "label":"Static regex", "regex":"/static/i"}]
        }]
    }))
    .unwrap();
    Plugin {
        id: id.into(),
        name: record_name.into(),
        version: "1.2.3".into(),
        path: format!("/installed/{id}"),
        enabled: true,
        manifest,
        created_at: "2026-10-01T00:00:00Z".into(),
        updated_at: updated_at.into(),
    }
}

fn insert_raw_plugin(db: &Database, id: &str, config: &str, updated_at: &str) {
    let conn = db.conn.lock();
    conn.execute(
        "INSERT INTO plugins(id,name,version,path,enabled,config,created_at,updated_at)
         VALUES(?1,?2,'1','/plugins/fixture',1,?3,'created',?4)",
        params![id, id, config, updated_at],
    )
    .unwrap();
}

#[test]
fn returns_canonical_plugin_name_static_dynamic_and_disabled_metadata_in_source_order() {
    let db = Database::in_memory().unwrap();
    let recent = plugin(
        "stable-id",
        "canonical-plugin",
        "manifest-alias",
        "2026-10-02",
    );
    let older = plugin("older-id", "older-plugin", "older-manifest", "2026-10-01");
    db.save_plugin_with_features(&recent, &recent.manifest.features)
        .unwrap();
    db.save_plugin_with_features(&older, &older.manifest.features)
        .unwrap();
    db.plugin_dynamic_features_set(
        &recent.id,
        &[
            json!({"code":"z-dynamic","explain":"dynamic last","cmds":["dynamic-z"]}),
            json!({"code":"a-dynamic","explain":"dynamic first","cmds":[{"type":"over","label":"dynamic over","length":3}]}),
        ],
    )
    .unwrap();
    let mut disabled = recent.clone();
    disabled.enabled = false;
    db.save_plugin(&disabled).unwrap();
    db.set_setting(
        LOCAL_SHORTCUTS_KEY,
        r#"[{"name":"Original name","alias":"Friendly name","path":"/shortcuts/file","icon":"shortcut.png"}]"#,
    )
    .unwrap();

    let snapshot = db.read_renderer_command_catalog().unwrap();
    assert_eq!(snapshot.plugins.len(), 2);
    assert_eq!(snapshot.plugins[0]["id"], "stable-id");
    assert_eq!(snapshot.plugins[0]["name"], "canonical-plugin");
    assert_eq!(
        snapshot.plugins[0]["title"],
        "canonical-plugin display title"
    );
    assert_eq!(snapshot.plugins[0]["enabled"], false);
    assert_eq!(
        snapshot.plugins[0]["features"][0]["code"],
        "static-stable-id"
    );
    assert_eq!(snapshot.plugins[0]["features"][1]["code"], "a-dynamic");
    assert_eq!(snapshot.plugins[0]["features"][2]["code"], "z-dynamic");
    assert_eq!(snapshot.plugins[1]["name"], "older-plugin");
    assert_eq!(
        snapshot.local_shortcuts,
        Some(json!([{
            "name":"Original name",
            "alias":"Friendly name",
            "path":"/shortcuts/file",
            "icon":"shortcut.png"
        }]))
    );
}

#[test]
fn rejects_plugin_record_and_aggregate_metadata_overflow_before_reading_rows() {
    let too_large_record_db = Database::in_memory().unwrap();
    let padding = "x".repeat(RENDERER_COMMAND_CATALOG_MAX_RECORD_BYTES);
    let oversized = format!(r#"{{"name":"large","features":[],"padding":"{padding}"}}"#);
    insert_raw_plugin(&too_large_record_db, "large", &oversized, "1");
    assert!(too_large_record_db
        .read_renderer_command_catalog()
        .unwrap_err()
        .to_string()
        .contains("512 KiB"));

    let total_db = Database::in_memory().unwrap();
    let padding = "x".repeat(450_000);
    let config = format!(r#"{{"name":"p","features":[],"padding":"{padding}"}}"#);
    for index in 0..20 {
        insert_raw_plugin(
            &total_db,
            &format!("plugin-{index}"),
            &config,
            &format!("{index:02}"),
        );
    }
    assert!(total_db
        .read_renderer_command_catalog()
        .unwrap_err()
        .to_string()
        .contains("8 MiB"));
}

#[test]
fn rejects_plugin_and_feature_count_overflow_without_returning_a_partial_catalog() {
    let plugin_count_db = Database::in_memory().unwrap();
    for index in 0..=RENDERER_COMMAND_CATALOG_MAX_PLUGINS {
        insert_raw_plugin(
            &plugin_count_db,
            &format!("plugin-{index}"),
            r#"{"name":"plugin","features":[]}"#,
            "1",
        );
    }
    assert!(plugin_count_db
        .read_renderer_command_catalog()
        .unwrap_err()
        .to_string()
        .contains("plugin"));

    let feature_count_db = Database::in_memory().unwrap();
    let features = (0..=RENDERER_COMMAND_CATALOG_MAX_FEATURES)
        .map(|_| json!({"code":"f"}))
        .collect::<Vec<_>>();
    let config = json!({"name":"many-features","features":features}).to_string();
    assert!(config.len() < RENDERER_COMMAND_CATALOG_MAX_RECORD_BYTES);
    insert_raw_plugin(&feature_count_db, "many-features", &config, "1");
    assert!(feature_count_db
        .read_renderer_command_catalog()
        .unwrap_err()
        .to_string()
        .contains("feature records"));
}

#[test]
fn rejects_command_row_and_local_shortcut_overflow_without_truncating() {
    let command_db = Database::in_memory().unwrap();
    let commands = (0..=RENDERER_COMMAND_CATALOG_MAX_PLUGIN_ROWS)
        .map(|index| json!(format!("command-{index}")))
        .collect::<Vec<_>>();
    let config = json!({
        "name":"many-commands",
        "features":[{"code":"open","cmds":commands}]
    })
    .to_string();
    assert!(config.len() < RENDERER_COMMAND_CATALOG_MAX_RECORD_BYTES);
    insert_raw_plugin(&command_db, "many-commands", &config, "1");
    assert!(command_db
        .read_renderer_command_catalog()
        .unwrap_err()
        .to_string()
        .contains("command rows"));

    let shortcuts_db = Database::in_memory().unwrap();
    shortcuts_db
        .set_setting(
            LOCAL_SHORTCUTS_KEY,
            &format!(
                "[{}]",
                " ".repeat(RENDERER_COMMAND_CATALOG_MAX_LOCAL_SHORTCUTS_BYTES)
            ),
        )
        .unwrap();
    assert!(shortcuts_db
        .read_renderer_command_catalog()
        .unwrap_err()
        .to_string()
        .contains("128 KiB"));
}
