use atools_core::{matcher::MediaFile, Database, Plugin};
use serde_json::json;
use std::time::{Duration, Instant};

#[path = "support/query_cpu.rs"]
mod query_cpu;

#[test]
fn cached_1200_media_rules_keep_all_selected_file_samples_under_25_ms() {
    let budget = Duration::from_millis(25);
    let mut exceeded = Vec::new();
    for (case, count, unique) in [
        ("normal20", 20, false),
        ("normal64", 64, false),
        ("maximum1000", 1000, false),
        ("unique6", 6, true),
        ("rejectUnique7", 7, true),
        ("rejectUnique1000", 1000, true),
    ] {
        let db = Database::in_memory().unwrap();
        let features=(0..1200).map(|i|json!({"code":format!("feature-{i}"),"cmds":[
            {"type":"files","fileType":"file","extensions":["PNG"],"match":if unique {format!("/^(?:item|other{i})[0-9]+\\.png$/i")}else{"/^item[0-9]+\\.png$/i".into()}},
            {"type":"img"}
        ]})).collect::<Vec<_>>();
        let plugin = Plugin {
            id: "budget".into(),
            name: "budget".into(),
            path: "/not-executed".into(),
            version: "1".into(),
            enabled: true,
            created_at: "now".into(),
            updated_at: "now".into(),
            manifest: serde_json::from_value(json!({"name":"budget","features":features})).unwrap(),
        };
        db.save_plugin_with_features(&plugin, &plugin.manifest.features)
            .unwrap();
        let index_started = Instant::now();
        let snapshot = db.feature_catalog_snapshot().unwrap();
        eprintln!(
            "media_index case={case} elapsed_ns={} index_allowance_bytes={}",
            index_started.elapsed().as_nanos(),
            snapshot.index_budget_bytes
        );
        let files = (0..count)
            .map(|n| MediaFile {
                path: format!("/fixture/item{n}.png"),
                name: format!("item{n}.png"),
                is_file: true,
                is_directory: false,
            })
            .collect::<Vec<_>>();
        for sample in 0..4 {
            let cpu_start = query_cpu::start_ns();
            let start = Instant::now();
            let result = snapshot.search_file_content(&files);
            let elapsed = start.elapsed();
            let cpu_elapsed = query_cpu::elapsed_ns(cpu_start);
            let result_count = result.as_ref().map_or(0, Vec::len);
            eprintln!("media1200 case={case} files={count} phase={} sample={sample} results={} elapsed_ns={} thread_cpu_ns={} budget_ns={}",if sample==0{"first"}else{"warm"},result_count,elapsed.as_nanos(),query_cpu::display(cpu_elapsed),budget.as_nanos());
            if case.starts_with("reject") {
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .contains("MEDIA_MATCH_WORK_BUDGET"));
            } else {
                let result = result.unwrap();
                assert_eq!(result.len(), 1200);
                assert!(result.iter().all(|r| r.match_type == "files"));
            }
            if elapsed > budget {
                exceeded.push((case, sample, elapsed));
            }
        }
        for sample in 0..4 {
            let cpu_start = query_cpu::start_ns();
            let start = Instant::now();
            let result = snapshot.search_image_content();
            let elapsed = start.elapsed();
            let cpu_elapsed = query_cpu::elapsed_ns(cpu_start);
            eprintln!(
                "image1200 case={case} sample={sample} results={} elapsed_ns={} thread_cpu_ns={} budget_ns={}",
                result.len(),
                elapsed.as_nanos(),
                query_cpu::display(cpu_elapsed),
                budget.as_nanos()
            );
            assert_eq!(result.len(), 1200);
            assert!(result.iter().all(|r| r.match_type == "img"));
            if elapsed > budget {
                exceeded.push((case, sample, elapsed));
            }
        }
    }
    assert!(
        exceeded.is_empty(),
        "Every sample must meet the unchanged 25 ms gate: {exceeded:?}"
    );
}

#[test]
fn work_and_name_byte_boundaries_keep_complete_success_or_complete_rejection_under_25_ms() {
    let budget = Duration::from_millis(25);
    let mut exceeded = Vec::new();
    for (case, patterns, count, long, reject) in [
        ("ruleBoundary8192", 1024, 8, false, false),
        ("nameBytesBoundary512KiB", 2, 32, true, false),
        ("nameBytesReject", 3, 32, true, true),
    ] {
        let db = Database::in_memory().unwrap();
        let features = (0..1200)
            .map(|i| {
                let pattern = if long {
                    ["/^.+$/", "/.+/", "/^.*/"][i % patterns].to_string()
                } else {
                    format!("/^(?:item|other{})[0-9]+\\.png$/i", i % patterns)
                };
                json!({"code":format!("feature-{i}"),"cmds":[{"type":"files","match":pattern}]})
            })
            .collect::<Vec<_>>();
        let plugin = Plugin {
            id: "boundary".into(),
            name: "boundary".into(),
            path: "/not-executed".into(),
            version: "1".into(),
            enabled: true,
            created_at: "now".into(),
            updated_at: "now".into(),
            manifest: serde_json::from_value(json!({"name":"boundary","features":features}))
                .unwrap(),
        };
        db.save_plugin_with_features(&plugin, &plugin.manifest.features)
            .unwrap();
        let started = Instant::now();
        let snapshot = db.feature_catalog_snapshot().unwrap();
        eprintln!(
            "media_index case={case} elapsed_ns={} index_allowance_bytes={}",
            started.elapsed().as_nanos(),
            snapshot.index_budget_bytes
        );
        let files = (0..count)
            .map(|n| {
                if long {
                    MediaFile {
                        path: format!("/{}", format!("{n:02}{}", "x".repeat(8189))),
                        name: format!("{n:02}{}", "x".repeat(8190)),
                        is_file: true,
                        is_directory: false,
                    }
                } else {
                    MediaFile {
                        path: format!("/fixture/item{n}.png"),
                        name: format!("item{n}.png"),
                        is_file: true,
                        is_directory: false,
                    }
                }
            })
            .collect::<Vec<_>>();
        for sample in 0..4 {
            let cpu_start = query_cpu::start_ns();
            let started = Instant::now();
            let result = snapshot.search_file_content(&files);
            let elapsed = started.elapsed();
            let cpu_elapsed = query_cpu::elapsed_ns(cpu_start);
            eprintln!("media1200 case={case} files={} phase={} sample={sample} results={} elapsed_ns={} thread_cpu_ns={} budget_ns={}",files.len(),if sample==0{"first"}else{"warm"},result.as_ref().map_or(0,Vec::len),elapsed.as_nanos(),query_cpu::display(cpu_elapsed),budget.as_nanos());
            if reject {
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .contains("MEDIA_MATCH_WORK_BUDGET"));
            } else {
                assert_eq!(result.unwrap().len(), 1200);
            }
            if elapsed > budget {
                exceeded.push((case, sample, elapsed));
            }
        }
    }
    assert!(
        exceeded.is_empty(),
        "All exact-boundary and complete-rejection samples must pass: {exceeded:?}"
    );
}
