use atools_core::matcher::{search_all, FeatureSearchIndex};
use atools_core::models::{Cmd, CmdType, CmdTyped, FeatureEntry};
use std::time::{Duration, Instant};

#[path = "support/query_cpu.rs"]
mod query_cpu;

fn make_feature(index: usize) -> FeatureEntry {
    FeatureEntry {
        code: format!("feature-{index}"),
        plugin_id: "benchmark-plugin".to_string(),
        plugin_name: "Benchmark Plugin".to_string(),
        label: format!("Benchmark Feature {index}"),
        icon: None,
        explain: format!("Synthetic benchmark feature {index}"),
        cmds: vec![
            Cmd::Text(format!("cmd{index}")),
            Cmd::Text(format!("project workspace {index}")),
            Cmd::Text(format!("剪贴板工具{index}")),
            Cmd::Typed(CmdTyped {
                type_: CmdType::Regex,
                label: Some("Hex Color".to_string()),
                match_: Some(r"/^#[0-9a-f]{6}$/i".to_string()),
                length: None,
                max_length: None,
                file_type: None,
                extensions: None,
                exclude: None,
            }),
        ],
        main_push: false,
        priority: (index % 10) as i32,
    }
}

#[test]
fn search_all_large_feature_set_stays_within_interactive_budget() {
    let features = (0..5_000).map(make_feature).collect::<Vec<_>>();

    let started = Instant::now();
    let results = search_all(&features, "cmd4999");
    let elapsed = started.elapsed();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].feature_code, "feature-4999");
    assert!(
        elapsed <= Duration::from_millis(500),
        "search_all took {:?} for 5000 features",
        elapsed
    );

    // Pre-computed FeatureSearchIndex benchmark
    let index = FeatureSearchIndex::build(&features);
    let idx_started = Instant::now();
    let idx_results = index.search("jtbgj4999");
    let idx_elapsed = idx_started.elapsed();

    assert_eq!(idx_results.len(), 1);
    assert_eq!(idx_results[0].feature_code, "feature-4999");
    assert!(
        idx_elapsed <= Duration::from_millis(50),
        "FeatureSearchIndex::search took {:?} for 5000 features",
        idx_elapsed
    );
}

#[test]
fn indexed_1200_features_keep_each_interactive_query_within_25ms() {
    const FEATURE_COUNT: usize = 1_200;
    const BUDGET: Duration = Duration::from_millis(25);
    const WARM_SAMPLES: usize = 3;

    let features = (0..FEATURE_COUNT).map(make_feature).collect::<Vec<_>>();
    let expected_codes = features
        .iter()
        .map(|feature| feature.code.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let cases = [
        ("exact_ascii", "cmd1199", "exact", 100, false),
        ("chinese", "剪贴板工具1199", "exact", 100, false),
        ("pinyin_initials", "jtbgj1199", "pinyin", 30, false),
        ("pinyin_full", "jiantiebangongju1199", "pinyin", 30, false),
        ("wide_prefix", "project workspace ", "prefix", 90, true),
    ];
    let mut over_budget = Vec::new();

    for (case, query, match_type, score, wide) in cases {
        // Every case gets a fresh index; build-time regex/pinyin preparation is excluded.
        // "first" is its first search, not process cold-start. Three "warm" searches
        // reuse that same index after the measured first search; none is discarded.
        let index = FeatureSearchIndex::build(&features);
        for sample in 0..=WARM_SAMPLES {
            let cpu_start = query_cpu::start_ns();
            let started = Instant::now();
            let results = index.search(query);
            let elapsed = started.elapsed();
            let cpu_elapsed = query_cpu::elapsed_ns(cpu_start);

            let phase = if sample == 0 { "first" } else { "warm" };
            eprintln!(
                "matcher1200 case={case} phase={phase} sample={sample} results={} elapsed_ns={} thread_cpu_ns={} budget_ns={}",
                results.len(), elapsed.as_nanos(), query_cpu::display(cpu_elapsed), BUDGET.as_nanos()
            );
            // Keep all raw samples even after a failure; no over-budget sample is discarded.
            if elapsed > BUDGET {
                over_budget.push((case, phase, sample, elapsed));
            }
            assert_eq!(results.len(), if wide { FEATURE_COUNT } else { 1 });
            assert!(results.iter().all(|result| {
                result.plugin_id == "benchmark-plugin"
                    && result.match_type == match_type
                    && result.score == score
            }));
            if wide {
                let actual_codes = results
                    .iter()
                    .map(|result| result.feature_code.as_str())
                    .collect::<std::collections::BTreeSet<_>>();
                assert_eq!(actual_codes, expected_codes);
            } else {
                assert_eq!(results[0].feature_code, "feature-1199");
            }
        }
    }
    assert!(
        over_budget.is_empty(),
        "Every 1200-feature query must finish within 25ms; over-budget samples: {over_budget:?}"
    );
}
