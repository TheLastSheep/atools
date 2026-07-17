use std::{collections::BTreeMap, fs, hint::black_box, path::PathBuf, time::Instant};

use atools_core::{
    db::Database,
    pasteboard::{PasteboardItem, PasteboardItemKind, PasteboardPayload, PasteboardSourceApp},
};
use serde::Serialize;

const WARMUP_RUNS: usize = 3;
const MEASURED_RUNS: usize = 40;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryResult {
    query: String,
    match_count: usize,
    median_ms: f64,
    p95_ms: f64,
    min_ms: f64,
    max_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SizeResult {
    item_count: usize,
    threshold_ms: f64,
    p95_ms: f64,
    pass: bool,
    queries: Vec<QueryResult>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    schema_version: u8,
    generated_at: String,
    runtime: RuntimeInfo,
    methodology: Methodology,
    pass: bool,
    results: Vec<SizeResult>,
}

#[derive(Serialize)]
struct RuntimeInfo {
    implementation: &'static str,
    database: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Methodology {
    data: &'static str,
    warmup_runs: usize,
    measured_runs: usize,
    percentile: u8,
    result_limit: usize,
    aggregation: &'static str,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("artifacts/pasteboardpro/atools-search-performance.json"));
    let cases = [(10_000, 50.0), (100_000, 150.0)];
    let queries = ["needle-token", "invoice", "Safari", "image/png"];
    let mut results = Vec::new();

    for (item_count, threshold_ms) in cases {
        let db = Database::in_memory()?;
        db.upsert_pasteboard_items_batch(&fixture_items(item_count))?;
        let query_results = queries
            .iter()
            .map(|query| benchmark_query(&db, query))
            .collect::<Result<Vec<_>, _>>()?;
        let p95_ms = query_results
            .iter()
            .map(|result| result.p95_ms)
            .fold(0.0_f64, f64::max);
        let pass = p95_ms <= threshold_ms;
        println!(
            "{item_count} items: P95 {p95_ms:.2} ms / {threshold_ms:.0} ms ({})",
            if pass { "PASS" } else { "FAIL" }
        );
        results.push(SizeResult {
            item_count,
            threshold_ms,
            p95_ms,
            pass,
            queries: query_results,
        });
    }

    let pass = results.iter().all(|result| result.pass);
    let report = BenchmarkReport {
        schema_version: 1,
        generated_at: unix_timestamp_string(),
        runtime: RuntimeInfo {
            implementation: "ATools atools-core Database::search_pasteboard_items",
            database: "SQLite via rusqlite bundled",
        },
        methodology: Methodology {
            data: "deterministic synthetic PasteboardItem records",
            warmup_runs: WARMUP_RUNS,
            measured_runs: MEASURED_RUNS,
            percentile: 95,
            result_limit: 200,
            aggregation: "slowest query P95 per item-count gate",
        },
        pass,
        results,
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        &output,
        format!("{}\n", serde_json::to_string_pretty(&report)?),
    )?;
    println!("Report: {}", output.display());
    if !pass {
        std::process::exit(1);
    }
    Ok(())
}

fn benchmark_query(db: &Database, query: &str) -> atools_core::error::Result<QueryResult> {
    for _ in 0..WARMUP_RUNS {
        black_box(db.search_pasteboard_items(query, None, 200)?);
    }
    let mut durations = Vec::with_capacity(MEASURED_RUNS);
    let mut match_count = 0;
    for _ in 0..MEASURED_RUNS {
        let started_at = Instant::now();
        let matches = db.search_pasteboard_items(query, None, 200)?;
        durations.push(started_at.elapsed().as_secs_f64() * 1_000.0);
        match_count = matches.len();
        black_box(matches);
    }
    durations.sort_by(f64::total_cmp);
    Ok(QueryResult {
        query: query.to_string(),
        match_count,
        median_ms: round(durations[durations.len() / 2]),
        p95_ms: round(percentile(&durations, 95)),
        min_ms: round(durations[0]),
        max_ms: round(*durations.last().expect("measured runs are non-empty")),
    })
}

fn percentile(sorted: &[f64], value: usize) -> f64 {
    let rank = (value * sorted.len()).div_ceil(100).saturating_sub(1);
    sorted[rank]
}

fn round(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

fn fixture_items(item_count: usize) -> Vec<PasteboardItem> {
    let kinds = [
        PasteboardItemKind::Text,
        PasteboardItemKind::RichText,
        PasteboardItemKind::Html,
        PasteboardItemKind::Url,
        PasteboardItemKind::Image,
        PasteboardItemKind::Pdf,
        PasteboardItemKind::Color,
        PasteboardItemKind::Files,
    ];
    let apps = [
        ("com.apple.Safari", "Safari"),
        ("com.microsoft.VSCode", "Visual Studio Code"),
        ("com.apple.Notes", "Notes"),
        ("com.tinyspeck.slackmacgap", "Slack"),
    ];
    (0..item_count)
        .map(|index| {
            let kind = kinds[index % kinds.len()];
            let app = apps[index % apps.len()];
            let timestamp = format!("2026-07-17T00:00:00.{index:06}Z");
            PasteboardItem {
                id: format!("benchmark-item-{index}"),
                kind,
                title: Some(format!("Project alpha clip {index}")),
                source_app: Some(PasteboardSourceApp {
                    bundle_id: Some(app.0.to_string()),
                    name: Some(app.1.to_string()),
                }),
                source_device_id: format!("device-{}", index % 3),
                copied_at: timestamp.clone(),
                updated_at: timestamp,
                content_fingerprint: format!("fingerprint-{index}"),
                payload: PasteboardPayload {
                    revision: format!("revision-{index}"),
                    text: Some(format!(
                        "Pasteboard benchmark content {index}{}",
                        if index % 997 == 0 {
                            " needle-token"
                        } else {
                            ""
                        }
                    )),
                    html: None,
                    blob_id: None,
                    media_type: Some(if kind == PasteboardItemKind::Image {
                        "image/png".to_string()
                    } else {
                        "text/plain".to_string()
                    }),
                    file_paths: (kind == PasteboardItemKind::Files)
                        .then(|| vec![format!("/tmp/benchmark-file-{index}.txt")]),
                },
                ocr_text: (index % 251 == 0).then(|| "invoice total needle-ocr".to_string()),
                pinboard_id: None,
                pinboard_order_key: None,
                pinned: false,
                field_clocks: BTreeMap::new(),
            }
        })
        .collect()
}

fn unix_timestamp_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}
