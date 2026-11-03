use super::operations;
use atools_core::Database;
use serde_json::{json, Value};

const KEY: &str = super::BACKGROUND_STARTUP_KEY;

fn save_plugin(db: &Database, id: &str, display_name: &str, manifest_name: &str) {
    let plugin: atools_core::Plugin = serde_json::from_value(json!({
        "id":id,
        "name":display_name,
        "version":"1.0.0",
        "path":"/inert",
        "enabled":true,
        "manifest":{"name":manifest_name,"version":"1.0.0","main":"index.html"},
        "created_at":"now",
        "updated_at":"now"
    }))
    .unwrap();
    db.save_plugin(&plugin).unwrap();
}

fn call(db: &Database, plugin: &str, method: &str, args: Value) -> Result<Value, String> {
    operations::execute(db, plugin, &json!({"method":method,"args":args}))
}

#[test]
fn startup_preference_is_plugin_local_and_bounded_before_success() {
    let db = Database::in_memory().unwrap();
    save_plugin(&db, "snipaste", "Snipaste 展示名", "snipaste");
    save_plugin(&db, "paste", "Paste", "paste");

    assert_eq!(
        call(&db, "snipaste", "startup.get", json!([])).unwrap(),
        json!([])
    );
    assert_eq!(
        call(
            &db,
            "snipaste",
            "startup.set",
            json!([["snipaste", "snipaste"]])
        )
        .unwrap(),
        Value::Null
    );
    assert_eq!(
        call(&db, "snipaste", "startup.get", json!([])).unwrap(),
        json!(["snipaste"])
    );
    assert_eq!(
        call(&db, "paste", "startup.get", json!([])).unwrap(),
        json!([])
    );
    assert_eq!(
        db.plugin_storage_get("snipaste", KEY).unwrap(),
        json!(["snipaste"])
    );

    assert!(call(&db, "snipaste", "startup.set", json!([["paste"]])).is_err());
    assert!(call(&db, "snipaste", "startup.set", json!([["Snipaste 展示名"]])).is_err());
    assert!(call(&db, "snipaste", "startup.set", json!(["snipaste"])).is_err());
    let too_many_names = vec!["snipaste"; 17];
    assert!(call(&db, "snipaste", "startup.set", json!([too_many_names])).is_err());
    assert_eq!(
        db.plugin_storage_get("snipaste", KEY).unwrap(),
        json!(["snipaste"])
    );

    assert_eq!(
        call(&db, "snipaste", "startup.set", json!([[]])).unwrap(),
        Value::Null
    );
    assert_eq!(
        call(&db, "snipaste", "startup.get", json!([])).unwrap(),
        json!([])
    );
    assert_eq!(db.plugin_storage_get("snipaste", KEY).unwrap(), json!([]));
}

#[test]
fn startup_get_treats_corrupt_or_foreign_persisted_values_as_not_requested() {
    let db = Database::in_memory().unwrap();
    save_plugin(&db, "snipaste", "Snipaste 展示名", "snipaste");
    db.plugin_storage_set("snipaste", KEY, &json!(["Paste"]))
        .unwrap();
    assert_eq!(
        call(&db, "snipaste", "startup.get", json!([])).unwrap(),
        json!([])
    );
    db.plugin_storage_set("snipaste", KEY, &json!("Snipaste"))
        .unwrap();
    assert_eq!(
        call(&db, "snipaste", "startup.get", json!([])).unwrap(),
        json!([])
    );
}

#[test]
fn startup_preference_survives_database_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("plugin-data.db");
    {
        let db = Database::open(&path).unwrap();
        save_plugin(&db, "snipaste", "Snipaste 展示名", "snipaste");
        assert_eq!(
            call(&db, "snipaste", "startup.set", json!([["snipaste"]])).unwrap(),
            Value::Null
        );
    }
    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        call(&reopened, "snipaste", "startup.get", json!([])).unwrap(),
        json!(["snipaste"])
    );
    assert_eq!(
        reopened.plugin_storage_get("snipaste", KEY).unwrap(),
        json!(["snipaste"])
    );
}
