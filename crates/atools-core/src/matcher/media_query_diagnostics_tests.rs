use super::{capture, Reading};
use crate::{
    matcher::{FeatureSearchIndex, MediaFile},
    models::FeatureEntry,
};
use serde_json::json;

const BUDGET_NS: u128 = 25_000_000;

fn fixture(patterns: usize, literal: bool, metadata: bool) -> Vec<FeatureEntry> {
    (0..1200)
        .map(|index| FeatureEntry {
            code: format!("feature-{index}"),
            plugin_id: "fixed-media-diagnostic".into(),
            plugin_name: "fixed-media-diagnostic".into(),
            label: String::new(),
            icon: None,
            explain: String::new(),
            cmds: vec![serde_json::from_value({
                let mut command = json!({
                "type":"files",
                "match":if literal { "item".into() } else {
                    format!("/^(?:item|other{})[0-9]+\\.png$/i", index % patterns)
                }
                });
                if metadata {
                    command["fileType"] = json!("file");
                    command["extensions"] = json!(["PNG"]);
                }
                command
            })
            .unwrap()],
            main_push: false,
            priority: 0,
        })
        .collect()
}

fn files(count: usize, prefix: &str) -> Vec<MediaFile> {
    (0..count)
        .map(|index| {
            let name = format!("{prefix}{index}.png");
            MediaFile {
                path: format!("/fixed-fixture/{name}"),
                name,
                is_file: true,
                is_directory: false,
            }
        })
        .collect()
}

fn signature(
    result: &crate::Result<Vec<crate::matcher::MatchResult>>,
) -> Result<Vec<crate::matcher::MatchResult>, String> {
    result.as_ref().cloned().map_err(ToString::to_string)
}

#[test]
#[ignore = "explicit serial macOS wall/thread-CPU diagnostic; not the 25 ms acceptance test"]
fn fresh_media_bank_first_query_stage_wall_and_thread_cpu_diagnostic() {
    let mut overhead = Vec::with_capacity(1024);
    for _ in 0..1024 {
        let started = Reading::now().expect("thread CPU clock must be available");
        overhead.push(Reading::now().unwrap().since(started).unwrap());
    }
    for clock in ["wall", "thread_cpu"] {
        let mut values = overhead
            .iter()
            .map(|elapsed| {
                if clock == "wall" {
                    elapsed.wall_ns
                } else {
                    elapsed.cpu_ns
                }
            })
            .collect::<Vec<_>>();
        values.sort_unstable();
        eprintln!(
            "media_clock_pair_overhead clock={clock} samples={} min_ns={} median_ns={} max_ns={}",
            values.len(),
            values[0],
            values[values.len() / 2],
            values[values.len() - 1]
        );
    }

    for (case, patterns, count, prefix, literal, expected_count, rejected) in [
        ("unique6", 1200, 6, "item", false, 1200, false),
        ("ruleBoundary8192", 1024, 8, "item", false, 1200, false),
        ("noMatch6", 1200, 6, "missing", false, 0, false),
        ("partialMatch6", 1200, 6, "other0", false, 1, false),
        ("rejectUnique7", 1200, 7, "item", false, 0, true),
        ("literal6", 1, 6, "item", true, 1200, false),
    ] {
        let entries = fixture(patterns, literal, case != "ruleBoundary8192");
        let selected = files(count, prefix);
        let mut reference_signatures = Vec::new();
        // Each mode builds an independent bank. Its sample 0 is never pre-searched.
        for mode in ["outer_only", "stages"] {
            let started = Reading::now().unwrap();
            let index = FeatureSearchIndex::try_build(&entries).unwrap();
            let elapsed = Reading::now().unwrap().since(started).unwrap();
            eprintln!(
                "media_diagnostic_build case={case} mode={mode} wall_ns={} thread_cpu_ns={}",
                elapsed.wall_ns, elapsed.cpu_ns
            );
            for sample in 0..4 {
                let (result, elapsed, segments) = if mode == "stages" {
                    let (result, trace) = capture(|| index.search_file_content(&selected)).unwrap();
                    (result, trace.elapsed, trace.segments)
                } else {
                    let started = Reading::now().unwrap();
                    let result = index.search_file_content(&selected);
                    (
                        result,
                        Reading::now().unwrap().since(started).unwrap(),
                        Vec::new(),
                    )
                };
                let result_count = result.as_ref().map_or(0, Vec::len);
                eprintln!("media_diagnostic_query case={case} mode={mode} sample={sample} phase={} results={result_count} rejected={rejected} wall_ns={} thread_cpu_ns={} budget_ns={BUDGET_NS} exceeds_wall_budget={}",
                    if sample == 0 { "first" } else { "warm" }, elapsed.wall_ns,
                    elapsed.cpu_ns, elapsed.wall_ns > BUDGET_NS);
                for (stage, elapsed) in segments {
                    eprintln!("media_diagnostic_stage case={case} sample={sample} stage={stage} wall_ns={} thread_cpu_ns={}",
                        elapsed.wall_ns, elapsed.cpu_ns);
                }
                if rejected {
                    assert!(result
                        .as_ref()
                        .unwrap_err()
                        .to_string()
                        .contains("MEDIA_MATCH_WORK_BUDGET"));
                } else {
                    assert_eq!(result_count, expected_count);
                }
                if mode == "outer_only" {
                    reference_signatures.push(signature(&result));
                } else {
                    assert_eq!(signature(&result), reference_signatures[sample]);
                }
            }
        }
    }
}
