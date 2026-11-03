use super::*;
use atools_core::Plugin;
use serde_json::json;

fn setup(root: &Path) -> (Database, Plugin) {
    let db = Database::in_memory().unwrap();
    let plugin = Plugin {
        id: "color-helper".into(),
        name: "color-helper".into(),
        version: "1".into(),
        path: root.to_string_lossy().to_string(),
        enabled: true,
        manifest: serde_json::from_value(
            json!({"name":"color-helper","title":"颜色助手","logo":"logo.svg","features":[
                {"code":"color","explain":"颜色","cmds":["Color","颜色"]},
                {"code":"collect","explain":"收藏颜色","cmds":["收藏颜色"]}
            ]}),
        )
        .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    (db, plugin)
}

#[test]
fn launcher_search_and_catalog_share_human_labels_and_keep_activation_codes() {
    let root = tempfile::tempdir().unwrap();
    let (db, plugin) = setup(root.path());
    let listed = catalog(&db, None).unwrap();
    let searched = search(&db, "颜色", None).unwrap();
    for (code, label) in [("color", "颜色"), ("collect", "收藏颜色")] {
        let item = listed.iter().find(|item| item.code == code).unwrap();
        assert_eq!(item.plugin_id, "color-helper");
        assert_eq!(item.plugin_name, "颜色助手");
        assert_eq!(item.label, label);
        assert_eq!(
            searched
                .iter()
                .find(|item| item.code == code)
                .unwrap()
                .label,
            label
        );
        let action =
            crate::commands::activate_feature_inner(&db, code, Some(json!({"original":true})))
                .unwrap();
        assert_eq!(action.feature_code, code);
        assert_eq!(action.plugin_id, plugin.id);
        assert_eq!(action.payload, json!({"original":true}));
    }
}

#[test]
fn warm_icon_projection_does_not_recheck_disk_and_new_snapshot_does() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("logo.svg"), "<svg/>").unwrap();
    let (db, mut plugin) = setup(root.path());
    let first = search(&db, "Color", None).unwrap();
    assert!(first[0].icon.is_some());
    std::fs::remove_file(root.path().join("logo.svg")).unwrap();
    assert_eq!(first[0].icon, search(&db, "Color", None).unwrap()[0].icon);
    plugin.manifest.title = Some("更新后的颜色助手".into());
    db.save_plugin(&plugin).unwrap();
    let next = search(&db, "Color", None).unwrap();
    assert!(next[0].icon.is_none());
    assert_eq!(next[0].plugin_name, "更新后的颜色助手");
}

#[test]
fn icon_cache_distinguishes_resource_roots_even_for_same_snapshot() {
    let temporary = tempfile::tempdir().unwrap();
    let root_a = temporary.path().join("a");
    let root_b = temporary.path().join("b");
    for root in [&root_a, &root_b] {
        std::fs::create_dir_all(root.join("color")).unwrap();
        std::fs::write(root.join("color/logo.svg"), "<svg/>").unwrap();
    }
    let (db, mut plugin) = setup(Path::new("/old/resources/plugins/builtin/color"));
    plugin.path = "/old/resources/plugins/builtin/color".into();
    db.save_plugin(&plugin).unwrap();
    let a = search(&db, "Color", Some(&root_a)).unwrap();
    let b = search(&db, "Color", Some(&root_b)).unwrap();
    assert_ne!(a[0].icon, b[0].icon);
    assert!(a[0].icon.as_ref().unwrap().contains("/a/color/"));
    assert!(b[0].icon.as_ref().unwrap().contains("/b/color/"));
}

#[test]
fn dynamic_explicit_label_equal_to_code_is_shared_by_list_and_activation() {
    let directory = tempfile::tempdir().unwrap();
    let (db, _) = setup(directory.path());
    let declared: Vec<atools_core::Feature> = serde_json::from_value(
        json!([{"code":"MD5","label":"MD5","explain":"摘要说明","cmds":["md5"]}]),
    )
    .unwrap();
    db.index_features("color-helper", &declared).unwrap();
    assert_eq!(search(&db, "md5", None).unwrap()[0].label, "MD5");
    let action = crate::commands::activate_feature_inner(&db, "MD5", None).unwrap();
    assert_eq!(action.feature_code, "MD5");
    assert_eq!(action.feature_label.as_deref(), Some("MD5"));
    assert_eq!(action.feature_label_source, Some("declared"));
}
