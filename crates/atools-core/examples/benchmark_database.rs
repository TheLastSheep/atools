use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use atools_core::memory::{MemoryApproval, MemoryItem, MemoryScope, MemoryType};
use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
use atools_core::Database;
use serde::Serialize;
use serde_json::json;

const PREFIX: &str = "ATOOLS_DATABASE_BENCHMARK ";

#[derive(Debug, Serialize)]
struct Report {
    schema_version: u32,
    generated_at: String,
    commit: String,
    iterations: usize,
    threshold_ms: f64,
    status: &'static str,
    runs: Vec<ScaleReport>,
}

#[derive(Debug, Serialize)]
struct ScaleReport {
    scale: usize,
    task_runs: usize,
    memory_items: usize,
    storage_size_bytes: u64,
    seed_duration_ms: f64,
    cases: Vec<CaseReport>,
}

#[derive(Debug, Serialize)]
struct CaseReport {
    name: &'static str,
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
        .unwrap_or("30")
        .parse::<usize>()?
        .max(1);
    let threshold_ms = argument(&args, "--threshold-ms")
        .unwrap_or("80")
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
        commit: env::var("GITHUB_SHA").unwrap_or_else(|_| "local".to_string()),
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
    if env::var_os("GITHUB_ACTIONS").is_some() {
        let summary = report
            .runs
            .iter()
            .map(|run| {
                let cases = run
                    .cases
                    .iter()
                    .map(|case| format!("{} P99 {:.3}ms", case.name, case.p99_ms))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{} rows: {}", run.scale, cases)
            })
            .collect::<Vec<_>>()
            .join("; ");
        println!(
            "::{} title=ATools database growth benchmark::{}",
            if exceeded { "warning" } else { "notice" },
            summary
        );
    }
    if exceeded && fail_on_threshold {
        return Err(format!("Database P99 exceeded {threshold_ms}ms threshold").into());
    }
    Ok(())
}

fn run_scale(scale: usize, iterations: usize) -> Result<ScaleReport, Box<dyn std::error::Error>> {
    let db = Database::in_memory()?;
    let seeded = Instant::now();
    for index in 0..scale {
        let mut run = TaskRun::new(
            if index % 2 == 0 {
                "find_local_files"
            } else {
                "compress_images"
            },
            TaskRunInitiator::agent("database-benchmark"),
            json!({ "index": index, "query": "benchmark" }),
        );
        run.id = format!("run-{index:010}");
        run.output = json!({ "items": [{ "index": index, "ok": true }] });
        run.summary = Some(format!("benchmark run {index}"));
        run.transition(TaskRunStatus::Running)?;
        run.transition(TaskRunStatus::Succeeded)?;
        db.upsert_task_run(&run)?;

        let tool = if index % 997 == 0 {
            "compress_images"
        } else {
            "unrelated_tool"
        };
        let mut memory = MemoryItem::new(
            MemoryType::Preference,
            MemoryScope {
                tool: Some(tool.to_string()),
                ..MemoryScope::default()
            },
            json!({ "arguments": { "quality": index % 100 } }),
            Some(run.id),
            1.0,
            MemoryApproval::Explicit,
            None,
        )?;
        memory.id = format!("memory-{index:010}");
        db.upsert_memory_item(&memory)?;
    }
    let seed_duration_ms = seeded.elapsed().as_secs_f64() * 1_000.0;
    let context = MemoryScope {
        tool: Some("compress_images".to_string()),
        ..MemoryScope::default()
    };

    let cases = vec![
        measure("list_task_runs_100", iterations, || {
            db.list_task_runs(100).map(|_| ())
        })?,
        measure("get_task_run", iterations, || {
            db.get_task_run(&format!("run-{:010}", scale / 2))
                .map(|_| ())
        })?,
        measure("list_memory_items_100", iterations, || {
            db.list_memory_items(false, 100).map(|_| ())
        })?,
        measure("find_scoped_memory_20", iterations, || {
            db.find_memory_items(&context, 20).map(|_| ())
        })?,
    ];
    Ok(ScaleReport {
        scale,
        task_runs: scale,
        memory_items: scale,
        storage_size_bytes: db.storage_size_bytes()?,
        seed_duration_ms: round(seed_duration_ms),
        cases,
    })
}

fn measure(
    name: &'static str,
    iterations: usize,
    mut operation: impl FnMut() -> atools_core::error::Result<()>,
) -> Result<CaseReport, Box<dyn std::error::Error>> {
    for _ in 0..3 {
        operation()?;
    }
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        operation()?;
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    samples.sort_by(f64::total_cmp);
    Ok(CaseReport {
        name,
        samples: samples.len(),
        p50_ms: round(percentile(&samples, 50.0)),
        p95_ms: round(percentile(&samples, 95.0)),
        p99_ms: round(percentile(&samples, 99.0)),
        max_ms: round(*samples.last().unwrap_or(&0.0)),
    })
}

fn percentile(samples: &[f64], percentile: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let index = ((percentile / 100.0) * (samples.len() - 1) as f64).ceil() as usize;
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
