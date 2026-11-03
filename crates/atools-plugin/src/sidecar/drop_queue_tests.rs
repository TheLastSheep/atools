use super::supervisor::{ProcessCommand, SidecarProcess};
use super::{NodeRuntimeSelector, SidecarLaunchSpec, SidecarStatus};
use atools_core::{PluginRuntimeKind, PluginRuntimeTransport};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch, Semaphore};

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

fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

async fn wait_for_terminal_status(
    status: &mut watch::Receiver<SidecarStatus>,
) -> Option<SidecarStatus> {
    loop {
        let current = *status.borrow_and_update();
        if matches!(current, SidecarStatus::Stopped | SidecarStatus::Crashed) {
            return Some(current);
        }
        if status.changed().await.is_err() {
            return None;
        }
    }
}

async fn wait_for_process_exit(pid: u32) {
    while process_exists(pid) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_sidecar_with_full_command_queue_still_reaps_real_node_child() {
    let directory = tempfile::tempdir().unwrap();
    let entry = directory.path().join("hold-open.cjs");
    std::fs::write(
        &entry,
        "process.stdin.resume();\nsetInterval(() => {}, 1000);\n",
    )
    .unwrap();
    let spec = SidecarLaunchSpec {
        plugin_id: "drop-queue-fixture".into(),
        plugin_dir: directory.path().to_path_buf(),
        entry,
        runtime: PluginRuntimeKind::Node,
        transport: PluginRuntimeTransport::JsonRpcStdio,
        args: Vec::new(),
        env: BTreeMap::new(),
        startup_timeout: Duration::from_secs(2),
        request_timeout: Duration::from_secs(2),
    };
    let command = spec
        .command_with_node_selector(
            &NodeRuntimeSelector::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let process_slots = Arc::new(Semaphore::new(1));
    let permit = Arc::clone(&process_slots).acquire_owned().await.unwrap();
    let process = SidecarProcess::spawn_with_command_and_diagnostics_and_permit(
        spec,
        command,
        None,
        Some(permit),
    )
    .await
    .unwrap();
    assert_eq!(process_slots.available_permits(), 0);
    let pid = process.owned_pid.expect("real Node child must have a PID");
    let mut cleanup = KillProcessGroupOnDrop(Some(pid));
    let mut status = process.status_receiver_for_test();
    assert_eq!(*status.borrow_and_update(), SidecarStatus::Running);

    // The current-thread runtime cannot poll run_process between these sends,
    // so the bounded queue is filled synchronously and deterministically.
    for id in 1..=128 {
        let (response, _response_rx) = oneshot::channel();
        process
            .command_tx
            .try_send(ProcessCommand::Request {
                id,
                method: "fixture/hold".into(),
                params: Value::Null,
                response,
            })
            .expect("the process command queue has exactly 128 available entries");
    }
    let (response, _response_rx) = oneshot::channel();
    assert!(matches!(
        process.command_tx.try_send(ProcessCommand::Notify {
            method: "fixture/probe".into(),
            params: Value::Null,
            response,
        }),
        Err(mpsc::error::TrySendError::Full(_))
    ));

    drop(process);
    let automatic_status = tokio::time::timeout(
        Duration::from_millis(500),
        wait_for_terminal_status(&mut status),
    )
    .await
    .ok()
    .flatten();
    let automatic_exit =
        tokio::time::timeout(Duration::from_millis(500), wait_for_process_exit(pid))
            .await
            .is_ok();

    if automatic_status.is_none() || !automatic_exit {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        cleanup.0 = None;
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            wait_for_terminal_status(&mut status),
        )
        .await;
        let _ = tokio::time::timeout(Duration::from_secs(1), wait_for_process_exit(pid)).await;
    } else {
        cleanup.0 = None;
    }

    assert_eq!(
        automatic_status,
        Some(SidecarStatus::Stopped),
        "dropping the last process handle must request cleanup even when the normal command queue is full"
    );
    assert!(
        automatic_exit,
        "the actual Node child PID must be reaped before Drop cleanup is considered complete"
    );
    assert_eq!(
        process_slots.available_permits(),
        1,
        "the host process slot must be returned after Drop cleanup reaps the child"
    );
}
