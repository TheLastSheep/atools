use atools_core::{Database, Plugin};
use serde_json::json;
use std::time::{Duration, Instant};

#[path = "support/query_cpu.rs"]
mod query_cpu;

#[test]
fn cached_1200_feature_text_content_queries_keep_every_sample_under_25_ms() {
    let db = Database::in_memory().unwrap();
    let features = (0..1200).map(|i| json!({"code":format!("feature-{i}"),"cmds":[
        format!("command{i}"), {"type":"regex","match":format!("/^item{i}$/i")}, {"type":"over"}
    ]})).collect::<Vec<_>>();
    let p = Plugin {
        id: "budget".into(),
        name: "budget".into(),
        path: "/not-executed".into(),
        version: "1".into(),
        enabled: true,
        created_at: "now".into(),
        updated_at: "now".into(),
        manifest: serde_json::from_value(json!({"name":"budget","features":features})).unwrap(),
    };
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let snapshot = db.feature_catalog_snapshot().unwrap();
    let too_long = "x".repeat(10_001);
    let cases = [
        ("regex", "item1199", 1200),
        ("ascii", "fixed original body", 1200),
        ("chinese", "固定原文", 1200),
        ("utf16", "😀中文", 1200),
        ("over_max", too_long.as_str(), 0),
    ];
    let budget = Duration::from_millis(25);
    let mut exceeded = Vec::new();
    for (case, query, count) in cases {
        for sample in 0..4 {
            let cpu_start = query_cpu::start_ns();
            let start = Instant::now();
            let result = snapshot.search_text_content(query).unwrap();
            let elapsed = start.elapsed();
            let cpu_elapsed = query_cpu::elapsed_ns(cpu_start);
            eprintln!("content1200 case={case} phase={} sample={sample} results={} elapsed_ns={} thread_cpu_ns={} budget_ns={}",
                if sample==0 {"first"} else {"warm"}, result.len(), elapsed.as_nanos(), query_cpu::display(cpu_elapsed), budget.as_nanos());
            if elapsed > budget {
                exceeded.push((case, sample, elapsed));
            }
            assert_eq!(result.len(), count);
            if case == "regex" {
                assert_eq!(
                    (&*result[0].feature_code, result[0].match_type),
                    ("feature-1199", "regex")
                );
            }
            assert!(result
                .iter()
                .all(|r| r.plugin_id == "budget" && ["regex", "over"].contains(&r.match_type)));
        }
    }
    assert!(
        exceeded.is_empty(),
        "All twenty cached text-content samples must pass: {exceeded:?}"
    );
}
