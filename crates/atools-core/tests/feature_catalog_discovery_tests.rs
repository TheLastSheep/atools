use atools_core::{
    matcher::{search_all, SCORE_CONTAINS, SCORE_EXACT, SCORE_REGEX},
    Database, Plugin,
};
use serde_json::json;

#[test]
fn human_feature_and_plugin_names_are_discoverable_without_rewriting_raw_rules() {
    let db = Database::in_memory().unwrap();
    let plugin = Plugin {
        id: "identity".into(),
        name: "machine-package".into(),
        version: "1".into(),
        path: "/unused".into(),
        enabled: true,
        manifest: serde_json::from_value(
            json!({"name":"machine-package","title":"颜色助手","features":[
                {"code":"opaque","label":"人类名称","cmds":["alien-command"]},
                {"code":"improved","label":"Human","cmds":["prefix-Human-suffix"]},
                {"code":"regex","label":"Human","cmds":[{"type":"regex","match":"/Human/"}]},
                {"code":"tie","label":"Same","cmds":[{"type":"regex","match":"/Same/"},"Same"]},
                {"code":"same","label":"颜色助手","cmds":["颜色助手","颜色助手"]}
            ]}),
        )
        .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    let raw = db.all_features().unwrap();
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert!(search_all(&raw, "人类名称").is_empty());
    assert_eq!(snapshot.search("人类名称")[0].feature_code, "opaque");
    assert_eq!(snapshot.search("renleimingcheng")[0].feature_code, "opaque");
    assert_eq!(snapshot.search("rlmc")[0].feature_code, "opaque");
    let discovered = snapshot.search("颜色助手");
    assert_eq!(discovered.len(), 5);
    assert!(discovered.iter().all(|item| item.score == SCORE_EXACT));
    assert_eq!(snapshot.search("yansezhushou").len(), 5);
    assert_eq!(
        search_all(&raw, "Human")
            .iter()
            .find(|item| item.feature_code == "improved")
            .unwrap()
            .score,
        SCORE_CONTAINS
    );
    assert_eq!(
        search_all(&raw, "Human")
            .iter()
            .find(|item| item.feature_code == "regex")
            .unwrap()
            .score,
        SCORE_REGEX
    );
    for code in ["improved", "regex"] {
        assert_eq!(
            snapshot
                .search("Human")
                .iter()
                .find(|item| item.feature_code == code)
                .unwrap()
                .score,
            SCORE_EXACT
        );
    }
    // Strong original command matches and ties retain exact scores and types.
    for query in ["alien-command", "Same", "prefix-Human-suffix"] {
        for original in search_all(&raw, query) {
            assert_eq!(
                snapshot
                    .search(query)
                    .iter()
                    .find(|item| item.feature_code == original.feature_code),
                Some(&original)
            );
        }
    }
    let identities = discovered
        .iter()
        .map(|item| (&item.plugin_id, &item.feature_code))
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(identities.len(), discovered.len());
    assert_eq!(db.get_feature("opaque").unwrap().label, "人类名称");
    assert_eq!(db.get_feature("opaque").unwrap().code, "opaque");
}
