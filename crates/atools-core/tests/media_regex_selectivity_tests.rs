use atools_core::{matcher::MediaFile, Database, Plugin};
use serde_json::{json, Value};

fn save(db: &Database, features: Value) {
    let plugin = Plugin {
        id: "selective-media".into(),
        name: "selective-media".into(),
        version: "1".into(),
        enabled: true,
        path: "/not-executed".into(),
        created_at: "now".into(),
        updated_at: "now".into(),
        manifest: serde_json::from_value(json!({"name":"selective-media","features":features}))
            .unwrap(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
}

fn file(name: &str, is_directory: bool) -> MediaFile {
    MediaFile {
        path: format!("/fixture/{name}"),
        name: name.into(),
        is_file: !is_directory,
        is_directory,
    }
}

fn codes(db: &Database, files: &[MediaFile]) -> Vec<String> {
    db.feature_catalog_snapshot()
        .unwrap()
        .search_file_content(files)
        .unwrap()
        .into_iter()
        .map(|matched| matched.feature_code)
        .collect()
}

fn regex_feature(code: String, expression: String) -> Value {
    json!({
        "code": code,
        "cmds": [{"type":"files", "match":format!("/{expression}/")}]
    })
}

fn selective_bank(count: usize) -> Value {
    let mut features = Vec::with_capacity(count);
    features.push(regex_feature("asset-00".into(), r"^asset-00\.txt$".into()));
    features.push(regex_feature(
        "asset-00-or-01".into(),
        r"^asset-0[01]\.txt$".into(),
    ));
    for index in 2..count {
        features.push(regex_feature(
            format!("other-{index:02}"),
            format!(r"^other-{index:02}\.txt$"),
        ));
    }
    Value::Array(features)
}

#[test]
fn small_and_set_banks_keep_per_pattern_selectivity_and_all_file_intersection() {
    for count in [8, 9] {
        let db = Database::in_memory().unwrap();
        save(&db, selective_bank(count));

        assert_eq!(
            codes(&db, &[file("asset-00.txt", false)]),
            ["asset-00", "asset-00-or-01"]
        );
        assert!(codes(&db, &[file("missing.txt", false)]).is_empty());
        assert_eq!(
            codes(
                &db,
                &[file("asset-00.txt", false), file("asset-01.txt", false)]
            ),
            ["asset-00-or-01"]
        );
    }
}

#[test]
fn large_bank_does_not_treat_the_total_pattern_count_as_the_match_count() {
    let db = Database::in_memory().unwrap();
    let features = (0..1200)
        .map(|index| {
            let expression = if index == 0 {
                r"^target\.dat$".to_owned()
            } else {
                format!(r"^unrelated-{index:04}\.dat$")
            };
            regex_feature(format!("rule-{index:04}"), expression)
        })
        .collect();
    save(&db, Value::Array(features));

    assert_eq!(codes(&db, &[file("target.dat", false)]), ["rule-0000"]);
    assert!(codes(&db, &[file("no-rule-matches.dat", false)]).is_empty());
}

#[test]
fn media_metadata_case_flags_and_input_payload_order_remain_unchanged() {
    let db = Database::in_memory().unwrap();
    save(
        &db,
        json!([
            {"code":"case-insensitive-png", "cmds":[{"type":"files","fileType":"file","extensions":["PNG"],"match":"/^photo\\.png$/i"}]},
            {"code":"directory-photo", "cmds":[{"type":"files","fileType":"directory","match":"/^photo\\.png$/i"}]}
        ]),
    );

    let files = [file("photo.PNG", false), file("photo.png", false)];
    let original = files.clone();
    assert_eq!(codes(&db, &files), ["case-insensitive-png"]);
    assert_eq!(files, original);
    assert_eq!(codes(&db, &[file("photo.png", true)]), ["directory-photo"]);
}
