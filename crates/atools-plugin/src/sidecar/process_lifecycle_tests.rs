use super::process::{OwnedSidecarChild, SharedCleanupError};
use super::process_loop::{run_process, ProcessReapPermit};
use super::supervisor::SidecarProcess;
use super::{NodeRuntimeSelector, SidecarError, SidecarLaunchSpec, SidecarStatus};
use atools_core::{PluginRuntimeKind, PluginRuntimeTransport};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::{mpsc, watch, Semaphore};

struct KillProcessGroupOnDrop(Option<u32>);

impl Drop for KillProcessGroupOnDrop {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

struct KillPidOnDrop(Option<u32>);

impl Drop for KillPidOnDrop {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
    }
}

fn fixture_spec(directory: &Path, entry: PathBuf) -> SidecarLaunchSpec {
    SidecarLaunchSpec {
        plugin_id: "process-lifecycle-fixture".into(),
        plugin_dir: directory.to_path_buf(),
        entry,
        runtime: PluginRuntimeKind::Node,
        transport: PluginRuntimeTransport::JsonRpcStdio,
        args: Vec::new(),
        env: BTreeMap::new(),
        startup_timeout: Duration::from_secs(2),
        request_timeout: Duration::from_secs(2),
    }
}

async fn node_fixture_command(spec: &SidecarLaunchSpec) -> Command {
    spec.command_with_node_selector(
        &NodeRuntimeSelector::default(),
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap()
}

fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

async fn wait_for_process_exit(pid: u32) {
    while process_exists(pid) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn process_group(pid: u32) -> Option<i32> {
    let group = unsafe { libc::getpgid(pid as i32) };
    (group >= 0).then_some(group)
}

async fn wait_for_fixture_pids(path: &Path) -> (u32, u32) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(contents) = std::fs::read_to_string(path) {
                if let Ok(value) = serde_json::from_str::<Value>(&contents) {
                    if let (Some(root), Some(auxiliary)) = (
                        value.get("rootPid").and_then(Value::as_u64),
                        value.get("auxiliaryPid").and_then(Value::as_u64),
                    ) {
                        return (root as u32, auxiliary as u32);
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Node fixture must write its root and auxiliary PIDs")
}

async fn wait_for_matching_process_groups(root_pid: u32, auxiliary_pid: u32) -> bool {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if process_group(root_pid) == Some(root_pid as i32)
                && process_group(auxiliary_pid) == Some(root_pid as i32)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

#[tokio::test(flavor = "current_thread")]
async fn normal_shutdown_returns_process_slot_only_after_child_wait() {
    let directory = tempfile::tempdir().unwrap();
    let entry = directory.path().join("hold-open.cjs");
    std::fs::write(
        &entry,
        "process.stdin.resume();\nsetInterval(() => {}, 1000);\n",
    )
    .unwrap();
    let spec = fixture_spec(directory.path(), entry);
    let command = node_fixture_command(&spec).await;
    let slots = Arc::new(Semaphore::new(1));
    let permit = Arc::clone(&slots).acquire_owned().await.unwrap();
    let process = SidecarProcess::spawn_with_command_and_diagnostics_and_permit(
        spec,
        command,
        None,
        Some(permit),
    )
    .await
    .unwrap();
    let pid = process.owned_pid.expect("Node child should have a PID");
    let mut cleanup = KillProcessGroupOnDrop(Some(pid));
    assert_eq!(slots.available_permits(), 0);

    tokio::time::timeout(Duration::from_secs(2), process.shutdown())
        .await
        .expect("shutdown should finish after child wait")
        .unwrap();

    assert_eq!(process.status(), SidecarStatus::Stopped);
    assert_eq!(slots.available_permits(), 1);
    assert_eq!(
        unsafe { libc::kill(pid as i32, 0) },
        -1,
        "the direct Node PID should no longer exist after shutdown responds"
    );
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    cleanup.0 = None;
}

#[tokio::test(flavor = "current_thread")]
async fn natural_exit_with_empty_owned_group_confirms_cleanup_after_reap() {
    let directory = tempfile::tempdir().unwrap();
    let entry = directory.path().join("exit-immediately.cjs");
    std::fs::write(&entry, "process.exit(0);\n").unwrap();
    let spec = fixture_spec(directory.path(), entry);
    let mut command = node_fixture_command(&spec).await;
    let spawned = command.spawn().expect("spawn isolated Node fixture");
    let shared_error = SharedCleanupError::default();
    let mut child = OwnedSidecarChild::new(spawned, shared_error.clone());

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if child
                .try_wait()
                .expect("observe natural child exit")
                .is_some()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the fixture exits without descendants");
    child
        .confirm_process_group_gone_after_reap(Duration::from_secs(1))
        .await
        .expect("an empty process group should be proven gone after root reap");

    assert!(child.reaped());
    assert!(child.process_group_cleanup_confirmed());
    assert!(child.cleanup_result().is_none());
    assert!(shared_error.get().is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn spawn_failure_returns_untransferred_process_slot() {
    let directory = tempfile::tempdir().unwrap();
    let spec = fixture_spec(directory.path(), directory.path().join("entry.cjs"));
    let mut command = Command::new(directory.path().join("missing-node-runtime"));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let slots = Arc::new(Semaphore::new(1));
    let permit = Arc::clone(&slots).acquire_owned().await.unwrap();

    let result = SidecarProcess::spawn_with_command_and_diagnostics_and_permit(
        spec,
        command,
        None,
        Some(permit),
    )
    .await;

    assert!(matches!(result, Err(SidecarError::Spawn(_))));
    assert_eq!(slots.available_permits(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn unowned_process_group_error_is_sticky_and_never_signals_parent_group() {
    let directory = tempfile::tempdir().unwrap();
    let entry = directory.path().join("hold-open.cjs");
    std::fs::write(
        &entry,
        "process.stdin.resume();\nsetInterval(() => {}, 1000);\n",
    )
    .unwrap();
    let spec = fixture_spec(directory.path(), entry);
    let selected_node = node_fixture_command(&spec).await;
    let node_program = selected_node.as_std().get_program().to_os_string();

    // Rebuild the selected Node command without launch.rs's setsid pre_exec.
    // This child shares the test process group, which this test must never signal.
    let mut command = Command::new(node_program);
    command
        .arg(&spec.entry)
        .current_dir(&spec.plugin_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let slots = Arc::new(Semaphore::new(1));
    let permit = Arc::clone(&slots).acquire_owned().await.unwrap();
    let process = SidecarProcess::spawn_with_command_and_diagnostics_and_permit(
        spec,
        command,
        None,
        Some(permit),
    )
    .await
    .unwrap();
    let pid = process.owned_pid.expect("Node child should have a PID");
    let mut cleanup = KillPidOnDrop(Some(pid));
    let actual_group = process_group(pid).expect("running child process group");
    assert_ne!(
        actual_group, pid as i32,
        "fresh command must not inherit launch.rs setsid"
    );
    assert_eq!(
        actual_group,
        process_group(std::process::id()).expect("test process group"),
        "fresh Node process must remain in the test process group"
    );
    assert_eq!(slots.available_permits(), 0);

    let first_error = tokio::time::timeout(Duration::from_secs(2), process.shutdown())
        .await
        .expect("shutdown should finish after direct-child wait")
        .expect_err("unowned process groups must preserve their cleanup error");
    assert!(matches!(&first_error, SidecarError::Crashed(message)
        if message.contains("process group") && message.contains(&actual_group.to_string())));
    assert_eq!(process.status(), SidecarStatus::Crashed);
    assert_eq!(
        slots.available_permits(),
        1,
        "the root must be waited before its process slot is returned"
    );
    assert!(
        !process_exists(pid),
        "direct Node PID must be gone after shutdown returns its group error"
    );
    cleanup.0 = None;

    let second_error = process
        .shutdown()
        .await
        .expect_err("terminal shutdown must retain the first cleanup failure");
    assert_eq!(second_error, first_error);
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_unpolled_run_process_kills_isolated_group_and_forgets_reap_slot() {
    let directory = tempfile::tempdir().unwrap();
    let entry = directory.path().join("spawn-descendant.cjs");
    let pid_file = directory.path().join("owned-pids.json");
    std::fs::write(
        &entry,
        r#"
          const { spawn } = require('node:child_process');
          const fs = require('node:fs');
          const path = require('node:path');
          const auxiliary = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
            detached: false,
          });
          auxiliary.unref();
          fs.writeFileSync(path.join(__dirname, 'owned-pids.json'), JSON.stringify({
            rootPid: process.pid,
            auxiliaryPid: auxiliary.pid,
          }));
          process.stdin.resume();
          setInterval(() => {}, 1000);
        "#,
    )
    .unwrap();
    let spec = fixture_spec(directory.path(), entry);
    let mut command = node_fixture_command(&spec).await;
    command.kill_on_drop(true);
    let root = command.spawn().expect("spawn isolated fixture Node root");
    let root_pid = root.id().expect("isolated fixture root PID");
    let mut cleanup = KillProcessGroupOnDrop(Some(root_pid));

    let (reported_root, auxiliary_pid) = wait_for_fixture_pids(&pid_file).await;
    assert_eq!(reported_root, root_pid, "PID file must belong to this root");
    assert_ne!(root_pid, auxiliary_pid);
    assert!(
        wait_for_matching_process_groups(root_pid, auxiliary_pid).await,
        "isolated fixture root and helper must share PGID=root PID before future construction"
    );
    eprintln!(
        "sidecar-unpolled-drop marker=process-lifecycle root_pid={root_pid} auxiliary_pid={auxiliary_pid}"
    );

    let cleanup_error = SharedCleanupError::default();
    let mut owned = OwnedSidecarChild::new(root, cleanup_error.clone());
    let (stdin, stdout, stderr) = owned.take_stdio();
    let stdin = stdin.expect("root stdin pipe");
    let stdout = stdout.expect("root stdout pipe");
    drop(stderr.expect("root stderr pipe"));

    let slots = Arc::new(Semaphore::new(1));
    let permit = Arc::clone(&slots).acquire_owned().await.unwrap();
    let reap_permit = ProcessReapPermit::new(Some(permit));
    let (_command_tx, command_rx) = mpsc::channel(128);
    let (status_tx, _status_rx) = watch::channel(SidecarStatus::Running);
    assert_eq!(slots.available_permits(), 0);

    let unpolled = run_process(
        owned,
        stdin,
        stdout,
        command_rx,
        status_tx,
        PluginRuntimeTransport::JsonRpcStdio,
        None,
        reap_permit,
        None,
        cleanup_error,
    );
    drop(unpolled);

    assert_eq!(
        slots.available_permits(),
        0,
        "an unpolled future cannot confirm wait, so its process slot must fail closed"
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        wait_for_process_exit(root_pid).await;
        wait_for_process_exit(auxiliary_pid).await;
    })
    .await
    .expect("dropping the unpolled future must kill and reap root plus helper");
    assert_eq!(
        slots.available_permits(),
        0,
        "unconfirmed reap capacity must remain unavailable after background exit"
    );
    cleanup.0 = None;
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_shutdowns_share_one_reap_result_and_return_one_slot() {
    let directory = tempfile::tempdir().unwrap();
    let entry = directory.path().join("hold-open.cjs");
    std::fs::write(
        &entry,
        "process.stdin.resume();\nsetInterval(() => {}, 1000);\n",
    )
    .unwrap();
    let spec = fixture_spec(directory.path(), entry);
    let command = node_fixture_command(&spec).await;
    let slots = Arc::new(Semaphore::new(1));
    let permit = Arc::clone(&slots).acquire_owned().await.unwrap();
    let process = SidecarProcess::spawn_with_command_and_diagnostics_and_permit(
        spec,
        command,
        None,
        Some(permit),
    )
    .await
    .unwrap();
    let pid = process.owned_pid.expect("Node child should have a PID");
    let mut cleanup = KillProcessGroupOnDrop(Some(pid));
    assert_eq!(process_group(pid), Some(pid as i32));
    assert_eq!(slots.available_permits(), 0);

    let (first, second) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(process.shutdown(), process.shutdown())
    })
    .await
    .expect("concurrent shutdowns should both complete after one child wait");
    assert_eq!(first, Ok(()));
    assert_eq!(second, Ok(()));
    assert!(
        !process_exists(pid),
        "the isolated direct Node PID must be gone when both shutdowns return"
    );
    assert_eq!(
        slots.available_permits(),
        1,
        "both shutdown callers must observe one confirmed reap and one returned slot"
    );

    process
        .shutdown()
        .await
        .expect("a later shutdown of the terminal process should remain successful");
    assert_eq!(slots.available_permits(), 1);
    cleanup.0 = None;
}
