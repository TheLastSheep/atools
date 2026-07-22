use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use atools_core::{Database, PasteboardItem, PasteboardItemKind, PasteboardSourceApp};
use rusqlite::{params, Connection};
use serde::Serialize;

const PREFIX: &str = "ATOOLS_PASTEBOARD_BENCHMARK ";

#[derive(Debug, Serialize)]
struct Report {
    schema_version: u32,
    generated_at: String,
    iterations: usize,
    threshold_ms: f64,
    status: &'static str,
    runs: Vec<ScaleReport>,
}

#[derive(Debug, Serialize)]
struct ScaleReport {
    scale: usize,
    storage_size_bytes: u64,
    seed_duration_ms: f64,
    cases: Vec<CaseReport>,
}

#[derive(Debug, Serialize)]
struct CaseReport {
    name: &'static str,
    result_count: usize,
    samples: usize,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let scales = argument(&args, "--scales")
        .unwrap_or("10000,100000")
        .split(',')
        .map(str::parse::<usize>)
        .collect::<Result<Vec<_>, _>>()?;
    let iterations = argument(&args, "--iterations")
        .unwrap_or("20")
        .parse::<usize>()?
        .max(1);
    let threshold_ms = argument(&args, "--threshold-ms")
        .unwrap_or("150")
        .parse::<f64>()?;
    let output = argument(&args, "--output").map(PathBuf::from);
    let fail_on_threshold = args.iter().any(|arg| arg == "--fail-on-threshold");

    let mut runs = Vec::new();
    for scale in scales {
        runs.push(run_scale(scale, iterations)?);
    }
    let exceeded = runs
        .iter()
        .flat_map(|run| &run.cases)
        .any(|case| case.p99_ms > threshold_ms);
    let report = Report {
        schema_version: 1,
        generated_at: atools_core::utils::now_iso(),
        iterations,
        threshold_ms,
        status: if exceeded { "warn" } else { "pass" },
        runs,
    };
    let encoded = serde_json::to_string_pretty(&report)?;
    if let Some(path) = output {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &encoded)?;
    }
    println!("{PREFIX}{}", serde_json::to_string(&report)?);
    if exceeded && fail_on_threshold {
        return Err(format!("Pasteboard P99 exceeded {threshold_ms}ms threshold").into());
    }
    Ok(())
}

fn run_scale(scale: usize, iterations: usize) -> Result<ScaleReport, Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let db_path = temp.path().join("pasteboard-benchmark.db");
    drop(Database::open(&db_path)?);
    let seeded = Instant::now();
    seed_rows(&db_path, scale)?;
    let seed_duration_ms = seeded.elapsed().as_secs_f64() * 1_000.0;
    let db = Database::open(&db_path)?;
    let middle_id = format!("bench-{:010}", scale / 2);
    let write_item = benchmark_item("write-benchmark", scale + 1);

    let cases = vec![
        measure("search_unique_text", iterations, || {
            db.search_pasteboard_items(
                &format!("item {}", scale.saturating_sub(1)),
                None,
                &[],
                500,
                0,
            )
            .map(|items| items.len())
        })?,
        measure("search_source", iterations, || {
            db.search_pasteboard_items("source 17", None, &[], 500, 0)
                .map(|items| items.len())
        })?,
        measure("search_localized_image_kind", iterations, || {
            db.search_pasteboard_items("图片", None, &[], 500, 0)
                .map(|items| items.len())
        })?,
        measure("search_no_match", iterations, || {
            db.search_pasteboard_items("zzzz-no-pasteboard-match", None, &[], 500, 0)
                .map(|items| items.len())
        })?,
        measure("latest_500", iterations, || {
            db.search_pasteboard_items("", None, &[], 500, 0)
                .map(|items| items.len())
        })?,
        measure("get_item", iterations, || {
            db.get_pasteboard_item(&middle_id)
                .map(|item| usize::from(item.is_some()))
        })?,
        measure("upsert_item", iterations, || {
            db.upsert_pasteboard_item(&write_item).map(|_| 1)
        })?,
    ];
    Ok(ScaleReport {
        scale,
        storage_size_bytes: db.storage_size_bytes()?,
        seed_duration_ms: round(seed_duration_ms),
        cases,
    })
}

fn seed_rows(path: &Path, scale: usize) -> Result<(), Box<dyn std::error::Error>> {
    let mut conn = Connection::open(path)?;
    let tx = conn.transaction()?;
    {
        let mut statement = tx.prepare(
            r#"
            INSERT INTO pasteboard_items
            (id, kind, title, source_app, source_device_id, copied_at, updated_at,
             content_fingerprint, payload, ocr_text, pinboard_id, pinboard_order_key,
             pinned, field_clocks, search_text)
            VALUES (?1, ?2, ?3, ?4, 'benchmark-device', ?5, ?5, ?6, ?7, NULL, NULL, NULL, 0, '{}', ?8)
            "#,
        )?;
        for index in 0..scale {
            let item = benchmark_item(&format!("bench-{index:010}"), index);
            statement.execute(params![
                item.id,
                item.kind.as_str(),
                item.title,
                serde_json::to_string(&item.source_app)?,
                item.copied_at,
                item.content_fingerprint,
                serde_json::to_string(&item.payload)?,
                item.searchable_text(),
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn benchmark_item(id: &str, index: usize) -> PasteboardItem {
    let kind = match index % 8 {
        0 => PasteboardItemKind::Image,
        1 => PasteboardItemKind::Files,
        2 => PasteboardItemKind::Url,
        3 => PasteboardItemKind::Html,
        4 => PasteboardItemKind::RichText,
        5 => PasteboardItemKind::Color,
        6 => PasteboardItemKind::Pdf,
        _ => PasteboardItemKind::Text,
    };
    let hour = (index / 3_600) % 24;
    let minute = (index / 60) % 60;
    let second = index % 60;
    let timestamp = format!("2026-07-21T{hour:02}:{minute:02}:{second:02}Z");
    PasteboardItem {
        id: id.into(),
        kind,
        title: Some(format!("Reference item {index}")),
        source_app: Some(PasteboardSourceApp {
            bundle_id: Some(format!("com.example.source{}", index % 50)),
            name: Some(format!("Source {}", index % 50)),
        }),
        source_device_id: "benchmark-device".into(),
        copied_at: timestamp.clone(),
        updated_at: timestamp,
        content_fingerprint: format!("benchmark-fingerprint-{index}"),
        payload: serde_json::json!({
            "text": format!("pasteboard benchmark item {index}"),
            "previewText": if index % 997 == 0 { "needle orchid" } else { "ordinary" },
        }),
        ocr_text: None,
        pinboard_id: None,
        pinboard_order_key: None,
        pinned: false,
        field_clocks: serde_json::json!({}),
    }
}

fn measure(
    name: &'static str,
    iterations: usize,
    mut operation: impl FnMut() -> atools_core::error::Result<usize>,
) -> Result<CaseReport, Box<dyn std::error::Error>> {
    for _ in 0..3 {
        operation()?;
    }
    let mut samples = Vec::with_capacity(iterations);
    let mut result_count = 0;
    for _ in 0..iterations {
        let started = Instant::now();
        result_count = operation()?;
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    samples.sort_by(f64::total_cmp);
    Ok(CaseReport {
        name,
        result_count,
        samples: samples.len(),
        p50_ms: round(percentile(&samples, 50.0)),
        p95_ms: round(percentile(&samples, 95.0)),
        p99_ms: round(percentile(&samples, 99.0)),
        max_ms: round(*samples.last().unwrap_or(&0.0)),
    })
}

fn percentile(samples: &[f64], requested: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let index = ((requested / 100.0) * (samples.len() - 1) as f64).ceil() as usize;
    samples[index.min(samples.len() - 1)]
}

fn round(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

fn argument<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}
