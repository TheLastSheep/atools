//! Parent-side bounded process ownership for the cache-only worker.
//! The caller validates the receipt and publishes only after `reaped` is true.
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Deserialize;

const MATERIALIZE_FLAG: &str = "--atools-locked-dependency-worker";
const POLICY_FLAG: &str = "--atools-locked-dependency-policy-probe";
pub(crate) const IGNORE_CANCEL_PROBE_FLAG: &str = "--atools-locked-dependency-ignore-cancel-probe";
pub(crate) const CANCEL_IGNORE_READY_MARKER: &[u8] = b"CANCEL_IGNORE_PROBE_READY\n";
const WALL_LIMIT: Duration = Duration::from_secs(120);
const CLEANUP_LIMIT: Duration = Duration::from_secs(3);
const CANCEL_PROBE_READY_LIMIT: Duration = Duration::from_secs(5);
const FORCE_KILL_AFTER: Duration = Duration::from_secs(2);

use super::observation::{Monitor, MonitorFailure, ResourceObservation};
use super::worker_io::{CancelPipe, ChildPipes};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Response {
    Complete {
        receipt: atools_plugin::source_build::DependencySetReceiptV1,
    },
    Failed {
        code: String,
    },
    PolicyProbe {
        fork_denied: bool,
        network_connect_denied: bool,
    },
}

#[derive(Debug)]
pub(crate) enum WorkerFailure {
    Cancelled,
    TimedOut,
    Spawn,
    Wait,
    OutputLimit,
    ObservedFootprintLimit,
    ResourceMonitorUnavailable,
    Pipe,
    Protocol,
    Worker(&'static str),
    Unreaped,
}

#[derive(Debug)]
pub(crate) struct WorkerOutcome {
    pub(crate) receipt: Result<atools_plugin::source_build::DependencySetReceiptV1, WorkerFailure>,
    pub(crate) exit_status: Option<ExitStatus>,
    pub(crate) reaped: bool,
    pub(crate) resource_observation: ResourceObservation,
}

/// Blocking supervisor for the current executable's early-dispatch mode; call
/// it from a blocking worker. The caller owns both roots and removes the unique
/// stage on every non-publish path, but only after `reaped` is true.
#[cfg(target_os = "macos")]
pub(crate) fn run_materializer(
    executable: &Path,
    archive_root: &Path,
    stage_root: &Path,
    plan: &[u8],
    cancelled: &AtomicBool,
) -> WorkerOutcome {
    let result = run_child(
        executable,
        MATERIALIZE_FLAG,
        archive_root,
        stage_root,
        Some(plan),
        Some(cancelled),
        false,
    );
    match result {
        Ok((Response::Complete { receipt }, Some(status), observation)) if status.success() => {
            let verified = super::receipt::verify_stage_output(stage_root, plan, &receipt);
            WorkerOutcome {
                receipt: verified
                    .map(|()| receipt)
                    .map_err(|_| WorkerFailure::Protocol),
                exit_status: Some(status),
                reaped: true,
                resource_observation: observation,
            }
        }
        Ok((Response::Failed { code }, status, observation)) => WorkerOutcome {
            receipt: Err(match code.as_str() {
                "dependency_worker_cancelled" => WorkerFailure::Cancelled,
                "dependency_worker_timeout" => WorkerFailure::TimedOut,
                other => WorkerFailure::Worker(
                    fixed_worker_code(other).unwrap_or("dependency_worker_failed"),
                ),
            }),
            exit_status: status,
            reaped: true,
            resource_observation: observation,
        },
        Ok((_, status, observation)) => WorkerOutcome {
            receipt: Err(WorkerFailure::Protocol),
            exit_status: status,
            reaped: true,
            resource_observation: observation,
        },
        Err((failure, status, reaped, observation)) => WorkerOutcome {
            receipt: Err(failure),
            exit_status: status,
            reaped,
            resource_observation: observation,
        },
    }
}

/// Test-only policy probe uses the identical parent supervisor and is not an
/// alternate materialization protocol.
#[cfg(target_os = "macos")]
pub(crate) fn run_policy_probe(
    executable: &Path,
    cache_root: &Path,
    stage_root: &Path,
) -> Result<(bool, bool), WorkerFailure> {
    match run_child(
        executable,
        POLICY_FLAG,
        cache_root,
        stage_root,
        None,
        None,
        false,
    ) {
        Ok((
            Response::PolicyProbe {
                fork_denied,
                network_connect_denied,
            },
            Some(status),
            _,
        )) if status.success() && fork_denied && network_connect_denied => {
            Ok((fork_denied, network_connect_denied))
        }
        Ok((Response::PolicyProbe { .. }, Some(status), _)) if status.success() => Err(
            WorkerFailure::Worker("dependency_worker_sandbox_policy_failed"),
        ),
        Ok((Response::Failed { code }, _, _)) => Err(WorkerFailure::Worker(
            fixed_worker_code(&code).unwrap_or("dependency_worker_failed"),
        )),
        Ok(_) => Err(WorkerFailure::Protocol),
        Err((failure, _, _, _)) => Err(failure),
    }
}

/// QA-only control: wait until the child confirms it consumed the full stdin
/// plan, then verify a child that ignores the pipe is still killed and reaped.
#[cfg(target_os = "macos")]
pub(crate) fn run_cancel_ignoring_probe(
    executable: &Path,
    archive_root: &Path,
    stage_root: &Path,
    plan: &[u8],
) -> WorkerOutcome {
    let cancelled = AtomicBool::new(false);
    match run_child(
        executable,
        IGNORE_CANCEL_PROBE_FLAG,
        archive_root,
        stage_root,
        Some(plan),
        Some(&cancelled),
        true,
    ) {
        Err((failure, exit_status, reaped, resource_observation)) => WorkerOutcome {
            receipt: Err(failure),
            exit_status,
            reaped,
            resource_observation,
        },
        Ok((_, exit_status, resource_observation)) => WorkerOutcome {
            receipt: Err(WorkerFailure::Protocol),
            exit_status,
            reaped: true,
            resource_observation,
        },
    }
}

#[cfg(target_os = "macos")]
fn run_child(
    executable: &Path,
    flag: &str,
    archive_root: &Path,
    stage_root: &Path,
    plan: Option<&[u8]>,
    cancelled: Option<&AtomicBool>,
    cancel_after_input: bool,
) -> Result<
    (Response, Option<ExitStatus>, ResourceObservation),
    (WorkerFailure, Option<ExitStatus>, bool, ResourceObservation),
> {
    let not_started = ResourceObservation {
        elapsed_milliseconds: None,
        sample_count: 0,
        unavailable_sample_count: 0,
        peak_observed_physical_footprint_bytes: None,
        sample_interval_milliseconds: super::observation::SAMPLE_INTERVAL.as_millis() as u64,
        observed_footprint_limit_bytes: super::observation::OBSERVED_FOOTPRINT_LIMIT_BYTES,
    };
    if plan.is_some_and(|bytes| {
        bytes.is_empty() || bytes.len() > atools_plugin::source_build::MAX_PLAN_JSON_BYTES
    }) {
        return Err((WorkerFailure::Protocol, None, true, not_started));
    }
    let cancel_pipe = if plan.is_some() {
        Some(CancelPipe::new().map_err(|_| (WorkerFailure::Pipe, None, true, not_started))?)
    } else {
        None
    };
    let mut command = Command::new(executable);
    command
        .arg(flag)
        .arg("--archive-root")
        .arg(archive_root)
        .arg("--stage-root")
        .arg(stage_root);
    if plan.is_some() {
        command.arg("--cancel-fd").arg("3");
    }
    if cancel_after_input {
        let Some(plan_bytes) = plan else {
            return Err((WorkerFailure::Protocol, None, true, not_started));
        };
        command
            .arg("--probe-bytes")
            .arg(plan_bytes.len().to_string());
    }
    command
        .stdin(if plan.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear()
        .env("LANG", "C")
        .env("LC_ALL", "C");
    let read_fd = cancel_pipe.as_ref().map(CancelPipe::read_fd);
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if let Some(fd) = read_fd {
                if libc::dup2(fd, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if fd != 3 {
                    libc::close(fd);
                }
                let flags = libc::fcntl(3, libc::F_GETFD);
                if flags < 0 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let spawn_started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|_| (WorkerFailure::Spawn, None, true, not_started))?;
    let pid = child.id() as i32;
    let mut monitor = Monitor::new(spawn_started);
    let mut pipes = match ChildPipes::from_child(&mut child, plan.is_some()) {
        Ok(pipes) => pipes,
        Err(()) => {
            let status = terminate_and_reap(&mut child, pid);
            let reaped = status.is_some();
            return Err((
                if reaped {
                    WorkerFailure::Pipe
                } else {
                    WorkerFailure::Unreaped
                },
                status,
                reaped,
                monitor.finish(),
            ));
        }
    };
    let mut input_offset = 0usize;
    let mut input_complete_at = None;
    let mut termination_started = None;
    let mut kill_sent = false;
    let mut failure = None;
    let mut cancellation_requested = false;
    let mut output = Vec::with_capacity(1024);
    let status = loop {
        let now = Instant::now();
        if let Some(monitor_failure) = monitor.sample_if_due(pid, now) {
            if failure.is_none() {
                failure = Some(match monitor_failure {
                    MonitorFailure::ObservedFootprintLimit => WorkerFailure::ObservedFootprintLimit,
                    MonitorFailure::ResourceMonitorUnavailable => {
                        WorkerFailure::ResourceMonitorUnavailable
                    }
                });
            }
        }
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire))
            && termination_started.is_none()
        {
            cancellation_requested = true;
            if let Some(pipe) = cancel_pipe.as_ref() {
                if pipe.signal().is_err() {
                    failure = Some(WorkerFailure::Pipe);
                }
            }
            pipes.stdin.take();
            termination_started = Some(Instant::now());
        }
        if spawn_started.elapsed() >= WALL_LIMIT && failure.is_none() {
            failure = Some(WorkerFailure::TimedOut);
        }
        if failure.is_none() && termination_started.is_none() {
            if let Some(plan_bytes) = plan {
                if pipes.pump_input(plan_bytes, &mut input_offset).is_err() {
                    failure = Some(WorkerFailure::Pipe);
                }
            }
        } else if failure.is_some() {
            pipes.stdin.take();
        }
        if cancel_after_input && plan.is_some_and(|bytes| input_offset == bytes.len()) {
            input_complete_at.get_or_insert(now);
        }
        let ready_marker_seen = output
            .windows(CANCEL_IGNORE_READY_MARKER.len())
            .any(|window| window == CANCEL_IGNORE_READY_MARKER);
        if cancel_after_input
            && termination_started.is_none()
            && plan.is_some_and(|bytes| input_offset == bytes.len())
            && ready_marker_seen
        {
            if let Some(flag) = cancelled {
                flag.store(true, Ordering::Release);
            } else {
                failure = Some(WorkerFailure::Protocol);
            }
        } else if cancel_after_input
            && termination_started.is_none()
            && !ready_marker_seen
            && failure.is_none()
            && input_complete_at.is_some_and(|time| time.elapsed() >= CANCEL_PROBE_READY_LIMIT)
        {
            failure = Some(WorkerFailure::Protocol);
        }
        if pipes.drain_output(&mut output).is_err() && failure.is_none() {
            failure = Some(WorkerFailure::OutputLimit);
        }
        if failure.is_some() {
            if termination_started.is_none() {
                if let Some(pipe) = cancel_pipe.as_ref() {
                    let _ = pipe.signal();
                }
                pipes.stdin.take();
                termination_started = Some(Instant::now());
            }
        }
        if !kill_sent && termination_started.is_some_and(|time| time.elapsed() >= FORCE_KILL_AFTER)
        {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            kill_sent = true;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if monitor.successful_samples() == 0 && failure.is_none() {
                    failure = Some(WorkerFailure::ResourceMonitorUnavailable);
                }
                break Some(status);
            }
            Ok(None) => {}
            Err(_) => {
                if failure.is_none() {
                    failure = Some(WorkerFailure::Wait);
                }
            }
        }
        if termination_started.is_some_and(|time| time.elapsed() >= CLEANUP_LIMIT) {
            return Err((WorkerFailure::Unreaped, None, false, monitor.finish()));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if pipes.drain_output(&mut output).is_err() && failure.is_none() {
        failure = Some(WorkerFailure::OutputLimit);
    }
    let observation = monitor.finish();
    if let Some(error) = failure {
        return Err((error, status, true, observation));
    }
    if cancellation_requested {
        return Err((WorkerFailure::Cancelled, status, true, observation));
    }
    let response = serde_json::from_slice(&output)
        .map_err(|_| (WorkerFailure::Protocol, status, true, observation))?;
    Ok((response, status, observation))
}

#[cfg(target_os = "macos")]
pub(crate) fn fixed_worker_code(code: &str) -> Option<&'static str> {
    const CODES: &[&str] = &[
        "dependency_worker_arguments_invalid",
        "dependency_worker_roots_invalid",
        "dependency_stage_permissions_invalid",
        "dependency_cache_permissions_invalid",
        "dependency_worker_platform_unsupported",
        "dependency_worker_sandbox_failed",
        "dependency_worker_sandbox_unavailable",
        "dependency_worker_sandbox_policy_failed",
        "dependency_worker_limits_unavailable",
        "dependency_stage_unavailable",
        "dependency_stage_not_empty",
        "dependency_stage_write_failed",
        "dependency_plan_read_failed",
        "dependency_plan_limit",
        "dependency_plan_invalid",
        "dependency_plan_checksum_invalid",
        "dependency_worker_cancelled",
        "dependency_worker_timeout",
        "dependency_worker_failed",
        "dependency_archive_missing",
        "dependency_cache_miss",
        "dependency_archive_invalid",
        "dependency_archive_unavailable",
        "dependency_archive_read_failed",
        "dependency_archive_changed",
        "dependency_archive_limit",
        "dependency_archive_integrity_failed",
        "dependency_archive_path_invalid",
        "dependency_archive_entry_invalid",
        "dependency_archive_entry_unsupported",
        "dependency_archive_duplicate",
        "dependency_archive_collision",
        "dependency_archive_write_failed",
        "dependency_manifest_limit",
        "dependency_manifest_write_failed",
        "dependency_worker_output_failed",
        "dependency_worker_output_limit",
        "dependency_package_identity_limit",
        "dependency_package_identity_invalid",
        "dependency_package_identity_mismatch",
        "dependency_package_metadata_missing",
        "dependency_package_metadata_invalid",
        "dependency_package_metadata_changed",
    ];
    CODES.iter().copied().find(|candidate| *candidate == code)
}

#[cfg(target_os = "macos")]
fn terminate_and_reap(child: &mut Child, pid: i32) -> Option<ExitStatus> {
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        if started.elapsed() >= CLEANUP_LIMIT {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
