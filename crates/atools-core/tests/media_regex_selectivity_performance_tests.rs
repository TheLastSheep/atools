use atools_core::{matcher::MediaFile, Database, Plugin};
use serde_json::json;
use std::time::{Duration, Instant};

#[path = "support/query_cpu.rs"]
mod query_cpu;

const QUERY_BUDGET: Duration = Duration::from_millis(25);
const RULE_LIMIT: usize = 1200;

#[derive(Clone, Copy)]
struct SelectivityCase {
    name: &'static str,
    rule_count: usize,
    names: &'static [&'static str],
    common_expression: &'static str,
    expected_code: Option<&'static str>,
}

fn cases() -> [SelectivityCase; 4] {
    [
        SelectivityCase {
            name: "unique1200_one_hit",
            rule_count: RULE_LIMIT,
            names: &["target.dat"],
            common_expression: r"^target\.dat$",
            expected_code: Some("rule-0000"),
        },
        SelectivityCase {
            name: "unique1200_zero_hit",
            rule_count: RULE_LIMIT,
            names: &["no-rule-matches.dat"],
            common_expression: r"^unused\.dat$",
            expected_code: None,
        },
        SelectivityCase {
            name: "unique1200_two_name_intersection",
            rule_count: RULE_LIMIT,
            names: &["pair-left.bin", "pair-right.bin"],
            common_expression: r"^pair-(?:left|right)\.bin$",
            expected_code: Some("rule-0000"),
        },
        SelectivityCase {
            name: "boundary8192_one_common_hit",
            rule_count: 1024,
            names: &[
                "boundary-0.bin",
                "boundary-1.bin",
                "boundary-2.bin",
                "boundary-3.bin",
                "boundary-4.bin",
                "boundary-5.bin",
                "boundary-6.bin",
                "boundary-7.bin",
            ],
            common_expression: r"^boundary-[0-7]\.bin$",
            expected_code: Some("rule-0000"),
        },
    ]
}

fn fixture(case: SelectivityCase) -> (Database, Vec<MediaFile>) {
    let db = Database::in_memory().expect("in-memory fixture database");
    let features = (0..case.rule_count)
        .map(|index| {
            let expression = if index == 0 {
                case.common_expression.to_owned()
            } else {
                format!(r"^unmatched-{index:04}\.fixture$")
            };
            json!({
                "code": format!("rule-{index:04}"),
                "cmds": [{"type":"files", "match":format!("/{expression}/")}]
            })
        })
        .collect::<Vec<_>>();
    let plugin = Plugin {
        id: "media-selectivity-perf".into(),
        name: "media-selectivity-perf".into(),
        version: "1".into(),
        enabled: true,
        path: "/not-executed".into(),
        created_at: "now".into(),
        updated_at: "now".into(),
        manifest: serde_json::from_value(
            json!({"name":"media-selectivity-perf","features":features}),
        )
        .expect("valid fixture manifest"),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .expect("save fixture rules");
    let files = case
        .names
        .iter()
        .map(|name| MediaFile {
            path: format!("/fixture/{name}"),
            name: (*name).into(),
            is_file: true,
            is_directory: false,
        })
        .collect();
    (db, files)
}

fn assert_exact_result(
    result: atools_core::Result<Vec<atools_core::matcher::MatchResult>>,
    expected: Option<&str>,
) -> usize {
    let results = result.expect("within-budget media query");
    let codes = results
        .iter()
        .map(|matched| matched.feature_code.as_str())
        .collect::<Vec<_>>();
    match expected {
        Some(code) => assert_eq!(codes, [code]),
        None => assert!(codes.is_empty(), "zero-hit case returned {codes:?}"),
    }
    results.len()
}

/// Run explicitly in a serial benchmark window with `--ignored`; building the index is excluded.
#[test]
#[ignore = "performance samples must run in a serialized matcher benchmark window"]
fn heterogeneous_regex_selectivity_stays_under_25ms_for_every_sample() {
    let mut over_budget = Vec::new();
    for case in cases() {
        let (db, files) = fixture(case);
        let build_started = Instant::now();
        let snapshot = db
            .feature_catalog_snapshot()
            .expect("build isolated feature index");
        eprintln!(
            "media_selectivity_index case={} elapsed_ns={} index_allowance_bytes={}",
            case.name,
            build_started.elapsed().as_nanos(),
            snapshot.index_budget_bytes
        );
        assert!(snapshot.index_budget_bytes <= 32 * 1024 * 1024);
        for sample in 0..4 {
            let cpu_start = query_cpu::start_ns();
            let started = Instant::now();
            let result = snapshot.search_file_content(&files);
            let elapsed = started.elapsed();
            let cpu_elapsed = query_cpu::elapsed_ns(cpu_start);
            let result_count = assert_exact_result(result, case.expected_code);
            eprintln!(
                "media_selectivity case={} phase={} sample={} results={} elapsed_ns={} thread_cpu_ns={} budget_ns={}",
                case.name,
                if sample == 0 { "first" } else { "warm" },
                sample,
                result_count,
                elapsed.as_nanos(),
                query_cpu::display(cpu_elapsed),
                QUERY_BUDGET.as_nanos()
            );
            if elapsed > QUERY_BUDGET {
                over_budget.push((case.name, sample, elapsed));
            }
        }
    }
    assert!(
        over_budget.is_empty(),
        "retain all selective samples under the unchanged 25 ms query budget: {over_budget:?}"
    );
}
