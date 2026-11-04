#![allow(dead_code, clippy::cloned_ref_to_slice_refs)]

use atools_core::{matcher::search_all, Cmd, Database, FeatureEntry, FeatureSearchIndex, Plugin};
use serde_json::{json, Value};

fn feature(command: Value) -> FeatureEntry {
    FeatureEntry {
        code: "fixture-rule".into(),
        plugin_id: "fixture-plugin".into(),
        plugin_name: String::new(),
        label: String::new(),
        icon: None,
        explain: String::new(),
        cmds: vec![serde_json::from_value(command).unwrap()],
        main_push: false,
        priority: 0,
    }
}

#[test]
fn hand_authored_official_typed_text_contract_matches_both_contexts() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/launcher-typed-text-contract-cases.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in fixture["cases"].as_array().unwrap() {
        let entry = feature(case["command"].clone());
        let index = FeatureSearchIndex::build(&[entry.clone()]);
        let text = case["text"].as_str().unwrap();
        for (mode, actual) in [
            ("ordinary", !index.search(text).is_empty()),
            (
                "fixedText",
                !index.search_text_content(text).unwrap().is_empty(),
            ),
            ("ordinary", !search_all(&[entry.clone()], text).is_empty()),
        ] {
            if actual != case[mode].as_bool().unwrap() {
                failures.push(format!("{} {mode}: got {actual}", case["name"]));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn exclude_is_preserved_in_static_and_dynamic_persistence_and_snapshot_invalidation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("typed.db");
    let db = Database::open(&path).unwrap();
    let mut plugin: Plugin = serde_json::from_value(json!({
        "id":"typed","name":"typed","version":"1","path":"/unused/typed","enabled":true,
        "manifest":{"name":"typed","features":[{"code":"static","cmds":[{"type":"over","exclude":"/secret/i"}]}]},
        "created_at":"now","updated_at":"now"
    })).unwrap();
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    let original = db.feature_catalog_snapshot().unwrap();
    let stored =
        serde_json::to_value(&original.find("typed", "static").unwrap().feature.cmds[0]).unwrap();
    assert_eq!(stored["exclude"], "/secret/i");
    assert!(original.search("secret").is_empty());
    assert_eq!(original.search("SECRET").len(), 1);
    assert_eq!(original.search_text_content("secret").unwrap().len(), 1);
    db.plugin_dynamic_features_set(
        "typed",
        &[json!({"code":"dynamic","cmds":[{"type":"over","exclude":"/private/"}]})],
    )
    .unwrap();
    let dynamic = db.feature_catalog_snapshot().unwrap();
    assert!(!std::sync::Arc::ptr_eq(&original, &dynamic));
    assert!(!dynamic
        .search("private")
        .iter()
        .any(|m| m.feature_code == "dynamic"));
    db.plugin_dynamic_features_set(
        "typed",
        &[json!({"code":"dynamic","cmds":[{"type":"over","exclude":"/public/"}]})],
    )
    .unwrap();
    let updated = db.feature_catalog_snapshot().unwrap();
    assert!(!std::sync::Arc::ptr_eq(&dynamic, &updated));
    assert!(updated
        .search("private")
        .iter()
        .any(|m| m.feature_code == "dynamic"));
    assert!(!updated
        .search("public")
        .iter()
        .any(|m| m.feature_code == "dynamic"));
    drop(db);
    let db = Database::open(&path).unwrap();
    let reopened = db.feature_catalog_snapshot().unwrap();
    let stored =
        serde_json::to_value(&reopened.find("typed", "dynamic").unwrap().feature.cmds[0]).unwrap();
    assert_eq!(stored["exclude"], "/public/");
    assert!(!reopened
        .search("public")
        .iter()
        .any(|m| m.feature_code == "dynamic"));
    db.plugin_dynamic_features_remove("typed", &["dynamic".into()])
        .unwrap();
    let removed = db.feature_catalog_snapshot().unwrap();
    assert!(!std::sync::Arc::ptr_eq(&reopened, &removed));
    assert!(removed.find("typed", "dynamic").is_none());
    plugin.enabled = false;
    db.save_plugin(&plugin).unwrap();
    assert!(db.feature_catalog_snapshot().unwrap().entries().is_empty());
    plugin.enabled = true;
    db.save_plugin(&plugin).unwrap();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap()
        .search("secret")
        .is_empty());
}

#[test]
fn ordinary_text_never_infers_media_from_a_path_or_suffix() {
    let entries = [
        feature(json!({"type":"files"})),
        FeatureEntry {
            code: "image".into(),
            ..feature(json!({"type":"img"}))
        },
        FeatureEntry {
            code: "normal-command".into(),
            cmds: vec![Cmd::Text("/tmp/a.png".into())],
            ..feature(json!({"type":"img"}))
        },
    ];
    let index = FeatureSearchIndex::build(&entries);
    for query in [
        "/tmp/a.png",
        "/tmp/dir",
        "file:///tmp/a.png",
        "https://example.test/a.jpg",
    ] {
        let actual = index.search(query);
        assert!(
            actual.iter().all(|m| m.feature_code == "normal-command"),
            "{query}: {actual:?}"
        );
        assert_eq!(actual, search_all(&entries, query));
    }
    assert_eq!(index.search("/tmp/a.png")[0].match_type, "exact");
    assert_eq!(index.search_image_content().len(), 1);
    let files = [atools_core::matcher::MediaFile {
        path: "/tmp/a.png".into(),
        name: "a.png".into(),
        is_file: true,
        is_directory: false,
    }];
    assert_eq!(index.search_file_content(&files).unwrap().len(), 1);
}

#[test]
fn mode_specific_bank_results_never_pollute_each_other_or_retain_global_sticky_state() {
    let entries = [
        FeatureEntry {
            code: "case".into(),
            ..feature(json!({"type":"regex","match":"/^x$/i"}))
        },
        FeatureEntry {
            code: "global".into(),
            ..feature(json!({"type":"regex","match":"/x/g"}))
        },
        FeatureEntry {
            code: "sticky".into(),
            ..feature(json!({"type":"regex","match":"/x/y"}))
        },
    ];
    let index = std::sync::Arc::new(FeatureSearchIndex::try_build(&entries).unwrap());
    let workers = (0..4)
        .map(|_| {
            let index = index.clone();
            std::thread::spawn(move || {
                for _ in 0..30 {
                    for (query, fixed, expected) in [
                        ("X", false, vec![]),
                        ("X", true, vec!["case"]),
                        ("ax", true, vec!["global"]),
                        ("x", true, vec!["case", "global", "sticky"]),
                        ("ax", false, vec!["global", "sticky"]),
                    ] {
                        let result = if fixed {
                            index.search_text_content(query)
                        } else {
                            index.search_checked(query)
                        };
                        match result {
                            Ok(actual) => assert_eq!(
                                actual
                                    .iter()
                                    .map(|m| m.feature_code.as_str())
                                    .collect::<Vec<_>>(),
                                expected
                            ),
                            Err(error) => {
                                assert!(error.to_string().contains("TYPED_TEXT_SEARCH_BUSY"))
                            }
                        }
                    }
                }
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(index.search_text_content("x").unwrap().len(), 3);
    assert!(index.search_checked("X").unwrap().is_empty());
}

#[test]
fn program_and_query_budget_failures_are_visible_and_never_return_partial_candidates() {
    let too_complex = feature(json!({"type":"regex","match":"/a{10000000}/"}));
    let error = FeatureSearchIndex::try_build(&[too_complex])
        .unwrap_err()
        .to_string();
    assert!(error.contains("TYPED_TEXT_REGEX_COMPILE_BUDGET"));
    let mut entries = (0..1200)
        .map(|i| FeatureEntry {
            code: format!("f{i}"),
            ..feature(json!({"type":"regex","match":format!("/value-{i}$/")}))
        })
        .collect::<Vec<_>>();
    entries.push(FeatureEntry {
        code: "ordinary-keyword".into(),
        cmds: vec![Cmd::Text("q".repeat(30000))],
        ..feature(json!({"type":"img"}))
    });
    let index = FeatureSearchIndex::try_build(&entries).unwrap();
    for failure in [
        index.search_checked(&"q".repeat(30000)),
        index.search_text_content(&"q".repeat(30000)),
    ] {
        let error = failure.unwrap_err().to_string();
        assert!(error.contains("TYPED_TEXT_MATCH_WORK_BUDGET"));
        assert!(!error.contains(&"q".repeat(64)));
    }
    assert_eq!(index.search_checked("value-1199").unwrap().len(), 1);
    assert_eq!(index.search_text_content("value-1199").unwrap().len(), 1);
}

#[test]
fn text_and_media_program_allowances_share_existing_thirty_two_mib_catalog_budget() {
    let db = Database::in_memory().unwrap();
    let plugin: Plugin = serde_json::from_value(json!({
        "id":"budget","name":"budget","version":"1","path":"/unused","enabled":true,
        "manifest":{"name":"budget","features":[
            {"code":"text","cmds":[{"type":"regex","match":"/small/"}]},
            {"code":"files","cmds":[{"type":"files","match":"/small/"}]}
        ]},"created_at":"now","updated_at":"now"
    }))
    .unwrap();
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert!(snapshot.index_budget_bytes >= 24 * 1024 * 1024);
    assert!(
        snapshot.index_budget_bytes
            <= atools_core::feature_catalog::MAX_FEATURE_CATALOG_INDEX_BYTES
    );
    let mut huge = plugin.manifest.features.clone();
    huge[0].cmds = vec![serde_json::from_value(
        json!({"type":"over","exclude":format!("/{} /","a".repeat(600000))}),
    )
    .unwrap()];
    assert!(db
        .index_features("budget", &huge)
        .unwrap_err()
        .to_string()
        .contains("32 MiB"));
    // Rejected writes do not publish or invalidate the previous working generation.
    assert!(std::sync::Arc::ptr_eq(
        &snapshot,
        &db.feature_catalog_snapshot().unwrap()
    ));
}

#[test]
fn ordinary_byte_limit_is_independent_of_regex_rules_and_counts_utf8_bytes() {
    for command in [
        json!("local"),
        json!({"type":"over","maxLength":262144}),
        json!({"type":"regex","match":"/x/"}),
    ] {
        let mut rule = feature(json!({"type":"img"}));
        rule.cmds = vec![serde_json::from_value(command).unwrap()];
        let index = FeatureSearchIndex::try_build(&[rule]).unwrap();
        assert!(index.search_checked(&"x".repeat(262144)).is_ok());
        assert!(index.search_text_content(&"x".repeat(262144)).is_ok());
        for value in [
            "x".repeat(262145),
            format!("PRIVATE_FIXTURE{}", "😀".repeat(65536)),
        ] {
            for result in [
                index.search_checked(&value),
                index.search_text_content(&value),
            ] {
                let error = result.unwrap_err().to_string();
                assert!(error.contains("TEXT_INPUT_BUDGET") && error.contains("262144"));
                assert!(!error.contains("PRIVATE_FIXTURE"));
            }
        }
    }
}
