use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LauncherReport {
    schema_version: u8,
    enabled: bool,
    passed: bool,
    errors: Vec<&'static str>,
    pub(super) catalog: CatalogReport,
    pub(super) input: InputReport,
    pub(super) space_disabled: SpaceDisabledReport,
    pub(super) unlisted: FourFlags,
    pub(super) denied: FiveFlags,
    pub(super) launched: LaunchReport,
    pub(super) counts: CountsReport,
    pub(super) cleanup: CleanupReport,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CatalogReport {
    pub(super) fixture_only: bool,
    pub(super) item_count: u64,
    pub(super) confined: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InputReport {
    pub(super) key: String,
    pub(super) space_enabled: bool,
    pub(super) dom_input: bool,
    pub(super) result_count: u64,
    pub(super) selection_changed: bool,
    pub(super) selected_identity_matched: bool,
    pub(super) selected_probe: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SpaceDisabledReport {
    pub(super) applicable: bool,
    pub(super) checked: bool,
    pub(super) no_task_run: bool,
    pub(super) no_marker: bool,
    pub(super) no_history: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FourFlags {
    pub(super) rejected: bool,
    pub(super) no_task_run: bool,
    pub(super) no_marker: bool,
    pub(super) no_history: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FiveFlags {
    pub(super) policy_readback: bool,
    pub(super) task_run_cancelled: bool,
    pub(super) audit_denied: bool,
    pub(super) no_marker: bool,
    pub(super) no_history: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LaunchReport {
    pub(super) policy_cleared: bool,
    pub(super) task_run_succeeded: bool,
    pub(super) audit_succeeded: bool,
    pub(super) marker_started: bool,
    pub(super) marker_nonce_matched: bool,
    pub(super) exit_marker: bool,
    pub(super) process_terminal: bool,
    pub(super) history_recorded_once: bool,
    pub(super) main_history_applied: bool,
    pub(super) use_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CountsReport {
    pub(super) task_runs: u64,
    pub(super) denied: u64,
    pub(super) succeeded: u64,
    pub(super) history_items: u64,
    pub(super) process_starts: u64,
    pub(super) process_exits: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CleanupReport {
    pub(super) probes_terminal: bool,
    pub(super) pending_launches: u64,
    pub(super) live_probe_processes: u64,
}

impl LauncherReport {
    pub(super) fn new(auto_clear: &str, catalog: CatalogReport, enabled: bool) -> Self {
        let enter_case = auto_clear == "immediately";
        Self {
            schema_version: 1,
            enabled,
            passed: false,
            errors: Vec::new(),
            catalog,
            input: InputReport {
                key: if enter_case { "Enter" } else { "Space" }.to_owned(),
                space_enabled: false,
                dom_input: false,
                result_count: 0,
                selection_changed: false,
                selected_identity_matched: false,
                selected_probe: String::new(),
            },
            space_disabled: SpaceDisabledReport {
                applicable: enter_case,
                checked: false,
                no_task_run: false,
                no_marker: false,
                no_history: false,
            },
            unlisted: FourFlags {
                rejected: false,
                no_task_run: false,
                no_marker: false,
                no_history: false,
            },
            denied: FiveFlags {
                policy_readback: false,
                task_run_cancelled: false,
                audit_denied: false,
                no_marker: false,
                no_history: false,
            },
            launched: LaunchReport {
                policy_cleared: false,
                task_run_succeeded: false,
                audit_succeeded: false,
                marker_started: false,
                marker_nonce_matched: false,
                exit_marker: false,
                process_terminal: false,
                history_recorded_once: false,
                main_history_applied: false,
                use_count: 0,
            },
            counts: CountsReport {
                task_runs: 0,
                denied: 0,
                succeeded: 0,
                history_items: 0,
                process_starts: 0,
                process_exits: 0,
            },
            cleanup: CleanupReport {
                probes_terminal: false,
                pending_launches: 0,
                live_probe_processes: 0,
            },
        }
    }

    pub(super) fn add_error(&mut self, error: &'static str) {
        if !self.errors.contains(&error) {
            self.errors.push(error);
        }
    }

    pub(super) fn to_value(mut self, enter_case: bool, pending_operations: usize) -> Value {
        self.cleanup.pending_launches = pending_operations as u64;
        self.passed = self.is_complete(enter_case);
        serde_json::to_value(self).unwrap_or_else(|_| Value::Null)
    }

    fn is_complete(&self, enter_case: bool) -> bool {
        self.enabled
            && self.errors.is_empty()
            && self.catalog.fixture_only
            && self.catalog.item_count == 2
            && self.catalog.confined
            && self.input.key == if enter_case { "Enter" } else { "Space" }
            && self.input.space_enabled == !enter_case
            && self.input.dom_input
            && self.input.result_count == 2
            && self.input.selection_changed
            && self.input.selected_identity_matched
            && matches!(self.input.selected_probe.as_str(), "first" | "second")
            && self.space_disabled.applicable == enter_case
            && self.space_disabled.checked == enter_case
            && self.space_disabled.no_task_run
            && self.space_disabled.no_marker
            && self.space_disabled.no_history
            && self.unlisted.rejected
            && self.unlisted.no_task_run
            && self.unlisted.no_marker
            && self.unlisted.no_history
            && self.denied.policy_readback
            && self.denied.task_run_cancelled
            && self.denied.audit_denied
            && self.denied.no_marker
            && self.denied.no_history
            && self.launched.policy_cleared
            && self.launched.task_run_succeeded
            && self.launched.audit_succeeded
            && self.launched.marker_started
            && self.launched.marker_nonce_matched
            && self.launched.exit_marker
            && self.launched.process_terminal
            && self.launched.history_recorded_once
            && self.launched.main_history_applied
            && self.launched.use_count == 1
            && self.counts.task_runs == 2
            && self.counts.denied == 1
            && self.counts.succeeded == 1
            && self.counts.history_items == 1
            && self.counts.process_starts == 1
            && self.counts.process_exits == 1
            && self.cleanup.probes_terminal
            && self.cleanup.pending_launches == 0
            && self.cleanup.live_probe_processes == 0
    }
}
