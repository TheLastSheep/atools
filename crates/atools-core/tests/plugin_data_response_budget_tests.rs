//! A write must account for the HTTP envelope before its transaction commits.

use atools_core::db::{Database, PLUGIN_DATA_MAX_RESPONSE_BYTES};
use atools_core::models::{Document, Plugin, PluginManifest};
use serde_json::json;

#[test]
fn bulk_result_below_raw_limit_but_above_enveloped_limit_rolls_back() {
    let db = Database::in_memory().unwrap();
    let manifest: PluginManifest = serde_json::from_value(json!({"name":"a"})).unwrap();
    db.save_plugin(&Plugin {
        id: "a".into(),
        name: "a".into(),
        version: "1".into(),
        path: "/tmp/a".into(),
        enabled: true,
        manifest,
        created_at: "now".into(),
        updated_at: "now".into(),
    })
    .unwrap();
    let mut documents = (0..1000)
        .map(|index| Document {
            id: format!("{index:04}"),
            rev: None,
            data: json!({"value":0}),
        })
        .collect::<Vec<_>>();
    let receipt =
        |doc: &Document| json!({"id":doc.id,"ok":true,"rev":format!("1-{}", "0".repeat(32))});
    let baseline = serde_json::to_vec(&documents.iter().map(receipt).collect::<Vec<_>>())
        .unwrap()
        .len();
    let padding = PLUGIN_DATA_MAX_RESPONSE_BYTES - 16 - baseline;
    for (index, doc) in documents.iter_mut().enumerate() {
        doc.id
            .push_str(&"x".repeat(padding / 1000 + usize::from(index < padding % 1000)));
    }
    let results = documents.iter().map(receipt).collect::<Vec<_>>();
    assert_eq!(
        serde_json::to_vec(&results).unwrap().len(),
        PLUGIN_DATA_MAX_RESPONSE_BYTES - 16
    );
    assert!(
        serde_json::to_vec(&json!({"ok":true,"result":results}))
            .unwrap()
            .len()
            > PLUGIN_DATA_MAX_RESPONSE_BYTES
    );
    assert!(serde_json::to_vec(&documents).unwrap().len() < PLUGIN_DATA_MAX_RESPONSE_BYTES);
    assert!(db.plugin_data_bulk_strict("a", &documents).is_err());
    assert!(db.plugin_data_all("a").unwrap().is_empty());
}
