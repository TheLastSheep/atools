//! Opt-in, metadata-only verification of the real official-target Rust function.

use crate::commands::PluginMarketCatalogSourceKind;
use crate::plugin_market_target::{
    fetch_official_plugin_target, official_target_probe_url, OfficialPluginTargetLookup,
    OfficialPluginTargetStatus,
};
use serde::Serialize;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const GLOBAL_TIMEOUT: Duration = Duration::from_secs(45);
const COHORT: [(&str, OfficialPluginTargetStatus); 7] = [
    ("regex-editor", OfficialPluginTargetStatus::Available),
    (
        "ip-switcher",
        OfficialPluginTargetStatus::UnsupportedPlatform,
    ),
    (
        "local-search-neo",
        OfficialPluginTargetStatus::UnsupportedPlatform,
    ),
    (
        "port-use-win",
        OfficialPluginTargetStatus::UnsupportedPlatform,
    ),
    (
        "remote-manager",
        OfficialPluginTargetStatus::UnsupportedPlatform,
    ),
    ("unlock", OfficialPluginTargetStatus::UnsupportedPlatform),
    (
        "atools-nonexistent-release-probe-20261015",
        OfficialPluginTargetStatus::NotFound,
    ),
];

#[derive(Serialize)]
struct ProbeReport {
    schema_version: u8,
    run_id: String,
    started_at_epoch_ms: u64,
    finished_at_epoch_ms: Option<u64>,
    elapsed_ms: u64,
    status: String,
    error: Option<String>,
    scope: ProbeScope,
    limits: ProbeLimits,
    observations: Vec<ProbeObservation>,
}

#[derive(Serialize)]
struct ProbeScope {
    real_backend_metadata: bool,
    tauri_ipc: bool,
    gui_started: bool,
    node_used: bool,
    resolver_calls: u8,
    archives_downloaded: u8,
    plugins_executed: u8,
    installation_acceptance: bool,
    expected_platform: &'static str,
    current_os: &'static str,
}

#[derive(Serialize)]
struct ProbeLimits {
    global_timeout_ms: u64,
    per_request_timeout_ms: u64,
    sequential_requests: bool,
    retries: u8,
}

#[derive(Serialize)]
struct ProbeObservation {
    plugin_id: String,
    expected_status: OfficialPluginTargetStatus,
    request_url: String,
    request_started: bool,
    elapsed_ms: u64,
    outcome: String,
    normalized_response: Option<OfficialPluginTargetLookup>,
    error: Option<String>,
}

/// Run the fixed darwin cohort without starting an app, plugin, resolver, or installer.
pub fn run() -> Result<(), String> {
    let output = parse_output(std::env::args_os().skip(1))?;
    let started = Instant::now();
    let mut report = initial_report()?;
    write_report(&output, &report)?;
    let execution = if cfg!(target_os = "macos") {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("Metadata probe runtime failed: {error}"))
            .and_then(|runtime| runtime.block_on(run_cohort(&mut report, &output, started)))
    } else {
        Err(
            "This fixed cohort is verified only for macOS/darwin; no requests were made"
                .to_string(),
        )
    };
    report.finished_at_epoch_ms = Some(epoch_ms());
    report.elapsed_ms = duration_ms(started.elapsed());
    report.status = if execution.is_ok()
        && report
            .observations
            .iter()
            .all(|row| row.outcome == "passed")
    {
        "passed".to_string()
    } else {
        "failed".to_string()
    };
    report.error = execution.err().or_else(|| {
        (report.status == "failed")
            .then(|| "Official metadata did not meet all fixed cohort expectations".to_string())
    });
    write_report(&output, &report)?;
    if report.status == "passed" {
        println!("Official metadata probe passed: {}", output.display());
        Ok(())
    } else {
        Err(format!(
            "Official metadata probe failed: {}; report: {}",
            report.error.as_deref().unwrap_or("unknown error"),
            output.display()
        ))
    }
}

fn parse_output(args: impl IntoIterator<Item = OsString>) -> Result<PathBuf, String> {
    let mut args = args.into_iter();
    let mut output = None;
    while let Some(argument) = args.next() {
        if argument != "--output" || output.is_some() {
            return Err("Usage: official_market_target_probe --output PATH".to_string());
        }
        let value = args
            .next()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "--output requires a nonempty path".to_string())?;
        output = Some(PathBuf::from(value));
    }
    output.ok_or_else(|| "Required argument missing: --output PATH".to_string())
}

fn initial_report() -> Result<ProbeReport, String> {
    let started_at_epoch_ms = epoch_ms();
    let observations = COHORT
        .iter()
        .map(|(plugin_id, expected_status)| {
            Ok(ProbeObservation {
                plugin_id: (*plugin_id).to_string(),
                expected_status: expected_status.clone(),
                request_url: official_target_probe_url(plugin_id)?.to_string(),
                request_started: false,
                elapsed_ms: 0,
                outcome: "not_run".to_string(),
                normalized_response: None,
                error: None,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ProbeReport {
        schema_version: 1,
        run_id: format!(
            "official-market-target-{started_at_epoch_ms}-{}",
            std::process::id()
        ),
        started_at_epoch_ms,
        finished_at_epoch_ms: None,
        elapsed_ms: 0,
        status: "running".to_string(),
        error: None,
        scope: ProbeScope {
            real_backend_metadata: true,
            tauri_ipc: false,
            gui_started: false,
            node_used: false,
            resolver_calls: 0,
            archives_downloaded: 0,
            plugins_executed: 0,
            installation_acceptance: false,
            expected_platform: "darwin",
            current_os: std::env::consts::OS,
        },
        limits: ProbeLimits {
            global_timeout_ms: duration_ms(GLOBAL_TIMEOUT),
            per_request_timeout_ms: 15_000,
            sequential_requests: true,
            retries: 0,
        },
        observations,
    })
}

async fn run_cohort(
    report: &mut ProbeReport,
    output: &Path,
    started: Instant,
) -> Result<(), String> {
    for index in 0..report.observations.len() {
        let remaining = GLOBAL_TIMEOUT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            mark_deadline_skips(&mut report.observations[index..]);
            return Err("Global 45-second metadata probe deadline exceeded".to_string());
        }
        let row = &mut report.observations[index];
        row.request_started = true;
        let request_started = Instant::now();
        let result = tokio::time::timeout(
            remaining,
            fetch_official_plugin_target(row.plugin_id.clone()),
        )
        .await;
        row.elapsed_ms = duration_ms(request_started.elapsed());
        match result {
            Ok(Ok(response)) => {
                row.error = assess_response(&row.plugin_id, &row.expected_status, &response).err();
                row.outcome = if row.error.is_none() {
                    "passed"
                } else {
                    "failed"
                }
                .to_string();
                row.normalized_response = Some(response);
            }
            Ok(Err(error)) => {
                row.outcome = "failed".to_string();
                row.error = Some(error);
            }
            Err(_) => {
                row.outcome = "failed".to_string();
                row.error = Some("Global 45-second deadline interrupted the request".to_string());
                mark_deadline_skips(&mut report.observations[index + 1..]);
                report.elapsed_ms = duration_ms(started.elapsed());
                write_report(output, report)?;
                return Err("Global 45-second metadata probe deadline exceeded".to_string());
            }
        }
        report.elapsed_ms = duration_ms(started.elapsed());
        write_report(output, report)?;
    }
    Ok(())
}

fn mark_deadline_skips(rows: &mut [ProbeObservation]) {
    for row in rows {
        row.error =
            Some("Not requested because the global probe deadline was exhausted".to_string());
    }
}

fn assess_response(
    plugin_id: &str,
    expected: &OfficialPluginTargetStatus,
    response: &OfficialPluginTargetLookup,
) -> Result<(), String> {
    if response.plugin_id != plugin_id
        || response.source_url != "https://z-tools.top/api/market"
        || response.source_kind != PluginMarketCatalogSourceKind::Ztools
    {
        return Err(
            "Normalized metadata identity or source differs from the fixed request".to_string(),
        );
    }
    if &response.status != expected {
        return Err(format!(
            "Expected {expected:?}, received {:?}",
            response.status
        ));
    }
    match (&response.status, &response.plugin) {
        (OfficialPluginTargetStatus::Available, Some(plugin))
            if plugin.id == plugin_id && !plugin.version.trim().is_empty() =>
        {
            Ok(())
        }
        (
            OfficialPluginTargetStatus::NotFound | OfficialPluginTargetStatus::UnsupportedPlatform,
            None,
        ) => Ok(()),
        _ => Err("Normalized metadata has inconsistent plugin availability".to_string()),
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(duration_ms)
        .unwrap_or(0)
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn write_report(output: &Path, report: &ProbeReport) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(report)
        .map_err(|error| format!("Serialize probe report: {error}"))?;
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Create probe output directory: {error}"))?;
    }
    let temporary = output.with_extension(format!("{}.tmp", report.run_id));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Create temporary probe report: {error}"))?;
    let written = file.write_all(&data);
    drop(file);
    let result = written.and_then(|_| std::fs::rename(&temporary, output));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Write probe report: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_argument_is_required_and_unambiguous() {
        assert_eq!(
            parse_output(["--output", "/tmp/probe report.json"].map(OsString::from)).unwrap(),
            PathBuf::from("/tmp/probe report.json")
        );
        for args in [
            vec![],
            vec!["--output"],
            vec!["--other", "path"],
            vec!["--output", ""],
            vec!["--output", "one", "--output", "two"],
        ] {
            assert!(parse_output(args.into_iter().map(OsString::from)).is_err());
        }
    }

    #[test]
    fn response_assessment_preserves_failure_and_identity_distinctions() {
        let response = OfficialPluginTargetLookup {
            plugin_id: "fixed-id".to_string(),
            source_url: "https://z-tools.top/api/market".to_string(),
            source_kind: PluginMarketCatalogSourceKind::Ztools,
            status: OfficialPluginTargetStatus::UnsupportedPlatform,
            plugin: None,
        };
        assert!(assess_response(
            "fixed-id",
            &OfficialPluginTargetStatus::UnsupportedPlatform,
            &response
        )
        .is_ok());
        assert!(
            assess_response("fixed-id", &OfficialPluginTargetStatus::NotFound, &response).is_err()
        );
        assert!(assess_response(
            "different-id",
            &OfficialPluginTargetStatus::UnsupportedPlatform,
            &response
        )
        .is_err());
        let mut wrong_source = response.clone();
        wrong_source.source_url = "https://example.invalid".to_string();
        assert!(assess_response(
            "fixed-id",
            &OfficialPluginTargetStatus::UnsupportedPlatform,
            &wrong_source
        )
        .is_err());
        let mut inconsistent = response;
        inconsistent.status = OfficialPluginTargetStatus::Available;
        assert!(assess_response(
            "fixed-id",
            &OfficialPluginTargetStatus::Available,
            &inconsistent
        )
        .is_err());
    }

    #[test]
    fn partial_report_has_all_fixed_cases_without_claiming_requests_or_acceptance() {
        let mut report = initial_report().unwrap();
        assert_eq!(report.observations.len(), 7);
        assert!(report.observations.iter().all(|row| !row.request_started
            && row.outcome == "not_run"
            && row.normalized_response.is_none()));
        assert!(!report.scope.tauri_ipc && !report.scope.installation_acceptance);
        mark_deadline_skips(&mut report.observations[2..]);
        assert!(report.observations[0].error.is_none());
        assert!(report.observations[2..]
            .iter()
            .all(|row| row.error.is_some() && !row.request_started && row.outcome == "not_run"));
    }

    #[test]
    fn checkpoints_replace_only_the_named_output_and_leave_no_temporary_report() {
        let scratch = tempfile::tempdir().unwrap();
        let output = scratch.path().join("reports/probe.json");
        let mut report = initial_report().unwrap();
        write_report(&output, &report).unwrap();
        report.status = "failed".to_string();
        report.error = Some("synthetic checkpoint failure".to_string());
        write_report(&output, &report).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
        assert_eq!(saved["status"], "failed");
        assert_eq!(saved["error"], "synthetic checkpoint failure");
        assert_eq!(
            std::fs::read_dir(output.parent().unwrap()).unwrap().count(),
            1
        );
    }
}
