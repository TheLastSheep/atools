use crate::matcher::{search_all, FeatureSearchIndex};
use crate::models::{Cmd, CmdType, CmdTyped, FeatureEntry};

fn make_feature(code: &str, cmds: Vec<Cmd>, priority: i32) -> FeatureEntry {
    FeatureEntry {
        code: code.to_string(),
        plugin_id: "test-plugin".to_string(),
        plugin_name: "Test Plugin".to_string(),
        label: code.to_string(),
        icon: None,
        explain: format!("Feature {}", code),
        cmds,
        main_push: false,
        priority,
    }
}

#[test]
fn test_search_all_exact_match() {
    let features = vec![
        make_feature("calc", vec![Cmd::Text("calculator".to_string())], 10),
        make_feature("weather", vec![Cmd::Text("weather".to_string())], 5),
    ];

    let matches = search_all(&features, "calculator");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].feature_code, "calc");
    assert_eq!(matches[0].score, 100);
    assert_eq!(matches[0].match_type, "exact");
}

#[test]
fn test_search_all_prefix_match() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("calculator".to_string())],
        10,
    )];

    let matches = search_all(&features, "calc");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].score, 90);
    assert_eq!(matches[0].match_type, "prefix");
}

#[test]
fn test_search_all_contains_match() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("calculator".to_string())],
        10,
    )];

    let matches = search_all(&features, "cula");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].score, 50);
    assert_eq!(matches[0].match_type, "contains");
}

#[test]
fn test_search_all_no_match() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("calculator".to_string())],
        10,
    )];

    let matches = search_all(&features, "xyz");
    assert_eq!(matches.len(), 0);
}

#[test]
fn test_search_all_regex_match_and_js_literal_regex() {
    let features = vec![
        make_feature(
            "color",
            vec![Cmd::Typed(CmdTyped {
                type_: CmdType::Regex,
                label: None,
                match_: Some(r"/^#[0-9a-fA-F]{6}$/".to_string()),
                length: None,
                max_length: None,
                file_type: None,
                extensions: None,
                exclude: None,
            })],
            10,
        ),
        make_feature(
            "github-url",
            vec![Cmd::Typed(CmdTyped {
                type_: CmdType::Regex,
                label: Some("GitHub".to_string()),
                match_: Some(r"/^https:\/\/github\.com/i".to_string()),
                length: None,
                max_length: None,
                file_type: None,
                extensions: None,
                exclude: None,
            })],
            5,
        ),
    ];

    let matches = search_all(&features, "#ff0000");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].score, 80);
    assert_eq!(matches[0].match_type, "regex");

    let url_matches = search_all(&features, "https://github.com/ZToolsCenter/ZTools");
    assert_eq!(url_matches.len(), 1);
    assert_eq!(url_matches[0].feature_code, "github-url");
    assert_eq!(url_matches[0].score, 80);
}

#[test]
fn test_search_all_over_match() {
    let features = vec![make_feature(
        "long-query",
        vec![Cmd::Typed(CmdTyped {
            type_: CmdType::Over,
            label: None,
            match_: None,
            length: Some(10),
            max_length: None,
            file_type: None,
            extensions: None,
            exclude: None,
        })],
        10,
    )];

    let matches = search_all(&features, "short");
    assert_eq!(matches.len(), 0);

    let matches = search_all(&features, "this is a very long query");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].score, 60);
    assert_eq!(matches[0].match_type, "over");
}

#[test]
fn test_search_all_priority_tie_breaker() {
    let features = vec![
        make_feature("low-prio", vec![Cmd::Text("json".to_string())], 1),
        make_feature("high-prio", vec![Cmd::Text("json".to_string())], 50),
    ];

    let matches = search_all(&features, "json");
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0].feature_code, "high-prio");
    assert_eq!(matches[1].feature_code, "low-prio");
}

#[test]
fn test_feature_search_index_matches_search_all() {
    let features = vec![
        make_feature("clipboard", vec![Cmd::Text("剪贴板".to_string())], 20),
        make_feature("calc", vec![Cmd::Text("calculator".to_string())], 10),
    ];
    let index = FeatureSearchIndex::build(&features);
    let direct = search_all(&features, "jiantie");
    let indexed = index.search("jiantie");
    assert_eq!(direct.len(), 1);
    assert_eq!(indexed.len(), 1);
    assert_eq!(direct[0].feature_code, indexed[0].feature_code);
}

#[test]
fn test_search_all_empty_query() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("calculator".to_string())],
        10,
    )];

    let matches = search_all(&features, "");
    assert_eq!(matches.len(), 0);
}

#[test]
fn generic_low_level_regex_api_keeps_raw_and_extended_flags_outside_typed_contexts() {
    assert!(super::compile_ztools_regex("^raw$")
        .unwrap()
        .is_match("raw"));
    assert!(super::compile_ztools_regex("/a.b/s")
        .unwrap()
        .is_match("a\nb"));
    assert!(super::compile_ztools_regex("/a b/x")
        .unwrap()
        .is_match("ab"));
}
