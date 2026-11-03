#![cfg(all(target_os = "macos", target_arch = "aarch64"))]

//! Opt-in real LegacyNodeSession checks for managed detached-child behavior.

#[path = "common/legacy_node_managed_children.rs"]
mod support;

use std::time::Duration;

use atools_plugin::sidecar::SidecarStatus;
use serde_json::Value;

use support::*;

const MANAGED_CHILD_FIXTURE: &str = include_str!("fixtures/managed_child_lifecycle_probe.cjs");
const INHERITANCE_FIXTURE: &str = include_str!("fixtures/managed_child_inheritance_probe.cjs");

#[tokio::test]
#[ignore = "requires local AF_UNIX transport and bundled Node; fixed short-lived helpers only"]
async fn product_node_raw_same_group_spawn_does_not_inherit_transport_sockets_or_env() {
    let Some(node_binary) = enter_isolated_case(
        "product_node_raw_same_group_spawn_does_not_inherit_transport_sockets_or_env",
        "raw-inheritance",
    ) else {
        return;
    };
    let temp = fixture(
        "fixtures/managed_child_inheritance_probe.cjs",
        INHERITANCE_FIXTURE,
    );
    let session = start_session(&temp).await;
    let module = require_module(&session, "./fixtures/managed_child_inheritance_probe.cjs").await;
    assert_product_runtime(&session, &module, &node_binary).await;

    let load_environment =
        get_property(&session, &module, "moduleLoadReservedEnvironmentAbsent").await;
    let pending = call_method(&session, &module, "observeRawChildInheritance", vec![]).await;
    let mut observed = Err("raw inheritance call did not start".to_string());
    if let Ok(pending) = pending {
        observed = poll_promise(&session, &pending).await;
    }
    let mut fields = std::collections::BTreeMap::new();
    if let Ok(object) = &observed {
        for field in [
            "moduleLoadReservedEnvironmentAbsent",
            "parentReservedEnvironmentKeysPresent",
            "parentSocketFds",
            "childExitCode",
            "childSignalCode",
            "childPid",
            "sameFdMatches",
            "sameSocketIdentityMatches",
        ] {
            fields.insert(field, get_resolved_field(&session, object, field).await);
        }
    }
    let close_result = session.stop().await;

    assert_eq!(load_environment["value"], true);
    let observed = observed.expect("raw same-group child report");
    assert_eq!(observed["kind"], "handle");
    assert!(observed["handleId"].as_i64().unwrap_or_default() > 0);
    let module_loaded_clean = &fields["moduleLoadReservedEnvironmentAbsent"];
    assert_eq!(module_loaded_clean.as_ref().unwrap()["value"], true);
    assert_eq!(
        fields["parentReservedEnvironmentKeysPresent"]
            .as_ref()
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert!(
        fields["parentSocketFds"].as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .len()
            >= 2
    );
    assert_eq!(fields["childExitCode"].as_ref().unwrap()["value"], 0);
    assert_eq!(
        fields["childSignalCode"].as_ref().unwrap()["value"],
        Value::Null
    );
    let observed_child_pid = fields["childPid"].as_ref().unwrap()["value"]
        .as_i64()
        .expect("raw helper reports its child PID") as i32;
    assert!(observed_child_pid > 0);
    assert_eq!(
        fields["sameFdMatches"].as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        fields["sameSocketIdentityMatches"].as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    close_result.expect("strict root close after raw child exited");
    assert!(
        process_is_gone(observed_child_pid),
        "raw child must be reaped before completion"
    );
}

#[tokio::test]
#[ignore = "requires local AF_UNIX transport and bundled Node; helper self-exits within 2.6 seconds"]
async fn product_node_harris_stdio_modes_capture_output_and_write_stdin() {
    let Some(node_binary) = enter_isolated_case(
        "product_node_harris_stdio_modes_capture_output_and_write_stdin",
        "stdio",
    ) else {
        return;
    };
    let temp = fixture("managed_child_lifecycle_probe.cjs", MANAGED_CHILD_FIXTURE);
    let session = start_session(&temp).await;
    let module = require_module(&session, "./managed_child_lifecycle_probe.cjs").await;
    assert_product_runtime(&session, &module, &node_binary).await;
    let mut outcomes = Vec::new();

    for (name, mode, input) in [("ignore", "ignore", ""), ("stdin", "pipe", "harris-input")] {
        let marker = temp.path().join(format!("{name}-report.json"));
        let spawn = call_method(
            &session,
            &module,
            "spawnStdioProbe",
            vec![
                argument(marker.display().to_string()),
                argument(mode.to_string()),
                argument(input.to_string()),
            ],
        )
        .await;
        let (root_pid, child_pid) = match spawn {
            Ok(result) => (
                array_item_number(&result, 0).map(|pid| pid as i32),
                array_item_number(&result, 1).map(|pid| pid as i32),
            ),
            Err(_) => (None, None),
        };
        let groups = child_pid.map(|child| {
            let root_group = root_pid.and_then(process_group);
            let child_group = process_group(child);
            (root_group, child_group)
        });
        let report = wait_for_report(&marker, REPORT_TIMEOUT).await;
        let child_gone = match child_pid {
            Some(pid) => wait_for_pid_gone(pid).await,
            None => false,
        };
        outcomes.push((mode, root_pid, child_pid, groups, report, child_gone));
    }
    let close_result = session.stop().await;

    close_result.expect("strict sidecar and managed-child close");
    for (mode, root_pid, child_pid, groups, report, child_gone) in outcomes {
        let report = report.expect("bounded helper output report");
        let root_pid = root_pid.expect("positive root PID");
        let child_pid = child_pid.expect("positive managed child PID");
        let (root_group, child_group) = groups.expect("process group observation");
        assert_eq!(root_group, Some(root_pid));
        assert_eq!(child_group, Some(child_pid));
        assert_ne!(
            root_group, child_group,
            "managed detached child owns an independent group"
        );
        assert_eq!(report["pid"], child_pid);
        assert_eq!(report["exitCode"], 0);
        assert_eq!(report["signalCode"], Value::Null);
        assert_eq!(report["spawnError"], Value::Null);
        assert_eq!(report["outputOverflow"], false);
        assert!(
            child_gone,
            "helper PID must be reaped before the case completes"
        );
        match mode {
            "ignore" => {
                assert_eq!(report["stdout"], "stdout:ready\n");
                assert_eq!(report["stderr"], "stderr:ready\n");
            }
            "pipe" => {
                assert_eq!(report["stdout"], "stdout:harris-input");
                assert_eq!(report["stderr"], "stderr:harris-input");
            }
            _ => unreachable!("fixed case list"),
        }
    }
}

#[tokio::test]
#[ignore = "requires local AF_UNIX transport and bundled Node; output payload is bounded at 96 KiB"]
async fn product_node_exit_before_unread_stdout_still_emits_close() {
    let Some(node_binary) = enter_isolated_case(
        "product_node_exit_before_unread_stdout_still_emits_close",
        "exit-before-output-consume",
    ) else {
        return;
    };
    let temp = fixture("managed_child_lifecycle_probe.cjs", MANAGED_CHILD_FIXTURE);
    let session = start_session(&temp).await;
    let module = require_module(&session, "./managed_child_lifecycle_probe.cjs").await;
    assert_product_runtime(&session, &module, &node_binary).await;

    let result = match call_method(
        &session,
        &module,
        "waitForExitBeforeConsumingOutput",
        vec![],
    )
    .await
    {
        Ok(pending) => {
            match tokio::time::timeout(Duration::from_secs(2), poll_promise(&session, &pending))
                .await
            {
                Ok(result) => result,
                Err(_) => Err("close Promise exceeded the 2s liveness deadline".into()),
            }
        }
        Err(error) => Err(format!("start exit-before-consume probe: {error}")),
    };
    let close_result = session.stop().await;

    close_result.expect("strict sidecar and managed-child cleanup after bounded probe");
    let result = result.expect("exit and close must arrive after stdout is consumed");
    let child_pid = array_item_number(&result, 1).expect("helper child PID") as i32;
    assert!(child_pid > 0);
    assert_eq!(result["items"][2]["value"], true, "exit callback ran");
    assert_eq!(array_item_number(&result, 3), Some(19));
    assert_eq!(
        result["items"][4]["value"],
        Value::Null,
        "exit was not signaled"
    );
    assert_eq!(array_item_number(&result, 5), Some(19));
    assert_eq!(
        result["items"][6]["value"],
        Value::Null,
        "close was not signaled"
    );
    let output_bytes = array_item_number(&result, 7).expect("captured stdout byte count");
    assert!(
        output_bytes > 0,
        "the deferred listener receives stdout bytes"
    );
    assert!(output_bytes <= 96 * 1024, "the helper output is bounded");
    assert!(
        wait_for_pid_gone(child_pid).await,
        "helper PID must be reaped after close"
    );
}

#[tokio::test]
#[ignore = "requires local AF_UNIX transport and bundled Node; helpers are fixed and bounded"]
async fn product_node_quick_exit_enoent_and_single_handle_kill_are_reported() {
    let Some(node_binary) = enter_isolated_case(
        "product_node_quick_exit_enoent_and_single_handle_kill_are_reported",
        "spawn-errors-kill",
    ) else {
        return;
    };
    let temp = fixture("managed_child_lifecycle_probe.cjs", MANAGED_CHILD_FIXTURE);
    let session = start_session(&temp).await;
    let module = require_module(&session, "./managed_child_lifecycle_probe.cjs").await;
    assert_product_runtime(&session, &module, &node_binary).await;

    let quick_marker = temp.path().join("quick-report.json");
    let quick = call_method(
        &session,
        &module,
        "spawnQuickExit",
        vec![argument(quick_marker.display().to_string())],
    )
    .await;
    let quick_pid = quick
        .as_ref()
        .ok()
        .and_then(|result| array_item_number(result, 1))
        .map(|pid| pid as i32);
    let quick_report = wait_for_report(&quick_marker, REPORT_TIMEOUT).await;
    let quick_gone = match quick_pid {
        Some(pid) => wait_for_pid_gone(pid).await,
        None => false,
    };

    let missing_marker = temp.path().join("missing-report.json");
    let missing_path = temp.path().join("definitely-missing-managed-helper");
    let missing = call_method(
        &session,
        &module,
        "spawnMissing",
        vec![
            argument(missing_marker.display().to_string()),
            argument(missing_path.display().to_string()),
        ],
    )
    .await;
    let missing_report = wait_for_report(&missing_marker, REPORT_TIMEOUT).await;

    let kill_marker = temp.path().join("kill-report.json");
    let long_lived = call_method(
        &session,
        &module,
        "spawnLongLived",
        vec![argument(kill_marker.display().to_string())],
    )
    .await;
    assert!(long_lived.is_ok(), "live ignore-stdio helper should start");
    let kill_pid = long_lived
        .as_ref()
        .ok()
        .and_then(|result| array_item_number(result, 1))
        .map(|pid| pid as i32);
    let live_helper_pid = kill_pid.expect("live ignore-stdio helper PID");
    assert!(
        !process_is_gone(live_helper_pid),
        "idle CPU sample needs a live helper"
    );
    let cpu_before = process_cpu_time();
    let idle_started = std::time::Instant::now();
    tokio::time::sleep(Duration::from_millis(250)).await;
    let idle_wall = idle_started.elapsed();
    let idle_cpu = process_cpu_time() - cpu_before;
    eprintln!(
        "Task20 managed-child idle sample: cpu_ms={:.2} wall_ms={:.2}",
        idle_cpu.as_secs_f64() * 1000.0,
        idle_wall.as_secs_f64() * 1000.0
    );
    assert!(
        idle_cpu < idle_wall.mul_f64(0.5),
        "idle Rust process CPU should stay below half wall time (cpu={idle_cpu:?}, wall={idle_wall:?})"
    );
    let kill_result = call_method(&session, &module, "killLastChild", vec![]).await;
    let kill_report = wait_for_report(&kill_marker, REPORT_TIMEOUT).await;
    let kill_gone = match kill_pid {
        Some(pid) => wait_for_pid_gone_with(pid, Duration::from_secs(1)).await,
        None => false,
    };
    if let Some(pid) = kill_pid {
        let _ = wait_for_pid_gone(pid).await;
    }
    let close_result = session.stop().await;

    close_result.expect("strict close after all child outcomes");
    assert!(quick.is_ok(), "quick child spawn should succeed");
    let quick_report = quick_report.unwrap();
    assert_eq!(quick_report["pid"], quick_pid.unwrap());
    assert_eq!(quick_report["exitCode"], 23);
    assert!(quick_gone, "quick exit child must be reaped");
    assert!(
        missing.is_ok(),
        "missing executable is reported through child events"
    );
    let missing_report = missing_report.unwrap();
    assert_eq!(missing_report["pid"], Value::Null);
    assert_eq!(missing_report["spawnError"]["code"], "ENOENT");
    assert!(kill_result.unwrap()["value"].as_bool().unwrap_or(false));
    let kill_report = kill_report.unwrap();
    assert_eq!(kill_report["pid"], kill_pid.unwrap());
    assert_eq!(kill_report["signalCode"], "SIGTERM");
    assert!(
        kill_gone,
        "single opaque-handle kill must reap only that child"
    );
}

#[tokio::test]
#[ignore = "requires local AF_UNIX transport and bundled Node; helpers self-exit within 2.6 seconds"]
async fn product_node_root_crash_and_session_drop_reap_detached_helpers() {
    let Some(node_binary) = enter_isolated_case(
        "product_node_root_crash_and_session_drop_reap_detached_helpers",
        "root-cleanup",
    ) else {
        return;
    };
    let temp = fixture("managed_child_lifecycle_probe.cjs", MANAGED_CHILD_FIXTURE);
    let session = start_session(&temp).await;
    let module = require_module(&session, "./managed_child_lifecycle_probe.cjs").await;
    assert_product_runtime(&session, &module, &node_binary).await;
    let crash_marker = temp.path().join("crash-report.json");
    let launched = call_method(
        &session,
        &module,
        "spawnLongLived",
        vec![argument(crash_marker.display().to_string())],
    )
    .await;
    let (crash_root_pid, crash_child_pid) = match launched {
        Ok(result) => (
            array_item_number(&result, 0).map(|pid| pid as i32),
            array_item_number(&result, 1).map(|pid| pid as i32),
        ),
        Err(_) => (None, None),
    };
    let crash = call_method(&session, &module, "crashRoot", vec![]).await;
    let crash_terminal = wait_for_terminal(&session).await;
    let crash_status = session.status();
    let crash_root_gone = match crash_root_pid {
        Some(pid) => wait_for_pid_gone_with(pid, Duration::from_secs(1)).await,
        None => false,
    };
    let crash_child_gone = match crash_child_pid {
        Some(pid) => wait_for_pid_gone_with(pid, Duration::from_secs(1)).await,
        None => false,
    };
    if let Some(pid) = crash_root_pid {
        let _ = wait_for_pid_gone(pid).await;
    }
    if let Some(pid) = crash_child_pid {
        let _ = wait_for_pid_gone(pid).await;
    }
    let crash_close = session.stop().await;
    drop(session);

    let drop_temp = fixture("managed_child_lifecycle_probe.cjs", MANAGED_CHILD_FIXTURE);
    let drop_session = start_session(&drop_temp).await;
    let drop_module = require_module(&drop_session, "./managed_child_lifecycle_probe.cjs").await;
    assert_product_runtime(&drop_session, &drop_module, &node_binary).await;
    let drop_marker = drop_temp.path().join("drop-report.json");
    let dropped_launch = call_method(
        &drop_session,
        &drop_module,
        "spawnLongLived",
        vec![argument(drop_marker.display().to_string())],
    )
    .await;
    let (drop_root_pid, drop_child_pid) = match dropped_launch {
        Ok(result) => (
            array_item_number(&result, 0).map(|pid| pid as i32),
            array_item_number(&result, 1).map(|pid| pid as i32),
        ),
        Err(_) => (None, None),
    };
    drop(drop_session);
    let drop_root_gone = match drop_root_pid {
        Some(pid) => wait_for_pid_gone_with(pid, Duration::from_secs(1)).await,
        None => false,
    };
    let drop_child_gone = match drop_child_pid {
        Some(pid) => wait_for_pid_gone_with(pid, Duration::from_secs(1)).await,
        None => false,
    };
    if let Some(pid) = drop_root_pid {
        let _ = wait_for_pid_gone(pid).await;
    }
    if let Some(pid) = drop_child_pid {
        let _ = wait_for_pid_gone(pid).await;
    }

    assert!(crash.is_ok(), "root crash request should be accepted");
    assert!(crash_terminal, "supervisor observes the crashed root");
    assert_eq!(crash_status, SidecarStatus::Crashed);
    assert!(crash_root_gone, "crashed root must be reaped");
    assert!(
        crash_child_gone,
        "owner must reap the detached helper after root crash"
    );
    crash_close.expect("terminal crash close reports successful helper cleanup");
    assert!(
        drop_root_gone,
        "dropping the session must terminate its root process"
    );
    assert!(
        drop_child_gone,
        "dropping the session must reap its detached helper"
    );
}
