use super::{
    evidence::DatabaseEvidence,
    process,
    schema::{self, Evidence, Operation, ProbeId},
    state::Harness,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};
use tauri::{AppHandle, Wry};

const RECEIPT_TIMEOUT: Duration = Duration::from_secs(12);

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) {
    let result = execute(app, harness).await;
    if let Err(error) = result {
        harness.record_error(error);
    }
    if let Err(error) = restore_input(app, harness).await {
        harness.record_error(error);
    }
    finalize(harness).await;
}

async fn restore_input(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    show_and_focus_main(app).await?;
    let receipt = call_probe(app, harness, Operation::RestoreInput, Value::Null).await?;
    match schema::parse(Operation::RestoreInput, &receipt, harness.enter_case())
        .map_err(|_| "launcher-operation-protocol-rejected")?
    {
        Evidence::RestoreInput(true) => Ok(()),
        Evidence::RestoreInput(false) => Err("launcher-renderer-probe-not-ready"),
        _ => Err("launcher-operation-protocol-rejected"),
    }
}

async fn execute(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    if !harness.fixture_valid() {
        return Err("launcher-owned-fixture-not-verified");
    }
    let baseline = DatabaseEvidence::read(&harness.database())
        .map_err(|_| "launcher-owned-fixture-not-verified")?;
    let baseline_markers_absent = process::markers_absent(harness.profile_root());
    if !baseline.empty() || !baseline_markers_absent {
        return Err("launcher-owned-fixture-not-verified");
    }
    if !harness.enter_case() {
        harness.update_report(|report| {
            report.space_disabled.no_task_run = baseline.task_run_count() == 0;
            report.space_disabled.no_marker = baseline_markers_absent;
            report.space_disabled.no_history = baseline.history_count() == 0;
        });
    }

    let search = call_probe(app, harness, Operation::Search, Value::Null).await?;
    let search = schema::parse(Operation::Search, &search, harness.enter_case())
        .map_err(|_| "launcher-dom-search-not-verified")?;
    let Evidence::Search(search) = search else {
        return Err("launcher-dom-search-not-verified");
    };
    let target_probe = search.selected_after;
    let target_path = harness.path_for(target_probe).to_owned();
    let target_name = match target_probe {
        ProbeId::First => "AToolsOwnedProbeFirst",
        ProbeId::Second => "AToolsOwnedProbeSecond",
    };

    let unlisted_path = harness
        .profile_root()
        .join("launcher-apps")
        .join("AToolsOwnedProbeUnlisted.app");
    if !path_is_absent(&unlisted_path) {
        return Err("launcher-unlisted-launch-not-rejected");
    }
    let unlisted_args = json!({
        "unlistedPath": unlisted_path.to_string_lossy().into_owned()
    });
    let unlisted_receipt = call_probe(app, harness, Operation::Unlisted, unlisted_args).await?;
    let unlisted = schema::parse(Operation::Unlisted, &unlisted_receipt, harness.enter_case())
        .map_err(|_| "launcher-unlisted-launch-not-rejected")?;
    if !matches!(unlisted, Evidence::Unlisted(_)) {
        return Err("launcher-unlisted-launch-not-rejected");
    }
    let after_unlisted = DatabaseEvidence::read(&harness.database())
        .map_err(|_| "launcher-unlisted-launch-not-rejected")?;
    let unlisted_clean = after_unlisted.empty() && process::markers_absent(harness.profile_root());
    harness.update_report(|report| {
        report.unlisted.no_task_run = after_unlisted.task_run_count() == 0;
        report.unlisted.no_marker = process::markers_absent(harness.profile_root());
        report.unlisted.no_history = after_unlisted.history_count() == 0;
    });
    if !unlisted_clean {
        return Err("launcher-unlisted-launch-not-rejected");
    }

    if harness.enter_case() {
        let space_receipt = call_probe(app, harness, Operation::SpaceDisabled, Value::Null).await?;
        let space = schema::parse(Operation::SpaceDisabled, &space_receipt, true)
            .map_err(|_| "launcher-space-disabled-not-verified")?;
        if !matches!(space, Evidence::SpaceDisabled(_)) {
            return Err("launcher-space-disabled-not-verified");
        }
        let after_space = DatabaseEvidence::read(&harness.database())
            .map_err(|_| "launcher-space-disabled-not-verified")?;
        let no_markers = process::markers_absent(harness.profile_root());
        harness.update_report(|report| {
            report.space_disabled.no_task_run = after_space.task_run_count() == 0;
            report.space_disabled.no_marker = no_markers;
            report.space_disabled.no_history = after_space.history_count() == 0;
        });
        if !after_space.empty() || !no_markers {
            return Err("launcher-space-disabled-not-verified");
        }
    }

    let policy_readback = set_scope_deny(&harness.database());
    harness.update_report(|report| report.denied.policy_readback = policy_readback);
    if !policy_readback {
        return Err("launcher-deny-policy-not-enforced");
    }
    let denied_args = launch_args(harness, target_path.as_str(), target_name);
    let denied_receipt = call_probe(app, harness, Operation::LaunchDenied, denied_args).await?;
    let denied = schema::parse(
        Operation::LaunchDenied,
        &denied_receipt,
        harness.enter_case(),
    )
    .map_err(|_| "launcher-deny-policy-not-enforced")?;
    if !matches!(denied, Evidence::Launch(_)) {
        return Err("launcher-deny-policy-not-enforced");
    }
    let denied_state = DatabaseEvidence::read(&harness.database())
        .map_err(|_| "launcher-deny-policy-not-enforced")?;
    let denied_markers_absent = process::markers_absent(harness.profile_root());
    let denied_run =
        denied_state.denied_run_count(&target_path) == 1 && denied_state.task_run_count() == 1;
    let denied_audit = denied_state.denied_audit(&target_path);
    let denied_history_empty = denied_state.history_count() == 0;
    harness.update_report(|report| {
        report.denied.task_run_cancelled = denied_run;
        report.denied.audit_denied = denied_audit;
        report.denied.no_marker = denied_markers_absent;
        report.denied.no_history = denied_history_empty;
    });
    if !denied_run || !denied_audit || !denied_markers_absent || !denied_history_empty {
        return Err("launcher-deny-policy-not-enforced");
    }

    let policy_cleared = clear_scope_deny(&harness.database());
    harness.update_report(|report| report.launched.policy_cleared = policy_cleared);
    if !policy_cleared {
        return Err("launcher-deny-policy-not-enforced");
    }
    show_and_focus_main(app).await?;
    harness.mark_success_launch_attempted();
    let success_args = launch_args(harness, target_path.as_str(), target_name);
    let success_receipt =
        call_probe(app, harness, Operation::LaunchSucceeded, success_args).await?;
    let success = schema::parse(
        Operation::LaunchSucceeded,
        &success_receipt,
        harness.enter_case(),
    )
    .map_err(|_| "launcher-launch-not-verified")?;
    let Evidence::Launch(success) = success else {
        return Err("launcher-launch-not-verified");
    };
    harness.update_report(|report| {
        report.launched.main_history_applied = success.main_history_applied;
    });

    let launch_state =
        DatabaseEvidence::read(&harness.database()).map_err(|_| "launcher-launch-not-verified")?;
    let task_run_ok = launch_state.task_run_count() == 2
        && launch_state.denied_run_count(&target_path) == 1
        && launch_state.succeeded_run_count(&target_path) == 1;
    let audit_ok =
        launch_state.denied_audit(&target_path) && launch_state.succeeded_audit(&target_path);
    let history_count = launch_state.history_count();
    let matching_history_count = launch_state.matching_history_count(&target_path, target_name);
    let use_count = launch_state.matching_history_use_count(&target_path, target_name);
    let main_history_applied = success.main_history_applied
        && success.selected_probe == target_probe
        && matching_history_count == 1
        && use_count == 1;

    harness.update_report(|report| {
        report.launched.task_run_succeeded = task_run_ok;
        report.launched.audit_succeeded = audit_ok;
        report.launched.history_recorded_once = matching_history_count == 1 && history_count == 1;
        report.launched.use_count = use_count;
        report.launched.main_history_applied = main_history_applied;
    });
    if !task_run_ok
        || !audit_ok
        || history_count != 1
        || matching_history_count != 1
        || use_count != 1
    {
        return Err("launcher-launch-not-verified");
    }
    if !main_history_applied {
        return Err("launcher-main-history-not-applied");
    }
    Ok(())
}

fn launch_args(harness: &Harness, path: &str, name: &str) -> Value {
    json!({
        "key": if harness.enter_case() { "Enter" } else { "Space" },
        "targetPath": path,
        "targetName": name
    })
}

async fn call_probe(
    app: &AppHandle<Wry>,
    harness: &Harness,
    operation: Operation,
    args: Value,
) -> Result<Value, &'static str> {
    let (nonce, receiver) = harness.begin(operation)?;
    let webview = match crate::window::main_webview(app) {
        Ok(webview) => webview,
        Err(_) => {
            harness.cancel(operation, &nonce);
            return Err("launcher-renderer-probe-not-ready");
        }
    };
    let operation_json = serde_json::to_string(operation.as_str())
        .map_err(|_| "launcher-operation-protocol-rejected")?;
    let nonce_json =
        serde_json::to_string(&nonce).map_err(|_| "launcher-operation-protocol-rejected")?;
    let args_json =
        serde_json::to_string(&args).map_err(|_| "launcher-operation-protocol-rejected")?;
    let script = format!(
        "window.__ATOOLS_RENDERER_LAUNCHER_PROBE__?.run({operation_json},{nonce_json},{args_json})"
    );
    if webview.eval(script).is_err() {
        harness.cancel(operation, &nonce);
        return Err("launcher-renderer-probe-not-ready");
    }
    match tokio::time::timeout(RECEIPT_TIMEOUT, receiver).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err("launcher-operation-protocol-rejected"),
        Err(_) => {
            harness.cancel(operation, &nonce);
            Err("launcher-renderer-probe-not-ready")
        }
    }
}

fn set_scope_deny(db: &atools_core::Database) -> bool {
    if db
        .set_setting("agent.scope_policy", r#"{"shell":"deny"}"#)
        .is_err()
    {
        return false;
    }
    read_scope_policy(db).is_some_and(|policy| {
        policy.len() == 1 && policy.get("shell").map(String::as_str) == Some("deny")
    })
}

fn clear_scope_deny(db: &atools_core::Database) -> bool {
    if db.set_setting("agent.scope_policy", "{}").is_err() {
        return false;
    }
    read_scope_policy(db).is_some_and(|policy| policy.is_empty())
}

fn read_scope_policy(db: &atools_core::Database) -> Option<BTreeMap<String, String>> {
    let value = db.get_setting("agent.scope_policy").ok()??;
    serde_json::from_str(&value).ok()
}

async fn show_and_focus_main(app: &AppHandle<Wry>) -> Result<(), &'static str> {
    let window =
        crate::window::main_window(app).map_err(|_| "launcher-renderer-probe-not-ready")?;
    let visible = window.is_visible().ok() == Some(true);
    let focused = window.is_focused().ok() == Some(true);
    if visible && focused {
        return Ok(());
    }
    if !visible {
        crate::window::show_main_window(app).map_err(|_| "launcher-renderer-probe-not-ready")?;
    }
    if window.is_focused().ok() != Some(true) {
        window
            .set_focus()
            .map_err(|_| "launcher-renderer-probe-not-ready")?;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if window.is_visible().ok() == Some(true) && window.is_focused().ok() == Some(true) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("launcher-renderer-probe-not-ready");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn path_is_absent(path: &Path) -> bool {
    matches!(
        fs::symlink_metadata(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

async fn finalize(harness: &Harness) {
    let harness = harness.clone();
    let _ = tokio::task::spawn_blocking(move || finalize_sync(&harness)).await;
}

fn finalize_sync(harness: &Harness) {
    let db = harness.database();
    let target_probe = harness.selected_probe().unwrap_or(ProbeId::Second);
    let target_path = harness.path_for(target_probe).to_owned();
    let target_name = match target_probe {
        ProbeId::First => "AToolsOwnedProbeFirst",
        ProbeId::Second => "AToolsOwnedProbeSecond",
    };
    let database = DatabaseEvidence::read(&db);
    let (task_runs, denied, succeeded, history_items, matching_history, use_count) = match database
    {
        Ok(evidence) => (
            evidence.task_run_count(),
            evidence.denied_run_count(&target_path),
            evidence.succeeded_run_count(&target_path),
            evidence.history_count(),
            evidence.matching_history_count(&target_path, target_name),
            evidence.matching_history_use_count(&target_path, target_name),
        ),
        Err(()) => (0, 0, 0, 0, 0, 0),
    };
    let process_observation = if harness.success_launch_attempted() {
        process::observe_probe(
            harness.profile_root(),
            harness.run_id(),
            target_probe.as_str(),
        )
    } else {
        process::ProbeObservation::default()
    };
    let no_markers_without_attempt =
        !harness.success_launch_attempted() && process::markers_absent(harness.profile_root());
    let terminal = if harness.success_launch_attempted() {
        process_observation.terminal
    } else {
        no_markers_without_attempt
    };
    let live_probe_processes = if terminal { 0 } else { 1 };
    let other_probe = if target_probe == ProbeId::First {
        ProbeId::Second
    } else {
        ProbeId::First
    };
    let other_markers_absent =
        process::markers_absent_for(harness.profile_root(), other_probe.as_str());
    let target_evidence_valid = harness.success_launch_attempted()
        && process_observation.started
        && process_observation.nonce_matched
        && process_observation.exit_marker
        && process_observation.terminal
        && other_markers_absent;

    let pending_operations = harness.pending_count();
    harness.update_report(|report| {
        report.launched.marker_started = process_observation.started;
        report.launched.marker_nonce_matched = process_observation.nonce_matched;
        report.launched.exit_marker = process_observation.exit_marker;
        report.launched.process_terminal = process_observation.terminal;
        report.launched.history_recorded_once = matching_history == 1 && history_items == 1;
        report.launched.use_count = use_count;
        report.counts.task_runs = task_runs;
        report.counts.denied = denied;
        report.counts.succeeded = succeeded;
        report.counts.history_items = history_items;
        report.counts.process_starts =
            u64::from(process_observation.started && process_observation.nonce_matched);
        report.counts.process_exits =
            u64::from(process_observation.exit_marker && process_observation.terminal);
        report.cleanup.probes_terminal = terminal && other_markers_absent;
        report.cleanup.live_probe_processes = live_probe_processes;
        if harness.success_launch_attempted() && !target_evidence_valid {
            report.add_error("launcher-probe-not-terminal");
        }
        if pending_operations != 0 {
            report.add_error("launcher-pending-operation-at-exit");
        }
    });
}
