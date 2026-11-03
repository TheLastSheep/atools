use super::error::RequestFailure;
use super::managed_child::run_managed_child;
use crate::sidecar::process::{terminate_child, OwnedSidecarChild, SharedCleanupError};
use crate::sidecar::SidecarError;
use serde_json::Value;
use std::io;
use std::sync::{Arc, OnceLock};
use tokio::process::Command;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

const OWNER_CHILD_LIMIT: usize = 4;
const GLOBAL_CHILD_LIMIT: usize = 8;
const MAX_MANAGED_PID_EXCLUSIVE: u32 = 4_194_304;
const MANAGED_TRANSPORT_ENV: [&str; 3] = [
    "ATOOLS_MANAGED_CHILD_CONTROL_SOCKET",
    "ATOOLS_MANAGED_CHILD_EVENT_SOCKET",
    "ATOOLS_MANAGED_CHILD_TOKEN",
];

static GLOBAL_BUDGET: OnceLock<Arc<Semaphore>> = OnceLock::new();

pub(super) fn global_budget() -> Arc<Semaphore> {
    Arc::clone(GLOBAL_BUDGET.get_or_init(|| Arc::new(Semaphore::new(GLOBAL_CHILD_LIMIT))))
}

pub(super) fn owner_budget() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(OWNER_CHILD_LIMIT))
}

pub(super) struct ChildBudgetGuard {
    owner: Option<OwnedSemaphorePermit>,
    global: Option<OwnedSemaphorePermit>,
    spawned: bool,
    confirmed: bool,
}

impl ChildBudgetGuard {
    fn new(owner: OwnedSemaphorePermit, global: OwnedSemaphorePermit) -> Self {
        Self {
            owner: Some(owner),
            global: Some(global),
            spawned: false,
            confirmed: false,
        }
    }

    fn mark_spawned(&mut self) {
        self.spawned = true;
    }

    pub(super) fn confirm_cleanup(&mut self) {
        self.confirmed = true;
        drop(self.owner.take());
        drop(self.global.take());
    }
}

impl Drop for ChildBudgetGuard {
    fn drop(&mut self) {
        if self.spawned && !self.confirmed {
            if let Some(owner) = self.owner.take() {
                std::mem::forget(owner);
            }
            if let Some(global) = self.global.take() {
                std::mem::forget(global);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StdioMode {
    Pipe,
    Ignore,
}

pub(super) struct SpawnSpec {
    pub(super) file: String,
    pub(super) args: Vec<String>,
    pub(super) env_pairs: Vec<(String, String)>,
    pub(super) cwd: Option<String>,
    pub(super) stdio: [StdioMode; 3],
}

pub(super) struct ManagedChild {
    pub(super) commands: mpsc::Sender<ChildCommand>,
}

pub(super) enum ChildCommand {
    Kill {
        signal: i32,
        group: bool,
        response: tokio::sync::oneshot::Sender<Result<bool, RequestFailure>>,
    },
    Write {
        write_id: u64,
        bytes: Vec<u8>,
        response: tokio::sync::oneshot::Sender<Result<(), RequestFailure>>,
    },
    End {
        write_id: u64,
        response: tokio::sync::oneshot::Sender<Result<(), RequestFailure>>,
    },
    Credit {
        stream: super::child_io::OutputStream,
        count: usize,
        response: tokio::sync::oneshot::Sender<Result<(), RequestFailure>>,
    },
    Shutdown,
}

pub(super) async fn spawn_managed_child(
    child_id: u64,
    spec: SpawnSpec,
    owner_budget: Arc<Semaphore>,
    event_tx: mpsc::Sender<Value>,
    tasks: &mut JoinSet<(u64, Result<(), SidecarError>)>,
) -> Result<(ManagedChild, u32), RequestFailure> {
    let owner_permit = owner_budget
        .try_acquire_owned()
        .map_err(|_| RequestFailure::limit("owner", OWNER_CHILD_LIMIT))?;
    let global_permit = global_budget()
        .try_acquire_owned()
        .map_err(|_| RequestFailure::limit("process", GLOBAL_CHILD_LIMIT))?;
    let stdio = spec.stdio;
    let mut command = build_command(spec)?;
    let mut budget = ChildBudgetGuard::new(owner_permit, global_permit);
    let spawned = command.spawn().map_err(RequestFailure::spawn)?;
    budget.mark_spawned();
    let mut child = OwnedSidecarChild::new(spawned, SharedCleanupError::default());
    let pid = match child.id().filter(|pid| *pid > 0) {
        Some(pid) => pid,
        None => {
            let cause = RequestFailure::new(
                "ERR_ATOOLS_CHILD_PID_UNAVAILABLE",
                "managed child did not provide a positive PID",
                None,
            );
            return Err(cleanup_start_failure(&mut child, cause, &mut budget).await);
        }
    };
    if !is_supported_managed_pid(pid) {
        let cause = RequestFailure::new(
            "ERR_ATOOLS_CHILD_PID_UNSUPPORTED",
            "managed child PID is outside the supported 1..4194303 range",
            None,
        );
        return Err(cleanup_start_failure(&mut child, cause, &mut budget).await);
    }
    if let Some(error) = child.cleanup_result() {
        let cause = RequestFailure::new(
            "ERR_ATOOLS_CHILD_GROUP_UNOWNED",
            "managed child process group could not be verified",
            None,
        );
        return Err(cleanup_start_failure_with_error(&mut child, cause, error, &mut budget).await);
    }

    let (stdin, stdout, stderr) = child.take_stdio();
    if (stdio[0] == StdioMode::Pipe && stdin.is_none())
        || (stdio[1] == StdioMode::Pipe && stdout.is_none())
        || (stdio[2] == StdioMode::Pipe && stderr.is_none())
    {
        let cause = RequestFailure::new(
            "ERR_ATOOLS_CHILD_STDIO_UNAVAILABLE",
            "managed child pipe was not created",
            None,
        );
        return Err(cleanup_start_failure(&mut child, cause, &mut budget).await);
    }

    let (commands, command_rx) = mpsc::channel(16);
    tasks.spawn(run_managed_child(
        child_id, child, stdio, stdin, stdout, stderr, budget, command_rx, event_tx,
    ));
    Ok((ManagedChild { commands }, pid))
}

async fn cleanup_start_failure(
    child: &mut OwnedSidecarChild,
    cause: RequestFailure,
    budget: &mut ChildBudgetGuard,
) -> RequestFailure {
    let cleanup = terminate_child(child).await;
    let error = match cleanup {
        Ok(termination) => termination.group_error.or_else(|| child.cleanup_result()),
        Err(error) => Some(error),
    };
    let confirmed = child.reaped()
        && error.is_none()
        && child.cleanup_result().is_none()
        && child.process_group_cleanup_confirmed();
    if confirmed {
        budget.confirm_cleanup();
    }
    if !confirmed && error.is_none() {
        return RequestFailure::cleanup(
            cause,
            SidecarError::Crashed("managed child cleanup was not confirmed".into()),
        );
    }
    error.map_or(cause.clone(), |error| RequestFailure::cleanup(cause, error))
}

async fn cleanup_start_failure_with_error(
    child: &mut OwnedSidecarChild,
    cause: RequestFailure,
    group_error: SidecarError,
    budget: &mut ChildBudgetGuard,
) -> RequestFailure {
    let cleanup = terminate_child(child).await;
    let error = match cleanup {
        Ok(termination) => termination
            .group_error
            .or_else(|| child.cleanup_result())
            .unwrap_or(group_error),
        Err(error) => error,
    };
    let confirmed = child.reaped()
        && child.cleanup_result().is_none()
        && child.process_group_cleanup_confirmed();
    if confirmed {
        budget.confirm_cleanup();
    }
    RequestFailure::cleanup(cause, error)
}

fn build_command(spec: SpawnSpec) -> Result<Command, RequestFailure> {
    use std::os::unix::process::CommandExt;

    let argv0 = spec
        .args
        .first()
        .ok_or_else(|| RequestFailure::invalid("args must contain argv[0]"))?;
    let mut command = Command::new(&spec.file);
    command
        .kill_on_drop(true)
        .stdin(stdio(spec.stdio[0]))
        .stdout(stdio(spec.stdio[1]))
        .stderr(stdio(spec.stdio[2]))
        .env_clear();
    for (key, value) in spec.env_pairs {
        if !MANAGED_TRANSPORT_ENV.contains(&key.as_str()) {
            command.env(key, value);
        }
    }
    if let Some(cwd) = spec.cwd {
        command.current_dir(cwd);
    }
    command.args(spec.args.iter().skip(1));
    command.as_std_mut().arg0(argv0);
    unsafe {
        command.as_std_mut().pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(command)
}

fn stdio(mode: StdioMode) -> std::process::Stdio {
    match mode {
        StdioMode::Pipe => std::process::Stdio::piped(),
        StdioMode::Ignore => std::process::Stdio::null(),
    }
}

pub(super) fn signal_is_valid(signal: i32) -> bool {
    #[cfg(target_os = "macos")]
    let limit = 32;
    #[cfg(target_os = "linux")]
    let limit = 65;
    signal >= 0 && signal < limit
}

fn is_supported_managed_pid(pid: u32) -> bool {
    pid > 0 && pid < MAX_MANAGED_PID_EXCLUSIVE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard_for(owner: &Arc<Semaphore>, global: &Arc<Semaphore>) -> ChildBudgetGuard {
        ChildBudgetGuard::new(
            Arc::clone(owner).try_acquire_owned().unwrap(),
            Arc::clone(global).try_acquire_owned().unwrap(),
        )
    }

    #[test]
    fn pre_spawn_drop_releases_reserved_budget() {
        let owner = Arc::new(Semaphore::new(1));
        let global = Arc::new(Semaphore::new(1));
        drop(guard_for(&owner, &global));
        assert_eq!(owner.available_permits(), 1);
        assert_eq!(global.available_permits(), 1);
    }

    #[test]
    fn spawned_but_unconfirmed_drop_keeps_budget_reserved() {
        let owner = Arc::new(Semaphore::new(1));
        let global = Arc::new(Semaphore::new(1));
        let mut guard = guard_for(&owner, &global);
        guard.mark_spawned();
        drop(guard);
        assert_eq!(owner.available_permits(), 0);
        assert_eq!(global.available_permits(), 0);
    }

    #[test]
    fn confirmed_cleanup_releases_spawned_budget() {
        let owner = Arc::new(Semaphore::new(1));
        let global = Arc::new(Semaphore::new(1));
        let mut guard = guard_for(&owner, &global);
        guard.mark_spawned();
        guard.confirm_cleanup();
        drop(guard);
        assert_eq!(owner.available_permits(), 1);
        assert_eq!(global.available_permits(), 1);
    }

    #[test]
    fn managed_pid_range_matches_the_node_retired_pid_bitmap() {
        assert!(!is_supported_managed_pid(0));
        assert!(is_supported_managed_pid(1));
        assert!(is_supported_managed_pid(MAX_MANAGED_PID_EXCLUSIVE - 1));
        assert!(!is_supported_managed_pid(MAX_MANAGED_PID_EXCLUSIVE));
    }
}
