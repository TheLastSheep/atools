#![cfg(unix)]

//! One-off, opt-in probe for a plugin child process detached from the Node
//! sidecar's Unix process group. This test intentionally fails when close
//! leaves that child alive; the child has a short self-exit timer, and the
//! failure is emitted only after its exit is observed and recorded.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use atools_plugin::legacy_node::LegacyNodeSession;
use serde_json::{json, Value};
use tempfile::TempDir;

const HELPER_LIFETIME_MS: u64 = 2_500;
const MARKER_TIMEOUT: Duration = Duration::from_secs(1);
const HELPER_EXIT_TIMEOUT: Duration = Duration::from_secs(4);

const FIXTURE_MODULE: &str = r#"
const { spawn } = require('node:child_process');

module.exports = {
  spawnDetached(markerPath, nonce, lifetimeMs) {
    const helper = [
      "const fs = require('node:fs');",
      "const markerPath = process.argv[1];",
      "const nonce = process.argv[2];",
      "const lifetimeMs = Number(process.argv[3]);",
      "const marker = { pid: process.pid, processGroupToken: String(process.pid), nonce };",
      "fs.writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });",
      "setTimeout(() => process.exit(0), lifetimeMs);",
    ].join('\n');
    const child = spawn(process.execPath, ['-e', helper, markerPath, nonce, String(lifetimeMs)], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', TMPDIR: process.env.TMPDIR || '' },
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', error => process.stderr.write(`detached-helper-spawn-error: ${error.message}\n`));
    child.unref();
    if (!child.pid) throw new Error('detached helper did not return a PID');
    return [process.pid, child.pid, process.versions.node, process.execPath, nonce];
  },
};
"#;

#[derive(Debug, serde::Serialize)]
struct ProcessObservation {
    pid: i32,
    kill_zero: &'static str,
    errno: Option<i32>,
    process_group: Option<i32>,
    process_group_errno: Option<i32>,
}

#[derive(Debug, serde::Serialize)]
struct ProbeReport {
    schema_version: u32,
    run_nonce: String,
    command: String,
    node_binary: String,
    node_version: Option<String>,
    sidecar_pid: Option<i32>,
    sidecar_group_before_close: Option<i32>,
    helper_pid: Option<i32>,
    helper_group_before_close: Option<i32>,
    helper_marker: Option<Value>,
    sidecar_close_result: String,
    sidecar_status_after_close: Option<String>,
    sidecar_after_close: Option<ProcessObservation>,
    helper_immediately_after_close: Option<ProcessObservation>,
    helper_eventually_after_close: Option<ProcessObservation>,
    helper_eventual_exit_observed: bool,
    helper_wait_ms: Option<u128>,
    helper_lifetime_ms: u64,
    existing_test_coverage: &'static str,
    error: Option<String>,
    report_path: Option<String>,
}

fn pid_observation(pid: i32) -> ProcessObservation {
    let result = unsafe { libc::kill(pid, 0) };
    let (kill_zero, errno) = if result == 0 {
        ("present", None)
    } else {
        let errno = std::io::Error::last_os_error().raw_os_error();
        match errno {
            Some(libc::ESRCH) => ("ESRCH", errno),
            Some(libc::EPERM) => ("EPERM", errno),
            _ => ("error", errno),
        }
    };
    let group = unsafe { libc::getpgid(pid) };
    let (process_group, process_group_errno) = if group >= 0 {
        (Some(group), None)
    } else {
        (None, std::io::Error::last_os_error().raw_os_error())
    };
    ProcessObservation {
        pid,
        kill_zero,
        errno,
        process_group,
        process_group_errno,
    }
}

fn process_is_gone(observation: &ProcessObservation) -> bool {
    observation.kill_zero == "ESRCH"
}

async fn wait_for_marker(path: &Path) -> Result<Value, String> {
    let started = Instant::now();
    while started.elapsed() < MARKER_TIMEOUT {
        match fs::read(path) {
            Ok(bytes) => {
                return serde_json::from_slice(&bytes)
                    .map_err(|error| format!("helper marker JSON invalid: {error}"));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => return Err(format!("helper marker read failed: {error}")),
        }
    }
    Err("helper marker was not written before its deadline".to_string())
}

async fn wait_for_pid_gone(pid: i32) -> (ProcessObservation, u128) {
    let started = Instant::now();
    let deadline = started + HELPER_EXIT_TIMEOUT;
    loop {
        let observation = pid_observation(pid);
        if process_is_gone(&observation) || Instant::now() >= deadline {
            return (observation, started.elapsed().as_millis());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn expected_product_node() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/binaries/node-aarch64-apple-darwin")
        .canonicalize()
        .expect("canonical product Node binary")
}

fn assert_product_node_override() -> PathBuf {
    let expected = expected_product_node();
    let configured = std::env::var_os("ATOOLS_NODE_BINARY")
        .map(PathBuf::from)
        .expect("run this opt-in probe with ATOOLS_NODE_BINARY set to product Node");
    let configured = configured
        .canonicalize()
        .expect("canonical ATOOLS_NODE_BINARY override");
    assert_eq!(configured, expected, "probe must use the bundled product Node binary");
    expected
}

fn run_nonce() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock after Unix epoch")
        .as_nanos();
    format!("detached-{}-{nanos}", std::process::id())
}

fn write_report(report: &mut ProbeReport) -> PathBuf {
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../output/detached-helper-repro");
    fs::create_dir_all(&output).expect("create dedicated detached-helper repro output directory");
    let output = output.canonicalize().expect("canonical detached-helper repro output directory");
    let path = output.join(format!("{}.json", report.run_nonce));
    report.report_path = Some(path.display().to_string());
    fs::write(
        &path,
        serde_json::to_vec_pretty(report).expect("serialize detached-helper probe report"),
    )
    .expect("persist detached-helper probe report before assertions");
    path
}

#[tokio::test]
#[ignore = "explicit production Node detached-child cleanup probe; writes only isolated temporary fixture files and one report"]
async fn production_session_close_should_reap_detached_product_node_helper() {
    let node_binary = assert_product_node_override();
    let nonce = run_nonce();
    let temp = TempDir::new().expect("create isolated plugin fixture");
    let plugin_dir = temp.path();
    let entry = plugin_dir.join("preload.cjs");
    let module_path = plugin_dir.join("detached-helper.cjs");
    let marker_path = plugin_dir.join("helper-marker.json");
    fs::write(&entry, "throw new Error('preload remains in UI fixture');\n")
        .expect("write inert preload anchor");
    fs::write(&module_path, FIXTURE_MODULE).expect("write fixed detached-helper fixture module");

    let mut report = ProbeReport {
        schema_version: 1,
        run_nonce: nonce.clone(),
        command: format!(
            "ATOOLS_NODE_BINARY={} cargo test --locked --offline --jobs 2 -p atools-plugin --test legacy_node_detached_spawn_cleanup_probe -- --ignored --nocapture",
            node_binary.display()
        ),
        node_binary: node_binary.display().to_string(),
        node_version: None,
        sidecar_pid: None,
        sidecar_group_before_close: None,
        helper_pid: None,
        helper_group_before_close: None,
        helper_marker: None,
        sidecar_close_result: "not_started".to_string(),
        sidecar_status_after_close: None,
        sidecar_after_close: None,
        helper_immediately_after_close: None,
        helper_eventually_after_close: None,
        helper_eventual_exit_observed: false,
        helper_wait_ms: None,
        helper_lifetime_ms: HELPER_LIFETIME_MS,
        existing_test_coverage: "legacy_node_descendant_cleanup_tests.rs exercises detached:false helpers which remain in the sidecar setsid group; this probe exercises detached:true and a separate group.",
        error: None,
        report_path: None,
    };

    let session = match LegacyNodeSession::start("detached-helper-probe", plugin_dir, Path::new("preload.cjs")).await {
        Ok(session) => session,
        Err(error) => {
            report.error = Some(format!("production sidecar start failed: {error}"));
            let report_path = write_report(&mut report);
            panic!("{error}; probe report: {}", report_path.display());
        }
    };

    let request_result = async {
        let module = session
            .request("require", json!({ "specifier": "./detached-helper.cjs" }))
            .await
            .map_err(|error| format!("require fixture module: {error}"))?;
        let method = session
            .request("get", json!({ "handleId": module["handleId"], "property": "spawnDetached" }))
            .await
            .map_err(|error| format!("get spawnDetached: {error}"))?;
        session
            .request(
                "call",
                json!({
                    "handleId": method["handleId"],
                    "args": [
                        { "kind": "value", "value": marker_path.display().to_string() },
                        { "kind": "value", "value": nonce.clone() },
                        { "kind": "value", "value": HELPER_LIFETIME_MS },
                    ]
                }),
            )
            .await
            .map_err(|error| format!("call spawnDetached: {error}"))
    }
    .await;

    let mut root_pid = None;
    let mut helper_pid = None;
    match request_result {
        Ok(result) => {
            let values = result["items"].as_array();
            match values {
                Some(values) if values.len() == 5 => {
                    root_pid = values[0]["value"].as_i64().map(|value| value as i32);
                    helper_pid = values[1]["value"].as_i64().map(|value| value as i32);
                    report.node_version = values[2]["value"].as_str().map(str::to_string);
                    let actual_binary = values[3]["value"].as_str().unwrap_or_default();
                    if Path::new(actual_binary).canonicalize().ok().as_ref() != Some(&node_binary) {
                        report.error = Some(format!("sidecar Node binary did not match explicit product binary: {actual_binary}"));
                    }
                    if values[4]["value"].as_str() != Some(nonce.as_str()) {
                        report.error = Some("spawn response nonce did not match the fixed probe token".to_string());
                    }
                }
                _ => report.error = Some(format!("unexpected spawnDetached response: {result}")),
            }
        }
        Err(error) => report.error = Some(error),
    }
    report.sidecar_pid = root_pid;
    report.sidecar_group_before_close = root_pid.and_then(process_group);

    match wait_for_marker(&marker_path).await {
        Ok(marker) => {
            report.helper_marker = Some(marker.clone());
            let marker_pid = marker["pid"].as_i64().map(|value| value as i32);
            let marker_group_token = marker["processGroupToken"].as_str();
            let marker_nonce = marker["nonce"].as_str();
            if helper_pid.is_none() {
                helper_pid = marker_pid;
            }
            if marker_pid != helper_pid
                || marker_pid.is_none()
                || marker_group_token != marker_pid.map(|pid| pid.to_string()).as_deref()
                || marker_nonce != Some(nonce.as_str())
            {
                report.error = Some(format!("helper marker identity did not match spawn result: {marker}"));
            }
        }
        Err(error) => {
            if report.error.is_none() {
                report.error = Some(error);
            }
        }
    }
    report.helper_pid = helper_pid;
    report.helper_group_before_close = helper_pid.and_then(process_group);

    let close_result = session.stop().await;
    report.sidecar_close_result = match &close_result {
        Ok(()) => "ok".to_string(),
        Err(error) => format!("error: {error}"),
    };
    report.sidecar_status_after_close = Some(format!("{:?}", session.status()));
    report.sidecar_after_close = root_pid.map(pid_observation);
    report.helper_immediately_after_close = helper_pid.map(pid_observation);

    if let Some(pid) = helper_pid {
        let (observation, waited_ms) = wait_for_pid_gone(pid).await;
        report.helper_wait_ms = Some(waited_ms);
        report.helper_eventual_exit_observed = process_is_gone(&observation);
        report.helper_eventually_after_close = Some(observation);
    } else {
        // If the RPC failed after starting the helper but before returning its
        // PID, allow the fixed self-exit timer to elapse before dropping scratch.
        tokio::time::sleep(Duration::from_millis(HELPER_LIFETIME_MS + 500)).await;
    }

    let report_path = write_report(&mut report);
    eprintln!("detached-helper-probe report={}", report_path.display());
    eprintln!("detached-helper-probe state={}", serde_json::to_string(&report).expect("serialize report"));

    assert!(report.error.is_none(), "production Node helper identity checks failed: {:?}", report.error);
    assert_eq!(report.node_version.as_deref(), Some("22.23.3"), "probe must execute the pinned product Node runtime");
    assert_eq!(report.sidecar_close_result, "ok", "production sidecar close must complete");
    assert_eq!(report.sidecar_status_after_close.as_deref(), Some("Stopped"), "recorded root sidecar must be Stopped");
    assert!(
        report.sidecar_after_close.as_ref().is_some_and(process_is_gone),
        "production close must reap the sidecar root before evaluating detached helper cleanup"
    );
    assert_eq!(report.helper_group_before_close, report.helper_pid, "detached helper must own a separate process group");
    assert!(report.helper_eventual_exit_observed, "helper's bounded self-exit must be observed before test completion");
    assert!(
        report.helper_immediately_after_close.as_ref().is_some_and(process_is_gone),
        "production close left its detached helper alive; bounded self-exit was confirmed and cleanup completed; report: {}",
        report_path.display()
    );
}

fn process_group(pid: i32) -> Option<i32> {
    let group = unsafe { libc::getpgid(pid) };
    (group >= 0).then_some(group)
}
