//! Content-free, bounded lifecycle checkpoints for this opt-in fixture only.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Instant};
use tauri::Manager;

const MAX_EVENTS: usize = 128;
const MAX_BYTES: usize = super::package_verification::MAX_REPORT_BYTES;
const FRONTEND_PHASES: &[&str] = &[
    "actual-catalog-search",
    "calculation-controlled-input-decimal-and-grouping",
    "calculation-invalid-empty-recovery",
    "close-and-drain",
    "codec-unicode-base64-round-trip",
    "codec-url-and-json-error-recovery",
    "color-helper-collection-dialog",
    "color-helper-invalid-recovery",
    "color-helper-original-lazy-gradient",
    "color-helper-red-conversion",
    "color-helper-whole-plugin-reopen",
    "content-link-json-and-social-layout",
    "content-normalize-and-markdown-plain-text",
    "cron-linux-five-field-step-editor",
    "cron-spring-six-field-backfill",
    "fixture",
    "frontend-entry",
    "frontend-mount-failed",
    "frontend-mount-start",
    "frontend-mounted",
    "frontend-report-submit",
    "frontend-scenario-complete",
    "frontend-scenario-failed",
    "frontend-scenario-start",
    "frontend-settings-ready",
    "invalid-pattern-recovery",
    "isolated-asset-protocol-defer",
    "native-installed-plugin-entry",
    "offline-example-and-visual",
    "original-ascii-tree-level-text-input",
    "original-ascii-tree-reverse-editor-input",
    "original-ascii-tree-whole-close-fresh-permission-reopen",
    "original-calculator-button-addition",
    "original-calculator-button-division",
    "original-json-editor-initial-worker-handshake",
    "original-json-editor-json-worker-valid-format",
    "original-json-editor-native-ui-preconditions",
    "original-json-editor-os-input-format",
    "original-json-editor-os-input-malformed",
    "original-json-editor-os-input-recovery",
    "original-json-editor-os-input-valid",
    "original-json-editor-ui-focus",
    "original-json-editor-worker-diagnostics-and-recovery",
    "original-json-worker-contract-only",
    "original-mybatis-clear",
    "original-mybatis-error-recovery",
    "original-mybatis-format-sql",
    "original-plain-markdown-drawer-two-draft-switch",
    "original-plain-native-visible-and-focus-preconditions",
    "original-plain-real-codemirror-browser-entry",
    "original-plain-text-os-input-alpha",
    "original-plain-text-os-input-beta",
    "original-plain-whole-close-fresh-data-path-node-reopen",
    "original-subnet-invalid-mask-recovery",
    "original-subnet-ipv4-24-31-32",
    "original-subnet-reverse-30-error-recovery",
    "original-uuid-host-subinput-deterministic-generation",
    "original-uuid-host-subinput-error-recovery",
    "original-zpx-conflicting-sources-rejected",
    "real-node-authorization",
    "real-display-authorization",
    "real-path-revocation-entry",
    "real-plugin-data-authorization",
    "real-standard-path-authorization",
    "real-startup-save-metadata-authorization",
    "regex-approved-standard-path-contract",
    "regex-matches-flags-captures",
    "regex-original-preload-fixed-text-write",
    "single-original-zpx-import",
    "single-package-directory-import",
    "timestamp-epoch-zone-observation",
    "timestamp-live-clock-pause-resume",
    "timestamp-reverse-calendar-controls",
    "timestamp-seconds-milliseconds-and-recovery",
    "todo-default-groups-and-sqlite",
    "todo-original-create-edit-complete",
    "todo-original-group-create-rename-and-return",
    "todo-original-search-and-completion-filter",
    "todo-whole-plugin-close-and-fresh-data-reopen",
];
const NATIVE_PHASES: &[&str] = &[
    "native-configured",
    "native-setup",
    "native-window-created",
    "native-build-failed",
    "frontend-entry",
    "frontend-settings-ready",
    "frontend-mount-start",
    "frontend-mounted",
    "frontend-scenario-start",
    "frontend-scenario-complete",
    "frontend-report-submit",
    "frontend-mount-failed",
    "frontend-report-received",
    "report-timeout",
    "report-channel-closed",
    "cleanup-resources-start",
    "cleanup-resources-complete",
    "cleanup-dialogs-start",
    "cleanup-dialogs-complete",
    "cleanup-paths-start",
    "cleanup-paths-complete",
    "cleanup-data-start",
    "cleanup-data-complete",
    "cleanup-legacy-start",
    "cleanup-legacy-complete",
    "cleanup-host-start",
    "cleanup-host-complete",
    "task-runs-start",
    "task-runs-complete",
    "final-runtime-start",
    "final-runtime-complete",
    "native-report-finalized",
    "event-loop-returned",
];

struct State {
    history: Vec<Value>,
    foreground: Value,
    receipt: Value,
    final_report: Option<Value>,
    write_failures: u32,
    overflowed: bool,
    loop_returned: bool,
    return_report: Option<Value>,
}
pub(super) struct Lifecycle {
    path: PathBuf,
    base: Value,
    started: Instant,
    state: Mutex<State>,
}
impl Lifecycle {
    pub(super) fn new(path: PathBuf, base: Value) -> Self {
        Self {
            path,
            base,
            started: Instant::now(),
            state: Mutex::new(State {
                history: Vec::new(),
                foreground: Value::Null,
                receipt: Value::Null,
                final_report: None,
                write_failures: 0,
                overflowed: false,
                loop_returned: false,
                return_report: None,
            }),
        }
    }
    fn append(&self, state: &mut State, event: Value) {
        if state.history.len() < MAX_EVENTS {
            state.history.push(event);
        } else {
            state.overflowed = true;
        }
    }
    fn failed(&self) -> Value {
        let mut report = self.base.clone();
        report["passed"] = json!(false);
        report["cleanupComplete"] = json!(false);
        report["cleanupStatus"] = json!("unknown");
        report["identityValid"] = json!(false);
        report["taskRunsTerminal"] = json!(false);
        report["finalRuntimeDrained"] = json!(false);
        report["checkpointOnly"] = json!(true);
        report
    }
    fn enrich(&self, state: &State, report: &mut Value) {
        report["nativeLifecycle"] = json!({"events":state.history,
            "windowEvents":state.foreground,"overflowed":state.overflowed,
            "receipt":state.receipt,"writeFailures":state.write_failures});
    }
    fn write(&self, state: &mut State, mut report: Value) -> Result<(), String> {
        self.enrich(state, &mut report);
        let result = (|| {
            let bytes =
                serde_json::to_vec_pretty(&report).map_err(|_| "REPORT_SERIALIZE_FAILED")?;
            if bytes.len() > MAX_BYTES {
                return Err("REPORT_SIZE_LIMIT");
            }
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent).map_err(|_| "REPORT_PARENT_FAILED")?;
            }
            let staging = self.path.with_extension("checkpoint-tmp");
            std::fs::write(&staging, bytes).map_err(|_| "REPORT_WRITE_FAILED")?;
            std::fs::rename(&staging, &self.path).map_err(|_| "REPORT_RENAME_FAILED")
        })();
        if let Err(code) = result {
            state.write_failures = state.write_failures.saturating_add(1);
            eprintln!("[published-smoke] diagnostic-write-failed {code}");
            return Err(code.into());
        }
        Ok(())
    }
    fn checkpoint(&self, state: &mut State) -> Result<(), String> {
        let report = state.final_report.clone().unwrap_or_else(|| self.failed());
        self.write(state, report)
    }
    pub(super) fn phase(&self, phase: &str) -> Result<(), String> {
        self.record_phase(phase, "native")
    }
    pub(super) fn received(&self, phase: &str, report: &Value) {
        if !matches!(
            phase,
            "frontend-report-received" | "report-timeout" | "report-channel-closed"
        ) {
            return;
        }
        {
            let mut state = self.state.lock();
            if state.loop_returned {
                return;
            }
            state.receipt = json!({"status":phase,"object":report.is_object(),
                "frontendPassed":report["passed"].as_bool(),
                "checkCount":report["checks"].as_object().map(|checks|checks.len().min(512))});
        }
        let _ = self.phase(phase);
    }
    pub(super) fn frontend_phase(&self, phase: &str) -> Result<(), String> {
        if !FRONTEND_PHASES.contains(&phase) {
            return Err("UNREGISTERED_PUBLISHED_PHASE".into());
        }
        self.record_phase(phase, "frontend")
    }
    fn record_phase(&self, phase: &str, source: &str) -> Result<(), String> {
        if phase.len() > 64
            || (!NATIVE_PHASES.contains(&phase) && !FRONTEND_PHASES.contains(&phase))
        {
            return Err("UNREGISTERED_PUBLISHED_PHASE".into());
        }
        let elapsed = self.started.elapsed().as_millis() as u64;
        let mut state = self.state.lock();
        if state.loop_returned {
            return Err("PUBLISHED_LIFECYCLE_CLOSED".into());
        }
        if state.history.len() >= MAX_EVENTS {
            if state.overflowed {
                return Ok(());
            }
            state.overflowed = true;
            return self.checkpoint(&mut state);
        }
        self.append(
            &mut state,
            json!({"kind":"phase","source":source,"phase":phase,"elapsedMs":elapsed}),
        );
        eprintln!("[published-smoke] {phase} {elapsed}ms");
        self.checkpoint(&mut state)
    }
    pub(super) fn foreground(&self, snapshot: Value) {
        let mut state = self.state.lock();
        if state.loop_returned || state.foreground == snapshot {
            return;
        }
        state.foreground = snapshot;
        let _ = self.checkpoint(&mut state); // write() emits a fixed diagnostic on failure.
    }
    pub(super) fn run_event(&self, event: &str, code: Option<i32>) {
        if !matches!(event, "exit-requested" | "exit") {
            return;
        }
        let mut state = self.state.lock();
        if state.loop_returned {
            return;
        }
        self.append(
            &mut state,
            json!({"kind":"run-event","event":event,"code":code,
            "elapsedMs":self.started.elapsed().as_millis() as u64}),
        );
        eprintln!("[published-smoke] {event} code={code:?}");
        let _ = self.checkpoint(&mut state);
    }
    pub(super) fn finalize(&self, mut report: Value) -> Result<bool, String> {
        let mut state = self.state.lock();
        if state.loop_returned {
            return Err("PUBLISHED_LIFECYCLE_CLOSED".into());
        }
        self.append(
            &mut state,
            json!({"kind":"phase","phase":"native-report-finalized",
            "elapsedMs":self.started.elapsed().as_millis() as u64}),
        );
        report["checkpointOnly"] = json!(false);
        if state.write_failures != 0 {
            report["passed"] = json!(false);
        }
        self.write(&mut state, report.clone())?;
        let success = report["passed"] == true;
        state.final_report = Some(report);
        Ok(success)
    }
    /// First operation after run_return: seal before snapshots or filesystem cleanup.
    pub(super) fn loop_returned(&self, code: i32) {
        let mut state = self.state.lock();
        if state.loop_returned {
            return;
        }
        state.loop_returned = true;
        self.append(
            &mut state,
            json!({"kind":"phase","phase":"event-loop-returned","code":code,
            "elapsedMs":self.started.elapsed().as_millis() as u64}),
        );
        let mut report = state.final_report.clone().unwrap_or_else(|| {
            let mut failed = self.failed();
            failed["error"] = json!("Native event loop ended before final fixture report");
            failed["earlyEventLoopExit"] = json!(true);
            failed
        });
        report["eventLoopExitCode"] = json!(code);
        report["temporaryDataRemoved"] = Value::Null;
        if code != 0 || state.write_failures != 0 {
            report["passed"] = json!(false);
        }
        state.return_report = Some(report.clone());
        let _ = self.write(&mut state, report);
    }
    pub(super) fn after_loop(
        &self,
        code: i32,
        removed: bool,
        foreground: Value,
    ) -> Result<bool, String> {
        let mut state = self.state.lock();
        let mut report = state
            .return_report
            .clone()
            .ok_or("PUBLISHED_LOOP_NOT_SEALED")?;
        state.foreground = foreground;
        report["temporaryDataRemoved"] = json!(removed);
        if !removed || code != 0 || state.write_failures != 0 {
            report["passed"] = json!(false);
        }
        self.write(&mut state, report.clone())?;
        Ok(report["passed"] == true)
    }
}

#[tauri::command]
pub(super) fn native_published_phase(app: tauri::AppHandle, phase: String) -> Result<(), String> {
    app.state::<std::sync::Arc<Lifecycle>>()
        .frontend_phase(&phase)
}

#[cfg(test)]
#[path = "desktop_smoke_published_lifecycle_tests.rs"]
mod tests;
