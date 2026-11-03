//! Opt-in paired wall/thread-CPU diagnostics for exact large text and media queries.
use super::{
    FeatureSearchIndex, MediaFile,
    index::{Reading, capture},
};
use crate::{Database, Plugin, models::FeatureEntry};
use serde_json::{Value, json};

const SAMPLES: usize = 4;

fn clock_pair_overhead() {
    let mut pairs = Vec::with_capacity(1024);
    for _ in 0..1024 {
        let start = Reading::now().unwrap();
        pairs.push(Reading::now().unwrap().since(start).unwrap());
    }
    for (clock, mut values) in [
        (
            "wall",
            pairs.iter().map(|value| value.wall_ns).collect::<Vec<_>>(),
        ),
        (
            "thread_cpu",
            pairs.iter().map(|value| value.cpu_ns).collect::<Vec<_>>(),
        ),
    ] {
        values.sort_unstable();
        eprintln!(
            "query_cpu_clock_overhead clock={clock} samples={} min_ns={} median_ns={} max_ns={}",
            values.len(),
            values[0],
            values[values.len() / 2],
            values[values.len() - 1]
        );
    }
}

fn text_fixture() -> Vec<FeatureEntry> {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/launcher-typed-text-ecosystem-rules.json"
    ))
    .unwrap();
    fixture["commands"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, command)| FeatureEntry {
            code: format!("ecosystem-{index}"),
            plugin_id: "fixed-text-diagnostic".into(),
            plugin_name: String::new(),
            label: String::new(),
            icon: None,
            explain: String::new(),
            cmds: vec![serde_json::from_value(command.clone()).unwrap()],
            main_push: false,
            priority: 0,
        })
        .collect()
}

fn text_query(shape: &str) -> String {
    match shape {
        "ascii" => "x".repeat(262_144),
        "json" => format!("{{\"fixture\":\"{}\"}}", "x".repeat(262_130)),
        _ => "😀".repeat(65_536),
    }
}

fn plugin(case: &str, features: Vec<Value>) -> Plugin {
    Plugin {
        id: format!("query-cpu-{case}"),
        name: "query-cpu-diagnostic".into(),
        path: "/not-executed".into(),
        version: "1".into(),
        enabled: true,
        created_at: "now".into(),
        updated_at: "now".into(),
        manifest: serde_json::from_value(json!({
            "name": "query-cpu-diagnostic",
            "features": features
        }))
        .unwrap(),
    }
}

fn max_media_features() -> Vec<Value> {
    (0..1200)
        .map(|index| {
            json!({
                "code": format!("feature-{index}"),
                "cmds": [
                    {"type":"files","fileType":"file","extensions":["PNG"],"match":"/^item[0-9]+\\.png$/i"},
                    {"type":"img"}
                ]
            })
        })
        .collect()
}

fn boundary_media_features() -> Vec<Value> {
    (0..1200)
        .map(|index| {
            json!({
                "code": format!("feature-{index}"),
                "cmds": [{"type":"files","match":format!("/^(?:item|other{})[0-9]+\\.png$/i", index % 1024)}]
            })
        })
        .collect()
}

fn files(count: usize) -> Vec<MediaFile> {
    (0..count)
        .map(|index| MediaFile {
            path: format!("/fixture/item{index}.png"),
            name: format!("item{index}.png"),
            is_file: true,
            is_directory: false,
        })
        .collect()
}

fn run_text_case(shape: &str, expected: usize) {
    let entries = text_fixture();
    let query = text_query(shape);
    let started = Reading::now().unwrap();
    let index = FeatureSearchIndex::try_build(&entries).unwrap();
    let built = Reading::now().unwrap().since(started).unwrap();
    eprintln!(
        "query_cpu_build kind=typed_text case={shape} wall_ns={} thread_cpu_ns={}",
        built.wall_ns, built.cpu_ns
    );

    // This fresh index has not been queried: sample 0 retains its first-query cost.
    let mut reference = None;
    for sample in 0..SAMPLES {
        let started = Reading::now().unwrap();
        let result = index.search_text_content(&query).unwrap();
        let elapsed = Reading::now().unwrap().since(started).unwrap();
        assert_eq!(result.len(), expected, "{shape} result cardinality changed");
        if let Some(reference) = &reference {
            assert_eq!(
                &result, reference,
                "{shape} ordered result signature changed"
            );
        } else {
            reference = Some(result.clone());
        }
        eprintln!(
            "query_cpu_sample kind=typed_text case={shape} sample={sample} bytes={} results={} outcome=success wall_ns={} thread_cpu_ns={} signature_stable=true",
            query.len(),
            result.len(),
            elapsed.wall_ns,
            elapsed.cpu_ns
        );
    }
}

fn run_media_case(case: &str, features: Vec<Value>, count: usize) {
    let database = Database::in_memory().unwrap();
    let record = plugin(case, features);
    database
        .save_plugin_with_features(&record, &record.manifest.features)
        .unwrap();
    let started = Reading::now().unwrap();
    let snapshot = database.feature_catalog_snapshot().unwrap();
    let built = Reading::now().unwrap().since(started).unwrap();
    eprintln!(
        "query_cpu_build kind=media case={case} wall_ns={} thread_cpu_ns={}",
        built.wall_ns, built.cpu_ns
    );
    let selected = files(count);

    // The snapshot is fresh and sample 0 is its first query; diagnostics never prewarm it.
    let mut reference = None;
    for sample in 0..SAMPLES {
        let (result, trace) = capture(|| snapshot.search_file_content(&selected)).unwrap();
        let result = result.unwrap();
        assert_eq!(result.len(), 1200, "{case} result cardinality changed");
        assert!(result.iter().all(|entry| entry.match_type == "files"));
        if let Some(reference) = &reference {
            assert_eq!(
                &result, reference,
                "{case} ordered result signature changed"
            );
        } else {
            reference = Some(result.clone());
        }
        eprintln!(
            "query_cpu_sample kind=media case={case} sample={sample} files={count} results={} outcome=success wall_ns={} thread_cpu_ns={} signature_stable=true",
            result.len(),
            trace.elapsed.wall_ns,
            trace.elapsed.cpu_ns
        );
        for (stage, elapsed) in trace.segments {
            eprintln!(
                "query_cpu_stage case={case} sample={sample} stage={stage} wall_ns={} thread_cpu_ns={}",
                elapsed.wall_ns, elapsed.cpu_ns
            );
        }
    }
}

#[test]
#[ignore = "opt-in serial wall/thread-CPU diagnosis; not a performance acceptance gate"]
fn exact_long_text_and_media_queries_report_paired_wall_and_thread_cpu() {
    clock_pair_overhead();
    for (shape, expected) in [("ascii", 4), ("json", 7), ("unicode", 5)] {
        run_text_case(shape, expected);
    }
    run_media_case("maximum1000", max_media_features(), 1000);
    run_media_case("ruleBoundary8192", boundary_media_features(), 8);
}
