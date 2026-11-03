//! Shared bounded helpers for ignored LegacyNodeSession managed-child probes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use atools_plugin::legacy_node::LegacyNodeSession;
use atools_plugin::sidecar::SidecarStatus;
use serde_json::{json, Value};
use tempfile::TempDir;

const CHILD_CASE_ENV: &str = "ATOOLS_TASK20_MANAGED_CHILD_CASE";
const NODE_BINARY_ENV: &str = "ATOOLS_NODE_BINARY";
const PRODUCT_NODE_VERSION: &str = "22.23.3";
pub(super) const REPORT_TIMEOUT: Duration = Duration::from_secs(3);
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) fn product_node_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/binaries/node-aarch64-apple-darwin")
        .canonicalize()
        .expect("canonical bundled Node 22.23.3 executable")
}

pub(super) fn enter_isolated_case(test_name: &str, case: &str) -> Option<PathBuf> {
    match std::env::var(CHILD_CASE_ENV) {
        Ok(value) => {
            assert_eq!(value, case, "unexpected isolated test case");
            let expected = product_node_binary();
            let configured = std::env::var_os(NODE_BINARY_ENV)
                .map(PathBuf::from)
                .expect("isolated test process must select the pinned product Node");
            assert_eq!(
                configured.canonicalize().expect("canonical Node override"),
                expected,
                "the sidecar must use the bundled product Node"
            );
            Some(expected)
        }
        Err(std::env::VarError::NotPresent) => {
            let previous_selector = std::env::var_os(NODE_BINARY_ENV);
            let node_binary = product_node_binary();
            let status = Command::new(std::env::current_exe().expect("test executable path"))
                .args(["--exact", test_name, "--ignored", "--nocapture"])
                .env(CHILD_CASE_ENV, case)
                .env(NODE_BINARY_ENV, &node_binary)
                .stdin(Stdio::null())
                .status()
                .expect("start isolated test harness process");
            assert_eq!(
                std::env::var_os(NODE_BINARY_ENV),
                previous_selector,
                "the parent test process Node selector environment must stay untouched"
            );
            assert!(
                status.success(),
                "isolated {case} case failed with {status}"
            );
            None
        }
        Err(error) => panic!("invalid isolated test case environment: {error}"),
    }
}

pub(super) fn fixture(source_path: &str, source: &str) -> TempDir {
    let temp = tempfile::tempdir().expect("private plugin fixture directory");
    fs::write(temp.path().join("preload.cjs"), "module.exports = {};\n")
        .expect("write inert preload anchor");
    let fixture_path = temp.path().join(source_path);
    if let Some(parent) = fixture_path.parent() {
        fs::create_dir_all(parent).expect("create fixture module parent");
    }
    fs::write(fixture_path, source).expect("write fixed plugin helper module");
    temp
}

pub(super) async fn start_session(temp: &TempDir) -> LegacyNodeSession {
    LegacyNodeSession::start(
        "managed-child-integration",
        temp.path(),
        Path::new("preload.cjs"),
    )
    .await
    .expect("start real product Node LegacyNodeSession")
}

pub(super) async fn require_module(session: &LegacyNodeSession, path: &str) -> Value {
    session
        .request("require", json!({ "specifier": path }))
        .await
        .expect("require fixed scratch plugin module")
}

pub(super) async fn get_property(
    session: &LegacyNodeSession,
    object: &Value,
    property: &str,
) -> Value {
    session
        .request(
            "get",
            json!({ "handleId": object["handleId"], "property": property }),
        )
        .await
        .expect("read fixed plugin property")
}

pub(super) async fn call_method(
    session: &LegacyNodeSession,
    object: &Value,
    property: &str,
    args: Vec<Value>,
) -> Result<Value, atools_plugin::sidecar::SidecarError> {
    let method = get_property(session, object, property).await;
    session
        .request(
            "call",
            json!({ "handleId": method["handleId"], "args": args }),
        )
        .await
}

pub(super) fn argument(value: impl Into<Value>) -> Value {
    json!({ "kind": "value", "value": value.into() })
}

pub(super) fn array_item_number(value: &Value, index: usize) -> Option<i64> {
    value
        .get("items")?
        .as_array()?
        .get(index)?
        .get("value")?
        .as_i64()
}

pub(super) fn array_item_string(value: &Value, index: usize) -> Option<&str> {
    value
        .get("items")?
        .as_array()?
        .get(index)?
        .get("value")?
        .as_str()
}

pub(super) async fn assert_product_runtime(
    session: &LegacyNodeSession,
    module: &Value,
    expected: &Path,
) {
    let runtime = call_method(session, module, "runtimeInfo", vec![])
        .await
        .expect("read sidecar Node runtime identity");
    assert_eq!(array_item_string(&runtime, 0), Some(PRODUCT_NODE_VERSION));
    let exec_path = Path::new(array_item_string(&runtime, 1).expect("Node execPath"))
        .canonicalize()
        .expect("canonical sidecar Node execPath");
    assert_eq!(exec_path, expected);
}

pub(super) async fn wait_for_report(path: &Path, timeout: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match fs::read(path) {
            Ok(bytes) => {
                return serde_json::from_slice(&bytes)
                    .map_err(|error| format!("invalid helper report JSON: {error}"));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("helper report read failed: {error}")),
        }
        if Instant::now() >= deadline {
            return Err("helper report did not arrive before its deadline".into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub(super) fn process_group(pid: i32) -> Option<i32> {
    if pid <= 0 {
        return None;
    }
    let group = unsafe { libc::getpgid(pid) };
    (group >= 0).then_some(group)
}

pub(super) fn process_is_gone(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    if unsafe { libc::kill(pid, 0) } == 0 {
        return false;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

pub(super) fn process_cpu_time() -> Duration {
    let mut usage = unsafe { std::mem::zeroed::<libc::rusage>() };
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    assert_eq!(result, 0, "getrusage(RUSAGE_SELF) should be available");
    let user = timeval_duration(usage.ru_utime);
    let system = timeval_duration(usage.ru_stime);
    user + system
}

fn timeval_duration(value: libc::timeval) -> Duration {
    Duration::new(value.tv_sec as u64, (value.tv_usec as u32) * 1_000)
}

pub(super) async fn wait_for_pid_gone(pid: i32) -> bool {
    wait_for_pid_gone_with(pid, PROCESS_EXIT_TIMEOUT).await
}

pub(super) async fn wait_for_pid_gone_with(pid: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if process_is_gone(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub(super) async fn wait_for_terminal(session: &LegacyNodeSession) -> bool {
    let deadline = Instant::now() + PROCESS_EXIT_TIMEOUT;
    while session.status() == SidecarStatus::Running && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    matches!(
        session.status(),
        SidecarStatus::Stopped | SidecarStatus::Crashed
    )
}

pub(super) async fn poll_promise(
    session: &LegacyNodeSession,
    promise: &Value,
) -> Result<Value, String> {
    let handle_id = promise["handleId"]
        .as_i64()
        .ok_or_else(|| "plugin call did not return a Promise handle".to_string())?;
    let deadline = Instant::now() + REPORT_TIMEOUT;
    loop {
        let state = session
            .request("pollPromise", json!({ "handleId": handle_id }))
            .await
            .map_err(|error| format!("poll plugin Promise: {error}"))?;
        match state["state"].as_str() {
            Some("fulfilled") => return Ok(state["value"].clone()),
            Some("rejected") => return Err(format!("plugin Promise rejected: {}", state["error"])),
            Some("pending") => {}
            other => return Err(format!("unexpected Promise state: {other:?}")),
        }
        if Instant::now() >= deadline {
            return Err("plugin Promise did not settle before its deadline".into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub(super) async fn get_resolved_field(
    session: &LegacyNodeSession,
    object: &Value,
    field: &str,
) -> Result<Value, String> {
    let handle_id = object["handleId"]
        .as_i64()
        .ok_or_else(|| "resolved Promise value was not an object handle".to_string())?;
    session
        .request("get", json!({ "handleId": handle_id, "property": field }))
        .await
        .map_err(|error| format!("read resolved Promise field {field}: {error}"))
}
