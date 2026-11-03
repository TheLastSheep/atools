#![cfg(all(target_os = "macos", target_arch = "aarch64"))]

//! Opt-in real LegacyNodeSession acceptance for Harris's unchanged FormatConverter
//! `runProcess`. The child process parent PID proves detached spawn is owned by
//! the Rust host rather than the Node sidecar; short fixed Node scripts only.

use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use atools_plugin::legacy_node::LegacyNodeSession;
use atools_plugin::sidecar::SidecarStatus;
use serde_json::{json, Value};
use tempfile::TempDir;

const CHILD_CASE_ENV: &str = "ATOOLS_TASK20_HARRIS_RUN_PROCESS_CASE";
const NODE_BINARY_ENV: &str = "ATOOLS_NODE_BINARY";
const ORIGINAL_ENGINE_UTILS_SHA256: &str =
    "26695256618d6cbff561d841c58a79b03833d98f2043514b9e8d1e9e7b8b3f5c";
const PRODUCT_NODE_VERSION: &str = "22.23.3";
const SOURCE_PATH: &str =
    "/Users/harris/Desktop/ZTools-plugins/plugins/format-converter/dist/preload/engine-utils.cjs";
const MARKER_TIMEOUT: Duration = Duration::from_secs(2);
const PROMISE_TIMEOUT: Duration = Duration::from_secs(4);
// Must finish before the helper's 2.6s fallback can mask a broken 1s timeout kill.
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_millis(800);

const RUN_PROCESS_FIXTURE: &str = include_str!("fixtures/harris_format_converter_run_process.cjs");

fn product_node_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/binaries/node-aarch64-apple-darwin")
        .canonicalize()
        .expect("canonical product Node 22.23.3 executable")
}

fn enter_isolated_case(test_name: &str) -> Option<PathBuf> {
    match std::env::var(CHILD_CASE_ENV) {
        Ok(value) => {
            assert_eq!(value, "harris-run-process", "unexpected isolated case");
            let expected = product_node_binary();
            let configured = std::env::var_os(NODE_BINARY_ENV)
                .map(PathBuf::from)
                .expect("isolated test process must select product Node");
            assert_eq!(
                configured.canonicalize().expect("canonical Node override"),
                expected,
                "LegacyNodeSession must use the pinned product Node"
            );
            Some(expected)
        }
        Err(std::env::VarError::NotPresent) => {
            let previous_selector = std::env::var_os(NODE_BINARY_ENV);
            let node_binary = product_node_binary();
            let status = Command::new(std::env::current_exe().expect("test executable path"))
                .args(["--exact", test_name, "--ignored", "--nocapture"])
                .env(CHILD_CASE_ENV, "harris-run-process")
                .env(NODE_BINARY_ENV, &node_binary)
                .stdin(Stdio::null())
                .status()
                .expect("start isolated Rust test process");
            assert_eq!(
                std::env::var_os(NODE_BINARY_ENV),
                previous_selector,
                "the parent test process environment remains unchanged"
            );
            assert!(
                status.success(),
                "isolated Harris runProcess case failed: {status}"
            );
            None
        }
        Err(error) => panic!("invalid isolated-case environment: {error}"),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn verify_original_pin(source: &[u8]) {
    let pin_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../output/managed-node-children/original-format-converter-before-main.json");
    let pins: Value =
        serde_json::from_slice(&fs::read(pin_path).expect("read original package pins"))
            .expect("parse original package pins");
    assert_eq!(
        pins["files"]["preload/engine-utils.cjs"]["sha256"], ORIGINAL_ENGINE_UTILS_SHA256,
        "the pinned artifact must identify the expected original source"
    );
    assert_eq!(sha256_hex(source), ORIGINAL_ENGINE_UTILS_SHA256);
}

fn fixture(original_bytes: &[u8]) -> TempDir {
    let temp = tempfile::tempdir().expect("private temporary plugin root");
    fs::write(temp.path().join("preload.cjs"), "module.exports = {};\n")
        .expect("write inert preload anchor");
    let engine_utils = temp.path().join("engine-utils.cjs");
    fs::write(&engine_utils, original_bytes).expect("copy original engine-utils bytes");
    fs::set_permissions(&engine_utils, fs::Permissions::from_mode(0o444))
        .expect("make only the temporary original copy read-only");
    fs::write(
        temp.path().join("harris-run-process.cjs"),
        RUN_PROCESS_FIXTURE,
    )
    .expect("write fixed process fixture");
    assert_eq!(
        fs::read(engine_utils).expect("read temporary engine-utils copy"),
        original_bytes,
        "the temporary module must remain byte-identical"
    );
    temp
}

async fn require_module(session: &LegacyNodeSession) -> Result<Value, String> {
    session
        .request(
            "require",
            json!({ "specifier": "./harris-run-process.cjs" }),
        )
        .await
        .map_err(|error| format!("require fixed Harris runner: {error}"))
}

async fn get_property(
    session: &LegacyNodeSession,
    object: &Value,
    property: &str,
) -> Result<Value, String> {
    session
        .request(
            "get",
            json!({ "handleId": object["handleId"], "property": property }),
        )
        .await
        .map_err(|error| format!("read {property}: {error}"))
}

async fn call_method(
    session: &LegacyNodeSession,
    object: &Value,
    property: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let method = get_property(session, object, property).await?;
    session
        .request(
            "call",
            json!({ "handleId": method["handleId"], "args": args }),
        )
        .await
        .map_err(|error| format!("call {property}: {error}"))
}

fn argument(value: impl Into<Value>) -> Value {
    json!({ "kind": "value", "value": value.into() })
}

fn handle_id(value: &Value) -> Result<i64, String> {
    value["handleId"]
        .as_i64()
        .ok_or_else(|| "expected a Node object handle".to_string())
}

async fn poll_promise(
    session: &LegacyNodeSession,
    promise: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = handle_id(promise)?;
    let deadline = Instant::now() + timeout;
    loop {
        let state = session
            .request("pollPromise", json!({ "handleId": id }))
            .await
            .map_err(|error| format!("poll original runProcess Promise: {error}"))?;
        match state["state"].as_str() {
            Some("fulfilled") => return Ok(state["value"].clone()),
            Some("rejected") => return Err(format!("Promise rejected: {}", state["error"])),
            Some("pending") => {}
            other => return Err(format!("unexpected Promise state {other:?}")),
        }
        if Instant::now() >= deadline {
            return Err("original runProcess Promise exceeded its fixture deadline".into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn get_value_field(
    session: &LegacyNodeSession,
    object: &Value,
    field: &str,
) -> Result<Value, String> {
    let encoded = get_property(session, object, field).await?;
    if encoded["kind"] != "value" {
        return Err(format!("field {field} is not a primitive value: {encoded}"));
    }
    Ok(encoded["value"].clone())
}

async fn wait_for_marker(path: &Path) -> Result<Value, String> {
    let deadline = Instant::now() + MARKER_TIMEOUT;
    loop {
        match fs::read(path) {
            Ok(bytes) => {
                return serde_json::from_slice(&bytes)
                    .map_err(|error| format!("invalid child marker: {error}"));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("child marker read failed: {error}")),
        }
        if Instant::now() >= deadline {
            return Err("child marker was not written before its deadline".into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn parent_pid(marker: &Value) -> Result<i32, String> {
    marker["ppid"]
        .as_i64()
        .map(|pid| pid as i32)
        .filter(|pid| *pid > 0)
        .ok_or_else(|| format!("child marker has no valid parent pid: {marker}"))
}

fn child_pid(marker: &Value) -> Result<i32, String> {
    marker["pid"]
        .as_i64()
        .map(|pid| pid as i32)
        .filter(|pid| *pid > 0)
        .ok_or_else(|| format!("child marker has no valid pid: {marker}"))
}

fn assert_host_owned_child(marker: &Value, sidecar_pid: i32) -> Result<i32, String> {
    let pid = child_pid(marker)?;
    let ppid = parent_pid(marker)?;
    let host_pid = std::process::id() as i32;
    if ppid != host_pid || ppid == sidecar_pid {
        return Err(format!(
            "detached child was not spawned by the Rust manager: child={pid}, ppid={ppid}, host={host_pid}, sidecar={sidecar_pid}"
        ));
    }
    let group = unsafe { libc::getpgid(pid) };
    if group != pid {
        return Err(format!(
            "detached child process group mismatch: pid={pid}, group={group}"
        ));
    }
    Ok(pid)
}

fn process_is_gone(pid: i32) -> bool {
    if unsafe { libc::kill(pid, 0) } == 0 {
        return false;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

async fn wait_for_pid_gone(pid: i32) -> bool {
    let deadline = Instant::now() + CHILD_EXIT_TIMEOUT;
    loop {
        if process_is_gone(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn verify_run_process(
    session: &LegacyNodeSession,
    module: &Value,
    node_binary: &Path,
    temp: &TempDir,
) -> Result<(), String> {
    let runtime = call_method(session, module, "runtimeInfo", vec![]).await?;
    if runtime["items"][0]["value"] != PRODUCT_NODE_VERSION {
        return Err(format!("unexpected sidecar Node version: {runtime}"));
    }
    let sidecar_pid = runtime["items"][2]["value"]
        .as_i64()
        .ok_or_else(|| "sidecar PID missing from runtimeInfo".to_string())?
        as i32;
    let sidecar_path = runtime["items"][1]["value"]
        .as_str()
        .ok_or_else(|| "sidecar execPath missing from runtimeInfo".to_string())?;
    if Path::new(sidecar_path).canonicalize().ok().as_deref() != Some(node_binary) {
        return Err(format!(
            "sidecar used unexpected Node executable: {sidecar_path}"
        ));
    }

    let output_marker = temp.path().join("run-process-output-marker.json");
    let output_promise = call_method(
        session,
        module,
        "runOutput",
        vec![
            argument(node_binary.display().to_string()),
            argument(output_marker.display().to_string()),
        ],
    )
    .await?;
    let output_marker_value = wait_for_marker(&output_marker).await?;
    let output_pid = assert_host_owned_child(&output_marker_value, sidecar_pid)?;
    let output = poll_promise(session, &output_promise, PROMISE_TIMEOUT).await?;
    if get_value_field(session, &output, "exitCode").await? != json!(7) {
        return Err(format!(
            "unexpected nonzero exit result from original runProcess: {output}"
        ));
    }
    if get_value_field(session, &output, "stdout").await?
        != json!(format!(
            "{}\nHARRIS_RUN_PROCESS_STDOUT\n",
            serde_json::to_string(&output_marker_value).unwrap()
        ))
    {
        return Err("runProcess stdout capture did not preserve marker + text".into());
    }
    if get_value_field(session, &output, "stderr").await? != json!("HARRIS_RUN_PROCESS_STDERR\n") {
        return Err("runProcess stderr capture did not preserve fixture text".into());
    }
    if !wait_for_pid_gone(output_pid).await {
        return Err(format!(
            "completed detached child PID {output_pid} was not reaped"
        ));
    }

    let timeout_marker = temp.path().join("run-process-timeout-marker.json");
    let timeout_promise = call_method(
        session,
        module,
        "runTimeout",
        vec![
            argument(node_binary.display().to_string()),
            argument(timeout_marker.display().to_string()),
        ],
    )
    .await?;
    let timeout_marker_value = wait_for_marker(&timeout_marker).await?;
    let timeout_pid = assert_host_owned_child(&timeout_marker_value, sidecar_pid)?;
    let timeout_result = poll_promise(session, &timeout_promise, PROMISE_TIMEOUT).await?;
    if get_value_field(session, &timeout_result, "code").await? != json!("ENGINE_TIMEOUT") {
        return Err(format!(
            "original timeout contract changed: {timeout_result}"
        ));
    }
    if !wait_for_pid_gone(timeout_pid).await {
        return Err(format!(
            "original runProcess timeout did not reap child PID {timeout_pid}"
        ));
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires opt-in macOS arm64, local AF_UNIX transport, original Harris package, and product Node; no OfficeCLI is launched"]
async fn product_node_harris_original_run_process_uses_managed_child_io_exit_and_timeout_kill() {
    let Some(node_binary) = enter_isolated_case(
        "product_node_harris_original_run_process_uses_managed_child_io_exit_and_timeout_kill",
    ) else {
        return;
    };

    let original_path = Path::new(SOURCE_PATH);
    let original_bytes = fs::read(original_path).expect("read unchanged Harris engine-utils.cjs");
    verify_original_pin(&original_bytes);
    let temp = fixture(&original_bytes);
    let session = LegacyNodeSession::start(
        "harris-format-converter-run-process",
        temp.path(),
        Path::new("preload.cjs"),
    )
    .await
    .expect("start real product Node LegacyNodeSession");

    let result = match require_module(&session).await {
        Ok(module) => verify_run_process(&session, &module, &node_binary, &temp).await,
        Err(error) => Err(error),
    };
    let close = session.stop().await;
    let unchanged_after = fs::read(original_path).expect("re-read original engine-utils.cjs");
    let copy_after = fs::read(temp.path().join("engine-utils.cjs"))
        .expect("re-read temporary original module copy");

    close.expect("strict LegacyNodeSession shutdown and managed-child cleanup");
    assert!(
        matches!(
            session.status(),
            SidecarStatus::Stopped | SidecarStatus::Crashed
        ),
        "LegacyNodeSession must be terminal after stop"
    );
    assert_eq!(sha256_hex(&unchanged_after), ORIGINAL_ENGINE_UTILS_SHA256);
    assert_eq!(sha256_hex(&copy_after), ORIGINAL_ENGINE_UTILS_SHA256);
    result.unwrap_or_else(|error| panic!("Harris original runProcess acceptance failed: {error}"));
}
