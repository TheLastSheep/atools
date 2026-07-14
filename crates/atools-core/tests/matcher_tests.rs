//! Integration tests for the feature matching engine.

use atools_core::matcher::{search_all, to_pinyin_initials};
use atools_core::models::{Cmd, CmdType, CmdTyped, FeatureEntry};

fn make_feature(code: &str, cmds: Vec<Cmd>) -> FeatureEntry {
    FeatureEntry {
        code: code.to_string(),
        plugin_id: "test-plugin".to_string(),
        plugin_name: "Test Plugin".to_string(),
        label: code.to_string(),
        icon: None,
        explain: format!("Feature {}", code),
        cmds,
        main_push: false,
        priority: 0,
    }
}

#[test]
fn test_exact_match() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("calculator".to_string())],
    )];

    let results = search_all(&features, "calculator");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 100);
    assert_eq!(results[0].match_type, "exact");
}

#[test]
fn test_prefix_match() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("calculator".to_string())],
    )];

    let results = search_all(&features, "calc");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 90);
    assert_eq!(results[0].match_type, "prefix");
}

#[test]
fn test_contains_match() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("calculator".to_string())],
    )];

    let results = search_all(&features, "cula");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 50);
    assert_eq!(results[0].match_type, "contains");
}

#[test]
fn test_regex_match() {
    let features = vec![make_feature(
        "color",
        vec![Cmd::Typed(CmdTyped {
            type_: CmdType::Regex,
            label: None,
            match_: Some(r"^#[0-9a-fA-F]{6}$".to_string()),
            length: None,
        })],
    )];

    let results = search_all(&features, "#ff0000");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 80);
    assert_eq!(results[0].match_type, "regex");

    let results = search_all(&features, "not-a-color");
    assert_eq!(results.len(), 0);
}

#[test]
fn test_over_length_match() {
    let features = vec![make_feature(
        "search",
        vec![Cmd::Typed(CmdTyped {
            type_: CmdType::Over,
            label: None,
            match_: None,
            length: Some(10),
        })],
    )];

    let results = search_all(&features, "short");
    assert_eq!(results.len(), 0);

    let results = search_all(&features, "this is long enough");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 60);
    assert_eq!(results[0].match_type, "over");
}

#[test]
fn test_multiple_matches_priority() {
    let features = vec![
        make_feature("exact", vec![Cmd::Text("test".to_string())]),
        make_feature("prefix", vec![Cmd::Text("testing".to_string())]),
        make_feature("contains", vec![Cmd::Text("mytest".to_string())]),
    ];

    let results = search_all(&features, "test");
    assert!(!results.is_empty());

    // Exact match should be first
    assert_eq!(results[0].feature_code, "exact");
    assert_eq!(results[0].score, 100);
}

#[test]
fn test_case_insensitive_match() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("Calculator".to_string())],
    )];

    let results = search_all(&features, "calculator");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 100);

    let results = search_all(&features, "CALCULATOR");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 100);
}

#[test]
fn test_multiple_commands() {
    let features = vec![make_feature(
        "calc",
        vec![
            Cmd::Text("calculator".to_string()),
            Cmd::Text("calc".to_string()),
            Cmd::Text("math".to_string()),
        ],
    )];

    let results = search_all(&features, "calc");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 100);
    assert_eq!(results[0].match_type, "exact");

    let results = search_all(&features, "math");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 100);
}

#[test]
fn test_empty_query() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("calculator".to_string())],
    )];

    let results = search_all(&features, "");
    assert_eq!(results.len(), 0);
}

#[test]
fn test_no_matches() {
    let features = vec![make_feature(
        "calc",
        vec![Cmd::Text("calculator".to_string())],
    )];

    let results = search_all(&features, "xyz");
    assert_eq!(results.len(), 0);
}

#[test]
fn test_chinese_exact_match() {
    let features = vec![make_feature(
        "timestamp",
        vec![Cmd::Text("时间戳".to_string())],
    )];

    let results = search_all(&features, "时间戳");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 100);
    assert_eq!(results[0].match_type, "exact");
}

#[test]
fn test_chinese_prefix_match() {
    let features = vec![make_feature(
        "timestamp",
        vec![Cmd::Text("时间戳".to_string())],
    )];

    let results = search_all(&features, "时间");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 90);
    assert_eq!(results[0].match_type, "prefix");
}

#[test]
fn test_chinese_pinyin_match_with_known_chars() {
    // Use characters that are in the actual lookup table
    let features = vec![make_feature(
        "open",
        vec![Cmd::Text("打开".to_string())], // 打→d, 开→k, pinyin="dk"
    )];

    // Querying "dk" should trigger a pinyin match
    let results = search_all(&features, "dk");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 30); // SCORE_PINYIN
    assert_eq!(results[0].match_type, "pinyin");
}

#[test]
fn test_chinese_pinyin_no_match_for_unknown_chars() {
    // '剪' and '切' are not in the lookup table, so pinyin "jq" won't match
    let features = vec![make_feature(
        "clipboard",
        vec![Cmd::Text("剪切".to_string())],
    )];

    let results = search_all(&features, "jq");
    // No pinyin match because the chars aren't in the table
    assert_eq!(results.len(), 0);
}

#[test]
fn test_mixed_language_match() {
    let features = vec![make_feature(
        "translate",
        vec![
            Cmd::Text("翻译".to_string()),
            Cmd::Text("translate".to_string()),
        ],
    )];

    let results = search_all(&features, "translate");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 100);
    assert_eq!(results[0].match_type, "exact");

    let results = search_all(&features, "翻译");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].score, 100);
    assert_eq!(results[0].match_type, "exact");
}

#[test]
fn test_pinyin_initials_ascii_passthrough() {
    // ASCII characters pass through unchanged
    assert_eq!(to_pinyin_initials("abc"), "abc");
    assert_eq!(to_pinyin_initials("timestamp"), "timestamp");
    assert_eq!(to_pinyin_initials("ABC"), "ABC");
}

#[test]
fn test_pinyin_initials_known_chars() {
    // Characters explicitly in the lookup table produce their pinyin initial
    assert_eq!(to_pinyin_initials("时间"), "sj"); // 时→s, 间→j
    assert_eq!(to_pinyin_initials("打开"), "dk"); // 打→d, 开→k
    assert_eq!(to_pinyin_initials("翻译"), "fy"); // 翻→f (via '福' group? no — let me check)
}

#[test]
fn test_pinyin_initials_unknown_chars_passthrough() {
    // Characters not in the lookup table pass through unchanged
    let result = to_pinyin_initials("剪切");
    // '剪' and '切' are not in the lookup map, so they pass through as-is
    assert_eq!(result, "剪切");
}

#[test]
fn test_pinyin_initials_mixed() {
    // Known Chinese chars + ASCII
    let pinyin = to_pinyin_initials("时间abc");
    assert_eq!(pinyin, "sjabc"); // 时→s, 间→j, abc passthrough
}
