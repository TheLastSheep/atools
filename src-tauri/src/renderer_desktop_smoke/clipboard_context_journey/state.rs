use crate::{
    pasteboard_native::clipboard_fixture::NamedClipboardFixture,
    renderer_desktop_smoke::profile::Profile,
};
use atools_core::Database;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Instant};
use tokio::sync::{oneshot, Notify};

pub(super) const ERROR_CODES: &[&str] = &[
    "clipboard-context-main-ready-timeout",
    "clipboard-context-probe-injection-failed",
    "clipboard-context-probe-ready-invalid",
    "clipboard-context-probe-timeout",
    "clipboard-context-probe-invalid",
    "clipboard-context-fixture-invalid",
    "clipboard-context-permission-baseline-invalid",
    "clipboard-context-stage-failed",
    "clipboard-context-privacy-audit-failed",
    "clipboard-context-cleanup-failed",
    "clipboard-context-report-write-failed",
    "clipboard-context-watchdog-timeout",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Evidence {
    pub(super) schema_version: u8,
    pub(super) operation: String,
    pub(super) probe_id: u64,
    pub(super) document_root: bool,
    pub(super) document_visibility: String,
    pub(super) document_has_focus: bool,
    pub(super) search_input_count: u32,
    pub(super) clipboard_getter_available: bool,
    pub(super) paste_canceled: Option<bool>,
    pub(super) input_empty: Option<bool>,
    pub(super) input_value_matches: Option<bool>,
    pub(super) selection_matches: Option<bool>,
    pub(super) text_chip_matches: Option<bool>,
    pub(super) image_chip_matches: Option<bool>,
    pub(super) file_chip_matches: Option<bool>,
    pub(super) file_name_matches: Option<bool>,
    pub(super) launch_context_observed: Option<bool>,
    pub(super) launch_context_unchanged: Option<bool>,
    pub(super) ui_unchanged: Option<bool>,
    pub(super) getter_returned_null: Option<bool>,
    pub(super) getter_rejected: Option<bool>,
    pub(super) natural_width: Option<u32>,
    pub(super) natural_height: Option<u32>,
    pub(super) adapter_outstanding_native_calls: Option<u32>,
}

pub(super) struct Pending {
    pub(super) id: u64,
    pub(super) operation: String,
    pub(super) sender: oneshot::Sender<Result<Evidence, &'static str>>,
}

pub(super) struct RunState {
    pub(super) injected: bool,
    pub(super) ready: Option<Evidence>,
    pub(super) ready_main_window_visible: Option<bool>,
    pub(super) ready_main_window_focused: Option<bool>,
    pub(super) next_id: u64,
    pub(super) pending: Option<Pending>,
    pub(super) reader_calls: u32,
    pub(super) stages: Value,
    pub(super) errors: Vec<&'static str>,
    pub(super) probe_disposed: bool,
    pub(super) last_evidence: Option<Evidence>,
}

impl Default for RunState {
    fn default() -> Self {
        Self {
            injected: false,
            ready: None,
            ready_main_window_visible: None,
            ready_main_window_focused: None,
            next_id: 1,
            pending: None,
            reader_calls: 0,
            stages: super::report::empty_stages(),
            errors: Vec::new(),
            probe_disposed: false,
            last_evidence: None,
        }
    }
}

pub(super) struct Inner {
    pub(super) profile: Arc<Profile>,
    pub(super) db: Arc<Database>,
    pub(super) board: Arc<NamedClipboardFixture>,
    pub(super) token: String,
    pub(super) started: Instant,
    pub(super) state: Mutex<RunState>,
    pub(super) changed: Notify,
    pub(super) permission_before: Option<String>,
    pub(super) metrics_before: Value,
    pub(super) media_permits_before: Option<usize>,
    pub(super) before: super::privacy::DatabaseFacts,
    pub(super) start_claimed: std::sync::atomic::AtomicBool,
}

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness(pub(super) Arc<Inner>);

impl Harness {
    pub(super) fn new(
        profile: Arc<Profile>,
        db: Arc<Database>,
        board: Arc<NamedClipboardFixture>,
    ) -> Result<Self, String> {
        let before = super::privacy::database_facts(&db, &profile).map_err(str::to_owned)?;
        if before.history_count != 0
            || !before.native_items_empty
            || !before.task_runs.is_empty()
            || !before.audits.is_empty()
        {
            return Err(super::report::PRIVACY_AUDIT_FAILED.to_owned());
        }
        let permission_before = db
            .get_setting("agent.scope_policy")
            .map_err(|_| super::report::PERMISSION_BASELINE_INVALID)?;
        let confirmed = crate::agent_tools::list_agent_scope_policies(&db)
            .map_err(|_| super::report::PERMISSION_BASELINE_INVALID)?
            .into_iter()
            .find(|row| row.scope == "clipboard_read")
            .is_some_and(|row| row.decision == "confirm");
        let metrics_before = board.metrics();
        if !confirmed || !valid_initial_metrics(&metrics_before) {
            return Err(super::report::PERMISSION_BASELINE_INVALID.to_owned());
        }
        #[cfg(feature = "legacy-node-smoke")]
        let media_permits_before = Some(crate::launcher_media_work::available_permits_for_smoke());
        #[cfg(not(feature = "legacy-node-smoke"))]
        let media_permits_before = None;
        Ok(Self(Arc::new(Inner {
            profile,
            db,
            board,
            token: uuid::Uuid::new_v4().simple().to_string(),
            started: Instant::now(),
            state: Mutex::new(RunState::default()),
            changed: Notify::new(),
            permission_before,
            metrics_before,
            media_permits_before,
            before,
            start_claimed: std::sync::atomic::AtomicBool::new(false),
        })))
    }

    pub(super) fn profile(&self) -> &Profile {
        &self.0.profile
    }

    pub(super) fn token(&self) -> &str {
        &self.0.token
    }

    pub(super) fn claim_start(&self) -> bool {
        !self
            .0
            .start_claimed
            .swap(true, std::sync::atomic::Ordering::AcqRel)
    }

    pub(super) fn note_error(&self, code: &'static str) {
        if ERROR_CODES.contains(&code) {
            let mut state = self.0.state.lock();
            if !state.errors.contains(&code) {
                state.errors.push(code);
            }
        }
    }

    pub(super) fn errors(&self) -> Vec<&'static str> {
        self.0.state.lock().errors.clone()
    }

    pub(super) fn media_permits_before(&self) -> Option<usize> {
        self.0.media_permits_before
    }

    pub(super) fn token_matches(&self, token: &str) -> bool {
        token == self.0.token
            && token.len() == 32
            && token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    }

    pub(super) fn mark_injected(&self) -> bool {
        let mut state = self.0.state.lock();
        if state.injected {
            return false;
        }
        state.injected = true;
        true
    }

    pub(super) fn accept_ready(
        &self,
        evidence: Evidence,
        main_window_visible: Option<bool>,
        main_window_focused: Option<bool>,
    ) -> Result<(), &'static str> {
        if !valid_evidence(&evidence, "ready", 0)
            || !evidence.document_root
            || !evidence.clipboard_getter_available
            || evidence.search_input_count != 1
        {
            return Err(super::report::PROBE_READY_INVALID);
        }
        let mut state = self.0.state.lock();
        if !state.injected || state.ready.is_some() {
            return Err(super::report::PROBE_READY_INVALID);
        }
        state.ready_main_window_visible = main_window_visible;
        state.ready_main_window_focused = main_window_focused;
        state.ready = Some(evidence.clone());
        state.last_evidence = Some(evidence);
        state.stages["ready"] = ready_stage(
            state
                .ready
                .as_ref()
                .ok_or(super::report::PROBE_READY_INVALID)?,
            main_window_visible,
            main_window_focused,
        );
        self.0.changed.notify_one();
        Ok(())
    }

    pub(super) fn begin(
        &self,
        operation: &str,
    ) -> Result<(u64, oneshot::Receiver<Result<Evidence, &'static str>>), &'static str> {
        let mut state = self.0.state.lock();
        if state.pending.is_some() || !valid_operation(operation) {
            return Err(super::report::PROBE_INVALID);
        }
        let id = state.next_id;
        state.next_id = id
            .checked_add(1)
            .filter(|next| *next <= 9_007_199_254_740_991)
            .ok_or(super::report::PROBE_INVALID)?;
        let (sender, receiver) = oneshot::channel();
        state.pending = Some(Pending {
            id,
            operation: operation.to_owned(),
            sender,
        });
        Ok((id, receiver))
    }

    pub(super) fn accept_evidence(&self, evidence: Evidence) -> Result<(), &'static str> {
        if !valid_operation(&evidence.operation)
            || !valid_evidence(&evidence, &evidence.operation, evidence.probe_id)
        {
            return Err(super::report::PROBE_INVALID);
        }
        let pending = {
            let mut state = self.0.state.lock();
            let Some(pending) = state.pending.as_ref() else {
                return Err(super::report::PROBE_INVALID);
            };
            if pending.id != evidence.probe_id || pending.operation != evidence.operation {
                return Err(super::report::PROBE_INVALID);
            }
            state.pending.take()
        };
        let Some(pending) = pending else {
            return Err(super::report::PROBE_INVALID);
        };
        if evidence.operation == "dispose" {
            self.0.state.lock().probe_disposed = true;
        }
        self.0.state.lock().last_evidence = Some(evidence.clone());
        pending
            .sender
            .send(Ok(evidence))
            .map_err(|_| super::report::PROBE_INVALID)
    }

    pub(super) fn add_reader_command(&self) {
        let mut state = self.0.state.lock();
        state.reader_calls = state.reader_calls.saturating_add(1).min(4096);
    }

    pub(super) fn reader_commands(&self) -> u32 {
        self.0.state.lock().reader_calls
    }

    pub(super) fn ready_window_facts(&self) -> (Option<bool>, Option<bool>) {
        let state = self.0.state.lock();
        (
            state.ready_main_window_visible,
            state.ready_main_window_focused,
        )
    }

    pub(super) fn set_stage(&self, key: &str, value: Value) {
        self.0.state.lock().stages[key] = value;
    }

    pub(super) fn stages(&self) -> Value {
        self.0.state.lock().stages.clone()
    }

    pub(super) fn pending_probe_count(&self) -> u32 {
        u32::from(self.0.state.lock().pending.is_some())
    }

    pub(super) fn probe_disposed(&self) -> bool {
        self.0.state.lock().probe_disposed
    }

    pub(super) fn ready(&self) -> Option<Evidence> {
        self.0.state.lock().ready.clone()
    }

    pub(super) fn last_evidence(&self) -> Option<Evidence> {
        self.0.state.lock().last_evidence.clone()
    }

    pub(super) async fn wait_ready(&self, duration: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + duration;
        loop {
            if self.0.state.lock().ready.is_some() {
                return true;
            }
            let notified = self.0.changed.notified();
            if self.0.state.lock().ready.is_some() {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return false;
            }
        }
    }

    pub(super) fn finish_pending(&self) -> u32 {
        self.0.state.lock().pending.take().map_or(0, |pending| {
            let _ = pending.sender.send(Err(super::report::PROBE_INVALID));
            1
        })
    }

    pub(super) fn set_denied(&self) -> Result<(), &'static str> {
        crate::agent_tools::set_agent_scope_policy(&self.0.db, "clipboard_read", "deny")
            .map(|_| ())
            .map_err(|_| super::report::PERMISSION_BASELINE_INVALID)
    }

    pub(super) fn restore_permission(&self) -> Result<bool, &'static str> {
        match &self.0.permission_before {
            Some(raw) => self
                .0
                .db
                .set_setting("agent.scope_policy", raw)
                .map_err(|_| super::report::CLEANUP_FAILED)?,
            None => {
                self.0
                    .db
                    .delete_setting("agent.scope_policy")
                    .map_err(|_| super::report::CLEANUP_FAILED)?;
            }
        }
        Ok(
            self.0.db.get_setting("agent.scope_policy").ok().flatten() == self.0.permission_before
                && crate::agent_tools::list_agent_scope_policies(&self.0.db)
                    .ok()
                    .is_some_and(|rows| {
                        rows.into_iter()
                            .find(|row| row.scope == "clipboard_read")
                            .is_some_and(|row| row.decision == "confirm")
                    }),
        )
    }

    pub(super) fn elapsed_ms(&self) -> u64 {
        self.0.started.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
}

pub(super) fn valid_operation(operation: &str) -> bool {
    matches!(
        operation,
        "textEmpty"
            | "textSelection"
            | "image"
            | "file"
            | "expiredSameCount"
            | "empty"
            | "denied"
            | "dispose"
    )
}

pub(super) fn valid_evidence(value: &Evidence, operation: &str, id: u64) -> bool {
    let common = value.schema_version == 1
        && value.operation == operation
        && value.probe_id == id
        && value.document_root
        && matches!(value.document_visibility.as_str(), "visible" | "hidden")
        && value.search_input_count == 1
        && value.clipboard_getter_available
        && value
            .adapter_outstanding_native_calls
            .is_none_or(|count| count <= 4096)
        && value.natural_width.is_none_or(|width| width <= 16_384)
        && value.natural_height.is_none_or(|height| height <= 16_384);
    if !common {
        return false;
    }
    match operation {
        "ready" => {
            value.paste_canceled.is_none()
                && value.launch_context_observed.is_none()
                && value.adapter_outstanding_native_calls == Some(0)
        }
        "textEmpty" => {
            value.paste_canceled.is_some()
                && value.input_empty.is_some()
                && value.text_chip_matches.is_some()
                && value.launch_context_observed.is_some()
        }
        "textSelection" => {
            value.paste_canceled.is_some()
                && value.input_value_matches.is_some()
                && value.selection_matches.is_some()
                && value.launch_context_observed.is_some()
        }
        "image" => {
            value.paste_canceled.is_some()
                && value.image_chip_matches.is_some()
                && value.natural_width.is_some()
                && value.natural_height.is_some()
                && value.launch_context_observed.is_some()
        }
        "file" => {
            value.paste_canceled.is_some()
                && value.file_chip_matches.is_some()
                && value.file_name_matches.is_some()
                && value.launch_context_observed.is_some()
        }
        "expiredSameCount" => {
            value.getter_returned_null.is_some() && value.launch_context_unchanged.is_some()
        }
        "empty" => {
            value.getter_returned_null.is_some()
                && value.ui_unchanged.is_some()
                && value.launch_context_unchanged.is_some()
        }
        "denied" => {
            value.getter_rejected.is_some()
                && value.ui_unchanged.is_some()
                && value.launch_context_unchanged.is_some()
        }
        "dispose" => value.adapter_outstanding_native_calls == Some(0),
        _ => false,
    }
}

fn ready_stage(
    evidence: &Evidence,
    main_window_visible: Option<bool>,
    main_window_focused: Option<bool>,
) -> Value {
    json!({
        "probeReady": true,
        "documentVisibility": evidence.document_visibility,
        "documentHasFocus": evidence.document_has_focus,
        "searchInputCount": evidence.search_input_count,
        "clipboardGetterAvailable": evidence.clipboard_getter_available,
        "mainWindowVisible": main_window_visible,
        "mainWindowFocused": main_window_focused,
    })
}

fn valid_initial_metrics(metrics: &Value) -> bool {
    metrics.get("snapshots").and_then(Value::as_u64) == Some(0)
        && metrics.get("changeCounts").and_then(Value::as_u64) == Some(0)
        && metrics.get("backgroundCaptures").and_then(Value::as_u64) == Some(0)
        && metrics.get("writesRejected").and_then(Value::as_u64) == Some(0)
        && metrics.get("pastesRejected").and_then(Value::as_u64) == Some(0)
        && metrics
            .get("pasteboardChangeCount")
            .and_then(Value::as_i64)
            .is_some()
        && metrics.get("clearVerified").and_then(Value::as_bool) == Some(false)
}
