use super::*;
use serde_json::{json, Value};

fn identity(sub_type: RendererDirectSubtype) -> RendererAppIdentity {
    RendererAppIdentity {
        path: "/shared/target".into(),
        name: "Target".into(),
        sub_type,
    }
}

fn array(db: &Database, key: &str) -> Vec<Value> {
    let raw = db.get_setting(key).unwrap().unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn identity_wire_defaults_to_app_and_serializes_the_direct_subtype() {
    let legacy: RendererAppIdentity = serde_json::from_value(json!({
        "path": "/shared/target",
        "name": "Target"
    }))
    .unwrap();
    assert_eq!(legacy.sub_type, RendererDirectSubtype::App);
    assert_eq!(serde_json::to_value(&legacy).unwrap()["subType"], "app");
    assert_eq!(
        serde_json::to_value(identity(RendererDirectSubtype::LocalShortcut)).unwrap()["subType"],
        "local-shortcut"
    );
}

#[test]
fn app_and_local_shortcut_history_and_pins_keep_distinct_subtypes() {
    let db = Database::in_memory().unwrap();
    for (sub_type, now_ms) in [
        (RendererDirectSubtype::App, 10),
        (RendererDirectSubtype::LocalShortcut, 20),
    ] {
        db.apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
            app: identity(sub_type),
            now_ms,
        })
        .unwrap();
        db.apply_renderer_app_state(RendererAppStateMutation::Pin {
            app: identity(sub_type),
        })
        .unwrap();
    }

    let state = db.read_renderer_app_state().unwrap();
    let history =
        serde_json::from_str::<Vec<Value>>(state.values[HISTORY_KEY].as_deref().unwrap()).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["subType"], "local-shortcut");
    assert_eq!(history[1]["subType"], "app");
    let pins =
        serde_json::from_str::<Vec<Value>>(state.values[PINS_KEY].as_deref().unwrap()).unwrap();
    assert_eq!(pins.len(), 2);
    assert_eq!(pins[0]["subType"], "app");
    assert_eq!(pins[1]["subType"], "local-shortcut");

    db.apply_renderer_app_state(RendererAppStateMutation::ReorderPins {
        apps: vec![
            identity(RendererDirectSubtype::LocalShortcut),
            identity(RendererDirectSubtype::App),
        ],
    })
    .unwrap();
    assert_eq!(array(&db, PINS_STORAGE_KEY)[0]["subType"], "local-shortcut");
    assert_eq!(array(&db, PINS_STORAGE_KEY)[1]["subType"], "app");
}

#[test]
fn history_pin_removal_and_clear_preserve_plugin_builtin_and_future_rows() {
    let db = Database::in_memory().unwrap();
    let opaque = vec![
        json!({"path":"/plugin","type":"plugin","featureCode":"run"}),
        json!({"path":"/builtin","type":"builtin","featureCode":"open"}),
        json!({"path":"/future","type":"direct","subType":"future-kind","extra":9007199254740993u64}),
    ];
    let direct_rows = vec![
        json!({"path":"/shared/target","name":"Target","type":"direct","subType":"app"}),
        json!({"path":"/shared/target","name":"Target","type":"direct","subType":"local-shortcut"}),
    ];
    let history = [direct_rows.clone(), opaque.clone()].concat();
    let pins = [direct_rows, opaque.clone()].concat();
    db.set_setting(
        HISTORY_STORAGE_KEY,
        &serde_json::to_string(&history).unwrap(),
    )
    .unwrap();
    db.set_setting(PINS_STORAGE_KEY, &serde_json::to_string(&pins).unwrap())
        .unwrap();

    db.apply_renderer_app_state(RendererAppStateMutation::RemoveHistory {
        path: "/shared/target".into(),
        name: Some("Target".into()),
    })
    .unwrap();
    assert_eq!(array(&db, HISTORY_STORAGE_KEY), opaque);

    db.apply_renderer_app_state(RendererAppStateMutation::Unpin {
        path: "/shared/target".into(),
        name: Some("Target".into()),
    })
    .unwrap();
    assert_eq!(array(&db, PINS_STORAGE_KEY), opaque);

    db.apply_renderer_app_state(RendererAppStateMutation::ClearHistory)
        .unwrap();
    db.apply_renderer_app_state(RendererAppStateMutation::ClearPins)
        .unwrap();
    assert_eq!(array(&db, HISTORY_STORAGE_KEY), opaque);
    assert_eq!(array(&db, PINS_STORAGE_KEY), opaque);
}
