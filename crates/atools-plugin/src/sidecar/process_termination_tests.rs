#![cfg(unix)]

use super::{
    terminate_child, terminate_child_with, OwnedSidecarChild, SharedCleanupError, SidecarError,
};
use std::io;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

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

fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn process_group(pid: u32) -> Option<i32> {
    let group = unsafe { libc::getpgid(pid as i32) };
    (group >= 0).then_some(group)
}

fn spawn_unisolated_node() -> (Child, u32, i32, KillPidOnDrop) {
    let node = super::super::node_runtime::resolve_node_binary()
        .expect("resolve the fixed Node runtime or system fallback");
    let mut command = Command::new(node);
    command
        .arg("-e")
        .arg("process.stdin.resume(); setInterval(() => {}, 60000);")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command.spawn().expect("spawn real unisolated Node process");
    let pid = child.id().expect("Node child PID");
    let cleanup = KillPidOnDrop(Some(pid));
    let group = process_group(pid).expect("running Node process group");
    let parent_group = process_group(std::process::id()).expect("test process group");
    assert_ne!(group, pid as i32, "Node must not start a new session");
    assert_eq!(
        group, parent_group,
        "Node must inherit the test process group"
    );
    eprintln!("process-termination marker=foreign-group pid={pid} pgid={group}");
    (child, pid, group, cleanup)
}

async fn finish_and_assert_foreign_group_error(
    child: &mut OwnedSidecarChild,
    expected_group_error: &SidecarError,
    pid: u32,
    group: i32,
) {
    let termination = tokio::time::timeout(Duration::from_secs(3), terminate_child(child))
        .await
        .expect("real terminate_child must finish after direct kill and wait")
        .expect("direct root termination should succeed despite foreign group ownership");
    assert!(child.reaped(), "direct Node root must be confirmed reaped");
    assert!(
        !process_exists(pid),
        "direct Node PID must be gone after real cleanup"
    );
    let group_error = termination
        .group_error
        .expect("foreign process group must remain a cleanup error");
    assert_eq!(&group_error, expected_group_error);
    assert!(group_error.to_string().contains(&group.to_string()));
    assert!(
        group_error.to_string().contains("process group"),
        "foreign-group cleanup cannot be reported as complete"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn permission_denied_kill_returns_promptly_without_reaping_root() {
    let (child, pid, group, mut cleanup) = spawn_unisolated_node();
    let mut child = OwnedSidecarChild::new(child, SharedCleanupError::default());
    let foreign_group_error = child
        .cleanup_result()
        .expect("unisolated Node must be rejected as an owned process group");

    let error = tokio::time::timeout(
        Duration::from_millis(200),
        terminate_child_with(
            &mut child,
            |_| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "fixture EPERM while starting direct kill",
                ))
            },
            Duration::from_secs(30),
        ),
    )
    .await
    .expect("a direct-kill permission error must return promptly despite a long wait budget")
    .expect_err("injected PermissionDenied must be surfaced");
    assert!(matches!(&error, SidecarError::Crashed(message)
        if message.contains("fixture EPERM while starting direct kill")));
    assert!(
        !child.reaped(),
        "failed kill attempt cannot claim the root was reaped"
    );
    assert!(
        process_exists(pid),
        "root must still be alive before fallback cleanup"
    );

    finish_and_assert_foreign_group_error(&mut child, &foreign_group_error, pid, group).await;
    cleanup.0 = None;
}

#[tokio::test(flavor = "current_thread")]
async fn no_op_kill_wait_timeout_is_bounded_without_reaping_root() {
    let (child, pid, group, mut cleanup) = spawn_unisolated_node();
    let mut child = OwnedSidecarChild::new(child, SharedCleanupError::default());
    let foreign_group_error = child
        .cleanup_result()
        .expect("unisolated Node must be rejected as an owned process group");

    let error = tokio::time::timeout(
        Duration::from_millis(200),
        terminate_child_with(&mut child, |_| Ok(()), Duration::from_millis(25)),
    )
    .await
    .expect("cleanup wait must respect the short injected deadline")
    .expect_err("no-op kill must time out while the root remains active");
    assert!(matches!(&error, SidecarError::Crashed(message)
        if message.contains("timed out after") && message.contains("25ms")));
    assert!(
        !child.reaped(),
        "wait timeout cannot claim the root was reaped"
    );
    assert!(
        process_exists(pid),
        "root must still be alive before fallback cleanup"
    );

    finish_and_assert_foreign_group_error(&mut child, &foreign_group_error, pid, group).await;
    cleanup.0 = None;
}
