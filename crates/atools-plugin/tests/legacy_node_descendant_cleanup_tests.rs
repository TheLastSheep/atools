#![cfg(unix)]

use std::path::Path;
use std::time::{Duration, Instant};

use atools_plugin::legacy_node::LegacyNodeSession;
use atools_plugin::sidecar::SidecarStatus;
use serde_json::{json, Value};
use tempfile::TempDir;

const CHILD_HELPER: &str = r#"
  const { spawn } = require('node:child_process');

  function startChild(marker, inheritStdio) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      stdio: inheritStdio ? 'inherit' : 'ignore',
      detached: false,
    });
    child.unref();
    return [marker, process.pid, child.pid];
  }

  module.exports = {
    startChild,
    exitNaturally() {
      setImmediate(() => process.exit(0));
      return 'exit-scheduled';
    },
    crash() {
      setImmediate(() => process.kill(process.pid, 'SIGKILL'));
      return 'kill-scheduled';
    },
  };
"#;

const PRELOAD_ANCHOR: &str = "throw new Error('preload stays in the UI');";
const ROOT_EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(3);

fn fixture() -> TempDir {
    let temp = tempfile::tempdir().expect("scratch plugin directory");
    std::fs::write(temp.path().join("preload.cjs"), PRELOAD_ANCHOR).expect("write preload anchor");
    std::fs::write(temp.path().join("helper.cjs"), CHILD_HELPER).expect("write helper");
    temp
}

async fn start_session(temp: &TempDir, marker: &'static str) -> LegacyNodeSession {
    LegacyNodeSession::start(marker, temp.path(), Path::new("preload.cjs"))
        .await
        .expect("start real Node sidecar from scratch preload anchor")
}

async fn require_helper(session: &LegacyNodeSession) -> Value {
    session
        .request("require", json!({ "specifier": "./helper.cjs" }))
        .await
        .expect("require scratch helper")
}

async fn get_property(session: &LegacyNodeSession, helper: &Value, property: &str) -> Value {
    session
        .request(
            "get",
            json!({ "handleId": helper["handleId"], "property": property }),
        )
        .await
        .expect("get helper method")
}

async fn call_method(session: &LegacyNodeSession, method: &Value, args: Vec<Value>) -> Value {
    session
        .request(
            "call",
            json!({ "handleId": method["handleId"], "args": args }),
        )
        .await
        .expect("call helper method")
}

struct OwnedDescendant {
    root_pid: i32,
    child_pid: i32,
}

impl OwnedDescendant {
    fn new(marker: &'static str, root_pid: i32, child_pid: i32) -> Self {
        eprintln!(
            "legacy-node-descendant marker={marker} root_pid={root_pid} child_pid={child_pid}"
        );
        Self {
            root_pid,
            child_pid,
        }
    }

    fn is_in_owned_process_group(&self) -> bool {
        self.root_pid > 0
            && self.child_pid > 0
            && self.child_pid != self.root_pid
            && process_group(self.root_pid) == Some(self.root_pid)
            && process_group(self.child_pid) == Some(self.root_pid)
    }
}

impl Drop for OwnedDescendant {
    fn drop(&mut self) {
        // Only signal the exact helper-reported PID while it remains in this
        // sidecar's setsid process group. This also covers red-test failures.
        if self.root_pid > 0
            && self.child_pid > 0
            && self.child_pid != self.root_pid
            && process_group(self.child_pid) == Some(self.root_pid)
        {
            unsafe {
                libc::kill(self.child_pid, libc::SIGKILL);
            }
        }
    }
}

fn process_group(pid: i32) -> Option<i32> {
    if pid <= 0 {
        return None;
    }
    let group = unsafe { libc::getpgid(pid) };
    (group >= 0).then_some(group)
}

fn process_is_alive(pid: i32) -> bool {
    pid > 0 && unsafe { libc::kill(pid, 0) == 0 }
}

async fn start_owned_descendant(
    session: &LegacyNodeSession,
    marker: &'static str,
    inherit_stdio: bool,
) -> OwnedDescendant {
    let helper = require_helper(session).await;
    let method = get_property(session, &helper, "startChild").await;
    let result = call_method(
        session,
        &method,
        vec![
            json!({ "kind": "value", "value": marker }),
            json!({ "kind": "value", "value": inherit_stdio }),
        ],
    )
    .await;
    let items = result["items"]
        .as_array()
        .expect("startChild returns marker and two PIDs as an array");
    let root_pid = items[1]["value"].as_i64().expect("Node helper root PID") as i32;
    let child_pid = items[2]["value"].as_i64().expect("spawned helper PID") as i32;
    let owned = OwnedDescendant::new(marker, root_pid, child_pid);
    assert_eq!(items[0]["value"], marker);
    owned
}

async fn request_root_exit(session: &LegacyNodeSession, method_name: &str, expected: &str) {
    let helper = require_helper(session).await;
    let method = get_property(session, &helper, method_name).await;
    let result = call_method(session, &method, vec![]).await;
    assert_eq!(result, json!({ "kind": "value", "value": expected }));
}

async fn wait_until_root_terminal(session: &LegacyNodeSession, timeout: Duration) -> bool {
    tokio::time::timeout(timeout, async {
        while session.status() == SidecarStatus::Running {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

async fn wait_for_owned_process_group(owned: &OwnedDescendant) -> bool {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !owned.is_in_owned_process_group() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

async fn wait_until_pid_gone(pid: i32) -> bool {
    let started = Instant::now();
    while started.elapsed() < CHILD_EXIT_TIMEOUT {
        if !process_is_alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    !process_is_alive(pid)
}

async fn natural_exit_must_reap_descendant(method: &str, response: &str, marker: &'static str) {
    let temp = fixture();
    let session = start_session(&temp, marker).await;
    let owned = start_owned_descendant(&session, marker, false).await;
    assert!(
        wait_for_owned_process_group(&owned).await,
        "spawned helper must inherit the setsid process group (marker={marker}, root_pid={}, child_pid={})",
        owned.root_pid,
        owned.child_pid
    );

    request_root_exit(&session, method, response).await;
    assert!(
        wait_until_root_terminal(&session, ROOT_EXIT_TIMEOUT).await,
        "supervisor must observe the root Node process exit (marker={marker}, root_pid={})",
        owned.root_pid
    );
    assert!(
        !process_is_alive(owned.root_pid),
        "root Node PID must be reaped before descendant cleanup is asserted (marker={marker}, root_pid={})",
        owned.root_pid
    );
    assert!(
        wait_until_pid_gone(owned.child_pid).await,
        "non-detached helper Node PID remained after root exit (marker={marker}, root_pid={}, child_pid={})",
        owned.root_pid,
        owned.child_pid
    );
    session.stop().await.expect("stop terminal session");
    drop(owned);
}

#[tokio::test]
async fn natural_node_exit_reaps_non_detached_helper_process() {
    natural_exit_must_reap_descendant(
        "exitNaturally",
        "exit-scheduled",
        "legacy-node-descendant-natural-exit",
    )
    .await;
}

#[tokio::test]
async fn crashed_node_reaps_non_detached_helper_process() {
    natural_exit_must_reap_descendant("crash", "kill-scheduled", "legacy-node-descendant-crash")
        .await;
}

#[tokio::test]
async fn explicit_session_stop_reaps_non_detached_helper_process() {
    let marker = "legacy-node-descendant-explicit-stop";
    let temp = fixture();
    let session = start_session(&temp, marker).await;
    let owned = start_owned_descendant(&session, marker, false).await;
    assert!(
        wait_for_owned_process_group(&owned).await,
        "spawned helper must inherit the setsid process group (marker={marker}, root_pid={}, child_pid={})",
        owned.root_pid,
        owned.child_pid
    );

    session
        .stop()
        .await
        .expect("explicit stop of real Node sidecar");
    assert_ne!(session.status(), SidecarStatus::Running);
    assert!(
        wait_until_pid_gone(owned.root_pid).await,
        "root Node PID remained after explicit stop (marker={marker}, root_pid={})",
        owned.root_pid
    );
    assert!(
        wait_until_pid_gone(owned.child_pid).await,
        "helper Node PID remained after explicit stop (marker={marker}, root_pid={}, child_pid={})",
        owned.root_pid,
        owned.child_pid
    );
    drop(owned);
}

#[tokio::test]
async fn inherited_stdout_and_stderr_do_not_block_root_exit_cleanup() {
    let marker = "legacy-node-descendant-inherited-pipes";
    let temp = fixture();
    let session = start_session(&temp, marker).await;
    let owned = start_owned_descendant(&session, marker, true).await;
    assert!(
        wait_for_owned_process_group(&owned).await,
        "spawned helper must inherit the setsid process group (marker={marker}, root_pid={}, child_pid={})",
        owned.root_pid,
        owned.child_pid
    );

    request_root_exit(&session, "exitNaturally", "exit-scheduled").await;
    assert!(
        wait_until_root_terminal(&session, Duration::from_secs(1)).await,
        "supervisor must observe root exit while the silent helper still holds inherited stdout/stderr (marker={marker}, root_pid={})",
        owned.root_pid
    );
    assert!(
        !process_is_alive(owned.root_pid),
        "root Node PID must be reaped through the 50 ms monitor path (marker={marker}, root_pid={})",
        owned.root_pid
    );
    assert!(
        wait_until_pid_gone(owned.child_pid).await,
        "silent helper holding inherited stdout/stderr remained after root exit (marker={marker}, root_pid={}, child_pid={})",
        owned.root_pid,
        owned.child_pid
    );
    session.stop().await.expect("stop terminal session");
    drop(owned);
}

#[tokio::test]
async fn dropping_session_reaps_root_and_non_detached_helper() {
    let marker = "legacy-node-descendant-session-drop";
    let temp = fixture();
    let session = start_session(&temp, marker).await;
    let owned = start_owned_descendant(&session, marker, false).await;
    assert!(
        wait_for_owned_process_group(&owned).await,
        "spawned helper must inherit the setsid process group (marker={marker}, root_pid={}, child_pid={})",
        owned.root_pid,
        owned.child_pid
    );

    drop(session);
    let started = Instant::now();
    while started.elapsed() < CHILD_EXIT_TIMEOUT
        && (process_is_alive(owned.root_pid) || process_is_alive(owned.child_pid))
    {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        !process_is_alive(owned.root_pid),
        "root Node PID remained after session Drop (marker={marker}, root_pid={})",
        owned.root_pid
    );
    assert!(
        !process_is_alive(owned.child_pid),
        "helper Node PID remained after session Drop (marker={marker}, root_pid={}, child_pid={})",
        owned.root_pid,
        owned.child_pid
    );
    drop(owned);
}
