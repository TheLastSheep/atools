use atools_core::matcher::search_all;
use atools_core::models::{Cmd, FeatureEntry};
use std::time::{Duration, Instant};

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
        ],
        main_push: false,
        priority: 0,
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
}
