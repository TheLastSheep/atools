use super::SidecarError;
#[path = "process_group.rs"]
mod process_group;
use process_group::{observe_process_group, ProcessGroupClaim};
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

/// Keeps the first process-lifecycle failure visible to every owner of the sidecar.
#[derive(Clone, Default)]
pub(super) struct SharedCleanupError(Arc<Mutex<Option<SidecarError>>>);

impl SharedCleanupError {
    pub(super) fn record(&self, error: SidecarError) {
        let mut current = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current.is_none() {
            *current = Some(error);
        }
    }

    pub(super) fn get(&self) -> Option<SidecarError> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// Owns the spawned process and its verified process-group identity as one RAII value.
/// Its Drop runs before Tokio Child's Drop, so pending group cleanup cannot follow a reap.
pub(super) struct OwnedSidecarChild {
    child: Child,
    group: ProcessGroupClaim,
    reaped: bool,
    cleanup_error: SharedCleanupError,
}

impl OwnedSidecarChild {
    pub(super) fn new(child: Child, cleanup_error: SharedCleanupError) -> Self {
        let group = ProcessGroupClaim::capture(child.id());
        if let Some(error) = group.initial_error() {
            cleanup_error.record(error.clone());
        }
        Self {
            child,
            group,
            reaped: false,
            cleanup_error,
        }
    }

    pub(super) fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub(super) fn take_stdio(
        &mut self,
    ) -> (Option<ChildStdin>, Option<ChildStdout>, Option<ChildStderr>) {
        (
            self.child.stdin.take(),
            self.child.stdout.take(),
            self.child.stderr.take(),
        )
    }

    pub(super) fn reaped(&self) -> bool {
        self.reaped
    }

    pub(super) fn cleanup_result(&self) -> Option<SidecarError> {
        self.cleanup_error.get()
    }

    pub(super) fn process_group_cleanup_confirmed(&self) -> bool {
        self.group.cleanup_confirmed()
    }

    /// After the exact root has been reaped, only read-only observation is safe:
    /// a process group ID may already have been reused by an unrelated process.
    pub(super) async fn confirm_process_group_gone_after_reap(
        &mut self,
        wait_budget: Duration,
    ) -> Result<(), SidecarError> {
        if !self.reaped {
            let error = record_cleanup_error(
                self,
                "cannot confirm process-group cleanup before the root is reaped".into(),
            );
            return Err(error);
        }

        let deadline = tokio::time::Instant::now() + wait_budget;
        loop {
            match self
                .group
                .observe_gone_after_reap_with(observe_process_group)
            {
                Ok(true) => return Ok(()),
                Ok(false) if tokio::time::Instant::now() < deadline => {
                    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                    tokio::time::sleep(remaining.min(PROCESS_GROUP_POLL_INTERVAL)).await;
                }
                Ok(false) => {
                    let error = self.group.fail_unconfirmed_after_reap(wait_budget);
                    self.cleanup_error.record(error.clone());
                    return Err(error);
                }
                Err(error) => {
                    self.cleanup_error.record(error.clone());
                    return Err(error);
                }
            }
        }
    }

    /// Sends a user-requested signal while this owner still pins the exact
    /// child identity. A group signal is only allowed for the group captured
    /// from this child at spawn; it never mutates the terminal cleanup claim.
    #[cfg(unix)]
    pub(super) fn send_signal(&mut self, signal: i32, group: bool) -> io::Result<bool> {
        if self.reaped || self.try_wait()?.is_some() {
            return Ok(false);
        }
        if group {
            return self.group.signal_owned_group(signal);
        }

        let pid = self.id().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "owned child PID is unavailable")
        })?;
        if unsafe { libc::kill(pid as i32, signal) } == 0 {
            Ok(true)
        } else {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(error)
            }
        }
    }

    fn cleanup_group_once(&mut self) -> Option<SidecarError> {
        let error = self.group.signal_once();
        if let Some(error) = &error {
            self.cleanup_error.record(error.clone());
        }
        error
    }

    fn disarm_group(&mut self, error: SidecarError) {
        let error = self.group.disarm_with_error(error);
        self.cleanup_error.record(error);
    }

    fn try_wait_child(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.reaped = true;
        }
        Ok(status)
    }

    async fn wait_child(&mut self) -> io::Result<std::process::ExitStatus> {
        let status = self.child.wait().await?;
        self.reaped = true;
        Ok(status)
    }

    fn start_kill_child(&mut self) -> io::Result<()> {
        self.child.start_kill()
    }

    /// Checks for exit without reaping on macOS/Linux, keeping the root PID bound
    /// to this process group until the single group signal has been attempted.
    pub(super) fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self.group.is_owned_and_pending() {
            match waitid_child_exited(self.id().expect("owned child PID remains available")) {
                Ok(false) => return Ok(None),
                Ok(true) => {
                    self.cleanup_group_once();
                    return self.try_wait_child();
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => return Ok(None),
                Err(error) => {
                    self.disarm_group(SidecarError::Crashed(format!(
                        "cannot safely observe sidecar exit before reaping: {error}"
                    )));
                    return Err(error);
                }
            }
        }

        let status = self.try_wait_child()?;

        #[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
        if status.is_some() && self.group.is_owned_and_pending() {
            // try_wait has reaped the root on these Unix targets; prevent Drop
            // from signaling a process group whose numeric ID may now be reused.
            self.disarm_group(SidecarError::Crashed(format!(
                "natural sidecar exit cannot safely clean its process group on {}",
                std::env::consts::OS
            )));
        }

        Ok(status)
    }
}

impl Drop for OwnedSidecarChild {
    fn drop(&mut self) {
        // The custom Drop runs before the Child field is dropped. Marking each
        // attempt first prevents a later Drop from signaling a reused group ID.
        self.cleanup_group_once();
        if let Some(error) = self.group.fail_unconfirmed_on_drop() {
            self.cleanup_error.record(error);
        }
    }
}

#[derive(Debug)]
pub(super) struct ProcessTermination {
    pub(super) group_error: Option<SidecarError>,
}

const CLEANUP_WAIT_BUDGET: Duration = Duration::from_secs(2);
const PROCESS_GROUP_WAIT_BUDGET: Duration = Duration::from_secs(1);
const PROCESS_GROUP_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub(super) async fn terminate_child(
    child: &mut OwnedSidecarChild,
) -> Result<ProcessTermination, SidecarError> {
    terminate_child_with(
        child,
        OwnedSidecarChild::start_kill_child,
        CLEANUP_WAIT_BUDGET,
    )
    .await
}

pub(super) async fn terminate_child_with(
    child: &mut OwnedSidecarChild,
    start_kill: impl FnOnce(&mut OwnedSidecarChild) -> io::Result<()>,
    wait_budget: Duration,
) -> Result<ProcessTermination, SidecarError> {
    let cleanup_deadline = tokio::time::Instant::now() + wait_budget;
    child.cleanup_group_once();
    // Always try to terminate and reap the owned root, even when no safe group
    // claim exists or the group signal failed.
    if let Err(kill_error) = start_kill(child) {
        return match child.try_wait_child() {
            Ok(Some(_)) => {
                let _ = child
                    .confirm_process_group_gone_after_reap(
                        remaining_group_budget(cleanup_deadline),
                    )
                    .await;
                Ok(ProcessTermination {
                    group_error: child.cleanup_result(),
                })
            }
            Ok(None) => Err(record_cleanup_error(
                child,
                format!("failed to start killing sidecar child: {kill_error}"),
            )),
            Err(wait_error) => Err(record_cleanup_error(
                child,
                format!(
                    "failed to start killing sidecar child: {kill_error}; failed to check whether it exited: {wait_error}"
                ),
            )),
        };
    }

    let root_wait_budget = cleanup_deadline.saturating_duration_since(tokio::time::Instant::now());
    match tokio::time::timeout(root_wait_budget, child.wait_child()).await {
        Ok(Ok(_)) => {
            let _ = child
                .confirm_process_group_gone_after_reap(remaining_group_budget(cleanup_deadline))
                .await;
            Ok(ProcessTermination {
                group_error: child.cleanup_result(),
            })
        }
        Ok(Err(error)) => Err(record_cleanup_error(
            child,
            format!("failed to confirm sidecar child reaping: {error}"),
        )),
        Err(_) => Err(record_cleanup_error(
            child,
            format!("timed out after {wait_budget:?} waiting for sidecar child reaping"),
        )),
    }
}

fn remaining_group_budget(deadline: tokio::time::Instant) -> Duration {
    PROCESS_GROUP_WAIT_BUDGET.min(deadline.saturating_duration_since(tokio::time::Instant::now()))
}

fn record_cleanup_error(child: &OwnedSidecarChild, message: String) -> SidecarError {
    let error = SidecarError::Crashed(message);
    child.cleanup_error.record(error.clone());
    error
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn waitid_child_exited(pid: u32) -> io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    let observed_pid = unsafe { info.si_pid() };
    if observed_pid == 0 {
        Ok(false)
    } else if observed_pid == pid as libc::pid_t {
        Ok(true)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("waitid observed PID {observed_pid} while checking sidecar PID {pid}"),
        ))
    }
}

#[cfg(all(test, unix))]
#[path = "process_termination_tests.rs"]
mod termination_tests;
