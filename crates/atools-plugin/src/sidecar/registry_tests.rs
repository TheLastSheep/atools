use super::SidecarSupervisor;
use crate::sidecar::{SidecarError, SidecarLaunchSpec, SidecarProcess, SidecarStatus};
use atools_core::{PluginRuntimeKind, PluginRuntimeTransport};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;

fn shell_spec(plugin_id: &str, plugin_dir: &Path) -> SidecarLaunchSpec {
    SidecarLaunchSpec {
        plugin_id: plugin_id.to_string(),
        plugin_dir: plugin_dir.to_path_buf(),
        entry: PathBuf::from("/bin/sh"),
        runtime: PluginRuntimeKind::Rust,
        transport: PluginRuntimeTransport::JsonRpcStdio,
        args: vec!["-c".into(), "exec sleep 30".into()],
        env: BTreeMap::new(),
        startup_timeout: Duration::from_secs(2),
        request_timeout: Duration::from_secs(2),
    }
}

fn unisolated_shell_command(plugin_dir: &Path) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("exec sleep 30")
        .current_dir(plugin_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

fn process_is_gone(pid: u32) -> bool {
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return false;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[tokio::test]
async fn concurrent_start_same_plugin_returns_single_owner() {
    let directory = tempfile::tempdir().unwrap();
    let supervisor = SidecarSupervisor::new();
    let spec = shell_spec("registry-concurrent-start", directory.path());

    // Both futures pass the initial empty-map check before either sleeping worker
    // reaches Running and can be published. Each child is a real, owned test process.
    let (first, second) = tokio::join!(supervisor.start(spec.clone()), supervisor.start(spec));
    let first = first.expect("first sidecar starts");
    let second = second.expect("second caller obtains the sidecar owner");
    let first_pid = first.owned_pid.expect("first fixture PID");
    let second_pid = second.owned_pid.expect("second fixture PID");
    eprintln!("registry-concurrent-start fixture pids: {first_pid}, {second_pid}");
    let same_owner = Arc::ptr_eq(&first, &second);
    let registered = supervisor
        .get("registry-concurrent-start")
        .await
        .expect("one owner should be registered");
    let registered_is_returned_owner =
        Arc::ptr_eq(&registered, &first) || Arc::ptr_eq(&registered, &second);

    // Clean every handle even when the red assertion below detects duplicate spawns.
    let first_shutdown = first.shutdown().await;
    let second_shutdown = second.shutdown().await;
    assert!(
        first_shutdown.is_ok(),
        "first owned child cleanup: {first_shutdown:?}"
    );
    assert!(
        second_shutdown.is_ok(),
        "second owned child cleanup: {second_shutdown:?}"
    );
    let registry_stop = supervisor.stop("registry-concurrent-start").await;

    assert!(registry_stop.is_ok(), "registry cleanup: {registry_stop:?}");
    assert!(
        process_is_gone(first_pid),
        "first fixture PID {first_pid} is reaped"
    );
    assert!(
        process_is_gone(second_pid),
        "second fixture PID {second_pid} is reaped"
    );
    assert!(registered_is_returned_owner);
    assert!(
        same_owner,
        "concurrent starts for one plugin must share one Arc and must not spawn twice"
    );
    assert!(matches!(first.status(), SidecarStatus::Stopped));
    assert!(matches!(second.status(), SidecarStatus::Stopped));
}

#[tokio::test]
async fn failed_stop_keeps_owner_and_blocks_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let plugin_id = "registry-failed-stop";
    let spec = shell_spec(plugin_id, directory.path());
    let process = SidecarProcess::spawn_with_command_and_diagnostics_and_permit(
        spec.clone(),
        unisolated_shell_command(directory.path()),
        None,
        None,
    )
    .await
    .expect("controlled sidecar starts in the test process group");
    let pid = process.owned_pid.expect("controlled fixture PID");
    eprintln!("registry-failed-stop fixture pid: {pid}");
    let supervisor = SidecarSupervisor::new();
    supervisor
        .processes
        .write()
        .await
        .insert(plugin_id.to_string(), process.clone());

    // The actual child is terminated and waited; cleanup still fails because this
    // fixture deliberately has no owned process group. SidecarProcess caches that
    // terminal cleanup failure and cannot safely retry it.
    let first_error = supervisor
        .stop(plugin_id)
        .await
        .expect_err("an unowned process group must be reported to the caller");
    assert!(
        matches!(&first_error, SidecarError::Crashed(message) if message.contains("process group"))
    );
    assert!(
        process_is_gone(pid),
        "failed-cleanup direct child PID {pid} is reaped"
    );
    assert_eq!(process.status(), SidecarStatus::Crashed);
    let repeated_error = process
        .shutdown()
        .await
        .expect_err("the terminal cleanup error is sticky, not retried");
    assert_eq!(repeated_error, first_error);

    // A new start must not replace an owner whose group cleanup was unconfirmed.
    // Capture state before cleanup so this assertion remains meaningful on the red version.
    let replacement_result = supervisor.start(spec).await;
    let current = supervisor.get(plugin_id).await;
    let retained_same_owner = current
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, &process));
    let did_not_return_replacement = match replacement_result.as_ref() {
        Ok(replacement) => Arc::ptr_eq(replacement, &process),
        Err(_) => true,
    };

    // If the broken implementation did spawn a replacement, stop it before failing.
    let replacement_cleanup = match replacement_result {
        Ok(replacement) if !Arc::ptr_eq(&replacement, &process) => {
            Some(replacement.shutdown().await)
        }
        _ => None,
    };
    let mut replacement_stop = None;
    if let Some(current) = current {
        if !Arc::ptr_eq(&current, &process) {
            replacement_stop = Some(supervisor.stop(plugin_id).await);
        }
    }

    assert!(
        replacement_cleanup
            .as_ref()
            .map_or(true, |result| result.is_ok()),
        "replacement cleanup: {replacement_cleanup:?}"
    );
    assert!(
        replacement_stop
            .as_ref()
            .map_or(true, |result| result.is_ok()),
        "replacement registry cleanup: {replacement_stop:?}"
    );
    assert!(
        retained_same_owner,
        "failed stop must keep the original owner queryable"
    );
    assert!(
        did_not_return_replacement,
        "start must reject or preserve the failed owner, never return a new owner"
    );
}

#[tokio::test]
async fn stop_all_strict_attempts_every_owner_and_returns_failures() {
    let directory = tempfile::tempdir().unwrap();
    let supervisor = SidecarSupervisor::new();
    let healthy_id = "registry-stop-all-healthy";
    let healthy = supervisor
        .start(shell_spec(healthy_id, directory.path()))
        .await
        .expect("healthy fixture starts through supervisor");
    let healthy_pid = healthy.owned_pid.expect("healthy fixture PID");

    let failed_id = "registry-stop-all-failed";
    let failed = SidecarProcess::spawn_with_command_and_diagnostics_and_permit(
        shell_spec(failed_id, directory.path()),
        unisolated_shell_command(directory.path()),
        None,
        None,
    )
    .await
    .expect("failure fixture starts in the test process group");
    let failed_pid = failed.owned_pid.expect("failed fixture PID");
    supervisor
        .processes
        .write()
        .await
        .insert(failed_id.to_string(), failed.clone());
    eprintln!("registry-stop-all fixture pids: healthy={healthy_pid}, failed={failed_pid}");

    let result = supervisor.stop_all_strict().await;
    let healthy_retained = supervisor.get(healthy_id).await;
    let failed_retained = supervisor.get(failed_id).await;
    let repeated_failure = failed
        .shutdown()
        .await
        .expect_err("failed cleanup is sticky and is not presented as recovered");

    assert!(
        process_is_gone(healthy_pid),
        "healthy fixture PID {healthy_pid} is reaped"
    );
    assert!(
        process_is_gone(failed_pid),
        "failed fixture PID {failed_pid} is reaped"
    );
    assert!(
        healthy_retained.is_none(),
        "successfully stopped owner is removed"
    );
    assert!(
        failed_retained
            .as_ref()
            .is_some_and(|retained| Arc::ptr_eq(retained, &failed)),
        "failed owner remains queryable"
    );
    assert_eq!(failed.status(), SidecarStatus::Crashed);
    match result {
        Err(failures) => {
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0].0, failed_id);
            assert_eq!(failures[0].1, repeated_failure);
        }
        Ok(()) => panic!("stop_all_strict must surface the failed plugin owner"),
    }
}
