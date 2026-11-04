#![allow(dead_code, clippy::format_in_format_args)]

use atools_core::{matcher::MediaFile, Database, Plugin};
use serde_json::{json, Value};
use std::sync::Arc;

fn save(db: &Database, features: Value) {
    let plugin = Plugin {
        id: "media".into(),
        name: "media".into(),
        version: "1".into(),
        enabled: true,
        path: "/not-executed".into(),
        created_at: "now".into(),
        updated_at: "now".into(),
        manifest: serde_json::from_value(json!({"name":"media","features":features})).unwrap(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
}
fn file(name: &str, directory: bool) -> MediaFile {
    MediaFile {
        path: format!("/fixture/{name}"),
        name: name.into(),
        is_file: !directory,
        is_directory: directory,
    }
}
fn codes(db: &Database, files: &[MediaFile]) -> Vec<String> {
    db.feature_catalog_snapshot()
        .unwrap()
        .search_file_content(files)
        .unwrap()
        .into_iter()
        .map(|m| m.feature_code)
        .collect()
}

#[test]
fn file_candidate_rules_keep_count_type_extensions_and_sqlite_round_trip() {
    let db = Database::in_memory().unwrap();
    save(
        &db,
        json!([
            {"code":"png", "cmds":[{"type":"files","fileType":"file","extensions":["PNG"],"minLength":2,"maxLength":2}]},
            {"code":"dot", "cmds":[{"type":"files","extensions":[".png"]}]},
            {"code":"directory", "cmds":[{"type":"files","fileType":"directory","extensions":["png"]}]},
            {"code":"any", "cmds":[{"type":"files"}]},
            {"code":"discovery", "cmds":["files", {"type":"over"}, {"type":"img"}]}
        ]),
    );
    assert_eq!(codes(&db, &[]), Vec::<String>::new());
    assert_eq!(
        codes(&db, &[file("A.PNG", false), file("B.png", false)]),
        ["any", "png"]
    );
    assert_eq!(
        codes(&db, &[file("folder.txt", true)]),
        ["any", "directory", "dot"]
    );
    assert_eq!(codes(&db, &[file("one.png", false)]), ["any"]);
    assert_eq!(
        codes(&db, &[file("one.png", false), file("two.txt", false)]),
        ["any"]
    );
    let stored = serde_json::to_value(&db.get_feature("png").unwrap().cmds).unwrap();
    assert_eq!(stored[0]["fileType"], "file");
    assert_eq!(stored[0]["extensions"], json!(["PNG"]));
    assert_eq!(stored[0]["minLength"], Value::Null); // canonical serialized alias is length
    assert_eq!(stored[0]["length"], 2);
    assert_eq!(stored[0]["maxLength"], 2);
}

#[test]
fn file_regex_uses_only_official_literals_with_flags_and_raw_name_substrings() {
    let db = Database::in_memory().unwrap();
    save(
        &db,
        json!([
            {"code":"raw", "cmds":[{"type":"files","match":".png"}]},
            {"code":"raw-regex", "cmds":[{"type":"files","match":".*png"}]},
            {"code":"literal", "cmds":[{"type":"files","match":"/\\.png$/i"}]},
            {"code":"global", "cmds":[{"type":"files","match":"/png/g"}]},
            {"code":"sticky", "cmds":[{"type":"files","match":"/png/y"}]},
            {"code":"invalid", "cmds":[{"type":"files","match":"/[broken/i"}]},
            {"code":"unsupported", "cmds":[{"type":"files","match":"/png/s"}]}
        ]),
    );
    assert_eq!(codes(&db, &[file("A.PNG", false)]), ["literal"]);
    assert_eq!(
        codes(&db, &[file("a.png", false), file("b.png", false)]),
        ["global", "literal", "raw"]
    );
    assert_eq!(
        codes(&db, &[file("png-a", false), file("png-b", false)]),
        ["global", "sticky"]
    );
    assert_eq!(codes(&db, &[file("xxpng", false)]), ["global"]);
    assert!(codes(&db, &[file("x/[broken/i", false)]).contains(&"invalid".into()));
    assert!(codes(&db, &[file("x/png/s", false)]).contains(&"unsupported".into()));
    assert!(codes(&db, &[file("prefix.*png", false)]).contains(&"raw-regex".into()));
}

#[test]
fn images_match_only_image_rules_and_files_do_not_rely_on_path_search_heuristics() {
    let db = Database::in_memory().unwrap();
    save(
        &db,
        json!([
            {"code":"mixed","priority":3,"cmds":["image",{"type":"files"},{"type":"img"}]},
            {"code":"image","cmds":[{"type":"img"}]},
            {"code":"text","cmds":["image",{"type":"over"}]}
        ]),
    );
    let snapshot = db.feature_catalog_snapshot().unwrap();
    let images = snapshot.search_image_content();
    assert_eq!(
        images
            .iter()
            .map(|m| m.feature_code.as_str())
            .collect::<Vec<_>>(),
        ["image", "mixed"]
    );
    assert!(images.iter().all(|m| m.match_type == "img"));
    assert_eq!(codes(&db, &[file("real.txt", false)]), ["mixed"]);
    assert!(snapshot
        .search_text_content("/not-a-real-file")
        .unwrap()
        .iter()
        .all(|m| m.match_type != "files"));
    assert!(Arc::ptr_eq(
        &snapshot,
        &db.feature_catalog_snapshot().unwrap()
    ));
}

#[test]
fn dynamic_file_rule_changes_refresh_cached_constraints_and_disable_removes_candidates() {
    let db = Database::in_memory().unwrap();
    save(&db, json!([]));
    let before = db.feature_catalog_snapshot().unwrap();
    db.plugin_dynamic_features_set("media",&[json!({"code":"dynamic","cmds":[{"type":"files","extensions":["png"],"fileType":"file"}]})]).unwrap();
    let first = db.feature_catalog_snapshot().unwrap();
    assert!(!Arc::ptr_eq(&before, &first));
    assert_eq!(codes(&db, &[file("a.png", false)]), ["dynamic"]);
    db.plugin_dynamic_features_set(
        "media",
        &[json!({"code":"dynamic","cmds":[{"type":"files","extensions":["txt"]}]})],
    )
    .unwrap();
    assert!(codes(&db, &[file("a.png", false)]).is_empty());
    assert_eq!(codes(&db, &[file("a.txt", false)]), ["dynamic"]);
    db.plugin_dynamic_features_remove("media", &["dynamic".into()])
        .unwrap();
    assert!(codes(&db, &[file("a.txt", false)]).is_empty());
    save(
        &db,
        json!([{"code":"disabled","cmds":[{"type":"img"},{"type":"files"}]}]),
    );
    let mut p = db.get_plugin("media").unwrap();
    p.enabled = false;
    db.save_plugin(&p).unwrap();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap()
        .search_image_content()
        .is_empty());
    assert!(codes(&db, &[file("a.txt", false)]).is_empty());
}

#[test]
fn file_input_budget_rejects_entire_payload_without_truncation() {
    use atools_core::matcher::{MAX_MEDIA_FILES, MAX_MEDIA_PATH_BYTES, MAX_MEDIA_PATH_TOTAL_BYTES};
    let db = Database::in_memory().unwrap();
    save(&db, json!([{"code":"any","cmds":[{"type":"files"}]}]));
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert!(snapshot
        .search_file_content(&vec![file("x", false); MAX_MEDIA_FILES + 1])
        .is_err());
    let mut long = file("x", false);
    long.path = format!("/{}", "x".repeat(MAX_MEDIA_PATH_BYTES));
    assert!(snapshot.search_file_content(&[long]).is_err());
    let file = file(&"x".repeat(1000), false);
    assert!(snapshot
        .search_file_content(&vec![file; MAX_MEDIA_PATH_TOTAL_BYTES / 1000 + 1])
        .is_err());
    let mut impossible = crate::file("x", false);
    impossible.is_directory = true;
    assert!(snapshot.search_file_content(&[impossible]).is_err());
}

#[test]
fn selected_official_contract_cases_match_shared_core_rules() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/launcher-media-contract-cases.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let db = Database::in_memory().unwrap();
        save(
            &db,
            json!([{"code":"selected","cmds":[case["command"].clone()]}]),
        );
        let files: Vec<MediaFile> = serde_json::from_value(case["files"].clone()).unwrap();
        assert_eq!(
            !codes(&db, &files).is_empty(),
            case["expected"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn compiled_bank_reservation_stays_inside_existing_index_budget_and_raw_rules_do_not_reserve_it() {
    let db = Database::in_memory().unwrap();
    save(
        &db,
        json!([{"code":"raw","cmds":[{"type":"files","match":"plain-name"}]}]),
    );
    let raw = db.feature_catalog_snapshot().unwrap();
    assert!(raw.index_budget_bytes < 1024 * 1024);
    save(
        &db,
        json!([{"code":"literal","cmds":[{"type":"files","match":"/^plain-name$/i"}]}]),
    );
    let literal = db.feature_catalog_snapshot().unwrap();
    assert!(literal.index_budget_bytes >= 12 * 1024 * 1024);
    assert!(
        literal.index_budget_bytes <= atools_core::feature_catalog::MAX_FEATURE_CATALOG_INDEX_BYTES
    );
    assert!(!Arc::ptr_eq(&raw, &literal));
}

#[test]
fn complete_work_ceiling_accepts_equality_rejects_excess_and_counts_repeated_names_once() {
    let db = Database::in_memory().unwrap();
    let features=(0..1024).map(|i|json!({"code":format!("r-{i}"),"cmds":[{"type":"files","match":format!("/^(?:item|other{i})[0-9]+\\.png$/i")}]})).collect::<Vec<_>>();
    save(&db, json!(features));
    let snapshot = db.feature_catalog_snapshot().unwrap();
    let eight = (0..8)
        .map(|i| file(&format!("item{i}.png"), false))
        .collect::<Vec<_>>();
    assert_eq!(snapshot.search_file_content(&eight).unwrap().len(), 1024);
    let nine = (0..9)
        .map(|i| file(&format!("item{i}.png"), false))
        .collect::<Vec<_>>();
    assert!(snapshot
        .search_file_content(&nine)
        .unwrap_err()
        .to_string()
        .contains("MEDIA_MATCH_WORK_BUDGET"));
    assert_eq!(
        snapshot
            .search_file_content(&vec![file("item1.png", false); 1000])
            .unwrap()
            .len(),
        1024
    );
    let small = Database::in_memory().unwrap();
    save(
        &small,
        json!([{"code":"first","cmds":[{"type":"files","match":"/^.+$/"}]},{"code":"second","cmds":[{"type":"files","match":"/.+/"}]}]),
    );
    let long = (0..32)
        .map(|i| MediaFile {
            path: format!("/{}", format!("{i:02}{}", "x".repeat(8189))),
            name: format!("{i:02}{}", "x".repeat(8190)),
            is_file: true,
            is_directory: false,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        small
            .feature_catalog_snapshot()
            .unwrap()
            .search_file_content(&long)
            .unwrap()
            .len(),
        2
    );
    save(
        &small,
        json!([{"code":"first","cmds":[{"type":"files","match":"/^.+$/"}]},{"code":"second","cmds":[{"type":"files","match":"/.+/"}]},{"code":"third","cmds":[{"type":"files","match":"/^.*/"}]}]),
    );
    assert!(small
        .feature_catalog_snapshot()
        .unwrap()
        .search_file_content(&long)
        .unwrap_err()
        .to_string()
        .contains("MEDIA_MATCH_WORK_BUDGET"));
}
