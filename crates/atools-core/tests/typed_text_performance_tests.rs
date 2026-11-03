use atools_core::{matcher::MAX_TYPED_TEXT_REGEX_WORK, Cmd, FeatureEntry, FeatureSearchIndex};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[path = "support/query_cpu.rs"]
mod query_cpu;

fn entry(code: String, command: Value) -> FeatureEntry {
    FeatureEntry {
        code,
        plugin_id: "text-benchmark".into(),
        plugin_name: String::new(),
        label: String::new(),
        icon: None,
        explain: String::new(),
        cmds: vec![serde_json::from_value::<Cmd>(command).unwrap()],
        main_push: false,
        priority: 0,
    }
}
fn samples(
    case: &str,
    features: &[FeatureEntry],
    query: &str,
    fixed: bool,
    expected: Option<usize>,
) -> Vec<u128> {
    let now = Instant::now();
    let index = FeatureSearchIndex::try_build(features).unwrap();
    eprintln!(
        "typedtext_build case={case} features={} elapsed_ns={}",
        features.len(),
        now.elapsed().as_nanos()
    );
    let mut over = Vec::new();
    for sample in 0..4 {
        let cpu_start = query_cpu::start_ns();
        let now = Instant::now();
        let result = if fixed {
            index.search_text_content(query)
        } else {
            index.search_checked(query)
        };
        let elapsed = now.elapsed();
        let cpu_elapsed = query_cpu::elapsed_ns(cpu_start);
        let (count, error) = match result {
            Ok(results) => (results.len(), None),
            Err(error) => (0, Some(error.to_string())),
        };
        eprintln!("typedtext_query case={case} fixed={fixed} phase={} sample={sample} bytes={} results={count} error={error:?} elapsed_ns={} thread_cpu_ns={} budget_ns=25000000",if sample==0 {"first"} else {"warm"},query.len(),elapsed.as_nanos(),query_cpu::display(cpu_elapsed));
        if let Some(expected) = expected {
            assert_eq!(count, expected, "{case}: {error:?}");
            assert!(error.is_none());
        } else {
            assert!(error
                .as_deref()
                .is_some_and(|error| error.contains("TYPED_TEXT_MATCH_WORK_BUDGET")));
        }
        if elapsed > Duration::from_millis(25) {
            over.push(elapsed.as_nanos());
        }
    }
    over
}

#[test]
fn twelve_hundred_distinct_rules_and_ecosystem_long_text_keep_complete_query_budget() {
    let mut over = Vec::new();
    for shape in ["literal", "leading_class", "wildcard", "overlap"] {
        let features = (0..1200)
            .map(|i| {
                entry(
                    format!("f{i}"),
                    json!({"type":"regex","match":match shape {
                        "literal"=>format!("/value-{i}$/"),
                        "leading_class"=>format!("/[a-z]{{1,4}}value-{i}[a-z0-9]*/"),
                        "wildcard"=>format!("/.*value-{i}[a-z0-9]*/"),
                        _=>format!("/[a-z]{{1,4}}a{{{}}}value-{i}/",i%5+1)
                    }}),
                )
            })
            .collect::<Vec<_>>();
        let query = format!("{}value-1199", "a".repeat(6980));
        for fixed in [false, true] {
            over.extend(samples(
                &format!("1200-{shape}"),
                &features,
                &query,
                fixed,
                Some(if shape == "literal" { 1 } else { 4 }),
            ));
        }
        let excessive = "a".repeat(MAX_TYPED_TEXT_REGEX_WORK / 1200 + 1);
        over.extend(samples(
            &format!("1200-{shape}-rejection"),
            &features,
            &excessive,
            true,
            None,
        ));
    }
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/launcher-typed-text-ecosystem-rules.json"
    ))
    .unwrap();
    let features = fixture["commands"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, c)| entry(format!("ecosystem-{i}"), c.clone()))
        .collect::<Vec<_>>();
    for shape in ["ascii", "json", "unicode"] {
        for bytes in [16, 1024, 262144] {
            let query = match shape {
                "ascii" => "x".repeat(bytes),
                "json" => format!("{{\"fixture\":\"{}\"}}", "x".repeat(bytes - 14)),
                _ => "😀".repeat(bytes / 4),
            };
            // Expected cardinality is independently established by the first unmeasured
            // index solely to detect query truncation/nondeterminism, not JS compatibility.
            let index = FeatureSearchIndex::try_build(&features).unwrap();
            let expected = index.search_text_content(&query).unwrap().len();
            over.extend(samples(
                &format!("ecosystem-{shape}-{bytes}"),
                &features,
                &query,
                true,
                Some(expected),
            ));
        }
    }
    assert!(
        over.is_empty(),
        "all over-budget samples retained above: {over:?}"
    );
}
